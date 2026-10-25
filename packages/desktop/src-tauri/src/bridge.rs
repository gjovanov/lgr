//! C18 — the native fiscal bridge (FR-14.26, FR-14.27).
//!
//! The shell opens the till's serial port and speaks **the existing bridge protocol** to the hub
//! as the registered desktop: `fiscal:bridge:register`, `fiscal:command`, `fiscal:response`,
//! base64 frames, and the `protocol: 'isl'` + `timeoutMs` framing the Web Serial relay
//! implements. This is why the desktop exists at all, beyond a tab with autostart:
//!
//!  · "Failed to open serial port" means another **tab** holds it. The 2026-09-28 memory records
//!    a Saturday tab holding COM4 for **33 hours**;
//!  · **WKWebView and WebKitGTK have no Web Serial at all**, so without this there is no fiscal
//!    path on macOS or Linux.
//!
//! ⚠ **The byte transport is Rust, never Bun.** Bun + `serialport` on Windows opens the port and
//! writes, but **never delivers received bytes** — that made the Eltrade A3 look dead for two days
//! in September (C18 trap 1). Do not "simplify" this into a script.
//!
//! ⚠ **The protocol drivers stay on the hub** (`packages/fiscal/src/isl-frame.ts`, `eltrade.ts`,
//! `tremol.ts`) and УНП allocation stays there too (`generateUNP`). This module moves bytes and
//! finds frame boundaries (`framing.rs`); it never retries, reorders or interprets a frame.
//! Eltrade REPLAYS a same-SEQ frame instead of executing it, so a transport that helpfully resent
//! one would turn a second sale into a repeat of the first (trap 4).
//!
//! ⚠ **One thread per device, blocking.** Commands on one port must be serialized — two frames
//! sharing a serial line is the one thing the protocol cannot survive — and a blocking read that
//! only continues when the exchange is done is the simplest thing that guarantees it. The shell
//! has no async runtime (local mode took tokio with it), and a socket that is idle between sales
//! does not justify adding one.

// ⚠ No `std::io::{Read, Write}` import: `serialport::SerialPort` has `Read + Write` as supertraits
// and brings their methods with it. Importing them too is an unused-import warning, which
// `ci.yml`'s clippy `-D warnings` treats as an error.
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::Message;

use crate::framing::{Collect, HeuristicCollector, IslCollector};
use crate::{enroll, presence};

/// ISL read budget. Mirrors `useFiscalBridge.ts` so both bridges give the hub the same answers.
const ISL_FIRST_BYTE_MS: u64 = 2_500;
const ISL_IDLE_MS: u64 = 8_000;
const ISL_DEFAULT_BUDGET_MS: u64 = 30_000;
/// Above this (Z-report, fiscal-memory reports) the budget is waited out without idle limits.
const ISL_LONG_COMMAND_MS: u64 = 60_000;
/// The heuristic (Datecs/Tremol) path's fixed budget, as the browser relay uses.
const HEURISTIC_BUDGET_MS: u64 = 30_000;

/// How long a single serial read may block before the loop re-checks its budget.
const SERIAL_READ_SLICE: Duration = Duration::from_millis(100);
/// How long the WS read blocks before the loop re-checks `stop`.
const WS_READ_SLICE: Duration = Duration::from_millis(500);

/// Set once this desktop learns it is revoked — every bridge thread then lets its port go.
///
/// ⚠ **Process-global, deliberately.** Revocation is discovered in two very different places: the
/// presence socket (which has the `AppHandle`) and `mint_token` deep inside `enroll.rs` (which has
/// nothing). `mark_revoked` documents the order "say so, **stop the bridge**, delete the key", and
/// that promise has to hold from BOTH, so the flag cannot live in `AppState`. A revoked till that
/// kept printing because the refusal happened to arrive on the wrong code path is the exact
/// failure this guards.
///
/// ⚠ One-way. Nothing clears it: a desktop that has been revoked re-enrolls by restarting, and a
/// resettable flag is one mis-ordered call away from a revoked till printing again.
static HALTED: AtomicBool = AtomicBool::new(false);

/// Stop every bridge, now and for the life of the process (FR-14.22).
pub fn halt() {
    HALTED.store(true, Ordering::SeqCst);
}

/// Has this desktop been revoked?
pub fn halted() -> bool {
    HALTED.load(Ordering::SeqCst)
}

/// A device this desktop may bridge, as `GET /api/desktop/v1/fiscal-devices` describes it.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct AssignedDevice {
    pub id: String,
    #[serde(rename = "deviceNumber")]
    pub device_number: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub manufacturer: String,
    /// `None` when an admin has not said which port — nothing to open, and we say so.
    pub port: Option<String>,
    #[serde(rename = "baudRate", default = "default_baud")]
    pub baud_rate: u32,
}

fn default_baud() -> u32 {
    115_200
}

