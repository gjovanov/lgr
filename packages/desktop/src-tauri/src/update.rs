//! C13 — the updater's rules (FR-14.28, FR-14.29).
//!
//! ⚠ This module is the DECISION layer: which version is newer, whether now is a safe moment,
//! and what to roll back to. It performs no download and runs no installer — `install.rs` does,
//! gated on signatures pinned in the binary (the minisign key in `updater.pub` and roomler's
//! Authenticode publisher).
//!
//! ⚠ **An updater that accepts an artifact it should not is worse than no updater — it is remote
//! code execution on every machine in the fleet.** So every rule here fails closed, and the
//! tests are written as the attack rather than as the happy path.
//!
//! ⚠ The version comparison mirrors `services/src/biz/desktop/version.ts` exactly. The hub
//! decides whether a desktop is below `DESKTOP_MIN_VERSION`; the desktop decides whether a
//! manifest is an upgrade. If the two disagree, a fleet either updates in a loop or never
//! updates at all.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

/// How many times an update may be deferred for a busy till before it is forced through.
///
/// ⚠ A compromise with a sharp edge (C13's trap): a till that is never idle would otherwise
/// never update. What keeps it safe is that forcing through still refuses **mid-receipt** — and
/// that is the bridge's own state, never a timer.
pub const MAX_DEFERRALS: u32 = 7;

/// How recently a fiscal command counts as "the till is in use".
///
/// Read by `BridgeState::till_state` (C18) — the native bridge is what knows when a fiscal command
/// last ran, and this is the window it measures against. It lives here, with `TillState`, so the
/// bridge reports into one decided policy rather than inventing its own rule.
pub const BUSY_WINDOW_SECS: i64 = 10 * 60;

/// FR-14.28 — the background check's period when automatic updates are on.
pub const CHECK_INTERVAL_SECS: u64 = 4 * 60 * 60;

/// FR-14.28 — "checked at start (5-min cooldown)". The first automatic check waits this long after
/// launch, so a till that is crash-looping or being restarted repeatedly does not hit the hub on
/// every start, and the start itself (Open LGR, the bridge opening its port) has the machine first.
pub const START_COOLDOWN_SECS: u64 = 5 * 60;

/// After a deferral, try again once the busy window could have closed — not in four hours. A
/// promise retried at the full interval would take 28 h to reach `MAX_DEFERRALS`.
pub const RETRY_AFTER_DEFER_SECS: u64 = BUSY_WINDOW_SECS as u64;
// A retry slower than the normal period would make deferring pointless — checked at compile time.
const _: () = assert!(RETRY_AFTER_DEFER_SECS < CHECK_INTERVAL_SECS);

/// Is an automatic check due?
///
/// `secs_since_start` is the process's age; `secs_since_last` is `None` until the background loop
/// has checked once.
///
/// ⚠ `enabled` is read from the settings file on EVERY tick, not captured when the loop starts:
/// switching automatic updates off has to stop the next attempt, not the next restart's.
///
/// ⚠ A deferral does not bring the next CHECK forward any more (lgr#976). The install it put off
/// is an `InstallRequest`, which the loop carries out on the till's own clock (`request_step`),
/// whoever deferred it. A check is only ever about finding something new.
pub fn auto_check_due(enabled: bool, secs_since_start: u64, secs_since_last: Option<u64>) -> bool {
    if !enabled {
        return false;
    }
    match secs_since_last {
        None => secs_since_start >= START_COOLDOWN_SECS,
        Some(s) => s >= CHECK_INTERVAL_SECS,
    }
}

/// lgr#976 — how long the shell keeps an install it promised. A press of Install is consent to
/// that moment's offer; a day later it would be a surprise, and pressing again is cheap.
pub const REQUEST_TTL_SECS: i64 = 24 * 60 * 60;

/// lgr#976 — after a FAILED attempt, the next one. A failure is retried on its own clock, whatever
/// the till does: a hub that cannot be reached does not come back because the till went idle.
pub const RETRY_AFTER_FAILURE_SECS: i64 = 15 * 60;

/// lgr#976 — failed attempts in a row, a handover that did not take included, before a promise is
/// withdrawn. It bounds a till whose installer fails every time to three tries, not one per start
/// for a whole day.
pub const MAX_REQUEST_FAILURES: u32 = 3;

/// Unix seconds now: what an `InstallRequest` is dated by, because it outlives the process.
pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Who asked for an install (lgr#976). It decides the log's words, and whether switching automatic
/// updates off withdraws the install.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    /// Someone pressed Install. ⚠ Their consent stands whatever the automatic-updates switch says:
    /// "Updates install only when you press Install" is what the Overview says with it off.
    Button,
    /// The background loop's own attempt, with automatic updates on.
    Auto,
}

impl Origin {
    /// The log's prefix. ⚠ `auto-update:` on a person's install read as the loop's work on a till
    /// whose loop was off (lgr#976). lgr-deploy's till lane accepts both prefixes.
    pub fn log_prefix(self) -> &'static str {
        match self {
            Origin::Button => "update",
            Origin::Auto => "auto-update",
        }
    }
}

/// lgr#976 — an install the shell has said it will carry out: a press of Install, or the loop's
/// own attempt, that a till in use deferred.
///
/// ⚠ A deferral TELLS the person the update will install once the till is free, and before this
/// nothing kept that promise. With automatic updates off nothing tried again; with them on, the
/// loop waited out its 4-hour period, because only its own deferral brought the next try forward.
/// The request is what the loop acts on now, whoever deferred, and it is saved, so a restart keeps
/// the promise too.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    pub version: String,
    pub origin: Origin,
    /// Unix seconds of the first deferral. ⚠ Later deferrals do not move it: `REQUEST_TTL_SECS`
    /// counts from the consent, not from the last time the till was busy.
    pub requested_at: i64,
    /// Unix seconds of the last attempt, deferred or failed.
    pub last_attempt_at: i64,
    /// Why the last attempt failed; `None` when it deferred.
    #[serde(default)]
    pub last_error: Option<String>,
    /// Failed attempts in a row. A deferral is not a failure.
    #[serde(default)]
    pub failures: u32,
    /// Handed to the installer since the last start. ⚠ Set BEFORE the handover: on Windows a
    /// successful one never returns, so only the next start can tell whether it took.
    #[serde(default)]
    pub handed_over: bool,
}

impl InstallRequest {
    pub fn new(version: &str, origin: Origin, now: i64) -> Self {
        Self {
            version: version.to_string(),
            origin,
            requested_at: now,
            last_attempt_at: now,
            last_error: None,
            failures: 0,
            handed_over: false,
        }
    }

