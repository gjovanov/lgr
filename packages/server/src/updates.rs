//! When this master takes an update (FR-20.20, plan step P1-8c): the supervisor's half.
//!
//! The supervisor runs as the service account, and decides WHEN. The helper (SYSTEM/root) decides
//! WHAT: it fetches the offer itself, downloads and verifies the bundle, and switches. The supervisor
//! never names a file or a version the helper acts on: it wakes the helper, and answers its questions
//! (the gate, a node token, the egress the helper downloads through).
//!
//! - **The window:** `UPDATE_WINDOW` (`config/api.env`), by default 22:00–06:00 site time (the
//!   machine's own clock and zone).
//! - **Never under a till:** no POS session open, no fiscal command in flight, by the API's own
//!   account. An API that cannot say is a till that may be busy.
//! - **Not right after the network changed** (10 minutes): a DHCP renewal or a VPN coming up is a
//!   poor moment to download a few hundred megabytes.
//! - **Seven windows blocked by open sessions raise an alarm** (status and the health frame), and
//!   nothing is forced.
//! - `UPDATE_AUTO=off` turns automatic updates off; an update from a file (`update apply`) still
//!   works (the plan's kill switch).
//! - ⚠ The supervisor is not a trust boundary for the update itself: everything it says the helper
//!   checks again or does not need (the bytes' signatures, the version inside them).

use crate::install::{self, Root, UpdateState};
use crate::supervisor::{Registrar, Supervisor};

use crate::version;
use anyhow::{Context, Result};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The API's control socket and its secret (`Supervisor::api_control`).
type ApiControl = Option<(PathBuf, String)>;

/// How often the supervisor looks.
pub const TICK: Duration = Duration::from_secs(5 * 60);
/// How often it asks global for the offer.
const OFFER_EVERY: Duration = Duration::from_secs(60 * 60);
/// How long after a network change it waits.
const NETWORK_SETTLE: Duration = Duration::from_secs(10 * 60);
/// How often it wakes the helper for the same version: a helper that refuses (a signature, a
/// download) is not asked every five minutes.
const WAKE_EVERY: Duration = Duration::from_secs(60 * 60);
/// FR-20.20: windows blocked by open sessions before the alarm.
pub const ALARM_WINDOWS: usize = 7;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Settings {
    pub auto: bool,
    /// Minutes since local midnight: [start, end), wrapping midnight when end <= start.
    pub window: (u32, u32),
}

impl Default for Settings {
    fn default() -> Self {
        Self { auto: true, window: (22 * 60, 6 * 60) }
    }
}

