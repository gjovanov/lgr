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
//! - **A SUPTO version waits for its declaration** (FR-20.50, P3-8c, `supto.rs`): the helper is not
//!   woken for it, and the status says which version waits (`suptoWaiting`, an alarm on lgrai.app).
//! - ⚠ The supervisor is not a trust boundary for the update itself: everything it says the helper
//!   checks again or does not need (the bytes' signatures, the version inside them).
//! - **An attempt that failed says so** (#952): the helper records its last attempt
//!   (`update/last-attempt.json`), and while it failed for the version offered, and the helper has
//!   not been woken for it since, the state is `failing`, with the error and the next try. Never
//!   `installing`, which holds the night's restart for libraries (`night_restart.rs`).

use crate::install::{self, LastAttempt, Root, UpdateState};
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
        Ok(Self { auto, window: window_from_operator(operator)? })
    }
}

/// `UPDATE_WINDOW` (`HH:MM-HH:MM`, the machine's local time), 22:00–06:00 when unset: when an update
/// installs, and when the server restarts itself for a library a security update replaced (#370).
pub fn window_from_operator(operator: &std::collections::BTreeMap<String, String>) -> Result<(u32, u32)> {
    match operator.get("UPDATE_WINDOW").map(|v| v.trim()).filter(|v| !v.is_empty()) {
        None => Ok(Settings::default().window),
        Some(w) => {
            let (a, b) = w.split_once('-').with_context(|| format!("UPDATE_WINDOW={w} is not HH:MM-HH:MM"))?;
            match (hhmm(a), hhmm(b)) {
                (Some(a), Some(b)) if a != b => Ok((a, b)),
                _ => anyhow::bail!("UPDATE_WINDOW={w} is not HH:MM-HH:MM with two different times"),
            }
        }
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

/// An update global offers: its version, and the SUPTO version it waits for, if it does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub version: String,
    pub supto_waiting: Option<String>,
}

/// #952: the helper's last attempt, when it failed for `candidate` and the helper has not been woken
/// for it since. `woken_at` (Unix seconds): when this supervisor last woke the helper for this
/// candidate. An attempt that failed before the offer was read names no version: it counts only
/// once this supervisor woke the helper for this candidate before it. A newer offered version, or a
/// later attempt that went well, is no failure.
pub fn failure_for<'a>(candidate: &str, last: Option<&'a LastAttempt>, woken_at: Option<i64>) -> Option<&'a LastAttempt> {
    let a = last.filter(|a| a.error.is_some())?;
    let ours = a.version == candidate || (a.version.is_empty() && woken_at.is_some());
    // Woken again since: a retry runs (or is about to), and it installs until it says otherwise.
    let since_wake = woken_at.is_none_or(|w| a.at >= w);
    (ours && since_wake).then_some(a)
}

/// #952: when the helper is next woken for a candidate whose last attempt failed (Unix seconds), as
/// far as the supervisor can say: in an open window, an hour after the last wake; outside it, when it
/// next opens. A window kept by tills or a network change says why instead, and automatic updates
/// that are off never try.
pub fn next_try(gate: &Gate, settings: Settings, local_minutes: Option<u32>, now: i64, woken_at: Option<i64>) -> Option<i64> {
    match gate {
        Gate::Open => Some(woken_at.map_or(now, |w| now.max(w + WAKE_EVERY.as_secs() as i64))),
        Gate::Closed { .. } if !settings.auto => None,
        Gate::Closed { .. } => {
            let minutes = local_minutes?;
            if in_window(minutes, settings.window) {
                return None;
            }
            let until = (settings.window.0 + 24 * 60 - minutes) % (24 * 60);
            Some(now - now.rem_euclid(60) + i64::from(until) * 60)
        }
    }
}

/// #370, #952: whether the update status holds the night's restart for libraries. Only an update
/// that installs tonight does: its own restart runs the new libraries. A failing one never.
pub fn holds_night_restart(update: &serde_json::Value) -> bool {
    update["state"] == "installing"
}

fn rfc3339(secs: i64) -> Option<String> {
    time::OffsetDateTime::from_unix_timestamp(secs).ok()?.format(&time::format_description::well_known::Rfc3339).ok()
}