    /// The till was in use again. Not a failure: the deferral count is what forces it through.
    pub fn deferred(&mut self, now: i64) {
        self.last_attempt_at = now;
        self.last_error = None;
        self.failures = 0;
    }

    /// An attempt failed with `err`. Returns whether the promise still stands.
    pub fn failed(&mut self, now: i64, err: &str) -> bool {
        self.last_attempt_at = now;
        self.last_error = Some(err.to_string());
        self.failures += 1;
        // A known failure supersedes a handover nobody heard back from.
        self.handed_over = false;
        !is_final_error(err) && self.failures < MAX_REQUEST_FAILURES
    }
}

/// lgr#976 — answers that end a promise at once: trying again would only repeat them.
///
/// ⚠ Matched as a whole code, or a code followed by `:`, never as a bare prefix. A prefix match is
/// how a new error code would silently become final.
const FINAL_ERRORS: &[&str] = &[
    // The till already runs it, or something newer.
    "not_an_upgrade",
    // A per-machine install never installs itself.
    "managed",
    // The hub stopped offering it.
    "no_update_offered",
    // The hub moved on; the next check decides on the new offer.
    "offer_changed",
    "updater_not_configured",
    "updater_unsupported_platform",
];

pub fn is_final_error(err: &str) -> bool {
    FINAL_ERRORS
        .iter()
        .any(|code| err.strip_prefix(code).is_some_and(|rest| rest.is_empty() || rest.starts_with(':')))
}

/// The answer of an attempt made while another one is installing. It touches no promise: the
/// install it would have made is already under way.
pub const INSTALL_IN_PROGRESS: &str = "install_in_progress";

/// What the loop does with a promise on this tick (lgr#976).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestStep {
    Wait,
    /// Try now. With the till free this installs. Still in use at the retry time, it counts a
    /// deferral, which is what lets `MAX_DEFERRALS` force it through on a till that is never free.
    Attempt,
    /// Forget it, and say why.
    Withdraw(&'static str),
}

/// The promise's policy, pure so it is tested without a till: `now` in Unix seconds,
/// `secs_since_start` the process's age, `in_flight` whether a fiscal command is running right now
/// (`BridgeState::is_busy`).
///
/// ⚠ **Never during a command in flight.** A promise can force an install about
/// `MAX_DEFERRALS × RETRY_AFTER_DEFER_SECS` after one press, with nobody at the button, so it must
/// never land on a running command. `Busy` cannot say "in flight" from "recently", so the caller
/// says it; the next tick after the command ends is soon enough.
pub fn request_step(
    req: &InstallRequest,
    now: i64,
    secs_since_start: u64,
    till: TillState,
    in_flight: bool,
    auto_enabled: bool,
) -> RequestStep {
    // ⚠ A request dated in the future is withdrawn, not waited for: a clock moved back by days would
    // otherwise keep it alive for days. Pressing Install again is cheap; a surprise install is not.
    let age = now - req.requested_at;
    if !(0..REQUEST_TTL_SECS).contains(&age) {
        return RequestStep::Withdraw("expired");
    }
    if req.origin == Origin::Auto && !auto_enabled {
        return RequestStep::Withdraw("automatic_updates_off");
    }
    if req.failures >= MAX_REQUEST_FAILURES {
        return RequestStep::Withdraw("failed");
    }
    // The start has the machine first, as for the loop's own first check.
    if secs_since_start < START_COOLDOWN_SECS || in_flight {
        return RequestStep::Wait;
    }
    let since = now - req.last_attempt_at;
    if req.last_error.is_some() {
        return if since >= RETRY_AFTER_FAILURE_SECS { RequestStep::Attempt } else { RequestStep::Wait };
    }
    match till {
        TillState::Idle => RequestStep::Attempt,
        TillState::MidReceipt => RequestStep::Wait,
        TillState::Busy if since >= RETRY_AFTER_DEFER_SECS as i64 => RequestStep::Attempt,
        TillState::Busy => RequestStep::Wait,
    }
}

/// What a promise the previous run left means at this start (lgr#976): kept, or why not.
pub fn reconcile_at_start(mut req: InstallRequest, running: &str, now: i64) -> Result<InstallRequest, &'static str> {
    if !is_upgrade(running, &req.version) {
        // This run IS that version, or a newer one: the promise was kept.
        return Err("installed");
    }
    if req.handed_over && !req.failed(now, "install_did_not_take") {
        // ⚠ Handed to the installer, and this is still the old version. Counted as a failure, so a
        // till whose installer always fails stops trying after `MAX_REQUEST_FAILURES` starts.
        return Err("failed");
    }
    Ok(req)
}

/// A promise withdrawn in this process, and why, for the Overview.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Withdrawn {
    pub version: String,
    pub reason: String,
    pub at: i64,
}

/// lgr#976 — the update the shell is waiting to install, shared by the Install button and the
/// background loop: how often it was put off, the install it promised, and whether an install is
/// under way.
#[derive(Default)]
pub struct Pending {
    pub deferrals: Deferrals,
    request: Mutex<Option<InstallRequest>>,
    /// Where `request` is saved. `None` keeps it in memory only (tests, and before `attach`).
    file: Mutex<Option<PathBuf>>,
    /// ⚠ One install at a time: the button and the loop can both decide to install at once.
    installing: AtomicBool,
    withdrawn: Mutex<Option<Withdrawn>>,
}

impl Pending {
    /// Save the promise in `file` from now on, and load what the previous run left there.
    pub fn attach(&self, file: PathBuf) -> Option<InstallRequest> {
        let loaded = load_request(&file);
        *self.file.lock().unwrap_or_else(|p| p.into_inner()) = Some(file);
        *self.request.lock().unwrap_or_else(|p| p.into_inner()) = loaded.clone();
        loaded
    }