fn hhmm(s: &str) -> Option<u32> {
    let (h, m) = s.trim().split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

impl Settings {
    pub fn from_operator(operator: &std::collections::BTreeMap<String, String>) -> Result<Self> {
        let auto = match operator.get("UPDATE_AUTO").map(|v| v.trim().to_ascii_lowercase()) {
            None => true,
            Some(v) if ["on", "true", "1", "yes", ""].contains(&v.as_str()) => true,
            Some(v) if ["off", "false", "0", "no"].contains(&v.as_str()) => false,
            Some(v) => anyhow::bail!("UPDATE_AUTO={v} is neither on nor off"),
        };
        let window = match operator.get("UPDATE_WINDOW").map(|v| v.trim()).filter(|v| !v.is_empty()) {
            None => Settings::default().window,
            Some(w) => {
                let (a, b) = w.split_once('-').with_context(|| format!("UPDATE_WINDOW={w} is not HH:MM-HH:MM"))?;
                let (a, b) = (hhmm(a), hhmm(b));
                match (a, b) {
                    (Some(a), Some(b)) if a != b => (a, b),
                    _ => anyhow::bail!("UPDATE_WINDOW={w} is not HH:MM-HH:MM with two different times"),
                }
            }
        };
        Ok(Self { auto, window })
    }
}

/// Is `minutes` (since local midnight) inside the window?
pub fn in_window(minutes: u32, (start, end): (u32, u32)) -> bool {
    if start < end {
        (start..end).contains(&minutes)
    } else {
        minutes >= start || minutes < end
    }
}

/// The day a window began on: the night of the 25th, after midnight, is still the 25th's window.
pub fn window_day(date: time::Date, minutes: u32, (start, end): (u32, u32)) -> Option<time::Date> {
    if !in_window(minutes, (start, end)) {
        return None;
    }
    if start > end && minutes < end {
        date.previous_day()
    } else {
        Some(date)
    }
}

/// The local date and the minutes since local midnight, by the machine's own clock and zone.
pub fn local_now() -> Option<(time::Date, u32)> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::GetLocalTime;
        // SAFETY: GetLocalTime fills the struct it is given.
        let st = unsafe {
            let mut st = std::mem::zeroed();
            GetLocalTime(&mut st);
            st
        };
        let date = time::Date::from_calendar_date(st.wYear as i32, time::Month::try_from(st.wMonth as u8).ok()?, st.wDay as u8).ok()?;
        Some((date, st.wHour as u32 * 60 + st.wMinute as u32))
    }
    #[cfg(unix)]
    {
        // SAFETY: localtime_r writes the struct it is given; `now` outlives the call.
        let tm = unsafe {
            let now = libc::time(std::ptr::null_mut());
            let mut tm: libc::tm = std::mem::zeroed();
            if libc::localtime_r(&now, &mut tm).is_null() {
                return None;
            }
            tm
        };
        let date = time::Date::from_calendar_date(tm.tm_year + 1900, time::Month::try_from((tm.tm_mon + 1) as u8).ok()?, tm.tm_mday as u8).ok()?;
        Some((date, tm.tm_hour as u32 * 60 + tm.tm_min as u32))
    }
}

/// Whether an update may be installed now, and if not why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    Open,
    /// `busy`: closed by a till (counts toward the alarm), not by the clock or the settings.
    Closed { reason: String, busy: bool },
}

impl Gate {
    fn closed(reason: impl Into<String>) -> Self {
        Gate::Closed { reason: reason.into(), busy: false }
    }
}

pub struct GateFacts {
    pub auto: bool,
    pub in_window: bool,
    pub network_changed_secs_ago: Option<u64>,
    pub pos_open: Option<u64>,
    pub fiscal_in_flight: Option<u64>,
}

pub fn gate(f: &GateFacts) -> Gate {
    if !f.auto {
        return Gate::closed("automatic updates are off (UPDATE_AUTO=off)");
    }
    if !f.in_window {
        return Gate::closed("outside the maintenance window");
    }
    if let Some(s) = f.network_changed_secs_ago.filter(|&s| s < NETWORK_SETTLE.as_secs()) {
        return Gate::closed(format!("the network changed {} minutes ago", s / 60));
    }
    match f.pos_open {
        None => return Gate::Closed { reason: "the API cannot say whether a till is open".into(), busy: true },
        Some(n) if n > 0 => return Gate::Closed { reason: format!("{n} POS session(s) open"), busy: true },
        _ => {}
    }
    match f.fiscal_in_flight {
        None => Gate::Closed { reason: "the API cannot say whether a fiscal command is in flight".into(), busy: true },
        Some(n) if n > 0 => Gate::Closed { reason: "a fiscal command is in flight".into(), busy: true },
        _ => Gate::Open,
    }
}

/// The windows an available version was kept from by open sessions (`state/update-deferrals.json`).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Deferrals {
    pub version: String,
    pub windows: Vec<String>,
}

impl Deferrals {
    /// Count `day`'s window against `version`. A new version starts from none: seven deferrals of
    /// last month's release never count against an unrelated one.
    pub fn record(&mut self, version: &str, day: time::Date) -> usize {
        if self.version != version {
            *self = Deferrals { version: version.to_string(), windows: vec![] };
        }
        let d = day.to_string();
        if !self.windows.contains(&d) {
            self.windows.push(d);
        }
        self.windows.len()
    }
}

