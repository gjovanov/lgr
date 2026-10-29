//! The update helper (FR-20.20, plan step P1-8b): SYSTEM's or root's, and the only thing that moves
//! a versioned install's pointers. `lgr-server update-helper` is what the helper service runs
//! (`LGRServerUpdate`; `lgr-server-update.service`), from the last known good version.
//!
//! What it does now: it watches every switch until it is confirmed or rolled back.
//! - **Confirmed** after the service has run cleanly for 5 minutes: the supervisor up that long, and
//!   the API running that long by the supervisor's own account. Then the version is the last known
//!   good, the helper itself moves to it, and only it and the version before stay on disk.
//! - **Rolled back**, from disk and offline, when it crash-loops (3 restarts in 10 minutes), stays
//!   down, or never runs cleanly within 20 minutes. The failure is recorded first, the version is
//!   never switched to again, and the helper confirms the version it went back to runs.
//!
//! When it runs: after the package switched (the MSI starts it; on Linux the service's unit pulls it
//! in on every start), at boot, which finishes a watch a power cut interrupted, and when the
//! supervisor wakes it (P1-8c).
//!
//! With nothing to watch it looks for an update (P1-8c): the supervisor's gate first (the window, the
//! tills), then the offer from lgrai.app, which it fetches ITSELF through the supervisor's egress, the
//! bundle into `update/staging/`, its sha256, both signatures against the keys this binary carries,
//! the version read from inside the bytes, the gate once more, and the switch, watched like any other.
//!
//! ⚠ It reads the service's health over the supervisor's own channel and nothing from the data
//! directory, which the service account may write (AC 59). On Windows that channel is a pipe the
//! service created: it is opened at identification level (`ipc.rs`), so the service account, which
//! may impersonate, can never act as SYSTEM through it.

use crate::install::{self, Attempt, Lock, Plan, Root, UpdateState};
use crate::pointer;
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// How long a switch is watched and what it must do to stay. `<root>/update/helper.json` may change
/// it (SYSTEM's or root's like the rest of `update/`): the release's upgrade lane runs in minutes.
#[derive(Debug, Clone, Copy, serde::Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Tuning {
    /// FR-20.20: `last_known_good` once it has run cleanly this long.
    pub clean_secs: u64,
    /// A switch that has not run cleanly by then goes back.
    pub deadline_secs: u64,
    /// Not running at all for this long goes back.
    pub down_secs: u64,
    /// FR-20.20's crash loop: this many restarts...
    pub crash_limit: u32,
    /// ...within this long.
    pub crash_window_secs: u64,
}

impl Default for Tuning {
    fn default() -> Self {
        Self { clean_secs: 300, deadline_secs: 1200, down_secs: 180, crash_limit: 3, crash_window_secs: 600 }
    }
}

impl Tuning {
    pub fn load(root: &Root) -> Self {
        let file = root.update().join("helper.json");
        let t: Tuning = match std::fs::read_to_string(&file) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
                tracing::warn!(file = %file.display(), error = %e, "the helper's tuning is unreadable: the defaults apply");
                Tuning::default()
            }),
            Err(_) => Tuning::default(),
        };
        // Never a watch that cannot see anything: a clean period of a few seconds proves nothing.
        Tuning {
            clean_secs: t.clean_secs.max(10),
            deadline_secs: t.deadline_secs.max(t.clean_secs.max(10) + 30),
            down_secs: t.down_secs.max(20),
            crash_limit: t.crash_limit.max(2),
            crash_window_secs: t.crash_window_secs.max(60),
        }
    }
}

/// The supervisor's own account of itself, over its channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Health {
    pub uptime_secs: u64,
    /// How long the API child has been running; `None` while it is not.
    pub api_running_secs: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Wait,
    Confirmed,
    Failed(String),
}

/// A duration as a person reads it: whole minutes, or seconds (a tuned watch is shorter than one).
fn span(secs: u64) -> String {
    if secs >= 120 && secs.is_multiple_of(60) {
        format!("{} minutes", secs / 60)
    } else {
        format!("{secs} seconds")
    }
}

/// One switch, watched: fed what the OS says about the service and what its supervisor says about
/// itself, once a second.
#[derive(Debug)]
pub struct Watch {
    last_pid: Option<u32>,
    /// The OS's own count of the service's automatic restarts, when it keeps one (Linux).
    last_auto: Option<u32>,
    /// Seen stopped with an error since the process last seen running (Windows).
    crash_seen: bool,
    restarts: Vec<u64>,
    down_since: Option<u64>,
}

impl Watch {
    pub fn new() -> Self {
        Self { last_pid: None, last_auto: None, crash_seen: false, restarts: Vec::new(), down_since: Some(0) }
    }

    /// `now`: seconds since the watch began.
    pub fn step(&mut self, now: u64, observed: pointer::Observed, health: Option<Health>, t: &Tuning) -> Verdict {
        // ⚠ A crash loop counts crashes, never restarts: an administrator's, or needrestart's after
        // a library upgrade, is not one (`pointer::Observed`). An orderly restart still delays the
        // confirmation, which needs five clean minutes of one process.
        if let Some(n) = observed.auto_restarts {
            // Linux: systemd's own count. It only moves when systemd started the service again after
            // its main process ended; an explicit start resets it, which counts nothing.
            if let Some(prev) = self.last_auto {
                for _ in prev..n {
                    self.restarts.push(now);
                }
            }
            self.last_auto = Some(n);
        } else {
            // Windows: a new process is a restart after a crash only when the service was seen
            // stopped with an error since the last one, which the SCM's recovery holds for at least
            // 5 s. A new process with nothing seen between was a fast stop and start that someone
            // asked for. A systemd too old to count says neither: every new process counts, as it
            // always did. (Only while it runs: on Linux the old process is still seen stopping right
            // after the switch, and that is not a crash.)
            if observed.crashed == Some(true) {
                self.crash_seen = true;
            }
            if observed.running {
                if let Some(pid) = observed.pid {
                    if self.last_pid != Some(pid) {
                        let crash = match observed.crashed {
                            Some(_) => self.crash_seen,
                            None => true,
                        };
                        if self.last_pid.is_some() && crash {
                            self.restarts.push(now);
                        }
                        // Whatever ended the last one, this process starts with a clean slate.
                        self.crash_seen = false;
                        self.last_pid = Some(pid);
                    }
                }
            }
        }
        self.restarts.retain(|&at| now.saturating_sub(at) < t.crash_window_secs);
        if self.restarts.len() as u32 >= t.crash_limit {
            return Verdict::Failed(format!("it restarted {} times within {}", self.restarts.len(), span(t.crash_window_secs)));
        }
        if observed.running {
            self.down_since = None;
            if let Some(h) = health {
                if h.uptime_secs >= t.clean_secs && h.api_running_secs.is_some_and(|s| s >= t.clean_secs) {
                    return Verdict::Confirmed;
                }
            }
        } else {
            let since = *self.down_since.get_or_insert(now);
            if now.saturating_sub(since) >= t.down_secs {
                return Verdict::Failed(format!("it has not been running for {} seconds", now - since));
            }
        }
        if now >= t.deadline_secs {
            return Verdict::Failed(format!("it did not run cleanly for {} within {}", span(t.clean_secs), span(t.deadline_secs)));
        }
        Verdict::Wait
    }
}