    pub fn request(&self) -> Option<InstallRequest> {
        self.request.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn withdrawn(&self) -> Option<Withdrawn> {
        self.withdrawn.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Change the promise and save it, in one hold of the lock: the button and the loop both write.
    fn update<R>(&self, change: impl FnOnce(&mut Option<InstallRequest>) -> R) -> R {
        let mut guard = self.request.lock().unwrap_or_else(|p| p.into_inner());
        let out = change(&mut guard);
        let file = self.file.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some(path) = file {
            save_request(&path, guard.as_ref());
        }
        out
    }

    /// Replace the promise outright (`None` clears it).
    pub fn set(&self, req: Option<InstallRequest>) {
        self.update(|r| *r = req);
    }

    /// A deferral of `version`: the shell now owes this install.
    pub fn promise(&self, version: &str, origin: Origin, now: i64) {
        self.update(|r| match r {
            Some(req) if req.version == version => {
                // A person's press outranks the loop's own attempt: it survives automatic updates
                // being switched off.
                if origin == Origin::Button {
                    req.origin = Origin::Button;
                }
                req.deferred(now);
            }
            _ => *r = Some(InstallRequest::new(version, origin, now)),
        });
    }

    /// An attempt at `version` failed. Keeps the promise or withdraws it; true while it stands.
    pub fn failed(&self, version: &str, err: &str, now: i64) -> bool {
        let withdrawn = self.update(|r| {
            let req = r.as_mut().filter(|req| req.version == version)?;
            if req.failed(now, err) {
                return None;
            }
            *r = None;
            Some(if is_final_error(err) { err.to_string() } else { "failed".to_string() })
        });
        match withdrawn {
            Some(reason) => {
                self.note_withdrawn(version, &reason, now);
                false
            }
            None => self.request().is_some_and(|req| req.version == version),
        }
    }

    /// Forget the promise, and remember why for the Overview.
    pub fn withdraw(&self, version: &str, reason: &str, now: i64) {
        self.set(None);
        self.note_withdrawn(version, reason, now);
    }

    fn note_withdrawn(&self, version: &str, reason: &str, now: i64) {
        *self.withdrawn.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(Withdrawn { version: version.to_string(), reason: reason.to_string(), at: now });
    }

    /// Mark the promise for `version` handed over, BEFORE the handover.
    fn handing_over(&self, version: &str) {
        self.update(|r| {
            if let Some(req) = r.as_mut().filter(|req| req.version == version) {
                req.handed_over = true;
            }
        });
    }
}

/// lgr#976 — where the promise is saved, beside the crash-loop state but in its own file, so the two
/// never overwrite each other's read-modify-write.
pub fn request_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(crate::paths::local_dir(app)?.join("update-request.json"))
}

/// ⚠ An unreadable file is no promise: fail closed, never a surprise install.
pub fn load_request(path: &Path) -> Option<InstallRequest> {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok())
}

/// Write it whole, or remove it. Through a temporary file, so a torn write leaves the old promise or
/// none, never half of one.
pub fn save_request(path: &Path, req: Option<&InstallRequest>) {
    let Some(req) = req else {
        let _ = std::fs::remove_file(path);
        return;
    };
    let Ok(text) = serde_json::to_string_pretty(req) else { return };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, text).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SemVer {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

/// Parse `1.2.3` / `v1.2.3` / `1.2.3-beta.1` / `1.2.3+build`.
///
/// ⚠ Strict: `1.2` and `1.2.3.4` are refused rather than coerced. A build tagged `v1.2` would
/// otherwise compare as `1.2.0` and could ship as an "upgrade" over `1.2.9`.
///
/// The prerelease is returned separately so precedence can follow semver §11.
pub fn parse_version(raw: &str) -> Option<(SemVer, String)> {
    let s = raw.trim();
    let s = s.strip_prefix('v').unwrap_or(s);
    // Drop build metadata: it takes no part in precedence.
    let s = s.split('+').next()?;
    let (core, pre) = match s.split_once('-') {
        Some((c, p)) => (c, p.to_string()),
        None => (s, String::new()),
    };
    if !pre.is_empty() && !pre.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return None;
    }

    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((SemVer { major, minor, patch }, pre))
}

fn cmp_prerelease(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    if a == b {
        return Ordering::Equal;
    }
    // ⚠ A release outranks any prerelease of the same version (semver §11.3). Backwards, and a
    // beta looks like an upgrade over the stable build it precedes.
    if a.is_empty() {
        return Ordering::Greater;
    }
    if b.is_empty() {
        return Ordering::Less;
    }
    let mut ai = a.split('.');
    let mut bi = b.split('.');
    loop {
        match (ai.next(), bi.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                let xn = x.parse::<u64>().ok();
                let yn = y.parse::<u64>().ok();
                let ord = match (xn, yn) {
                    (Some(p), Some(q)) => p.cmp(&q),
                    // Numeric identifiers rank below alphanumeric ones (semver §11.4.3).
                    (Some(_), None) => Ordering::Less,
                    (None, Some(_)) => Ordering::Greater,
                    (None, None) => x.cmp(y),
                };
                if ord != Ordering::Equal {
                    return ord;
                }
            }
        }
    }
}

pub fn compare(a: &(SemVer, String), b: &(SemVer, String)) -> std::cmp::Ordering {
    a.0.major
        .cmp(&b.0.major)
        .then(a.0.minor.cmp(&b.0.minor))
        .then(a.0.patch.cmp(&b.0.patch))
        .then_with(|| cmp_prerelease(&a.1, &b.1))
}

/// Is `candidate` strictly newer than `current`?
///
/// ⚠ **No downgrade, ever**, equality is not an upgrade (reinstalling the running version is how
/// an updater loops), and an unparseable version on EITHER side is refused. A tag typo must not
/// look like a newer release, and installing over a version nobody can read is how a rollback
/// becomes an upgrade.
pub fn is_upgrade(current: &str, candidate: &str) -> bool {
    let (Some(cur), Some(next)) = (parse_version(current), parse_version(candidate)) else {
        return false;
    };
    compare(&next, &cur) == std::cmp::Ordering::Greater
}

/// Does this build satisfy the hub's floor (FR-14.29)?
///
/// Mirrors the server's `meetsMinimum`, including its fail-closed directions: an empty or
/// unparseable minimum means none is set, and an unparseable current version satisfies nothing.
pub fn meets_minimum(current: &str, minimum: &str) -> bool {
    let Some(min) = parse_version(minimum) else { return true };
    let Some(cur) = parse_version(current) else { return false };
    compare(&cur, &min) != std::cmp::Ordering::Less
}

