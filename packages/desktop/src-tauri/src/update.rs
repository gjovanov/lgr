//! C13 — the updater's rules (FR-14.28, FR-14.29).
//!
//! ⚠ This module is the DECISION layer: which version is newer, whether now is a safe moment,
//! and what to roll back to. It deliberately performs no download and runs no installer — those
//! belong to Tauri's updater plugin and are gated on signatures pinned in the binary (C05's
//! minisign key and roomler's platform identity), which is material this chunk does not hold.
//!
//! ⚠ **An updater that accepts an artifact it should not is worse than no updater — it is remote
//! code execution on every machine in the fleet.** So every rule here fails closed, and the
//! tests are written as the attack rather than as the happy path.
//!
//! ⚠ The version comparison mirrors `services/src/biz/desktop/version.ts` exactly. The hub
//! decides whether a desktop is below `DESKTOP_MIN_VERSION`; the desktop decides whether a
//! manifest is an upgrade. If the two disagree, a fleet either updates in a loop or never
//! updates at all.

use std::sync::atomic::{AtomicU32, Ordering};

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

/// After a deferral, look again once the busy window could have closed — not in four hours. A
/// deferral that waited a full interval would take 28 h to reach `MAX_DEFERRALS`.
pub const RETRY_AFTER_DEFER_SECS: u64 = BUSY_WINDOW_SECS as u64;
// A retry slower than the normal period would make deferring pointless — checked at compile time.
const _: () = assert!(RETRY_AFTER_DEFER_SECS < CHECK_INTERVAL_SECS);

/// Is an automatic check due?
///
/// `secs_since_start` is the process's age; `secs_since_last` is `None` until the background loop
/// has checked once. `deferred` is whether that last check ended in a deferral.
///
/// ⚠ `enabled` is read from the settings file on EVERY tick, not captured when the loop starts:
/// switching automatic updates off has to stop the next attempt, not the next restart's.
pub fn auto_check_due(enabled: bool, secs_since_start: u64, secs_since_last: Option<u64>, deferred: bool) -> bool {
    if !enabled {
        return false;
    }
    match secs_since_last {
        None => secs_since_start >= START_COOLDOWN_SECS,
        Some(s) if deferred => s >= RETRY_AFTER_DEFER_SECS,
        Some(s) => s >= CHECK_INTERVAL_SECS,
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
    // macOS `/Applications` and Linux `/usr` are both machine-wide.
    if p.starts_with("/applications/") || p.starts_with("/usr/") || p.starts_with("/opt/") {
        InstallKind::PerMachine
    } else {
        InstallKind::PerUser
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

/// Hand the artifact to the installer — the step this chunk deliberately stops short of.
///
/// ⚠ **Not implemented, and refusing is the correct behaviour until C05's key material exists.**
/// Installing requires verifying TWO signatures, both against anchors **pinned in this binary**:
/// Tauri's updater minisign key, and roomler's platform identity (Authenticode subject
/// `G ROX LTD`, Team ID `4TG7586MY5`, or the release GPG fingerprint). Neither is in the tree.
///
/// Wiring an updater that downloads and runs an artifact it cannot verify would be remote code
/// execution on every machine in the fleet — precisely what C13's opening paragraph warns about
/// — so this returns an error rather than a plausible-looking stub.
fn hand_to_installer(_version: &str) -> Result<(), String> {
    Err("updater_not_configured".into())
}

/// The install decision and, if it is time, the attempt (FR-14.28).
pub fn try_install(
    app: &tauri::AppHandle,
    running: &str,
    candidate: &str,
    till: TillState,
    deferrals: &Deferrals,
) -> Result<UpdateAction, String> {
    if !is_upgrade(running, candidate) {
        // Covers downgrades, equality and unparseable tags in one place.
        return Err("not_an_upgrade".into());
    }

    // A different candidate starts its own deferral count.
    deferrals.target(candidate);

    let kind = detect_install_kind(
        &std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    );
    if !kind.may_self_install() {
        // ⚠ Managed. Check, notify, report — never elevate (decided 2026-09-29).
        return Err("managed".into());
    }

    match decide(till, deferrals.count()) {
        UpdateAction::Defer => {
            deferrals.record();
            Ok(UpdateAction::Defer)
        }
        UpdateAction::Install => {
            // ⚠ BEFORE the attempt. Written afterwards, a crash loop has nothing to roll back to.
            let mut state = load_state(app);
            state.begin_attempt(running, candidate);
            save_state(app, &state);

            hand_to_installer(candidate)?;
            Ok(UpdateAction::Install)
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
            for deferred in [false, true] {
                assert!(!auto_check_due(false, u64::MAX, last, deferred), "{last:?}/{deferred}");
            }
        }
    }

    #[test]
    fn the_first_automatic_check_waits_out_the_start_cooldown() {
        assert!(!auto_check_due(true, 0, None, false));
        assert!(!auto_check_due(true, START_COOLDOWN_SECS - 1, None, false));
        assert!(auto_check_due(true, START_COOLDOWN_SECS, None, false));
    }

    #[test]
    fn later_checks_run_every_interval() {
        assert!(!auto_check_due(true, u64::MAX, Some(CHECK_INTERVAL_SECS - 1), false));
        assert!(auto_check_due(true, u64::MAX, Some(CHECK_INTERVAL_SECS), false));
    }

    #[test]
    fn a_deferral_is_retried_after_the_busy_window_not_the_interval() {
        // Otherwise reaching MAX_DEFERRALS on a busy till takes over a day.
        assert!(!auto_check_due(true, u64::MAX, Some(RETRY_AFTER_DEFER_SECS - 1), true));
        assert!(auto_check_due(true, u64::MAX, Some(RETRY_AFTER_DEFER_SECS), true));
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