/// The version the running home says it is (`HOME.json`), or the binary's.
pub fn running_version(paths: &crate::config::Paths) -> String {
    install::HomeManifest::read(&paths.home).map(|m| m.version).unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string())
}

pub struct Updates {
    pub registrar: Arc<Registrar>,
    pub settings: Settings,
    pub egress: (u16, String),
    pub running: String,
    pub root: Option<Root>,
    deferrals_file: PathBuf,
    network: Mutex<(Vec<std::net::IpAddr>, Option<Instant>)>,
    pub status: Arc<Mutex<serde_json::Value>>,
}

impl Updates {
    pub fn new(registrar: Arc<Registrar>, settings: Settings, egress: (u16, String), running: String, root: Option<Root>) -> Self {
        let deferrals_file = registrar.data.join("state").join("update-deferrals.json");
        Self { registrar, settings, egress, running, root, deferrals_file, network: Mutex::new((crate::certs::lan_addresses(), None)), status: Arc::new(Mutex::new(serde_json::Value::Null)) }
    }

    fn network_changed_secs_ago(&self) -> Option<u64> {
        let mut n = self.network.lock().unwrap_or_else(|p| p.into_inner());
        let now = crate::certs::lan_addresses();
        if now != n.0 {
            n.0 = now;
            n.1 = Some(Instant::now());
        }
        n.1.map(|t| t.elapsed().as_secs())
    }

    /// The gate as it is now: the clock, the settings, the network, and the API's tills.
    pub async fn gate_now(&self, api: ApiControl) -> (Gate, Option<time::Date>) {
        let local = local_now();
        let in_window = local.map(|(_, m)| in_window(m, self.settings.window)).unwrap_or(false);
        // The API's own account of its tills; none (not started, no answer in 2 s) is a busy till.
        let api: serde_json::Value = match api {
            Some((socket, secret)) => match crate::control::call(&socket, &secret, "GET", "/status", Duration::from_secs(2)).await {
                Ok((200, body)) => serde_json::from_str(&body).unwrap_or_default(),
                _ => serde_json::Value::Null,
            },
            None => serde_json::Value::Null,
        };
        let facts = GateFacts {
            auto: self.settings.auto,
            in_window,
            network_changed_secs_ago: self.network_changed_secs_ago(),
            pos_open: api["posOpen"].as_u64(),
            fiscal_in_flight: api["fiscalInFlight"].as_u64(),
        };
        (gate(&facts), local.and_then(|(d, m)| window_day(d, m, self.settings.window)))
    }

    /// What the helper asks before it downloads and again before it switches: the gate, where
    /// global is, a node token, and the egress to reach it through.
    pub async fn context(&self, api: ApiControl) -> crate::ipc::Response {
        let Some(reg) = crate::register::current(&self.registrar.data) else {
            return crate::ipc::Response::error("this server is not registered with lgrai.app");
        };
        let (gate, _) = self.gate_now(api).await;
        let token = match crate::node_key::NodeKey::load_or_create(&self.registrar.data) {
            Ok(key) => crate::register::fetch_token(&reg.server, &reg.node_id, &key, &self.registrar.client).await,
            Err(e) => Err(e),
        };
        let token = match token {
            Ok(t) => t,
            Err(e) => return crate::ipc::Response::error(format!("no node token: {e:#}")),
        };
        crate::ipc::Response::status(serde_json::json!({
            "server": reg.server,
            "token": token,
            "egress": { "port": self.egress.0, "secret": self.egress.1 },
            "gate": match &gate { Gate::Open => serde_json::json!({ "open": true }), Gate::Closed { reason, .. } => serde_json::json!({ "open": false, "reason": reason }) },
        }))
    }

    fn set(&self, v: serde_json::Value) {
        *self.status.lock().unwrap_or_else(|p| p.into_inner()) = v;
    }

    fn failed(&self, v: &str) -> bool {
        self.root.as_ref().and_then(|r| UpdateState::load(r).ok()).is_some_and(|s| s.failed.iter().any(|f| f.version == v))
    }