impl Default for Watch {
    fn default() -> Self {
        Self::new()
    }
}

/// Set by the OS's stop: the watch ends, the attempt stays marked, and the next start resumes it.
static STOP: AtomicBool = AtomicBool::new(false);

/// What the supervisor at `endpoint` says about itself, or `None` when it does not answer in time.
fn health(rt: &tokio::runtime::Runtime, endpoint: &str) -> Option<Health> {
    // ⚠ The timeout is made inside the runtime: a tokio timer built outside one panics ("no reactor
    // running"), which is how the first upgrade lane found the helper dying at its first look.
    let answer = rt
        .block_on(async { tokio::time::timeout(Duration::from_secs(3), crate::ipc::request(endpoint, &crate::ipc::Request::Status)).await })
        .ok()?
        .ok()?;
    let s = answer.status?;
    let api = s["children"].as_array()?.iter().find(|c| c["name"] == "api")?;
    Some(Health { uptime_secs: s["uptimeSecs"].as_u64()?, api_running_secs: (api["state"] == "running").then(|| api["sinceSecs"].as_u64()).flatten() })
}

fn watch(t: &Tuning) -> Verdict {
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => return Verdict::Failed(format!("no runtime to watch with: {e}")),
    };
    let started = Instant::now();
    let mut w = Watch::new();
    loop {
        if STOP.load(Ordering::SeqCst) {
            return Verdict::Wait;
        }
        let observed = pointer::observe().unwrap_or_default();
        let h = if observed.running { health(&rt, &crate::ipc::default_endpoint()) } else { None };
        match w.step(started.elapsed().as_secs(), observed, h, t) {
            Verdict::Wait => std::thread::sleep(Duration::from_secs(1)),
            v => return v,
        }
    }
}

fn data_dir() -> Result<PathBuf> {
    Ok(crate::config::Paths::resolve()?.data)
}

/// Make the pointers say what the state says: a crash between saving the state and moving one
/// leaves them apart, and the state is what was decided.
fn reconcile(root: &Root, state: &UpdateState) -> Result<()> {
    if state.current.is_empty() || !root.version_dir(&state.current).is_dir() {
        return Ok(());
    }
    if pointer::service_version(root).as_deref() != Some(state.current.as_str()) {
        tracing::warn!(current = %state.current, "the service was not pointed where the update state says: pointing it there");
        pointer::point_service(root, &state.current, &data_dir()?, false)?;
        if pointer::observe().map(|o| o.running).unwrap_or(false) {
            pointer::restart()?;
        }
    }
    if !state.last_known_good.is_empty() && root.version_dir(&state.last_known_good).is_dir() {
        pointer::point_helper(root, &state.last_known_good)?;
    }
    Ok(())
}

/// Remove what the state does not keep, and what an interrupted install left beside the versions.
fn prune(root: &Root, state: &UpdateState) {
    let here = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf));
    for v in install::to_prune(&root.installed(), state) {
        let dir = root.version_dir(&v);
        if here.as_deref() == Some(dir.as_path()) {
            continue;
        }
        match install::remove_tree(&dir) {
            Ok(()) => tracing::info!(version = %v, "removed a version nothing needs any more"),
            Err(e) => tracing::warn!(version = %v, error = %format!("{e:#}"), "a version could not be removed"),
        }
    }
    for e in std::fs::read_dir(root.versions()).into_iter().flatten().flatten() {
        if e.file_name().to_string_lossy().starts_with(".incoming-") {
            let _ = install::remove_tree(&e.path());
        }
    }
}

/// FR-20.20's order: a backup first, then migrations (the new version's start), then the health
/// check (the watch). The OLD version's API takes it, of the data the new one is about to migrate.
/// ⚠ No backup, no switch: a version stays installed and is switched to at a later chance.
fn backup_now(rt: &tokio::runtime::Runtime) -> Result<()> {
    let answer = rt
        .block_on(async { tokio::time::timeout(Duration::from_secs(2 * 3600 + 60), crate::ipc::request(&crate::ipc::default_endpoint(), &crate::ipc::Request::BackupNow)).await })
        .map_err(|_| anyhow::anyhow!("the backup did not finish within two hours"))?
        .context("the supervisor could not be asked for a backup")?;
    if !answer.ok {
        anyhow::bail!("no backup: {}", answer.error.unwrap_or_default());
    }
    let status = answer.status.unwrap_or_default();
    if status["ok"].as_bool() != Some(true) {
        anyhow::bail!("the backup did not complete: {status}");
    }
    let runs = status["runs"].as_array().map(|r| r.len()).unwrap_or(0);
    tracing::info!(orgs = runs, "backed up before the switch");
    Ok(())
}

/// The supervisor's answer to `update-context`. Untrusted, every field: the gate decides only WHEN,
/// and what is installed is decided by the bytes' signatures.
#[derive(Debug, Clone)]
struct UpdateContext {
    server: String,
    token: String,
    egress: (u16, String),
    open: bool,
    reason: String,
}