/// What the Overview's fiscal-devices card shows per device (FR-14.17, C09).
#[derive(Debug, Clone, serde::Serialize)]
pub struct DeviceReport {
    pub id: String,
    #[serde(rename = "deviceNumber")]
    pub device_number: String,
    pub name: String,
    pub port: Option<String>,
    /// `idle` · `printing` · `opening` · `in_use` · `unassigned` · `no_port` · `error` · `offline`
    pub state: &'static str,
    /// Seconds since the last completed command, so the card can say "last used 2 min ago".
    #[serde(rename = "lastCommandSecsAgo")]
    pub last_command_secs_ago: Option<i64>,
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceLink {
    Offline,
    Opening,
    Idle,
    Printing,
    /// The hub refused us because something else holds the device (`bridge_in_use`).
    InUse,
    /// Not in this desktop's assignment any more (`device_not_assigned`).
    Unassigned,
    /// No serial port configured for it.
    NoPort,
    Error,
}

impl DeviceLink {
    fn as_str(self) -> &'static str {
        match self {
            DeviceLink::Offline => "offline",
            DeviceLink::Opening => "opening",
            DeviceLink::Idle => "idle",
            DeviceLink::Printing => "printing",
            DeviceLink::InUse => "in_use",
            DeviceLink::Unassigned => "unassigned",
            DeviceLink::NoPort => "no_port",
            DeviceLink::Error => "error",
        }
    }
}

struct DeviceInner {
    device: AssignedDevice,
    link: DeviceLink,
    last_command: Option<Instant>,
    last_error: Option<String>,
}

/// Bridge state the rest of the shell reads (C08's Quit, C13's deferral, C09's card).
#[derive(Default)]
pub struct BridgeState {
    /// Commands being relayed RIGHT NOW, across every device.
    ///
    /// ⚠ A counter, not a bool: a two-device till can be mid-print on one port while the other
    /// is idle, and Quit must wait for both.
    inflight: AtomicUsize,
    devices: Mutex<Vec<DeviceInner>>,
}

impl BridgeState {
    /// Is a fiscal command in flight? C08's Quit waits on this (FR-14.6).
    pub fn is_busy(&self) -> bool {
        self.inflight.load(Ordering::SeqCst) > 0
    }

    /// Seconds since the most recent completed command on any device, if there has been one.
    pub fn secs_since_last_command(&self) -> Option<i64> {
        let devices = self.devices.lock().ok()?;
        devices
            .iter()
            .filter_map(|d| d.last_command)
            .map(|t| t.elapsed().as_secs() as i64)
            .min()
    }

    /// Is the till in use, for C13's update deferral (FR-14.28)?
    ///
    /// ⚠ **`Busy`, never `MidReceipt`.** `MidReceipt` is not derivable here and must not be
    /// guessed: knowing a fiscal receipt is OPEN means reading the command stream, and this module
    /// deliberately does not interpret frames — the drivers on the hub do. Reporting `Busy` is the
    /// truthful answer a pure transport can give, and it is the stricter one for the first
    /// `MAX_DEFERRALS` attempts; what it loses is the absolute never-interrupt guarantee at the
    /// force-through limit. Closing that needs the HUB to tell the shell a receipt is open, which
    /// is a protocol addition, not a thing to infer.
    pub fn till_state(&self) -> crate::update::TillState {
        if self.is_busy() {
            return crate::update::TillState::Busy;
        }
        match self.secs_since_last_command() {
            Some(secs) if secs < crate::update::BUSY_WINDOW_SECS => crate::update::TillState::Busy,
            _ => crate::update::TillState::Idle,
        }
    }

    /// What C09's Fiscal devices card renders.
    pub fn report(&self) -> Vec<DeviceReport> {
        let Ok(devices) = self.devices.lock() else { return Vec::new() };
        devices
            .iter()
            .map(|d| DeviceReport {
                id: d.device.id.clone(),
                device_number: d.device.device_number.clone(),
                name: d.device.name.clone(),
                port: d.device.port.clone(),
                state: d.link.as_str(),
                last_command_secs_ago: d.last_command.map(|t| t.elapsed().as_secs() as i64),
                last_error: d.last_error.clone(),
            })
            .collect()
    }

    fn register_device(&self, device: AssignedDevice) {
        if let Ok(mut devices) = self.devices.lock() {
            let link = if device.port.is_some() { DeviceLink::Opening } else { DeviceLink::NoPort };
            devices.retain(|d| d.device.id != device.id);
            devices.push(DeviceInner { device, link, last_command: None, last_error: None });
        }
    }

    fn set_link(&self, device_id: &str, link: DeviceLink, error: Option<String>) {
        if let Ok(mut devices) = self.devices.lock() {
            if let Some(d) = devices.iter_mut().find(|d| d.device.id == device_id) {
                d.link = link;
                // ⚠ An error is CLEARED on a healthy state rather than sticking for ever: a card
                // that still shows yesterday's unplugged cable next to a working printer is how
                // an operator learns to ignore it.
                d.last_error = error.or(if matches!(link, DeviceLink::Idle | DeviceLink::Printing) {
                    None
                } else {
                    d.last_error.clone()
                });
            }
        }
    }