/// What the bridge says about the till right now.
///
/// `Idle` and `Busy` are constructed by `BridgeState::till_state` (C18).
///
/// ⚠ **`MidReceipt` is still never constructed, and that is a known gap, not an oversight.**
/// Recognising an OPEN fiscal receipt means reading the command stream, and the native bridge
/// deliberately does not interpret frames — the drivers on the hub do (C18: "the shell only moves
/// bytes"). A transport that started parsing commands to guess at receipt state would be the one
/// place in the system with a second, divergent opinion of the protocol.
///
/// What this costs is bounded and worth stating: for the first `MAX_DEFERRALS` attempts `Busy`
/// defers exactly as `MidReceipt` would, so the difference appears only at the force-through
/// limit — a till that has deferred seven times AND is mid-receipt at that moment. Closing it
/// needs the hub to TELL the shell a receipt is open, which is a protocol addition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TillState {
    Idle,
    /// A fiscal command ran within `BUSY_WINDOW_SECS`, or one is in flight.
    Busy,
    /// A receipt is open. ⚠ The one state that is never overridden, however many deferrals.
    ///
    /// ⚠ Not yet reachable in production — see the type's note. The rule that acts on it is
    /// tested, so the day the hub can report it, the policy is already decided.
    #[allow(dead_code)]
    MidReceipt,
}

/// Whether to install now (FR-14.28's deferral rule).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateAction {
    Install,
    Defer,
}

/// ⚠ The force-through counts deferrals, but `MidReceipt` is absolute. A till that has deferred
/// twenty times and is halfway through a customer's receipt still does not get interrupted —
/// "never mid-receipt" is what makes the force-through safe at all.
pub fn decide(state: TillState, deferrals: u32) -> UpdateAction {
    match state {
        TillState::MidReceipt => UpdateAction::Defer,
        TillState::Idle => UpdateAction::Install,
        TillState::Busy if deferrals >= MAX_DEFERRALS => UpdateAction::Install,
        TillState::Busy => UpdateAction::Defer,
    }
}

/// How many times the current pending update has been put off, and for which version.
#[derive(Default)]
pub struct Deferrals {
    count: AtomicU32,
    /// The candidate the count belongs to.
    candidate: std::sync::Mutex<String>,
}

impl Deferrals {
    pub fn count(&self) -> u32 {
        self.count.load(Ordering::SeqCst)
    }

    pub fn record(&self) -> u32 {
        self.count.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Point the counter at `candidate`, resetting it if that is a different version.
    ///
    /// ⚠ The count belongs to ONE pending update, not to the machine. Carried over, seven
    /// deferrals of last month's release would force an unrelated one through the moment it
    /// appeared — on a till that had never been offered it.
    pub fn target(&self, candidate: &str) {
        let Ok(mut current) = self.candidate.lock() else { return };
        if *current != candidate {
            *current = candidate.to_string();
            self.count.store(0, Ordering::SeqCst);
        }
    }
}

/// Crash-loop rollback state (FR-14.28).
///
/// ⚠ `last_known_good` is written **before** the attempt. Writing it after a successful start
/// sounds tidier and leaves a crash loop with nothing to roll back to — which is the entire
/// failure this exists for.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UpdateState {
    pub last_known_good: String,
    /// The version currently being attempted, if any.
    pub attempting: String,
    /// Consecutive starts that did not reach "the UI came up".
    pub consecutive_failed_starts: u32,
    /// Set once a rollback has been reported to the hub, so it is reported once.
    pub rollback_reported: bool,
}

/// How many failed starts in a row before reverting.
pub const CRASH_LOOP_LIMIT: u32 = 3;

impl UpdateState {
    /// Call before launching a new version.
    pub fn begin_attempt(&mut self, running: &str, candidate: &str) {
        // Only record a GOOD version — one that actually started. Recording the candidate would
        // make the thing we are rolling back from the thing we roll back to.
        if !running.is_empty() && parse_version(running).is_some() {
            self.last_known_good = running.to_string();
        }
        self.attempting = candidate.to_string();
        self.consecutive_failed_starts = 0;
        self.rollback_reported = false;
    }

    /// Call when the UI reports ready (C08's `shell_ready`).
    pub fn mark_started(&mut self, running: &str) {
        self.consecutive_failed_starts = 0;
        self.attempting = String::new();
        if parse_version(running).is_some() {
            self.last_known_good = running.to_string();
        }
    }

    /// Call on a start that never reached ready. Returns the version to revert to, if it is time.
    pub fn mark_failed_start(&mut self) -> Option<String> {
        self.consecutive_failed_starts += 1;
        if self.consecutive_failed_starts < CRASH_LOOP_LIMIT {
            return None;
        }
        if self.last_known_good.is_empty() {
            // ⚠ Nothing to go back to. Reverting to "unknown" would be worse than staying put,
            // and the Overview still shows the machine as failing.
            return None;
        }
        Some(self.last_known_good.clone())
    }
}

/// How the app was installed, which decides whether it may update itself (FR-14.28 §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallKind {
    /// NSIS per-user on Windows, or any install the running account owns.
    PerUser,
    /// MSI per-machine. ⚠ **Managed**: check, notify, report — never self-install, never elevate.
    PerMachine,
}

impl InstallKind {
    pub fn as_str(self) -> &'static str {
        match self {
            InstallKind::PerUser => "per_user",
            InstallKind::PerMachine => "per_machine",
        }
    }

    pub fn may_self_install(self) -> bool {
        self == InstallKind::PerUser
    }
}

/// Decide from the executable's own location.
///
/// ⚠ **Never elevate** (C13's trap). A standard user cannot elevate `msiexec`, and trying
/// produces a UAC prompt on a till nobody will answer — so a per-machine install reports
/// `managed` and stops. Decided 2026-09-29: no elevated service, ever.
pub fn detect_install_kind(exe_path: &str) -> InstallKind {
    let p = exe_path.to_ascii_lowercase();
    if cfg!(windows) {
        // A per-user NSIS install lands under the user's own profile; an MSI lands in
        // Program Files, which a standard account cannot write.
        if p.contains("\\appdata\\local\\") || p.contains("\\users\\") && !p.contains("\\program files") {
            return InstallKind::PerUser;
        }
        return InstallKind::PerMachine;
    }
    // Linux `/usr` and `/opt` are machine-wide (and macOS `/Applications`, for callers that only
    // have a path; the running app asks `detect_install_kind_here`, which looks at permissions).
    if p.starts_with("/applications/") || p.starts_with("/usr/") || p.starts_with("/opt/") {
        InstallKind::PerMachine
    } else {
        InstallKind::PerUser
    }
}