fn ask_context(rt: &tokio::runtime::Runtime) -> Option<UpdateContext> {
    // A node token may take the supervisor a network round trip.
    let answer = rt
        .block_on(async { tokio::time::timeout(Duration::from_secs(60), crate::ipc::request(&crate::ipc::default_endpoint(), &crate::ipc::Request::UpdateContext)).await })
        .ok()?
        .ok()?;
    if !answer.ok {
        tracing::info!(reason = %answer.error.unwrap_or_default(), "the supervisor gives no update context");
        return None;
    }
    let s = answer.status?;
    let server = s["server"].as_str()?.to_string();
    // https only, and short: it is a base URL, never a place to read bytes from unchecked.
    if !server.starts_with("https://") || server.len() > 200 {
        return None;
    }
    Some(UpdateContext {
        server,
        token: s["token"].as_str().filter(|t| t.len() < 8192)?.to_string(),
        egress: (s["egress"]["port"].as_u64().and_then(|p| u16::try_from(p).ok())?, s["egress"]["secret"].as_str()?.to_string()),
        open: s["gate"]["open"].as_bool() == Some(true),
        reason: s["gate"]["reason"].as_str().unwrap_or_default().to_string(),
    })
}

/// What lgrai.app offers this machine (`GET /api/node/v1/server-release`).
#[derive(Debug, Clone)]
struct Offer {
    version: String,
    name: String,
    size: u64,
    signature: String,
    #[cfg_attr(windows, allow(dead_code))]
    platform: String,
    sha256: String,
}

/// The largest bundle a master downloads.
const MAX_BUNDLE: u64 = 2 << 30;

fn offer_from(v: &serde_json::Value) -> Option<Offer> {
    let t = &v["targets"][install::this_target()];
    let name = t["bundle"]["name"].as_str()?.to_string();
    let ok_name = (1..=200).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) && !name.starts_with('.');
    let size = t["bundle"]["size"].as_u64().filter(|&s| s > 0 && s <= MAX_BUNDLE)?;
    let sha256 = t["sha256"].as_str().filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))?.to_ascii_lowercase();
    let version = v["version"].as_str().filter(|x| crate::version::parse(x).is_some())?.to_string();
    ok_name.then(|| Offer { version, name, size, signature: t["signature"].as_str().unwrap_or_default().to_string(), platform: t["platform"].as_str().unwrap_or_default().to_string(), sha256 })
}

fn sha256_of(file: &Path) -> Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(file)?;
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
    }
    Ok(ctx.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect())
}

/// Look for an update, and switch to it if one is due and verifies: `true` when a switch is now in
/// flight (watched next).
fn try_update(root: &Root) -> Result<bool> {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    let Some(ctx) = ask_context(&rt) else { return Ok(false) };
    if !ctx.open {
        tracing::info!(reason = %ctx.reason, "no update now");
        return Ok(false);
    }
    use base64::Engine as _;
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("lgr:{}", ctx.egress.1));
    let https = crate::https::Https::with_os_roots(std::sync::Arc::new(crate::egress::Rules::through("127.0.0.1", ctx.egress.0, Some(basic))))?;
    let (status, body) = rt.block_on(https.json("GET", &format!("{}/api/node/v1/server-release", ctx.server), Some(&ctx.token), None))?;
    if status == 204 {
        return Ok(false);
    }
    if status != 200 {
        anyhow::bail!("global answered {status} for the server release");
    }
    let offer = offer_from(&body).context("global's offer for this machine is not one this helper takes")?;
    let state = UpdateState::load(root)?;
    if !crate::version::is_upgrade(&state.current, &offer.version) || state.failed.iter().any(|f| f.version == offer.version) {
        return Ok(false);
    }
    // FR-20.50 (P3-8c): a SUPTO version waits for its declaration. What runs is the current home's
    // (this helper may be an older version's), or this build's when that home names none.
    let running_supto = install::HomeManifest::read(&root.version_dir(&state.current)).ok().and_then(|m| m.supto).unwrap_or_else(crate::supto::this_build);
    if let Some(waiting) = crate::supto::waits(&body, Some(&running_supto)) {
        tracing::info!(version = %offer.version, supto = %waiting, "not installed: its SUPTO version waits for its declaration");
        return Ok(false);
    }
    // Installed and verified already (a window closed between its download and its switch)?
    if install::verify_home(&root.version_dir(&offer.version)).is_err() {
        let staging = root.staging();
        install::remove_tree(&staging)?;
        std::fs::create_dir_all(&staging)?;
        let dest = staging.join(&offer.name);
        tracing::info!(version = %offer.version, bytes = offer.size, "downloading an update");
        let url = format!("{}/api/node/v1/server-release/{}/{}", ctx.server, offer.version, offer.name);
        let got = rt.block_on(https.download(&url, &dest, offer.size, Duration::from_secs(2 * 3600)))?;
        let result = (|| -> Result<()> {
            if got != offer.size {
                anyhow::bail!("the bundle came as {got} bytes, not the {} offered", offer.size);
            }
            if sha256_of(&dest)? != offer.sha256 {
                anyhow::bail!("the bundle's sha256 is not the offer's");
            }
            crate::signatures::verify_update_signature(&dest, &offer.signature)?;
            #[cfg(unix)]
            crate::signatures::verify_platform_signature(&dest, &offer.platform)?;
            let _lock = Lock::take(root, Duration::from_secs(300))?;
            let installed = install::install_bundle_checked(root, &dest, &|home: &Path| {
                #[cfg(windows)]
                crate::signatures::verify_publisher(&home.join(install::exe_name()))?;
                let _ = home;
                Ok(())
            })?;
            // The version is the one inside the signed bytes, and it must be the one offered.
            if installed.version() != offer.version {
                anyhow::bail!("the bundle says it is {}, and the offer {}", installed.version(), offer.version);
            }
            // So is its SUPTO version: the offer only said which one it is.
            let bundled = install::HomeManifest::read(&root.version_dir(&offer.version))?.supto;
            crate::supto::bundle_is_offered(&body, bundled.as_deref())?;
            Ok(())
        })();
        let _ = install::remove_tree(&staging);
        if let Err(e) = result {
            tracing::error!(version = %offer.version, error = %format!("{e:#}"), "an update was refused");
            return Err(e);
        }
    }
    // The gate again: a till may have opened during the download.
    match ask_context(&rt) {
        Some(c) if c.open => {}
        other => {
            tracing::info!(version = %offer.version, reason = %other.map(|c| c.reason).unwrap_or_default(), "installed, and switched to at the next chance");
            return Ok(false);
        }
    }
    if let Err(e) = backup_now(&rt) {
        tracing::error!(version = %offer.version, error = %format!("{e:#}"), "not switched to: no backup was taken first");
        return Ok(false);
    }
    let _lock = Lock::take(root, Duration::from_secs(300))?;
    let state = UpdateState::load(root)?;
    let current_ok = !state.current.is_empty() && install::verify_home(&root.version_dir(&state.current)).is_ok();
    let plan = install::plan(&state, &offer.version, current_ok);
    if !matches!(plan, Plan::Attempt { .. }) {
        tracing::info!(version = %offer.version, ?plan, "not switched to");
        return Ok(false);
    }
    let next = install::apply(&state, &offer.version, &plan, "helper");
    next.save(root)?;
    pointer::point_service(root, &next.current, &data_dir()?, false)?;
    pointer::point_helper(root, &next.last_known_good)?;
    tracing::info!(version = %offer.version, "switching to an update");
    pointer::restart()?;
    Ok(true)
}