    fn mark_command_done(&self, device_id: &str) {
        if let Ok(mut devices) = self.devices.lock() {
            if let Some(d) = devices.iter_mut().find(|d| d.device.id == device_id) {
                d.last_command = Some(Instant::now());
            }
        }
    }

    /// Forget every device — the assignment changed, or the shell is shutting down.
    pub fn clear(&self) {
        if let Ok(mut devices) = self.devices.lock() {
            devices.clear();
        }
    }
}

/// Things worth telling the shell about.
pub enum Event {
    /// The bridge is up for a device and the hub accepted it.
    Registered(String),
    /// Refused for a reason retrying will not fix (unassigned, revoked, taken over).
    Refused { device_id: String, code: String },
    Disconnected(String),
}

/// Fetch what this desktop may bridge.
///
/// ⚠ Re-fetched on every reconnect rather than cached at enrollment: an admin moving a printer
/// from COM3 to COM4, or assigning a device to a different till, has to reach the running shell.
pub fn fetch_assignment(server_url: &str) -> Result<Vec<AssignedDevice>, String> {
    let token = enroll::mint_token(server_url).map_err(|e| e.to_string())?;
    let url = format!("{}/api/desktop/v1/fiscal-devices", server_url.trim_end_matches('/'));
    let client = crate::trust::client_for(server_url, Duration::from_secs(15))?;

    let res = crate::trust::desktop_headers(client.get(&url), server_url, &token)
        .send()
        .map_err(|_| "server_unreachable".to_string())?;
    if !res.status().is_success() {
        return Err(format!("assignment_refused_{}", res.status().as_u16()));
    }

    #[derive(serde::Deserialize)]
    struct Body {
        #[serde(rename = "fiscalDevices")]
        fiscal_devices: Vec<AssignedDevice>,
    }
    let body: Body = res.json().map_err(|e| e.to_string())?;
    Ok(body.fiscal_devices)
}

/// The websocket URL for the bridge, derived from the server's own scheme.
///
/// ⚠ Never carries a credential. The register MESSAGE does — a token in a URL lands in ingress and
/// proxy logs, which is S-05's lesson and the same rule `presence.rs` follows.
pub fn ws_url(server_url: &str) -> Option<String> {
    let base = server_url.trim_end_matches('/');
    let (scheme, rest) = base
        .strip_prefix("https://")
        .map(|r| ("wss://", r))
        .or_else(|| base.strip_prefix("http://").map(|r| ("ws://", r)))?;
    Some(format!("{}{}/ws/fiscal-bridge", scheme, rest))
}

/// How the hub's answers map to what the bridge does about them. Pure, so the mapping is tested
/// without a socket.
#[derive(Debug, PartialEq, Eq)]
pub enum Incoming {
    Registered,
    /// Refused; the `String` is the machine-readable code.
    Error(String),
    Evicted,
    Command { id: String, frame: String, isl: bool, timeout_ms: Option<u64> },
    Info,
    Pong,
}

pub fn classify(text: &str) -> Option<Incoming> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    match v.get("type")?.as_str()? {
        "fiscal:bridge:registered" => Some(Incoming::Registered),
        "fiscal:bridge:error" => Some(Incoming::Error(
            v.get("code").and_then(|c| c.as_str()).unwrap_or("error").to_string(),
        )),
        "fiscal:bridge:evicted" => Some(Incoming::Evicted),
        "fiscal:bridge:info" => Some(Incoming::Info),
        "pong" => Some(Incoming::Pong),
        "fiscal:command" => Some(Incoming::Command {
            id: v.get("commandId")?.as_str()?.to_string(),
            frame: v.get("frame")?.as_str()?.to_string(),
            isl: v.get("protocol").and_then(|p| p.as_str()) == Some("isl"),
            timeout_ms: v.get("timeoutMs").and_then(|t| t.as_u64()),
        }),
        _ => None,
    }
}

/// Is this refusal worth retrying?
///
/// ⚠ `bridge_in_use` IS retried, with backoff: the other holder may be a tab that is about to be
/// closed, and a till that gave up for good would need a restart to come back. The rest are
/// states only an admin can change, so hammering them is noise in the hub's audit log.
pub fn is_fatal(code: &str) -> bool {
    matches!(
        code,
        "device_not_assigned"
            | "device_not_found"
            | "desktop_revoked"
            | "key_rotated"
            | "unauthenticated"
            | "forbidden"
            | "org_mismatch"
            | "bridged_by_desktop"
    )
}