/// The running app's install kind — what `try_install` and `install` act on.
///
/// ⚠ **macOS decides by PERMISSION, not by path.** Almost every Mac install is a drag into
/// `/Applications`, which an admin account can write without elevating — so "anything under
/// `/Applications` is managed" would mean no Mac ever updates itself. What actually matters is
/// whether the plugin can move the bundle without asking: when it cannot, its answer is an
/// administrator password prompt (AppleScript `with administrator privileges`), the one thing the
/// shell never does. So a Mac self-installs exactly when this user can write BOTH the folder the
/// `.app` sits in and the `.app` itself (moving a directory needs both), and is `managed`
/// otherwise — a standard account under an admin-installed app, or an app on a read-only volume.
pub fn detect_install_kind_here() -> InstallKind {
    let exe = std::env::current_exe().unwrap_or_default();
    if cfg!(target_os = "macos") {
        let Some(app) = exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")) else {
            // Not running from a bundle (a dev build): nothing an updater should replace.
            return InstallKind::PerMachine;
        };
        let writable = app.parent().is_some_and(dir_writable) && dir_writable(app);
        return if writable { InstallKind::PerUser } else { InstallKind::PerMachine };
    }
    detect_install_kind(&exe.to_string_lossy())
}

/// Can this user create a file in `dir`? Asked by trying, because permission bits do not tell the
/// whole story (ACLs, a read-only volume, an app translocated by Gatekeeper).
fn dir_writable(dir: &std::path::Path) -> bool {
    let probe = dir.join(format!(".lgr-write-probe-{}", std::process::id()));
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// What a check found.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    /// A strictly newer version the hub is offering, if any.
    pub available: Option<String>,
    /// The hub refuses this build (FR-14.29).
    pub required: bool,
    /// `per_user` | `per_machine` — a per-machine install never self-installs.
    pub install_kind: &'static str,
    /// True when this machine must be updated by whoever manages it.
    pub managed: bool,
}

/// Where the rollback state lives.
///
/// ⚠ NOT in the keystore directory. This carries no credential, and putting it beside the key
/// would widen what a machine's secret directory holds for no reason.
pub fn state_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::paths::local_dir(app)?.join("update-state.json"))
}