/// What one look found, for the status.
pub struct Look<'a> {
    pub running: &'a str,
    pub supto: &'a str,
    pub auto: bool,
    pub candidate: Option<&'a Candidate>,
    pub gate: &'a Gate,
    pub deferrals: &'a Deferrals,
    /// The helper's last attempt, when it failed for this candidate (`failure_for`).
    pub failure: Option<&'a LastAttempt>,
    /// Unix seconds (`next_try`).
    pub next_try: Option<i64>,
    pub checked_at: &'a str,
}

/// The update status (`update` in the supervisor's status, and the health frame global keeps).
pub fn status_of(l: &Look) -> serde_json::Value {
    let Some(c) = l.candidate else {
        return serde_json::json!({ "state": "up-to-date", "running": l.running, "supto": l.supto, "auto": l.auto, "checkedAt": l.checked_at });
    };
    let v = &c.version;
    // FR-20.20: the windows open tills kept it out, counted whatever else is said.
    let blocked = if l.deferrals.version == *v { l.deferrals.windows.len() } else { 0 };
    let reason = match l.gate {
        Gate::Open => None,
        Gate::Closed { reason, .. } => Some(reason.as_str()),
    };
    // FR-20.50: not before its declaration, whatever the gate says; nothing is counted.
    if let Some(waiting) = &c.supto_waiting {
        return serde_json::json!({
            "state": "deferred",
            "running": l.running,
            "supto": l.supto,
            "available": v,
            "reason": format!("SUPTO version {waiting} waits for its declaration to НАП"),
            "suptoWaiting": waiting,
            "blockedWindows": 0,
            "alarm": false,
            "checkedAt": l.checked_at,
        });
    }
    // #952: the last attempt failed for it. `reason` is why it is not tried now, when it is not.
    if let Some(f) = l.failure {
        return serde_json::json!({
            "state": "failing",
            "running": l.running,
            "supto": l.supto,
            "available": v,
            "error": f.error,
            "failedAt": rfc3339(f.at),
            "nextTryAt": l.next_try.and_then(rfc3339),
            "reason": reason,
            "blockedWindows": blocked,
            "alarm": blocked >= ALARM_WINDOWS,
            "checkedAt": l.checked_at,
        });
    }
    match reason {
        None => serde_json::json!({ "state": "installing", "running": l.running, "supto": l.supto, "available": v, "checkedAt": l.checked_at }),
        Some(reason) => serde_json::json!({
            "state": "deferred",
            "running": l.running,
            "supto": l.supto,
            "available": v,
            "reason": reason,
            "blockedWindows": blocked,
            "alarm": blocked >= ALARM_WINDOWS,
            "checkedAt": l.checked_at,
        }),
    }
}

/// FR-20.12: why nothing on this machine installs an update, when nothing does.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
enum Elsewhere {
    /// The image this server runs from (`LGR_SERVER_IMAGE`, which the Dockerfile sets): it is
    /// updated by its tag.
    Image(String),
    /// A Linux that systemd does not run: there is no update helper to wake.
    NoSystemd,
}

impl Elsewhere {
    fn here() -> Option<Self> {
        #[cfg(target_os = "linux")]
        if !crate::pointer::has_systemd() {
            return Some(match std::env::var("LGR_SERVER_IMAGE").ok().filter(|i| !i.is_empty()) {
                Some(image) => Elsewhere::Image(image),
                None => Elsewhere::NoSystemd,
            });
        }
        None
    }

    /// The update status then: what runs, what global offers, and how it is taken.
    fn status(&self, running: &str, supto: &str, auto: bool, available: Option<&str>, checked_at: &str) -> serde_json::Value {
        let (state, reason) = match (self, available) {
            (Elsewhere::Image(image), Some(v)) => ("image", Some(format!("pull {image}:{v} and start the container from it"))),
            (Elsewhere::Image(_), None) => ("image", None),
            (Elsewhere::NoSystemd, _) => ("manual", Some("no systemd runs this machine, so nothing here installs updates".to_string())),
        };
        serde_json::json!({ "state": state, "running": running, "supto": supto, "auto": auto, "available": available, "reason": reason, "checkedAt": checked_at })
    }
}