    /// What global offers this machine, if it is newer than what runs: `(version, offer)`.
    async fn candidate(&self) -> Result<Option<String>> {
        let Some(reg) = crate::register::current(&self.registrar.data) else { return Ok(None) };
        let key = crate::node_key::NodeKey::load_or_create(&self.registrar.data)?;
        let token = crate::register::fetch_token(&reg.server, &reg.node_id, &key, &self.registrar.client).await?;
        let (status, offer) = self.registrar.client.json("GET", &format!("{}/api/node/v1/server-release", reg.server), Some(&token), None).await?;
        if status == 204 {
            return Ok(None);
        }
        if status != 200 {
            anyhow::bail!("global answered {status} for the server release");
        }
        let v = offer["version"].as_str().unwrap_or_default().to_string();
        if offer["targets"][install::this_target()].is_null() || !version::is_upgrade(&self.running, &v) || self.failed(&v) {
            return Ok(None);
        }
        Ok(Some(v))
    }

    /// For as long as the supervisor runs.
    pub async fn run(self: Arc<Self>, sup: Arc<Supervisor>) {
        if self.root.is_none() {
            self.set(serde_json::json!({ "state": "not-versioned", "note": "this home was not installed by a package: it updates with its package" }));
            return;
        }
        let mut deferrals: Deferrals = std::fs::read_to_string(&self.deferrals_file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let (mut last_offer, mut candidate): (Option<Instant>, Option<String>) = (None, None);
        let mut last_wake: Option<(String, Instant)> = None;
        // A minute after start: the API first, and a crash loop never asks global on every start.
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            if self.settings.auto && last_offer.is_none_or(|t| t.elapsed() >= OFFER_EVERY) {
                match self.candidate().await {
                    Ok(c) => {
                        candidate = c;
                        last_offer = Some(Instant::now());
                    }
                    Err(e) => tracing::warn!(error = %format!("{e:#}"), "the server release could not be checked"),
                }
            }
            let (gate, day) = self.gate_now(sup.api_control()).await;
            let now = time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default();
            match (&candidate, &gate) {
                (None, _) => self.set(serde_json::json!({ "state": "up-to-date", "running": self.running, "auto": self.settings.auto, "checkedAt": now })),
                (Some(v), Gate::Open) => {
                    let due = last_wake.as_ref().is_none_or(|(w, at)| w != v || at.elapsed() >= WAKE_EVERY);
                    if due {
                        tracing::info!(version = %v, "an update is available and nothing is in its way: waking the update helper");
                        match crate::pointer::wake_helper(&self.registrar.data) {
                            Ok(()) => last_wake = Some((v.clone(), Instant::now())),
                            Err(e) => tracing::error!(error = %format!("{e:#}"), "the update helper could not be woken"),
                        }
                    }
                    self.set(serde_json::json!({ "state": "installing", "running": self.running, "available": v, "checkedAt": now }));
                }
                (Some(v), Gate::Closed { reason, busy }) => {
                    let mut blocked = 0;
                    if *busy {
                        if let Some(day) = day {
                            blocked = deferrals.record(v, day);
                            if let Some(dir) = self.deferrals_file.parent() {
                                let _ = std::fs::create_dir_all(dir);
                            }
                            let _ = std::fs::write(&self.deferrals_file, serde_json::to_string(&deferrals).unwrap_or_default());
                            if blocked >= ALARM_WINDOWS {
                                tracing::error!(version = %v, windows = blocked, "open sessions have kept this update from installing through {blocked} maintenance windows: close the tills at night");
                            }
                        }
                    }
                    self.set(serde_json::json!({
                        "state": "deferred",
                        "running": self.running,
                        "available": v,
                        "reason": reason,
                        "blockedWindows": if deferrals.version == *v { deferrals.windows.len() } else { blocked },
                        "alarm": deferrals.version == *v && deferrals.windows.len() >= ALARM_WINDOWS,
                        "checkedAt": now,
                    }));
                }
            }
            tokio::time::sleep(TICK).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(y: i32, m: u8, d: u8) -> time::Date {
        time::Date::from_calendar_date(y, time::Month::try_from(m).unwrap(), d).unwrap()
    }

    #[test]
    fn the_window_wraps_midnight_and_belongs_to_the_night_it_began() {
        let w = Settings::default().window;
        assert!(in_window(22 * 60, w) && in_window(23 * 60 + 59, w) && in_window(0, w) && in_window(5 * 60 + 59, w));
        assert!(!in_window(6 * 60, w) && !in_window(12 * 60, w) && !in_window(21 * 60 + 59, w));
        assert_eq!(window_day(date(2026, 10, 26), 3 * 60, w), Some(date(2026, 10, 25)), "after midnight is the 25th's night");
        assert_eq!(window_day(date(2026, 10, 25), 23 * 60, w), Some(date(2026, 10, 25)));
        assert_eq!(window_day(date(2026, 10, 25), 12 * 60, w), None);
        // A window that does not wrap.
        assert!(in_window(2 * 60, (60, 300)) && !in_window(300, (60, 300)));
        assert_eq!(window_day(date(2026, 1, 1), 2 * 60, (60, 300)), Some(date(2026, 1, 1)));
    }

    #[test]
    fn settings_read_the_operators_and_refuse_nonsense() {
        let op = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(Settings::from_operator(&op(&[])).unwrap(), Settings::default());
        assert_eq!(Settings::from_operator(&op(&[("UPDATE_WINDOW", "01:30-04:00"), ("UPDATE_AUTO", "off")])).unwrap(), Settings { auto: false, window: (90, 240) });
        for bad in ["22:00", "25:00-06:00", "22:00-22:00", "night"] {
            assert!(Settings::from_operator(&op(&[("UPDATE_WINDOW", bad)])).is_err(), "{bad}");
        }
        assert!(Settings::from_operator(&op(&[("UPDATE_AUTO", "maybe")])).is_err());
    }

    fn facts() -> GateFacts {
        GateFacts { auto: true, in_window: true, network_changed_secs_ago: None, pos_open: Some(0), fiscal_in_flight: Some(0) }
    }

    #[test]
    fn the_gate_opens_only_at_night_with_every_till_closed() {
        assert_eq!(gate(&facts()), Gate::Open);
        assert!(matches!(gate(&GateFacts { in_window: false, ..facts() }), Gate::Closed { busy: false, .. }));
        assert!(matches!(gate(&GateFacts { auto: false, ..facts() }), Gate::Closed { busy: false, .. }));
        assert!(matches!(gate(&GateFacts { network_changed_secs_ago: Some(120), ..facts() }), Gate::Closed { busy: false, .. }));
        assert_eq!(gate(&GateFacts { network_changed_secs_ago: Some(3600), ..facts() }), Gate::Open);
        // A till, a receipt, or an API that cannot say: busy, and those count toward the alarm.
        for f in [GateFacts { pos_open: Some(1), ..facts() }, GateFacts { pos_open: None, ..facts() }, GateFacts { fiscal_in_flight: Some(1), ..facts() }, GateFacts { fiscal_in_flight: None, ..facts() }] {
            assert!(matches!(gate(&f), Gate::Closed { busy: true, .. }));
        }
    }

    #[test]
    fn deferrals_count_windows_per_version() {
        let mut d = Deferrals::default();
        assert_eq!(d.record("0.2.0", date(2026, 10, 25)), 1);
        assert_eq!(d.record("0.2.0", date(2026, 10, 25)), 1, "the same night counts once");
        for (i, day) in (26..=31).enumerate() {
            assert_eq!(d.record("0.2.0", date(2026, 10, day)), i + 2);
        }
        assert_eq!(d.windows.len(), ALARM_WINDOWS);
        // Another version starts from none.
        assert_eq!(d.record("0.2.1", date(2026, 11, 1)), 1);
    }

    #[test]
    fn the_local_clock_reads() {
        let (_, minutes) = local_now().unwrap();
        assert!(minutes < 24 * 60);
    }
}
