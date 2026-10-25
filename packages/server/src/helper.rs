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
//! in on every start), and at boot, which finishes a watch a power cut interrupted. Downloading and
//! verifying updates itself is P1-8c.
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

/// One switch, watched: fed what the OS says about the service and what its supervisor says about
/// itself, once a second.
#[derive(Debug)]
pub struct Watch {
    last_pid: Option<u32>,
    restarts: Vec<u64>,
    down_since: Option<u64>,
}

impl Watch {
    pub fn new() -> Self {
        Self { last_pid: None, restarts: Vec::new(), down_since: Some(0) }
    }

    /// `now`: seconds since the watch began.
    pub fn step(&mut self, now: u64, observed: pointer::Observed, health: Option<Health>, t: &Tuning) -> Verdict {
        // A new process while it runs is a restart. (Only while it runs: on Linux the old process
        // is still seen stopping right after the switch, and that is not a crash.)
        if observed.running {
            if let Some(pid) = observed.pid {
                if self.last_pid.is_some_and(|prev| prev != pid) {
                    self.restarts.push(now);
                }
                self.last_pid = Some(pid);
            }
        }
        self.restarts.retain(|&at| now.saturating_sub(at) < t.crash_window_secs);
        if self.restarts.len() as u32 >= t.crash_limit {
            return Verdict::Failed(format!("it restarted {} times within {} minutes", self.restarts.len(), t.crash_window_secs / 60));
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
            return Verdict::Failed(format!("it did not run cleanly for {} minutes within {}", t.clean_secs / 60, t.deadline_secs / 60));
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
                    return Ok(());
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

    fn up(pid: u32) -> Observed {
        Observed { running: true, pid: Some(pid) }
    }
    const DOWN: Observed = Observed { running: false, pid: None };
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
        // Linux, right after `restart --no-block`: the old PID still there, not running.
        assert_eq!(w.step(0, Observed { running: false, pid: Some(41) }, None, &T), Verdict::Wait);
        assert_eq!(w.step(2, up(42), None, &T), Verdict::Wait);
        assert_eq!(w.restarts.len(), 0);
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
        assert!(matches!(w.step(1200, up(7), Some(Health { uptime_secs: 1200, api_running_secs: None }), &T), Verdict::Failed(r) if r.contains("did not run cleanly")));
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