/// The helper's work: watch the switch in flight, if there is one, to its end.
pub fn run(root: &Root) -> Result<()> {
    #[cfg(unix)]
    if !pointer::has_systemd() {
        // A container with no init to ask: nothing here can see the service, so nothing is decided.
        tracing::warn!("no systemd: the update helper cannot watch the service here");
        return Ok(());
    }
    let t = Tuning::load(root);
    loop {
        let attempt: Attempt = {
            let _lock = Lock::take(root, Duration::from_secs(300))?;
            let state = UpdateState::load(root)?;
            reconcile(root, &state)?;
            match state.attempting.clone() {
                None => {
                    prune(root, &state);
                    drop(_lock);
                    // Nothing to watch: an update, if one is due (P1-8c). A switch made here is
                    // watched on the next turn of the loop.
                    match try_update(root) {
                        Ok(true) => continue,
                        Ok(false) => return Ok(()),
                        Err(e) => {
                            tracing::error!(error = %format!("{e:#}"), "no update was installed");
                            return Ok(());
                        }
                    }
                }
                Some(a) => a,
            }
        };
        tracing::info!(version = %attempt.version, from = %attempt.from, by = %attempt.by, "watching an update");
        let verdict = watch(&t);
        let _lock = Lock::take(root, Duration::from_secs(300))?;
        let state = UpdateState::load(root)?;
        if state.attempting.as_ref() != Some(&attempt) {
            // Replaced while watched (a newer package): watch that one.
            continue;
        }
        match verdict {
            Verdict::Wait => {
                tracing::info!(version = %attempt.version, "stopped while watching: the next start resumes it");
                return Ok(());
            }
            Verdict::Confirmed => {
                let next = install::confirmed(&state, &attempt);
                next.save(root)?;
                pointer::point_helper(root, &next.last_known_good)?;
                tracing::info!(version = %attempt.version, "the update ran cleanly: it is the last known good version");
                prune(root, &next);
                return Ok(());
            }
            Verdict::Failed(reason) => {
                tracing::error!(version = %attempt.version, back_to = %attempt.from, %reason, "the update failed: switching back");
                install::verify_home(&root.version_dir(&attempt.from)).with_context(|| format!("{} cannot be gone back to", attempt.from))?;
                // Marked before it is made: a crash from here on is finished by `reconcile`.
                let next = install::rolled_back(&state, &attempt, &reason);
                next.save(root)?;
                pointer::point_service(root, &next.current, &data_dir()?, false)?;
                pointer::point_helper(root, &next.last_known_good)?;
                pointer::restart()?;
                drop(_lock);
                // Confirmed running again, or said loudly: there is nothing further to go back to.
                match watch(&Tuning { clean_secs: t.clean_secs.min(120), ..t }) {
                    Verdict::Confirmed => tracing::info!(version = %next.current, "switched back: the previous version runs"),
                    Verdict::Failed(r) => tracing::error!(version = %next.current, reason = %r, "switched back, and the previous version does not run either"),
                    Verdict::Wait => {}
                }
                let _lock = Lock::take(root, Duration::from_secs(300))?;
                prune(root, &UpdateState::load(root)?);
                return Ok(());
            }
        }
    }
}

/// What a package's install undoes if Windows Installer rolls it back: the state before, and the
/// version directory it made. `update/undo.json`, written by `install-bundle --undoable`, removed by
/// `update commit`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Undo {
    before: UpdateState,
    made: Option<String>,
}

fn undo_file(root: &Root) -> PathBuf {
    root.update().join("undo.json")
}

/// `update install-bundle`: install a bundle (the package's own by default) and switch to it as the
/// rules allow. What the MSI's action and the .deb's postinst run.
pub fn install_bundle(root: Option<PathBuf>, bundle: Option<PathBuf>, start: bool, undoable: bool) -> Result<i32> {
    let root = root.map(Root).or_else(Root::here).context("this lgr-server is not part of an installed server: name its --root")?;
    let bundle = bundle.unwrap_or_else(|| root.installer().join(install::PACKAGE_BUNDLE));
    let data = data_dir()?;
    let _lock = Lock::take(&root, Duration::from_secs(600))?;
    let installed = install::install_bundle(&root, &bundle)?;
    let v = installed.version().to_string();
    let state = UpdateState::load(&root)?;
    if undoable {
        let undo = Undo { before: state.clone(), made: matches!(installed, install::Installed::New(_)).then(|| v.clone()) };
        std::fs::write(undo_file(&root), serde_json::to_string_pretty(&undo)?)?;
    }
    let current_ok = !state.current.is_empty() && install::verify_home(&root.version_dir(&state.current)).is_ok();
    let plan = install::plan(&state, &v, current_ok);
    let next = install::apply(&state, &v, &plan, "package");
    match &plan {
        Plan::Refused(why) => println!("{v} is installed, and the server stays on {}: {why}.", state.current),
        Plan::First => println!("Installed {v}."),
        Plan::Same => println!("{v} is installed and current."),
        Plan::Attempt { from } => println!("Installed {v}: the server runs it from its next start, and goes back to {from} if it fails."),
    }
    // The attempt is marked before the pointer moves.
    next.save(&root)?;
    pointer::point_service(&root, &next.current, &data, plan == Plan::First)?;
    pointer::point_helper(&root, &next.last_known_good)?;
    if start {
        pointer::restart()?;
        pointer::start_helper()?;
    }
    Ok(0)
}