pub fn load_state(app: &tauri::AppHandle) -> UpdateState {
    state_file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save_state(app: &tauri::AppHandle, state: &UpdateState) {
    if let Ok(path) = state_file(app) {
        if let Ok(text) = serde_json::to_string_pretty(state) {
            let _ = std::fs::write(path, text);
        }
    }
}

/// Hand the artifact to the installer: `install.rs`, which runs nothing until the minisign key
/// pinned in `updater.pub` AND the platform signature (Authenticode `G ROX LTD`, or Developer ID
/// team `4TG7586MY5` + notarisation) both accept the bytes.
///
/// ⚠ While `updater.pub` is empty this is still `updater_not_configured` — the honest answer
/// until the one-time key generation has happened.
fn hand_to_installer(app: &tauri::AppHandle, version: &str, origin: Origin) -> Result<(), String> {
    let server = crate::settings::load(app).server_url;
    crate::install::install(app, &server, version, origin)
}

/// The install decision and, if it is time, the attempt (FR-14.28), for the button and the loop
/// alike.
///
/// ⚠ The promise's bookkeeping is HERE, once (lgr#976): a deferral promises the install, a failure
/// keeps or withdraws the promise, and an install already under way leaves it alone. A caller that
/// did its own would be a second, divergent opinion of what the shell has promised.
pub fn try_install(
    app: &tauri::AppHandle,
    running: &str,
    candidate: &str,
    till: TillState,
    pending: &Pending,
    origin: Origin,
) -> Result<UpdateAction, String> {
    let outcome = attempt(app, running, candidate, till, pending, origin);
    let now = now_unix();
    match &outcome {
        Ok(UpdateAction::Defer) => pending.promise(candidate, origin, now),
        Ok(UpdateAction::Install) => {}
        Err(e) if e == INSTALL_IN_PROGRESS => {}
        Err(e) => {
            pending.failed(candidate, e, now);
        }
    }
    outcome
}

fn attempt(
    app: &tauri::AppHandle,
    running: &str,
    candidate: &str,
    till: TillState,
    pending: &Pending,
    origin: Origin,
) -> Result<UpdateAction, String> {
    if !is_upgrade(running, candidate) {
        // Covers downgrades, equality and unparseable tags in one place.
        return Err("not_an_upgrade".into());
    }

    // A different candidate starts its own deferral count.
    pending.deferrals.target(candidate);

    let kind = detect_install_kind_here();
    if !kind.may_self_install() {
        // ⚠ Managed. Check, notify, report — never elevate (decided 2026-09-29).
        return Err("managed".into());
    }

    match decide(till, pending.deferrals.count()) {
        UpdateAction::Defer => {
            pending.deferrals.record();
            Ok(UpdateAction::Defer)
        }
        UpdateAction::Install => {
            if pending.installing.swap(true, Ordering::SeqCst) {
                return Err(INSTALL_IN_PROGRESS.into());
            }
            // ⚠ BEFORE the attempt. Written afterwards, a crash loop has nothing to roll back to.
            let mut state = load_state(app);
            state.begin_attempt(running, candidate);
            save_state(app, &state);
            pending.handing_over(candidate);

            let handed = hand_to_installer(app, candidate, origin);
            // Reached on a failure: a successful install exits (Windows) or restarts (macOS) inside it.
            pending.installing.store(false, Ordering::SeqCst);
            handed.map(|()| UpdateAction::Install)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_parse_the_shapes_a_release_actually_tags() {
        assert!(parse_version("1.2.3").is_some());
        assert!(parse_version("v1.2.3").is_some());
        assert!(parse_version("1.2.3-beta.1").is_some());
        assert!(parse_version("1.2.3+20260930").is_some());
    }

    #[test]
    fn an_unparseable_version_is_refused_rather_than_coerced() {
        // ⚠ C13's trap: a tag typo must not look like a newer release.
        for bad in ["", "1.2", "1.2.3.4", "latest", "v", "1.2.x", "nightly"] {
            assert!(parse_version(bad).is_none(), "{bad} should not parse");
            assert!(!is_upgrade("1.0.0", bad), "{bad} must not be an upgrade");
        }
    }

    #[test]
    fn no_downgrade_ever() {
        assert!(is_upgrade("1.0.0", "1.0.1"));
        assert!(is_upgrade("1.0.0", "1.1.0"));
        assert!(is_upgrade("1.0.0", "2.0.0"));
        assert!(!is_upgrade("2.0.0", "1.9.9"));
        assert!(!is_upgrade("1.0.1", "1.0.0"));
    }

    #[test]
    fn the_same_version_is_not_an_upgrade() {
        // Reinstalling the running version is how an updater loops.
        assert!(!is_upgrade("1.2.3", "1.2.3"));
        assert!(!is_upgrade("1.2.3", "v1.2.3"));
    }

    #[test]
    fn a_prerelease_sorts_before_its_release() {
        // ⚠ Backwards, and a beta looks like an upgrade over the stable build it precedes.
        assert!(is_upgrade("1.2.3-beta.1", "1.2.3"));
        assert!(!is_upgrade("1.2.3", "1.2.3-beta.1"));
        assert!(is_upgrade("1.2.3-beta.1", "1.2.3-beta.2"));
        assert!(is_upgrade("1.2.3-alpha", "1.2.3-beta"));
    }

    #[test]
    fn numeric_prerelease_identifiers_rank_below_alphanumeric_ones() {
        // semver §11.4.3 — and `beta.10` must beat `beta.2`, not lose to it alphabetically.
        assert!(is_upgrade("1.0.0-beta.2", "1.0.0-beta.10"));
        assert!(is_upgrade("1.0.0-1", "1.0.0-alpha"));
    }

    #[test]
    fn an_unparseable_current_version_installs_nothing() {
        // Installing over a version nobody can read is how a rollback becomes an upgrade.
        assert!(!is_upgrade("", "9.9.9"));
        assert!(!is_upgrade("garbage", "9.9.9"));
    }

    #[test]
    fn the_minimum_matches_the_servers_rule() {
        assert!(meets_minimum("1.2.3", "1.2.3"));
        assert!(meets_minimum("1.2.4", "1.2.3"));
        assert!(!meets_minimum("1.2.2", "1.2.3"));
        // No minimum configured is the one case that passes on an unreadable input.
        assert!(meets_minimum("anything", ""));
        assert!(meets_minimum("anything", "not-a-version"));
        // ⚠ But a desktop that cannot state a version does NOT satisfy a configured floor.
        assert!(!meets_minimum("", "1.0.0"));
        assert!(!meets_minimum("0.1.x", "1.0.0"));
    }

    #[test]
    fn a_prototype_cannot_meet_the_first_release() {
        // FR-14.29's stated purpose: a v0.1.x prototype never talks to the new endpoints.
        assert!(!meets_minimum("0.1.3", "1.0.0"));
    }

    #[test]
    fn automatic_updates_off_never_checks() {
        for last in [None, Some(0), Some(CHECK_INTERVAL_SECS * 10)] {
            assert!(!auto_check_due(false, u64::MAX, last), "{last:?}");
        }
    }

    #[test]
    fn the_first_automatic_check_waits_out_the_start_cooldown() {
        assert!(!auto_check_due(true, 0, None));
        assert!(!auto_check_due(true, START_COOLDOWN_SECS - 1, None));
        assert!(auto_check_due(true, START_COOLDOWN_SECS, None));
    }

    #[test]
    fn later_checks_run_every_interval() {
        assert!(!auto_check_due(true, u64::MAX, Some(CHECK_INTERVAL_SECS - 1)));
        assert!(auto_check_due(true, u64::MAX, Some(CHECK_INTERVAL_SECS)));
    }

    // ---- lgr#976: a deferred install is a promise the loop keeps ----

    /// A process old enough to be past the start cooldown.
    const RUNNING: u64 = START_COOLDOWN_SECS + 1;
    const T0: i64 = 1_800_000_000;

    fn req(origin: Origin) -> InstallRequest {
        InstallRequest::new("0.1.15", origin, T0)
    }

    #[test]
    fn a_deferred_press_installs_once_the_till_is_free_with_automatic_updates_off() {
        // ⚠ The bug: "the update will install shortly", and with automatic updates off nothing did.
        let r = req(Origin::Button);
        assert_eq!(request_step(&r, T0 + 60, RUNNING, TillState::Busy, false, false), RequestStep::Wait);
        assert_eq!(request_step(&r, T0 + 60, RUNNING, TillState::Idle, false, false), RequestStep::Attempt);
    }

    #[test]
    fn a_busy_till_is_tried_again_after_the_busy_window_not_the_check_interval() {
        // With automatic updates ON the old loop waited out its 4-hour period after a button's deferral.
        let r = req(Origin::Button);
        let retry = RETRY_AFTER_DEFER_SECS as i64;
        for auto in [false, true] {
            assert_eq!(request_step(&r, T0 + retry - 1, RUNNING, TillState::Busy, false, auto), RequestStep::Wait);
            assert_eq!(request_step(&r, T0 + retry, RUNNING, TillState::Busy, false, auto), RequestStep::Attempt);
        }
    }

    #[test]
    fn a_till_that_is_never_free_is_still_forced_through_at_the_eighth_attempt() {
        // The deferral limit is what makes a busy till update at all; the promise must not undo it by
        // retrying every tick (seven deferrals in two minutes) or never (no force-through).
        let d = Deferrals::default();
        d.target("0.1.15");
        let mut r = req(Origin::Button);
        assert_eq!(decide(TillState::Busy, d.count()), UpdateAction::Defer); // the press itself
        d.record();
        let mut now = T0;
        let mut attempts = 1;
        loop {
            now += 15; // the loop's tick
            assert!(now - T0 < REQUEST_TTL_SECS, "never forced through");
            if request_step(&r, now, RUNNING, TillState::Busy, false, false) != RequestStep::Attempt {
                continue;
            }
            attempts += 1;
            match decide(TillState::Busy, d.count()) {
                UpdateAction::Defer => {
                    d.record();
                    r.deferred(now);
                }
                UpdateAction::Install => break,
            }
        }
        assert_eq!(attempts, MAX_DEFERRALS + 1);
        let waited = now - T0;
        assert!(waited >= (MAX_DEFERRALS as i64) * RETRY_AFTER_DEFER_SECS as i64, "{waited} s");
        assert!(waited < (MAX_DEFERRALS as i64 + 1) * RETRY_AFTER_DEFER_SECS as i64, "{waited} s");
    }

    #[test]
    fn a_promise_never_lands_on_a_command_in_flight() {
        // ⚠ It can force an install with nobody at the button, so not even the forced attempt runs
        // while a fiscal command does — whatever the count, the till state or the clock say.
        let mut r = req(Origin::Button);
        for till in [TillState::Idle, TillState::Busy] {
            assert_eq!(request_step(&r, T0 + 3600, RUNNING, till, true, true), RequestStep::Wait, "{till:?}");
        }
        assert!(r.failed(T0, "download_failed: x"));
        assert_eq!(request_step(&r, T0 + 3600, RUNNING, TillState::Busy, true, true), RequestStep::Wait);
        // The command over, the very next tick tries.
        assert_eq!(request_step(&r, T0 + 3600, RUNNING, TillState::Busy, false, true), RequestStep::Attempt);
    }

    #[test]
    fn mid_receipt_waits_even_when_the_retry_is_due() {
        let r = req(Origin::Button);
        assert_eq!(request_step(&r, T0 + 3600, RUNNING, TillState::MidReceipt, false, true), RequestStep::Wait);
    }

    #[test]
    fn a_promise_waits_out_the_start_cooldown() {
        // A promise kept over a restart does not install while the start still has the machine.
        let r = req(Origin::Button);
        assert_eq!(request_step(&r, T0 + 3600, START_COOLDOWN_SECS - 1, TillState::Idle, false, true), RequestStep::Wait);
        assert_eq!(request_step(&r, T0 + 3600, START_COOLDOWN_SECS, TillState::Idle, false, true), RequestStep::Attempt);
    }

    #[test]
    fn a_failure_is_retried_on_its_own_clock_whatever_the_till_does() {
        let mut r = req(Origin::Button);
        assert!(r.failed(T0, "download_failed: timed out"));
        // Idle does not hammer an unreachable hub every tick.
        assert_eq!(request_step(&r, T0 + 60, RUNNING, TillState::Idle, false, true), RequestStep::Wait);
        assert_eq!(
            request_step(&r, T0 + RETRY_AFTER_FAILURE_SECS, RUNNING, TillState::Idle, false, true),
            RequestStep::Attempt
        );
    }

    #[test]
    fn a_promise_expires_after_a_day_and_one_from_the_future_is_withdrawn() {
        let r = req(Origin::Button);
        assert_eq!(
            request_step(&r, T0 + REQUEST_TTL_SECS, RUNNING, TillState::Idle, false, true),
            RequestStep::Withdraw("expired")
        );
        // ⚠ A clock moved back by days must not keep a stale consent alive for days.
        assert_eq!(request_step(&r, T0 - 1, RUNNING, TillState::Idle, false, true), RequestStep::Withdraw("expired"));
    }

    #[test]
    fn switching_automatic_updates_off_withdraws_only_the_loops_own_promise() {
        assert_eq!(
            request_step(&req(Origin::Auto), T0 + 60, RUNNING, TillState::Idle, false, false),
            RequestStep::Withdraw("automatic_updates_off")
        );
        // A person's press stands: it is the consent "updates install only when you press Install" asks for.
        assert_eq!(request_step(&req(Origin::Button), T0 + 60, RUNNING, TillState::Idle, false, false), RequestStep::Attempt);
    }

    #[test]
    fn three_failures_in_a_row_withdraw_a_promise_and_a_deferral_forgives_them() {
        let mut r = req(Origin::Button);
        assert!(r.failed(T0, "download_failed: x"));
        r.deferred(T0 + 1);
        assert_eq!(r.failures, 0, "a deferral is not a failure, and ends a run of them");
        assert!(r.failed(T0 + 2, "download_failed: x"));
        assert!(r.failed(T0 + 3, "install_failed: x"));
        assert!(!r.failed(T0 + 4, "download_failed: x"), "the third failure in a row withdraws it");
        assert_eq!(
            request_step(&r, T0 + 5, RUNNING, TillState::Idle, false, true),
            RequestStep::Withdraw("failed")
        );
    }

    #[test]
    fn a_final_error_withdraws_at_once_and_is_matched_as_a_whole_code() {
        for err in ["not_an_upgrade", "managed", "no_update_offered", "offer_changed: decided 0.1.15, hub now offers 0.1.16"] {
            assert!(is_final_error(err), "{err}");
            assert!(!req(Origin::Button).failed(T0, err), "{err}");
        }
        // ⚠ Never a bare prefix: a new code that starts like a final one is retried, not dropped.
        for err in ["managed_elsewhere", "offer_changedx", "download_failed: managed", "install_failed: no_update_offered"] {
            assert!(!is_final_error(err), "{err}");
        }
    }

    #[test]
    fn a_second_press_keeps_the_first_consent_and_outranks_the_loop() {
        let p = Pending::default();
        p.promise("0.1.15", Origin::Auto, T0);
        p.promise("0.1.15", Origin::Button, T0 + 600);
        let r = p.request().unwrap();
        assert_eq!(r.origin, Origin::Button, "a person's press survives automatic updates being switched off");
        assert_eq!(r.requested_at, T0, "the day counts from the first consent");
        assert_eq!(r.last_attempt_at, T0 + 600);

        // The loop deferring the same version later does not demote it.
        p.promise("0.1.15", Origin::Auto, T0 + 1200);
        assert_eq!(p.request().unwrap().origin, Origin::Button);

        // A different version is a different consent.
        p.promise("0.1.16", Origin::Auto, T0 + 1800);
        let r = p.request().unwrap();
        assert_eq!((r.version.as_str(), r.origin, r.requested_at), ("0.1.16", Origin::Auto, T0 + 1800));
    }

    #[test]
    fn a_failure_of_another_version_leaves_the_promise_alone() {
        let p = Pending::default();
        p.promise("0.1.15", Origin::Button, T0);
        assert!(!p.failed("0.1.16", "managed", T0 + 1));
        assert_eq!(p.request().unwrap().version, "0.1.15");
        assert!(p.withdrawn().is_none());
    }

    #[test]
    fn a_withdrawn_promise_says_why() {
        let p = Pending::default();
        p.promise("0.1.15", Origin::Button, T0);
        assert!(!p.failed("0.1.15", "offer_changed: decided 0.1.15, hub now offers 0.1.16", T0 + 1));
        assert!(p.request().is_none());
        let w = p.withdrawn().unwrap();
        assert_eq!((w.version.as_str(), w.reason.as_str()), ("0.1.15", "offer_changed: decided 0.1.15, hub now offers 0.1.16"));

        p.promise("0.1.16", Origin::Button, T0 + 2);
        for _ in 0..MAX_REQUEST_FAILURES {
            p.failed("0.1.16", "download_failed: x", T0 + 3);
        }
        assert!(p.request().is_none());
        assert_eq!(p.withdrawn().unwrap().reason, "failed", "a transient error is summarised, not quoted as final");
    }

    #[test]
    fn at_start_a_kept_promise_is_closed_and_one_that_did_not_take_counts_as_a_failure() {
        let mut r = req(Origin::Button);
        assert_eq!(reconcile_at_start(r.clone(), "0.1.15", T0), Err("installed"));
        assert_eq!(reconcile_at_start(r.clone(), "0.1.16", T0), Err("installed"));

        // Never handed over (the till was in use until the restart): kept as it was.
        assert_eq!(reconcile_at_start(r.clone(), "0.1.14", T0 + 5), Ok(r.clone()));

        // ⚠ Handed over, and still the old version: the installer failed after this process exited.
        r.handed_over = true;
        let kept = reconcile_at_start(r.clone(), "0.1.14", T0 + 5).unwrap();
        assert_eq!(kept.failures, 1);
        assert!(!kept.handed_over, "counted once, not again at every later start");
        assert_eq!(kept.last_error.as_deref(), Some("install_did_not_take"));

        // An installer that never takes stops being retried.
        let mut r = kept;
        for _ in 1..MAX_REQUEST_FAILURES - 1 {
            r.handed_over = true;
            r = reconcile_at_start(r, "0.1.14", T0 + 6).unwrap();
        }
        r.handed_over = true;
        assert_eq!(reconcile_at_start(r, "0.1.14", T0 + 7), Err("failed"));
    }

    #[test]
    fn a_promise_survives_a_restart_through_its_file() {
        let dir = std::env::temp_dir().join(format!("lgr-976-{}-{}", std::process::id(), now_unix()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("update-request.json");

        let p = Pending::default();
        assert_eq!(p.attach(file.clone()), None, "no file is no promise");
        p.promise("0.1.15", Origin::Button, T0);

        let after_restart = Pending::default();
        assert_eq!(after_restart.attach(file.clone()), p.request());

        // ⚠ A torn or foreign file is no promise: fail closed, never a surprise install.
        std::fs::write(&file, "{\"version\":").unwrap();
        assert_eq!(load_request(&file), None);

        p.set(None);
        assert!(!file.exists(), "a withdrawn promise leaves no file behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_log_says_who_asked() {
        assert_eq!(Origin::Button.log_prefix(), "update");
        assert_eq!(Origin::Auto.log_prefix(), "auto-update");
    }

    #[test]
    fn an_idle_till_updates_immediately() {
        assert_eq!(decide(TillState::Idle, 0), UpdateAction::Install);
    }

    #[test]
    fn a_busy_till_defers_until_the_limit() {
        for n in 0..MAX_DEFERRALS {
            assert_eq!(decide(TillState::Busy, n), UpdateAction::Defer, "at {n}");
        }
        assert_eq!(decide(TillState::Busy, MAX_DEFERRALS), UpdateAction::Install);
        assert_eq!(decide(TillState::Busy, MAX_DEFERRALS + 50), UpdateAction::Install);
    }

    #[test]
    fn mid_receipt_is_never_forced_through() {
        // ⚠ The rule that makes the force-through safe. However many deferrals have piled up, a
        // customer's receipt is not interrupted.
        for n in [0, MAX_DEFERRALS, MAX_DEFERRALS + 1000] {
            assert_eq!(decide(TillState::MidReceipt, n), UpdateAction::Defer, "at {n}");
        }
    }

    #[test]
    fn deferrals_count_per_candidate_not_per_machine() {
        let d = Deferrals::default();
        d.target("1.1.0");
        assert_eq!(d.record(), 1);
        assert_eq!(d.record(), 2);

        // The same candidate keeps its count across checks.
        d.target("1.1.0");
        assert_eq!(d.count(), 2, "re-checking the same version must not forgive deferrals");

        // ⚠ A DIFFERENT candidate starts over. Otherwise seven deferrals of last month's release
        // would force an unrelated one through on a till that had never been offered it.
        d.target("1.2.0");
        assert_eq!(d.count(), 0);
    }

    #[test]
    fn last_known_good_is_recorded_before_the_attempt() {
        // ⚠ The trap: written after a successful start, a crash loop has nothing to roll back to.
        let mut s = UpdateState::default();
        s.begin_attempt("1.0.0", "1.1.0");
        assert_eq!(s.last_known_good, "1.0.0");
        assert_eq!(s.attempting, "1.1.0");
    }

    #[test]
    fn a_crash_loop_rolls_back_after_three_failed_starts() {
        let mut s = UpdateState::default();
        s.begin_attempt("1.0.0", "1.1.0");
        assert_eq!(s.mark_failed_start(), None);
        assert_eq!(s.mark_failed_start(), None);
        assert_eq!(s.mark_failed_start(), Some("1.0.0".into()));
    }

    #[test]
    fn a_successful_start_clears_the_crash_counter() {
        let mut s = UpdateState::default();
        s.begin_attempt("1.0.0", "1.1.0");
        s.mark_failed_start();
        s.mark_started("1.1.0");
        assert_eq!(s.consecutive_failed_starts, 0);
        assert_eq!(s.last_known_good, "1.1.0", "the new version is now the good one");
        assert!(s.attempting.is_empty());
    }

    #[test]
    fn nothing_to_roll_back_to_is_not_a_rollback_to_nothing() {
        let mut s = UpdateState::default();
        for _ in 0..10 {
            assert_eq!(s.mark_failed_start(), None, "must not revert to an empty version");
        }
    }

    #[test]
    fn a_per_machine_install_never_self_installs() {
        // ⚠ Never elevate: a standard user cannot elevate msiexec, and the UAC prompt lands on a
        // till nobody will answer.
        assert!(!InstallKind::PerMachine.may_self_install());
        assert!(InstallKind::PerUser.may_self_install());
        assert_eq!(InstallKind::PerMachine.as_str(), "per_machine");
    }

    #[cfg(windows)]
    #[test]
    fn windows_install_kinds_are_told_apart_by_location() {
        assert_eq!(
            detect_install_kind(r"C:\Users\ana\AppData\Local\LGR Desktop\lgr-desktop.exe"),
            InstallKind::PerUser
        );
        assert_eq!(
            detect_install_kind(r"C:\Program Files\LGR Desktop\lgr-desktop.exe"),
            InstallKind::PerMachine
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_install_kinds_are_told_apart_by_location() {
        assert_eq!(detect_install_kind("/usr/bin/lgr-desktop"), InstallKind::PerMachine);
        assert_eq!(detect_install_kind("/Applications/LGR.app/Contents/MacOS/lgr"), InstallKind::PerMachine);
        assert_eq!(detect_install_kind("/home/ana/.local/bin/lgr-desktop"), InstallKind::PerUser);
    }
}