pub struct Updates {
    pub registrar: Arc<Registrar>,
    pub settings: Settings,
    pub egress: (u16, String),
    pub running: String,
    /// FR-20.50: the SUPTO version that runs (this build's).
    pub supto: String,
    pub root: Option<Root>,
    deferrals_file: PathBuf,
    network: Mutex<(Vec<std::net::IpAddr>, Option<Instant>)>,
    pub status: Arc<Mutex<serde_json::Value>>,
}

impl Updates {
    pub fn new(registrar: Arc<Registrar>, settings: Settings, egress: (u16, String), running: String, root: Option<Root>) -> Self {
        let deferrals_file = registrar.data.join("state").join("update-deferrals.json");
        Self { registrar, settings, egress, running, supto: crate::supto::this_build(), root, deferrals_file, network: Mutex::new((crate::certs::lan_addresses(), None)), status: Arc::new(Mutex::new(serde_json::Value::Null)) }
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

    /// What global offers this machine, if it is newer than what runs: its version, and the SUPTO
    /// version it waits for, if it does.
    async fn candidate(&self) -> Result<Option<Candidate>> {
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
        let supto_waiting = crate::supto::waits(&offer, Some(&self.supto));
        Ok(Some(Candidate { version: v, supto_waiting }))
    }

    /// For as long as the supervisor runs.
    pub async fn run(self: Arc<Self>, sup: Arc<Supervisor>) {
        if self.root.is_none() {
            self.set(serde_json::json!({ "state": "not-versioned", "note": "this home was not installed by a package: it updates with its package" }));
            return;
        }
        let elsewhere = Elsewhere::here();
        let mut deferrals: Deferrals = std::fs::read_to_string(&self.deferrals_file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let (mut last_offer, mut candidate): (Option<Instant>, Option<Candidate>) = (None, None);
        // The version, when (to space the wakes), and when by the wall clock (to compare with the
        // helper's last attempt, #952).
        let mut last_wake: Option<(String, Instant, i64)> = None;
        // The failed attempt last logged: once each, not every five minutes.
        let mut last_failure_said: Option<(String, i64)> = None;
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
            let now = time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default();
            // FR-20.12: nothing here installs (an image, updated by its tag): say what is offered, and
            // never wake a helper that is not there, nor count windows it could not have used.
            if let Some(elsewhere) = &elsewhere {
                self.set(elsewhere.status(&self.running, &self.supto, self.settings.auto, candidate.as_ref().map(|c| c.version.as_str()), &now));
                tokio::time::sleep(TICK).await;
                continue;
            }
            let (gate, day) = self.gate_now(sup.api_control()).await;
            match (&candidate, &gate) {
                // FR-20.50: not before its declaration, whatever the gate says; nothing is counted.
                (None, _) | (Some(Candidate { supto_waiting: Some(_), .. }), _) => {}
                (Some(Candidate { version: v, .. }), Gate::Open) => {
                    let due = last_wake.as_ref().is_none_or(|(w, at, _)| w != v || at.elapsed() >= WAKE_EVERY);
                    if due {
                        tracing::info!(version = %v, "an update is available and nothing is in its way: waking the update helper");
                        match crate::pointer::wake_helper(&self.registrar.data) {
                            Ok(()) => last_wake = Some((v.clone(), Instant::now(), install::now_secs())),
                            Err(e) => tracing::error!(error = %format!("{e:#}"), "the update helper could not be woken"),
                        }
                    }
                }
                (Some(Candidate { version: v, .. }), Gate::Closed { busy: true, .. }) => {
                    if let Some(day) = day {
                        let blocked = deferrals.record(v, day);
                        if let Some(dir) = self.deferrals_file.parent() {
                            let _ = std::fs::create_dir_all(dir);
                        }
                        let _ = std::fs::write(&self.deferrals_file, serde_json::to_string(&deferrals).unwrap_or_default());
                        if blocked >= ALARM_WINDOWS {
                            tracing::error!(version = %v, windows = blocked, "open sessions have kept this update from installing through {blocked} maintenance windows: close the tills at night");
                        }
                    }
                }
                (Some(_), Gate::Closed { .. }) => {}
            }
            // #952: what the helper made of its last attempt, for this candidate.
            let last = self.root.as_ref().and_then(LastAttempt::load);
            let woken_at = |v: &str| last_wake.as_ref().filter(|(w, ..)| w == v).map(|(.., at)| *at);
            let failure = candidate.as_ref().and_then(|c| failure_for(&c.version, last.as_ref(), woken_at(&c.version)));
            if let (Some(c), Some(f)) = (&candidate, failure) {
                if last_failure_said.as_ref() != Some(&(c.version.clone(), f.at)) {
                    tracing::warn!(version = %c.version, error = %f.error.as_deref().unwrap_or_default(), "the update helper's last attempt at this version failed: it is tried again later");
                    last_failure_said = Some((c.version.clone(), f.at));
                }
            }
            let next = match (&candidate, failure) {
                (Some(c), Some(_)) => next_try(&gate, self.settings, local_now().map(|(_, m)| m), install::now_secs(), woken_at(&c.version)),
                _ => None,
            };
            self.set(status_of(&Look {
                running: &self.running,
                supto: &self.supto,
                auto: self.settings.auto,
                candidate: candidate.as_ref(),
                gate: &gate,
                deferrals: &deferrals,
                failure,
                next_try: next,
                checked_at: &now,
            }));
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

    fn candidate(v: &str) -> Candidate {
        Candidate { version: v.into(), supto_waiting: None }
    }

    fn look<'a>(c: Option<&'a Candidate>, gate: &'a Gate, deferrals: &'a Deferrals, failure: Option<&'a LastAttempt>, next_try: Option<i64>) -> Look<'a> {
        Look { running: "0.1.912", supto: "1", auto: true, candidate: c, gate, deferrals, failure, next_try, checked_at: "t" }
    }

    /// #952: `failing` only for the candidate, only while nothing was tried since, and never once an
    /// attempt went well or a newer version is offered.
    #[test]
    fn a_failed_attempt_is_failing_only_for_its_candidate_until_something_is_tried_again() {
        let failed = LastAttempt { version: "0.1.913".into(), at: 1_000, error: Some("global answered 401 Unauthorized".into()) };
        // No attempt yet: nothing fails.
        assert_eq!(failure_for("0.1.913", None, None), None);
        // Failed for this candidate, before any wake of this supervisor, or after its last one.
        assert_eq!(failure_for("0.1.913", Some(&failed), None), Some(&failed));
        assert_eq!(failure_for("0.1.913", Some(&failed), Some(900)), Some(&failed));
        assert_eq!(failure_for("0.1.913", Some(&failed), Some(1_000)), Some(&failed), "the same second is after the wake");
        // Woken again since: a retry is running, and that installs.
        assert_eq!(failure_for("0.1.913", Some(&failed), Some(1_001)), None);
        // A newer version offered: its own attempt, not the old one's error.
        assert_eq!(failure_for("0.1.914", Some(&failed), None), None);
        // A later attempt that went well.
        assert_eq!(failure_for("0.1.913", Some(&LastAttempt { error: None, ..failed.clone() }), None), None);
        // Before the offer was read (no version): only once this supervisor woke the helper for it.
        let unnamed = LastAttempt { version: String::new(), ..failed.clone() };
        assert_eq!(failure_for("0.1.913", Some(&unnamed), None), None);
        assert_eq!(failure_for("0.1.913", Some(&unnamed), Some(900)), Some(&unnamed));
    }

    #[test]
    fn the_state_says_installing_failing_or_deferred() {
        let (c, d) = (candidate("0.1.913"), Deferrals::default());
        let failed = LastAttempt { version: "0.1.913".into(), at: 1_764_100_000, error: Some("the bundle's sha256 is not the offer's".into()) };
        // No candidate.
        assert_eq!(status_of(&look(None, &Gate::Open, &d, None, None))["state"], "up-to-date");
        // No attempt has failed: installing in an open window.
        let s = status_of(&look(Some(&c), &Gate::Open, &d, None, None));
        assert_eq!((s["state"].as_str(), s["available"].as_str()), (Some("installing"), Some("0.1.913")));
        assert!(!holds_night_restart(&serde_json::json!({ "state": "failing" })));
        assert!(holds_night_restart(&s), "a real install holds the night restart");
        // Failed for it: failing, with the error, when, and the next try.
        let s = status_of(&look(Some(&c), &Gate::Open, &d, Some(&failed), Some(1_764_103_600)));
        assert_eq!(s["state"], "failing");
        assert_eq!(s["error"], "the bundle's sha256 is not the offer's");
        assert_eq!(s["failedAt"], "2025-11-25T19:46:40Z");
        assert_eq!(s["nextTryAt"], "2025-11-25T20:46:40Z");
        assert!(s["reason"].is_null(), "{s}");
        assert!(!holds_night_restart(&s), "a failing update never holds the night restart");
        // Outside the window it still says it is failing, and why it waits; the tills' count stays.
        let closed = Gate::Closed { reason: "outside the maintenance window".into(), busy: false };
        let seven = Deferrals { version: "0.1.913".into(), windows: (1..=7).map(|d| format!("2026-11-{d:02}")).collect() };
        let s = status_of(&look(Some(&c), &closed, &seven, Some(&failed), None));
        assert_eq!((s["state"].as_str(), s["reason"].as_str()), (Some("failing"), Some("outside the maintenance window")));
        assert_eq!((s["blockedWindows"].as_u64(), s["alarm"].as_bool()), (Some(7), Some(true)));
        assert!(s["nextTryAt"].is_null());
        // Without a failure a closed gate is deferred, as before.
        let s = status_of(&look(Some(&c), &closed, &d, None, None));
        assert_eq!((s["state"].as_str(), s["blockedWindows"].as_u64(), s["alarm"].as_bool()), (Some("deferred"), Some(0), Some(false)));
        // A SUPTO version waiting for its declaration says that first.
        let waiting = Candidate { version: "0.1.913".into(), supto_waiting: Some("2".into()) };
        let s = status_of(&look(Some(&waiting), &Gate::Open, &d, Some(&failed), None));
        assert_eq!((s["state"].as_str(), s["suptoWaiting"].as_str()), (Some("deferred"), Some("2")));
    }

    #[test]
    fn the_next_try_is_the_next_wake_or_the_next_window() {
        let s = Settings::default();
        let closed = |busy| Gate::Closed { reason: "x".into(), busy };
        // Open: an hour after the last wake, or now when none was made (it is made this look).
        assert_eq!(next_try(&Gate::Open, s, Some(23 * 60), 10_000, Some(9_000)), Some(9_000 + 3600));
        assert_eq!(next_try(&Gate::Open, s, Some(23 * 60), 20_000, Some(9_000)), Some(20_000));
        assert_eq!(next_try(&Gate::Open, s, Some(23 * 60), 10_000, None), Some(10_000));
        // Outside the window: when it opens next (21:30 → 22:00, 06:00 → 22:00), at the minute.
        assert_eq!(next_try(&closed(false), s, Some(21 * 60 + 30), 3_600 + 17, None), Some(3_600 + 30 * 60));
        assert_eq!(next_try(&closed(false), s, Some(6 * 60), 0, None), Some(16 * 3600));
        // Kept by tills inside the window, or automatic updates off: no time to give.
        assert_eq!(next_try(&closed(true), s, Some(23 * 60), 0, None), None);
        assert_eq!(next_try(&closed(false), Settings { auto: false, ..s }, Some(12 * 60), 0, None), None);
    }

    /// FR-20.12: an image is updated by its tag. Its status says what is offered and how to take it,
    /// and never "installing", which nothing in a container would ever finish.
    #[test]
    fn an_image_says_what_is_offered_and_installs_nothing() {
        let image = Elsewhere::Image("ghcr.io/gjovanov/lgr-server".into());
        let s = image.status("0.1.5", "1", true, Some("0.1.6"), "t");
        assert_eq!(s["state"], "image");
        assert_eq!(s["available"], "0.1.6");
        assert_eq!(s["reason"], "pull ghcr.io/gjovanov/lgr-server:0.1.6 and start the container from it");
        let s = image.status("0.1.5", "1", true, None, "t");
        assert_eq!(s["state"], "image");
        assert!(s["available"].is_null() && s["reason"].is_null(), "{s}");
        let s = Elsewhere::NoSystemd.status("0.1.5", "1", true, Some("0.1.6"), "t");
        assert_eq!(s["state"], "manual");
        assert!(s["reason"].as_str().unwrap().contains("no systemd"), "{s}");
    }
}