/// `update apply`: an update brought by hand (an air-gapped master, FR-20.20), with both of its
/// signatures: copied into `update/staging/` first, so what is checked is what is unpacked, checked
/// against the keys this binary carries, installed, and switched to now, watched like any other.
pub fn apply(bundle: PathBuf, sig: PathBuf, asc: Option<PathBuf>, no_backup: bool) -> Result<i32> {
    let root = Root::here().context("this lgr-server is not part of an installed server")?;
    let data = data_dir()?;
    let signature = std::fs::read_to_string(&sig).with_context(|| format!("reading {}", sig.display()))?;
    #[cfg(unix)]
    let asc = std::fs::read_to_string(asc.as_ref().context("a Linux update needs its .asc (--asc)")?).context("reading the .asc")?;
    #[cfg(windows)]
    let _ = asc;
    let _lock = Lock::take(&root, Duration::from_secs(600))?;
    let staging = root.staging();
    install::remove_tree(&staging)?;
    std::fs::create_dir_all(&staging)?;
    let name = bundle.file_name().context("the bundle has no file name")?;
    let copy = staging.join(name);
    std::fs::copy(&bundle, &copy).with_context(|| format!("copying {}", bundle.display()))?;
    let result = (|| -> Result<i32> {
        crate::signatures::verify_update_signature(&copy, &signature)?;
        #[cfg(unix)]
        crate::signatures::verify_platform_signature(&copy, &asc)?;
        let installed = install::install_bundle_checked(&root, &copy, &|home: &Path| {
            #[cfg(windows)]
            crate::signatures::verify_publisher(&home.join(install::exe_name()))?;
            let _ = home;
            Ok(())
        })?;
        let v = installed.version().to_string();
        let state = UpdateState::load(&root)?;
        let current_ok = !state.current.is_empty() && install::verify_home(&root.version_dir(&state.current)).is_ok();
        let plan = install::plan(&state, &v, current_ok);
        let Plan::Attempt { from } = &plan else {
            if let Plan::Refused(why) = &plan {
                anyhow::bail!("{v} is installed, and not switched to: {why}");
            }
            println!("{v} is installed already, and current.");
            return Ok(0);
        };
        // A backup first (FR-20.20), unless the operator says there is no server running to take it.
        if no_backup {
            println!("No backup is taken first (--no-backup).");
        } else {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
            backup_now(&rt).context("not switched: no backup was taken first (a server that is not running needs --no-backup)")?;
        }
        let next = install::apply(&state, &v, &plan, "operator");
        next.save(&root)?;
        pointer::point_service(&root, &next.current, &data, false)?;
        pointer::point_helper(&root, &next.last_known_good)?;
        pointer::restart()?;
        pointer::start_helper()?;
        println!("Switched to {v}. The update helper watches it run, and goes back to {from} if it does not.");
        Ok(0)
    })();
    let _ = install::remove_tree(&staging);
    result
}

/// `update undo`: Windows Installer is rolling the package back. The state and the pointers go back
/// to what they were, the version it made goes, and a first install leaves nothing behind it.
pub fn undo() -> Result<i32> {
    let root = Root::here().context("this lgr-server is not part of an installed server")?;
    let _lock = Lock::take(&root, Duration::from_secs(600))?;
    let Ok(text) = std::fs::read_to_string(undo_file(&root)) else { return Ok(0) };
    let undo: Undo = serde_json::from_str(&text)?;
    if undo.before.current.is_empty() {
        let _ = crate::service::platform::uninstall();
        pointer::remove_helper()?;
        pointer::remove_firewall();
    } else {
        undo.before.save(&root)?;
        pointer::point_service(&root, &undo.before.current, &data_dir()?, false)?;
        pointer::point_helper(&root, &undo.before.last_known_good)?;
    }
    if let Some(v) = undo.made.filter(|v| *v != undo.before.current && *v != undo.before.last_known_good) {
        install::remove_tree(&root.version_dir(&v))?;
    }
    if undo.before.current.is_empty() {
        let _ = install::remove_tree(&root.update());
        let _ = install::remove_tree(&root.versions());
    } else {
        let _ = std::fs::remove_file(undo_file(&root));
    }
    Ok(0)
}

/// `update commit`: the package's install is final, so nothing is left to undo.
pub fn commit() -> Result<i32> {
    if let Some(root) = Root::here() {
        let _ = std::fs::remove_file(undo_file(&root));
    }
    Ok(0)
}

/// `update status`: the state, and where the pointers really are.
pub fn status(json: bool) -> Result<i32> {
    let root = Root::here().context("this lgr-server is not part of an installed server")?;
    let state = UpdateState::load(&root)?;
    let service = pointer::service_version(&root);
    if json {
        let mut v = serde_json::to_value(&state)?;
        v["serviceRuns"] = service.into();
        v["installed"] = root.installed().into();
        println!("{}", serde_json::to_string_pretty(&v)?);
        return Ok(0);
    }
    println!("current        {}", state.current);
    println!("known good     {}", state.last_known_good);
    if !state.previous.is_empty() {
        println!("previous       {}", state.previous);
    }
    if let Some(a) = &state.attempting {
        println!("being watched  {} (goes back to {} if it fails)", a.version, a.from);
    }
    for f in &state.failed {
        println!("failed         {} ({})", f.version, f.reason);
    }
    println!("service runs   {}", service.as_deref().unwrap_or("?"));
    println!("on disk        {}", root.installed().join(", "));
    Ok(0)
}