/// Run one device's bridge until `stop` is set. Intended for a dedicated thread.
pub fn run(
    server_url: String,
    device: AssignedDevice,
    state: Arc<BridgeState>,
    stop: Arc<AtomicBool>,
    mut on_event: impl FnMut(Event),
) {
    state.register_device(device.clone());

    let Some(port_name) = device.port.clone() else {
        // Nothing to open. Said once and left alone: an admin has to set the port, and a retry
        // loop against a missing setting is a log full of nothing.
        state.set_link(&device.id, DeviceLink::NoPort, Some("no serial port configured".into()));
        return;
    };

    let mut attempt = 0u32;
    while !stop.load(Ordering::SeqCst) && !halted() {
        match connect_once(&server_url, &device, &port_name, &state, &stop, &mut on_event) {
            Outcome::Closed => attempt = 0,
            Outcome::Unreachable => attempt = attempt.saturating_add(1),
            Outcome::Fatal(code) => {
                on_event(Event::Refused { device_id: device.id.clone(), code });
                return;
            }
        }
        on_event(Event::Disconnected(device.id.clone()));

        let wait = presence::backoff_secs(attempt);
        for _ in 0..(wait * 10) {
            if stop.load(Ordering::SeqCst) || halted() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    state.set_link(&device.id, DeviceLink::Offline, None);
}

enum Outcome {
    Closed,
    Unreachable,
    Fatal(String),
}

type Socket = crate::trust::Socket;

/// Give the WS read a timeout, so the loop can notice `stop` instead of blocking for ever.
///
/// ⚠ One arm per transport, and `Rustls` is a master's (`trust.rs`). The enum is `non_exhaustive`,
/// so a transport missing here would fall to `_` in silence: no timeout, a loop blocked in `read`
/// for ever, and a port that `stop` and revocation could no longer make it let go of.
fn set_ws_read_timeout(socket: &mut Socket, dur: Option<Duration>) {
    match socket.get_mut() {
        MaybeTlsStream::Plain(s) => {
            let _ = s.set_read_timeout(dur);
        }
        MaybeTlsStream::NativeTls(s) => {
            let _ = s.get_ref().set_read_timeout(dur);
        }
        MaybeTlsStream::Rustls(s) => {
            let _ = s.get_ref().set_read_timeout(dur);
        }
        _ => {}
    }
}

/// Did this websocket error come from our own read timeout rather than a broken connection?
fn is_read_timeout(e: &tungstenite::Error) -> bool {
    matches!(
        e,
        tungstenite::Error::Io(io)
            if io.kind() == std::io::ErrorKind::WouldBlock || io.kind() == std::io::ErrorKind::TimedOut
    )
}

fn connect_once(
    server_url: &str,
    device: &AssignedDevice,
    port_name: &str,
    state: &Arc<BridgeState>,
    stop: &Arc<AtomicBool>,
    on_event: &mut impl FnMut(Event),
) -> Outcome {
    state.set_link(&device.id, DeviceLink::Opening, None);

    // ── The credential first ──────────────────────────────────────────────────────────────────
    // Minting before opening anything tells us which of "unreachable" and "refused" this is, and
    // means a revoked till never touches the serial port at all.
    let token = match enroll::mint_token(server_url) {
        Ok(t) => t,
        Err(e) => {
            let msg = e.to_string();
            if msg == "server_unreachable" || msg == "server_timeout" {
                state.set_link(&device.id, DeviceLink::Offline, Some(msg));
                return Outcome::Unreachable;
            }
            state.set_link(&device.id, DeviceLink::Error, Some(msg.clone()));
            return Outcome::Fatal(msg);
        }
    };

    // ── The serial port ───────────────────────────────────────────────────────────────────────
    // ⚠ Opened BEFORE registering. Registering first would have the hub believe the device is
    // online and route a sale to a port we then fail to open — the sale would wait out the full
    // 60 s bridge timeout and the cashier would be told nothing useful.
    let mut serial = match serialport::new(port_name, device.baud_rate)
        .timeout(SERIAL_READ_SLICE)
        .open()
    {
        Ok(p) => p,
        Err(e) => {
            // The other owner is usually a Chrome tab (Web Serial takes the port exclusively), or
            // the device is switched off. Both are worth retrying — the tab may be closed.
            let msg = format!("cannot open {port_name}: {e}");
            state.set_link(&device.id, DeviceLink::InUse, Some(msg));
            return Outcome::Unreachable;
        }
    };

    let Some(url) = ws_url(server_url) else {
        return Outcome::Fatal("invalid_server_url".into());
    };
    // Pinned and straight to a master, with its credential on the upgrade (FR-20.31, FR-20.32): the
    // fiscal path stays on the shop's LAN (FR-20.36).
    let mut socket = match crate::trust::ws_connect(&url, &token) {
        Ok(socket) => socket,
        Err(_) => {
            state.set_link(&device.id, DeviceLink::Offline, Some("hub unreachable".into()));
            return Outcome::Unreachable;
        }
    };
    set_ws_read_timeout(&mut socket, Some(WS_READ_SLICE));

    // ⚠ FIRST message, within the hub's 10 s deadline, and never in the URL.
    let register = serde_json::json!({
        "type": "fiscal:bridge:register",
        "deviceNumber": device.device_number,
        "token": token,
    });
    if socket.send(Message::Text(register.to_string())).is_err() {
        return Outcome::Unreachable;
    }

    loop {
        // ⚠ `halted()` as well as `stop`: revocation may be discovered by a different thread
        // entirely (`mark_revoked`, from inside `mint_token`), and this port has to be let go of
        // whichever path noticed.
        if stop.load(Ordering::SeqCst) || halted() {
            let _ = socket.close(None);
            return Outcome::Closed;
        }

        let text = match socket.read() {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) => return Outcome::Closed,
            Ok(_) => continue,
            Err(e) if is_read_timeout(&e) => continue,
            Err(_) => {
                state.set_link(&device.id, DeviceLink::Offline, None);
                return Outcome::Unreachable;
            }
        };

        match classify(&text) {
            Some(Incoming::Registered) => {
                state.set_link(&device.id, DeviceLink::Idle, None);
                on_event(Event::Registered(device.id.clone()));
            }
            Some(Incoming::Error(code)) => {
                let fatal = is_fatal(&code);
                // ⚠ Three distinct states, because an operator reads them and they mean different
                // things to do: `in_use` = close the other tab; `unassigned` = an admin must
                // assign the device; `error` = something else, look in the log.
                let link = match code.as_str() {
                    "bridge_in_use" => DeviceLink::InUse,
                    "device_not_assigned" | "device_not_found" | "bridged_by_desktop" => {
                        DeviceLink::Unassigned
                    }
                    _ => DeviceLink::Error,
                };
                state.set_link(&device.id, link, Some(code.clone()));
                let _ = socket.close(None);
                return if fatal { Outcome::Fatal(code) } else { Outcome::Unreachable };
            }
            Some(Incoming::Evicted) => {
                // An admin took the device, or this desktop was revoked. Either way the port is
                // not ours any more — let go of it rather than holding it against the new owner.
                state.set_link(&device.id, DeviceLink::InUse, Some("taken over".into()));
                let _ = socket.close(None);
                return Outcome::Fatal("evicted".into());
            }
            Some(Incoming::Command { id, frame, isl, timeout_ms }) => {
                relay(&mut socket, &mut *serial, state, device, &id, &frame, isl, timeout_ms);
            }
            Some(Incoming::Info) | Some(Incoming::Pong) | None => {}
        }
    }
}

/// Relay one command: decode → write to the port → collect the answer → answer the hub.
///
/// ⚠ Synchronous, inside the read loop, which is what serializes commands on the port. Two frames
/// sharing a serial line is the one thing the protocol cannot survive.
#[allow(clippy::too_many_arguments)]
fn relay(
    socket: &mut Socket,
    serial: &mut dyn serialport::SerialPort,
    state: &Arc<BridgeState>,
    device: &AssignedDevice,
    command_id: &str,
    frame_b64: &str,
    isl: bool,
    timeout_ms: Option<u64>,
) {
    let engine = base64::engine::general_purpose::STANDARD;
    let Ok(frame) = engine.decode(frame_b64) else {
        answer_error(socket, command_id, "the hub sent a frame that is not base64");
        return;
    };
    if frame.is_empty() {
        answer_error(socket, command_id, "the hub sent an empty frame");
        return;
    }

    state.inflight.fetch_add(1, Ordering::SeqCst);
    state.set_link(&device.id, DeviceLink::Printing, None);

    let result = exchange(serial, &frame, isl, timeout_ms);

    state.inflight.fetch_sub(1, Ordering::SeqCst);
    // ⚠ Recorded even on failure: C13 must not install an update over a till that is being used
    // but failing, and "the last command was 10 seconds ago" is true either way.
    state.mark_command_done(&device.id);

    match result {
        Ok(bytes) => {
            state.set_link(&device.id, DeviceLink::Idle, None);
            let _ = socket.send(Message::Text(
                serde_json::json!({
                    "type": "fiscal:response",
                    "commandId": command_id,
                    "frame": engine.encode(&bytes),
                })
                .to_string(),
            ));
        }
        Err(e) => {
            // ⚠ An ANSWER, never a dropped command. Saying nothing makes the hub wait out its
            // full 60 s timeout, and the POS then reports a timeout instead of the real cause —
            // and a print failure must surface as `receiptError` with the sale still saved
            // (CLAUDE.md), which it cannot do if it never learns what went wrong.
            //
            // ⚠ And NOT a device `error` status: an `error` device makes the hub 503 every sale
            // once no bridge holds it. This is a per-command failure, reported as one.
            state.set_link(&device.id, DeviceLink::Idle, Some(e.clone()));
            answer_error(socket, command_id, &e);
        }
    }
}

fn answer_error(socket: &mut Socket, command_id: &str, error: &str) {
    let _ = socket.send(Message::Text(
        serde_json::json!({
            "type": "fiscal:response:error",
            "commandId": command_id,
            "error": error,
        })
        .to_string(),
    ));
}

/// Write the frame and collect the device's answer, with the browser relay's read budgets.
fn exchange(
    serial: &mut dyn serialport::SerialPort,
    frame: &[u8],
    isl: bool,
    timeout_ms: Option<u64>,
) -> Result<Vec<u8>, String> {
    serial.write_all(frame).map_err(|e| format!("serial write failed: {e}"))?;
    serial.flush().map_err(|e| format!("serial flush failed: {e}"))?;

    if isl {
        read_isl(serial, frame, timeout_ms)
    } else {
        read_heuristic(serial)
    }
}

fn read_isl(
    serial: &mut dyn serialport::SerialPort,
    frame: &[u8],
    timeout_ms: Option<u64>,
) -> Result<Vec<u8>, String> {
    let budget = timeout_ms.filter(|t| *t > 0).unwrap_or(ISL_DEFAULT_BUDGET_MS);
    let long = budget > ISL_LONG_COMMAND_MS;
    let deadline = Instant::now() + Duration::from_millis(budget);

    // ⚠ `frame[2]` is the SEQ. The collector stops at the frame carrying THIS SEQ, so a late
    // answer to an earlier command cannot be handed back as this one's.
    let seq = *frame.get(2).ok_or("the hub sent a frame too short to carry a SEQ")?;
    let mut collector = IslCollector::new(seq);

    // Until the first byte arrives a silent line is given ISL_FIRST_BYTE_MS, not the whole
    // budget: a device that is switched off is then reported in 2.5 s instead of 30.
    let mut quiet_limit = if long { budget } else { ISL_FIRST_BYTE_MS };
    let mut last_byte = Instant::now();
    let mut buf = [0u8; 512];

    loop {
        if Instant::now() >= deadline {
            return Err(timeout_message(collector.received, budget));
        }
        if last_byte.elapsed() >= Duration::from_millis(quiet_limit) {
            return Err(timeout_message(collector.received, quiet_limit));
        }

        match serial.read(&mut buf) {
            Ok(0) => {}
            Ok(n) => {
                last_byte = Instant::now();
                // SYN (busy, every 60 ms) extends the wait, so a long print is not cut off.
                quiet_limit = if long { budget } else { ISL_IDLE_MS };
                match collector.push(&buf[..n]) {
                    Collect::More => {}
                    Collect::Frame | Collect::Nak => return Ok(collector.bytes()),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => return Err(format!("serial read failed: {e}")),
        }
    }
}

fn timeout_message(received: usize, ms: u64) -> String {
    if received > 0 {
        // ⚠ Worth distinguishing: bytes arriving but no complete frame is a protocol or cabling
        // problem, while total silence is almost always a switched-off device or the wrong port.
        format!("the device answered {received} bytes but no complete frame within {ms} ms")
    } else {
        format!("the device did not answer within {ms} ms")
    }
}

fn read_heuristic(serial: &mut dyn serialport::SerialPort) -> Result<Vec<u8>, String> {
    let deadline = Instant::now() + Duration::from_millis(HEURISTIC_BUDGET_MS);
    let mut collector = HeuristicCollector::new();
    let mut buf = [0u8; 512];
    let mut received = 0usize;

    loop {
        if Instant::now() >= deadline {
            return Err(timeout_message(received, HEURISTIC_BUDGET_MS));
        }
        match serial.read(&mut buf) {
            Ok(0) => {}
            Ok(n) => {
                received += n;
                match collector.push(&buf[..n]) {
                    Collect::More => {}
                    Collect::Frame | Collect::Nak => return Ok(collector.bytes()),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => return Err(format!("serial read failed: {e}")),
        }
    }
}

/// The serial ports this machine can see, for `report_self` (FR-14.21).
///
/// ⚠ Names only. An admin picking "COM4" from a list on the Desktops page is the whole point, and
/// a till that reports nothing leaves them typing a port name from memory.
pub fn visible_ports() -> Vec<String> {
    serialport::available_ports()
        .map(|ports| ports.into_iter().map(|p| p.port_name).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_socket_url_follows_the_scheme_of_the_server() {
        assert_eq!(ws_url("https://lgrai.app").unwrap(), "wss://lgrai.app/ws/fiscal-bridge");
        assert_eq!(ws_url("https://lgrai.app/").unwrap(), "wss://lgrai.app/ws/fiscal-bridge");
        // A dev hub on loopback is plain http and must not be upgraded to wss.
        assert_eq!(
            ws_url("http://127.0.0.1:4001").unwrap(),
            "ws://127.0.0.1:4001/ws/fiscal-bridge"
        );
        assert!(ws_url("ftp://x").is_none());
        assert!(ws_url("lgrai.app").is_none());
    }

    #[test]
    fn the_credential_is_never_in_the_socket_url() {
        // ⚠ Structural, same rule as the presence socket: a token in a URL lands in proxy logs.
        let url = ws_url("https://lgrai.app").unwrap();
        for forbidden in ["token", "?", "assertion", "desktopId", "deviceNumber"] {
            assert!(!url.contains(forbidden), "{forbidden} must not appear in {url}");
        }
    }

    #[test]
    fn hub_messages_map_to_what_the_bridge_does_about_them() {
        assert_eq!(
            classify(r#"{"type":"fiscal:bridge:registered","deviceNumber":"12345678"}"#),
            Some(Incoming::Registered)
        );
        assert_eq!(
            classify(r#"{"type":"fiscal:bridge:error","code":"bridge_in_use"}"#),
            Some(Incoming::Error("bridge_in_use".into()))
        );
        assert_eq!(classify(r#"{"type":"fiscal:bridge:evicted"}"#), Some(Incoming::Evicted));
        assert_eq!(classify(r#"{"type":"pong","timestamp":1}"#), Some(Incoming::Pong));
    }

    #[test]
    fn an_error_without_a_code_still_refuses() {
        // The hub sends a bare `message` for a few shape failures ("deviceNumber required").
        assert_eq!(
            classify(r#"{"type":"fiscal:bridge:error","message":"deviceNumber required"}"#),
            Some(Incoming::Error("error".into()))
        );
    }

    #[test]
    fn a_command_carries_its_id_frame_and_framing() {
        let msg = r#"{"type":"fiscal:command","commandId":"c1","frame":"AQID","protocol":"isl","timeoutMs":9000}"#;
        assert_eq!(
            classify(msg),
            Some(Incoming::Command {
                id: "c1".into(),
                frame: "AQID".into(),
                isl: true,
                timeout_ms: Some(9000)
            })
        );
    }

    #[test]
    fn a_command_without_a_protocol_takes_the_heuristic_path() {
        // ⚠ Datecs and Tremol send no `protocol` field. Defaulting to ISL would hang every
        // non-Eltrade device, because an ISL collector never sees a frame it recognises.
        let msg = r#"{"type":"fiscal:command","commandId":"c2","frame":"AQID"}"#;
        match classify(msg) {
            Some(Incoming::Command { isl, timeout_ms, .. }) => {
                assert!(!isl);
                assert_eq!(timeout_ms, None);
            }
            other => panic!("expected a command, got {other:?}"),
        }
    }

    #[test]
    fn a_command_missing_its_id_or_frame_is_not_a_command() {
        // Rubbish is ignored rather than relayed as an empty write to the printer.
        assert_eq!(classify(r#"{"type":"fiscal:command","frame":"AQID"}"#), None);
        assert_eq!(classify(r#"{"type":"fiscal:command","commandId":"c1"}"#), None);
    }

    #[test]
    fn rubbish_is_ignored_rather_than_crashing_the_bridge() {
        assert!(classify("not json").is_none());
        assert!(classify("{}").is_none());
        assert!(classify(r#"{"type":"something:else"}"#).is_none());
        assert!(classify(r#"{"type":123}"#).is_none());
    }

    #[test]
    fn bridge_in_use_is_retried_but_an_assignment_refusal_is_not() {
        // ⚠ The distinction that decides whether a till comes back by itself. The other holder of
        // a port is usually a tab somebody will close; an unassigned device needs an admin.
        assert!(!is_fatal("bridge_in_use"));
        assert!(is_fatal("device_not_assigned"));
        assert!(is_fatal("desktop_revoked"));
        assert!(is_fatal("key_rotated"));
        assert!(is_fatal("bridged_by_desktop"));
        // An unknown code is retried: a newer hub may refuse for a reason this build predates,
        // and giving up for good on something we do not understand needs a restart to undo.
        assert!(!is_fatal("something_new"));
    }

    #[test]
    fn an_idle_bridge_is_not_busy_and_the_till_reads_idle() {
        let s = BridgeState::default();
        assert!(!s.is_busy());
        assert_eq!(s.secs_since_last_command(), None);
        assert_eq!(s.till_state(), crate::update::TillState::Idle);
    }

    #[test]
    fn an_in_flight_command_makes_the_till_busy() {
        // ⚠ What C08's Quit waits on: "quit interrupted a receipt" is a bug that only shows up on
        // a customer's till.
        let s = BridgeState::default();
        s.inflight.fetch_add(1, Ordering::SeqCst);
        assert!(s.is_busy());
        assert_eq!(s.till_state(), crate::update::TillState::Busy);

        s.inflight.fetch_sub(1, Ordering::SeqCst);
        assert!(!s.is_busy());
    }

    #[test]
    fn a_recent_command_keeps_the_till_busy_for_the_window() {
        let s = BridgeState::default();
        s.register_device(dev());
        s.mark_command_done("d1");

        assert!(!s.is_busy(), "nothing is in flight");
        assert_eq!(
            s.till_state(),
            crate::update::TillState::Busy,
            "a command seconds ago still means the till is in use (FR-14.28)"
        );
        assert!(s.secs_since_last_command().unwrap() < 5);
    }

    #[test]
    fn two_devices_both_count_towards_busy() {
        let s = BridgeState::default();
        s.inflight.fetch_add(2, Ordering::SeqCst);
        s.inflight.fetch_sub(1, Ordering::SeqCst);
        assert!(s.is_busy(), "one port idle does not make the till idle");
        s.inflight.fetch_sub(1, Ordering::SeqCst);
        assert!(!s.is_busy());
    }

    #[test]
    fn a_device_with_no_port_is_reported_as_such_rather_than_as_broken() {
        // An admin has not finished configuring it; "error" would send somebody hunting a fault.
        let s = BridgeState::default();
        s.register_device(AssignedDevice { port: None, ..dev() });
        let r = s.report();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].state, "no_port");
        assert_eq!(r[0].last_command_secs_ago, None);
    }

    #[test]
    fn the_report_carries_what_the_overview_renders() {
        let s = BridgeState::default();
        s.register_device(dev());
        s.set_link("d1", DeviceLink::Idle, None);
        let r = s.report();
        assert_eq!(r[0].device_number, "12345678");
        assert_eq!(r[0].name, "Till 2 printer");
        assert_eq!(r[0].port.as_deref(), Some("COM4"));
        assert_eq!(r[0].state, "idle");
        assert_eq!(r[0].last_error, None);
    }

    #[test]
    fn a_healthy_state_clears_a_stale_error() {
        // ⚠ Otherwise the card shows yesterday's unplugged cable next to a working printer, and
        // an operator learns to ignore the field.
        let s = BridgeState::default();
        s.register_device(dev());
        s.set_link("d1", DeviceLink::Error, Some("cannot open COM4".into()));
        assert_eq!(s.report()[0].last_error.as_deref(), Some("cannot open COM4"));

        s.set_link("d1", DeviceLink::Idle, None);
        assert_eq!(s.report()[0].last_error, None);
        assert_eq!(s.report()[0].state, "idle");
    }

    #[test]
    fn an_unhealthy_state_without_a_new_reason_keeps_the_last_one() {
        let s = BridgeState::default();
        s.register_device(dev());
        s.set_link("d1", DeviceLink::Error, Some("cannot open COM4".into()));
        s.set_link("d1", DeviceLink::Offline, None);
        assert_eq!(
            s.report()[0].last_error.as_deref(),
            Some("cannot open COM4"),
            "the reason it went wrong survives into the next unhealthy state",
        );
    }

    #[test]
    fn re_registering_a_device_replaces_it_rather_than_duplicating_it() {
        // The assignment is re-fetched on every reconnect, so this happens routinely.
        let s = BridgeState::default();
        s.register_device(dev());
        s.register_device(AssignedDevice { port: Some("COM7".into()), ..dev() });
        let r = s.report();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].port.as_deref(), Some("COM7"));
    }

    #[test]
    fn clearing_forgets_every_device() {
        let s = BridgeState::default();
        s.register_device(dev());
        s.clear();
        assert!(s.report().is_empty());
        assert_eq!(s.till_state(), crate::update::TillState::Idle);
    }

    #[test]
    fn an_assignment_deserializes_from_what_the_hub_sends() {
        let json = r#"{"id":"d1","deviceNumber":"12345678","name":"T","manufacturer":"eltrade","port":"COM4","baudRate":9600}"#;
        let d: AssignedDevice = serde_json::from_str(json).unwrap();
        assert_eq!(d.device_number, "12345678");
        assert_eq!(d.baud_rate, 9600);
        assert_eq!(d.port.as_deref(), Some("COM4"));
    }

    #[test]
    fn a_missing_baud_rate_falls_back_to_the_usual_one_and_a_null_port_is_none() {
        // The hub sends `port: null` when an admin has not set one — it must not be an error.
        let json = r#"{"id":"d1","deviceNumber":"12345678","port":null}"#;
        let d: AssignedDevice = serde_json::from_str(json).unwrap();
        assert_eq!(d.baud_rate, 115_200);
        assert!(d.port.is_none());
    }

    #[test]
    fn a_timeout_says_whether_the_device_was_silent_or_merely_incomplete() {
        assert!(timeout_message(0, 2500).contains("did not answer"));
        assert!(timeout_message(7, 8000).contains("7 bytes"));
    }

    fn dev() -> AssignedDevice {
        AssignedDevice {
            id: "d1".into(),
            device_number: "12345678".into(),
            name: "Till 2 printer".into(),
            manufacturer: "eltrade".into(),
            port: Some("COM4".into()),
            baud_rate: 115_200,
        }
    }
}