/// The helper's log: in `update/`, never in the data directory.
fn log_to(root: &Root) {
    crate::init_logging(Some(&root.update().join("helper.log")));
}

/// `update-helper`: what the OS starts.
pub fn entry() -> Result<i32> {
    let root = Root::here().context("the helper runs from an installed server's versions/")?;
    #[cfg(windows)]
    {
        windows::run(root)
    }
    #[cfg(not(windows))]
    {
        log_to(&root);
        run(&root)?;
        Ok(0)
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::ffi::OsString;
    use windows_service::service::{ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType};
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::{define_windows_service, service_dispatcher};

    static ROOT: std::sync::OnceLock<Root> = std::sync::OnceLock::new();

    define_windows_service!(ffi_helper_main, helper_main);

    pub fn run(root: Root) -> Result<i32> {
        log_to(&root);
        let _ = ROOT.set(root.clone());
        match service_dispatcher::start(pointer::HELPER, ffi_helper_main) {
            Ok(()) => Ok(0),
            // ERROR_FAILED_SERVICE_CONTROLLER_CONNECT: run by a person, not the SCM.
            Err(windows_service::Error::Winapi(e)) if e.raw_os_error() == Some(1063) => {
                super::run(&root)?;
                Ok(0)
            }
            Err(e) => Err(e.into()),
        }
    }

    fn helper_main(_args: Vec<OsString>) {
        let handle = match service_control_handler::register(pointer::HELPER, |event| match event {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                STOP.store(true, Ordering::SeqCst);
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        }) {
            Ok(h) => h,
            Err(e) => {
                tracing::error!(error = %e, "the helper cannot talk to the service manager");
                return;
            }
        };
        let status = |state, code: u32| ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: if state == ServiceState::Running { ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN } else { ServiceControlAccept::empty() },
            exit_code: if code == 0 { ServiceExitCode::Win32(0) } else { ServiceExitCode::ServiceSpecific(code) },
            checkpoint: 0,
            wait_hint: Duration::ZERO,
            process_id: None,
        };
        let _ = handle.set_service_status(status(ServiceState::Running, 0));
        let code = match ROOT.get().map(super::run) {
            Some(Ok(())) => 0,
            Some(Err(e)) => {
                tracing::error!(error = %format!("{e:#}"), "the helper failed");
                1
            }
            None => 1,
        };
        let _ = handle.set_service_status(status(ServiceState::Stopped, code));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pointer::Observed;

    const T: Tuning = Tuning { clean_secs: 300, deadline_secs: 1200, down_secs: 180, crash_limit: 3, crash_window_secs: 600 };

    /// Running, from an OS that says nothing about why a process ended (a systemd older than 235):
    /// every new process counts.
    fn up(pid: u32) -> Observed {
        Observed { running: true, pid: Some(pid), auto_restarts: None, crashed: None }
    }
    /// Running, as systemd reports it: `NRestarts` beside the PID.
    fn up_linux(pid: u32, n_restarts: u32) -> Observed {
        Observed { running: true, pid: Some(pid), auto_restarts: Some(n_restarts), crashed: None }
    }
    /// Running, as the SCM reports it.
    fn up_win(pid: u32) -> Observed {
        Observed { running: true, pid: Some(pid), auto_restarts: None, crashed: Some(false) }
    }
    const DOWN: Observed = Observed { running: false, pid: None, auto_restarts: None, crashed: None };
    /// Windows: STOPPED with an error, which the SCM's recovery holds for at least 5 s.
    const WIN_CRASHED: Observed = Observed { running: false, pid: None, auto_restarts: None, crashed: Some(true) };
    /// Windows: STOP_PENDING, STOPPED with no error, START_PENDING: no crash.
    const WIN_BETWEEN: Observed = Observed { running: false, pid: None, auto_restarts: None, crashed: Some(false) };
    fn healthy(secs: u64) -> Option<Health> {
        Some(Health { uptime_secs: secs, api_running_secs: Some(secs) })
    }

    #[test]
    fn five_clean_minutes_by_the_supervisors_own_account_confirm_it() {
        let mut w = Watch::new();
        assert_eq!(w.step(0, up(10), healthy(1), &T), Verdict::Wait);
        assert_eq!(w.step(200, up(10), healthy(200), &T), Verdict::Wait);
        // The supervisor up for 5 minutes and the API only just restarted: not clean yet.
        assert_eq!(w.step(310, up(10), Some(Health { uptime_secs: 310, api_running_secs: Some(20) }), &T), Verdict::Wait);
        assert_eq!(w.step(320, up(10), Some(Health { uptime_secs: 320, api_running_secs: None }), &T), Verdict::Wait);
        assert_eq!(w.step(600, up(10), healthy(600), &T), Verdict::Confirmed);
    }

    #[test]
    fn three_restarts_in_ten_minutes_is_a_crash_loop() {
        let mut w = Watch::new();
        let mut pid = 100;
        assert_eq!(w.step(0, up(pid), None, &T), Verdict::Wait);
        for at in [60, 120] {
            pid += 1;
            assert_eq!(w.step(at, up(pid), None, &T), Verdict::Wait);
        }
        pid += 1;
        assert!(matches!(w.step(180, up(pid), None, &T), Verdict::Failed(r) if r.contains("restarted 3 times")));
    }

    #[test]
    fn restarts_spread_wider_than_the_window_are_not_a_loop() {
        let mut w = Watch::new();
        assert_eq!(w.step(0, up(1), None, &T), Verdict::Wait);
        assert_eq!(w.step(100, up(2), None, &T), Verdict::Wait);
        assert_eq!(w.step(500, up(3), None, &T), Verdict::Wait);
        assert_eq!(w.step(800, up(4), healthy(10), &T), Verdict::Wait, "the restart at 100 s is out of the window");
    }

    #[test]
    fn the_old_process_seen_stopping_after_the_switch_is_not_a_crash() {
        let mut w = Watch::new();
        // A systemd too old to count, right after `restart --no-block`: the old PID still there, not running.
        assert_eq!(w.step(0, Observed { running: false, pid: Some(41), auto_restarts: None, crashed: None }, None, &T), Verdict::Wait);
        assert_eq!(w.step(2, up(42), None, &T), Verdict::Wait);
        assert_eq!(w.restarts.len(), 0);
    }

    /// The first update lane (2026-10-29): unattended-upgrades ran on the fresh Ubuntu master,
    /// needrestart restarted the service after each library it upgraded, and the helper counted
    /// three new processes in a minute and a half as a crash loop. 0.1.3, which ran cleanly, was
    /// taken back and never switched to again on that machine.
    #[test]
    fn an_orderly_restart_is_not_a_crash_on_linux() {
        let mut w = Watch::new();
        // The old process seen first, before the switch's restart has run (`--no-block`).
        assert_eq!(w.step(0, up_linux(100, 0), None, &T), Verdict::Wait);
        // The switch, then needrestart three times: new processes, and systemd's count unmoved.
        for (at, pid) in [(2, 101), (20, 102), (25, 103), (70, 104)] {
            assert_eq!(w.step(at, up_linux(pid, 0), None, &T), Verdict::Wait, "at {at}");
        }
        assert_eq!(w.restarts.len(), 0);
        // Five clean minutes of the last one confirm it.
        assert_eq!(w.step(370, up_linux(104, 0), healthy(300), &T), Verdict::Confirmed);
    }

    #[test]
    fn systemd_s_own_restarts_are_the_crash_loop_on_linux() {
        let mut w = Watch::new();
        assert_eq!(w.step(0, up_linux(100, 0), None, &T), Verdict::Wait);
        // The process dies and systemd starts it again: `NRestarts` moves, between two looks too.
        assert_eq!(w.step(60, Observed { running: false, pid: None, auto_restarts: Some(1), crashed: None }, None, &T), Verdict::Wait);
        assert_eq!(w.step(66, up_linux(101, 1), None, &T), Verdict::Wait);
        // Two at once (a look missed one): both count.
        assert!(matches!(w.step(130, up_linux(103, 3), None, &T), Verdict::Failed(r) if r.contains("restarted 3 times")));
    }

    #[test]
    fn an_explicit_start_resets_systemd_s_count_and_counts_nothing() {
        let mut w = Watch::new();
        assert_eq!(w.step(0, up_linux(100, 2), None, &T), Verdict::Wait, "two from before the watch are not this switch's");
        assert_eq!(w.step(10, up_linux(101, 0), None, &T), Verdict::Wait, "a manual restart resets it");
        assert_eq!(w.step(20, up_linux(102, 1), None, &T), Verdict::Wait);
        assert_eq!(w.restarts.len(), 1);
    }

    #[test]
    fn on_windows_a_new_process_with_no_crash_seen_is_not_a_crash() {
        let mut w = Watch::new();
        assert_eq!(w.step(0, up_win(1), None, &T), Verdict::Wait);
        // An administrator's Restart-Service, three times: over within a look, or with only its
        // stop or its start seen in between. Never STOPPED with an error.
        assert_eq!(w.step(10, up_win(2), None, &T), Verdict::Wait);
        assert_eq!(w.step(20, WIN_BETWEEN, None, &T), Verdict::Wait);
        assert_eq!(w.step(21, up_win(3), None, &T), Verdict::Wait);
        assert_eq!(w.step(30, WIN_BETWEEN, None, &T), Verdict::Wait);
        assert_eq!(w.step(31, WIN_BETWEEN, None, &T), Verdict::Wait);
        assert_eq!(w.step(32, up_win(4), None, &T), Verdict::Wait);
        assert_eq!(w.restarts.len(), 0);
    }

    #[test]
    fn on_windows_a_kill_is_seen_stopped_with_an_error_and_counts() {
        // A kill: STOPPED with the SCM's 1067, for the 5, 30, then 60 s its recovery waits.
        let mut w = Watch::new();
        assert_eq!(w.step(0, up_win(1), None, &T), Verdict::Wait);
        for (at, wait, pid) in [(10, 5, 2), (50, 30, 3)] {
            for s in 0..wait {
                assert_eq!(w.step(at + s, WIN_CRASHED, None, &T), Verdict::Wait);
            }
            assert_eq!(w.step(at + wait, WIN_BETWEEN, None, &T), Verdict::Wait, "START_PENDING");
            assert_eq!(w.step(at + wait + 1, up_win(pid), None, &T), Verdict::Wait);
        }
        assert_eq!(w.step(150, WIN_CRASHED, None, &T), Verdict::Wait);
        assert!(matches!(w.step(211, up_win(4), None, &T), Verdict::Failed(r) if r.contains("restarted 3 times")));
    }

    #[test]
    fn a_crash_seen_before_the_first_process_is_not_held_against_the_next() {
        let mut w = Watch::new();
        // The helper starts while the service is still stopped with an error (before the switch).
        assert_eq!(w.step(0, WIN_CRASHED, None, &T), Verdict::Wait);
        assert_eq!(w.step(2, up_win(10), None, &T), Verdict::Wait);
        assert_eq!(w.step(30, up_win(11), None, &T), Verdict::Wait, "a restart with nothing seen between");
        assert_eq!(w.restarts.len(), 0);
        assert_eq!(w.step(40, WIN_CRASHED, None, &T), Verdict::Wait);
        assert_eq!(w.step(46, up_win(12), None, &T), Verdict::Wait);
        assert_eq!(w.restarts.len(), 1);
    }

    #[test]
    fn systemctl_show_is_read() {
        let show = "ActiveState=active\nSubState=running\nMainPID=4321\nNRestarts=2\n";
        assert_eq!(pointer::observed_from_show(show), Observed { running: true, pid: Some(4321), auto_restarts: Some(2), crashed: None });
        // A systemd older than 235 has no NRestarts; a stopped unit's MainPID is 0. And
        // `deactivating` is never "in order": systemd passes it clearing a crashed one's children.
        let old = "ActiveState=deactivating\nSubState=stop-sigterm\nMainPID=0\n";
        assert_eq!(pointer::observed_from_show(old), Observed { running: false, pid: None, auto_restarts: None, crashed: None });
    }

    #[test]
    fn a_service_that_stays_down_goes_back() {
        let mut w = Watch::new();
        // Exit 7 on Linux: systemd does not restart it, so nothing ever runs.
        assert_eq!(w.step(0, DOWN, None, &T), Verdict::Wait);
        assert_eq!(w.step(100, DOWN, None, &T), Verdict::Wait);
        assert!(matches!(w.step(180, DOWN, None, &T), Verdict::Failed(r) if r.contains("not been running")));

        // Down for a while, then up: the clock restarts.
        let mut w = Watch::new();
        assert_eq!(w.step(170, DOWN, None, &T), Verdict::Wait);
        assert_eq!(w.step(171, up(5), None, &T), Verdict::Wait);
        assert_eq!(w.step(300, DOWN, None, &T), Verdict::Wait);
    }

    #[test]
    fn running_without_ever_being_clean_goes_back_at_the_deadline() {
        // The supervisor stays up and the API crashes over and over: the PID never changes.
        let mut w = Watch::new();
        for at in (0..1200).step_by(30) {
            assert_eq!(w.step(at, up(7), Some(Health { uptime_secs: at, api_running_secs: Some(3) }), &T), Verdict::Wait, "at {at}");
        }
        assert!(matches!(w.step(1200, up(7), Some(Health { uptime_secs: 1200, api_running_secs: None }), &T), Verdict::Failed(r) if r == "it did not run cleanly for 5 minutes within 20 minutes"));
        // A tuned watch says seconds, never "0 minutes".
        let short = Tuning { clean_secs: 30, deadline_secs: 180, ..T };
        assert!(matches!(Watch::new().step(180, up(7), None, &short), Verdict::Failed(r) if r == "it did not run cleanly for 30 seconds within 3 minutes"));
    }

    #[test]
    fn a_supervisor_that_does_not_answer_is_no_health_and_no_panic() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let nowhere = if cfg!(windows) { r"\\.\pipe\lgr-server-nobody-here".to_string() } else { std::env::temp_dir().join("lgr-server-nobody-here.sock").display().to_string() };
        assert_eq!(health(&rt, &nowhere), None);
    }

    /// A real supervisor channel: the status a running supervisor gives, read as health.
    #[test]
    fn a_supervisors_status_is_read_as_health() {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        let endpoint = if cfg!(windows) {
            format!(r"\\.\pipe\lgr-server-helper-test-{}", std::process::id())
        } else {
            std::env::temp_dir().join(format!("lgr-server-helper-test-{}.sock", std::process::id())).display().to_string()
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel::<crate::ipc::Call>(4);
        let serve_at = endpoint.clone();
        rt.spawn(async move {
            let _ = crate::ipc::serve(&serve_at, tx).await;
        });
        rt.spawn(async move {
            while let Some((_, answer)) = rx.recv().await {
                let _ = answer.send(crate::ipc::Response::status(serde_json::json!({
                    "uptimeSecs": 400,
                    "children": [{ "name": "mongod", "state": "running", "sinceSecs": 400 }, { "name": "api", "state": "running", "sinceSecs": 390 }],
                })));
            }
        });
        let mut got = None;
        for _ in 0..50 {
            got = health(&rt, &endpoint);
            if got.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(got, Some(Health { uptime_secs: 400, api_running_secs: Some(390) }));
    }

    fn offer(target: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "version": "0.2.0", "minVersion": "", "targets": { install::this_target(): target } })
    }
    fn target() -> serde_json::Value {
        serde_json::json!({ "bundle": { "name": "lgr-server-0.2.0-x86_64.zip", "size": 1234 }, "signature": "c2ln", "platform": "-----BEGIN PGP SIGNATURE-----", "sha256": "AB".repeat(32) })
    }

    #[test]
    fn an_offer_is_taken_only_whole_and_sane() {
        let o = offer_from(&offer(target())).unwrap();
        assert_eq!((o.version.as_str(), o.name.as_str(), o.size), ("0.2.0", "lgr-server-0.2.0-x86_64.zip", 1234));
        assert_eq!(o.sha256, "ab".repeat(32), "compared lower-case");
        // A name that is a path, or hidden; no size, or too large; no sha256; another machine's.
        for name in ["../lgr-server.zip", "a/b.zip", ".hidden.zip", "a\\b.zip", ""] {
            let mut t = target();
            t["bundle"]["name"] = name.into();
            assert!(offer_from(&offer(t)).is_none(), "{name:?}");
        }
        for size in [serde_json::json!(0), serde_json::json!(MAX_BUNDLE + 1), serde_json::json!("12")] {
            let mut t = target();
            t["bundle"]["size"] = size.clone();
            assert!(offer_from(&offer(t)).is_none(), "{size}");
        }
        let mut t = target();
        t["sha256"] = "not-a-hash".into();
        assert!(offer_from(&offer(t)).is_none());
        assert!(offer_from(&serde_json::json!({ "version": "0.2.0", "targets": { "some-other-target": target() } })).is_none());
        let mut o = offer(target());
        o["version"] = "latest".into();
        assert!(offer_from(&o).is_none());
    }

    #[test]
    fn tuning_cannot_make_a_watch_that_sees_nothing() {
        let t = tempfile::tempdir().unwrap();
        let root = Root(t.path().to_path_buf());
        std::fs::create_dir_all(root.update()).unwrap();
        std::fs::write(root.update().join("helper.json"), r#"{"cleanSecs":0,"deadlineSecs":1,"crashLimit":0}"#).unwrap();
        let tuned = Tuning::load(&root);
        assert!(tuned.clean_secs >= 10 && tuned.deadline_secs > tuned.clean_secs && tuned.crash_limit >= 2);
        std::fs::write(root.update().join("helper.json"), "not json").unwrap();
        assert_eq!(Tuning::load(&root), Tuning::default());
    }
}
