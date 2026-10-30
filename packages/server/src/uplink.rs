//! The uplink, the supervisor's side (FR-20.52, plan step P2-2b): a registered master's two sockets
//! to global, `wss://<server>/api/node/v1/uplink?ch=interactive|bulk`.
//!
//! Each channel is one task, for as long as the supervisor runs:
//! - **Not registered:** it waits, and starts within moments of `lgr-server register`.
//! - **Connecting:** a token for a fresh assertion (`register::fetch_token`), the socket through the
//!   machine's proxy rules and the OS trust store (`Https::connect`), then `hello`, with this boot's
//!   nonce. The URL carries no credential.
//! - **Connected:** a ping every 30 s; a socket that hears nothing for 75 s is dead, and is replaced.
//!   While the bulk socket has work, the interactive one pings every 2 s, one at a time, and each
//!   round trip goes to the bulk socket's pacer (FR-20.52, `pacing.rs`): what queues in front of a
//!   click on the shop's line is what the mirror holds back for.
//! - **Refused:** 4403 (revoked) stops the uplink until the master is registered again: it never
//!   stops the shop. 4401 makes it authenticate again. Anything else is retried with full jitter,
//!   1 s to 5 minutes.
//! - ⚠ **`clone-alarm`:** another machine is connected with this node id. The socket stays open,
//!   and the status says so loudly. Global trusts neither socket until an admin registers the real
//!   machine again.
//! - **Health** (FR-20.57, plan step P2-3a): every 60 s on the interactive socket, from the
//!   supervisor's own status, the API's, and the data volume's free space.
//! - **`master_outdated`** (FR-20.58): this build is older than global's minimum. The socket stays
//!   for the update; replication and remote access wait, and the status says so.
//! - **Licences** (FR-20.55, plan step P2-3b): one per org in `welcome`, then an `entitlements` frame
//!   when one changes. Each is verified and kept by `licence::keep`.
//! - **The mirror** (FR-20.64, plan step P3-2b): on the bulk socket of a master linked at Full, the
//!   pages `replication::pump` has the API build, as binary frames, and global's answers back to it.
//!   Not under a clone alarm, and not while this build is outdated: global would refuse them anyway.

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::tungstenite::Message;

use crate::node_key::NodeKey;
use crate::register;
use crate::supervisor::Registrar;

pub const CHANNELS: [&str; 2] = ["interactive", "bulk"];

/// What a `health` frame is built from, called once a minute on the interactive socket.
pub type HealthFn = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = serde_json::Value> + Send>> + Send + Sync>;

/// What is done with a licence global sends (a JWS): verified and kept (`licence::keep`).
pub type LicenceFn = Arc<dyn Fn(&str) + Send + Sync>;

/// What a session calls out to.
#[derive(Clone, Default)]
pub struct Hooks {
    /// Only on the interactive channel.
    pub health: Option<HealthFn>,
    pub licence: Option<LicenceFn>,
    /// Only on the bulk channel: where the mirror's pages come from, and this master's node id.
    pub pages: Option<PagesHook>,
    /// FR-20.52: the bulk socket's pacer, fed by the interactive socket's round trips.
    pub pacer: Option<Arc<crate::pacing::Pacer>>,
    /// FR-20.73 (P3-4c): only on the interactive channel, the API the tunnel's streams go to.
    pub tunnel: Option<Arc<crate::ingress::Upstream>>,
    /// FR-20.18: `state/setup-complete`, without which the tunnel carries nothing.
    pub setup_marker: Option<std::path::PathBuf>,
}

#[derive(Clone)]
pub struct PagesHook {
    pub source: Arc<dyn crate::replication::PageSource>,
    pub node_id: String,
}

/// What a channel's sessions call out to, before a registration names the node.
#[derive(Clone, Default)]
struct Wants {
    health: Option<HealthFn>,
    pages: Option<Arc<dyn crate::replication::PageSource>>,
    pacer: Option<Arc<crate::pacing::Pacer>>,
    tunnel: Option<Arc<crate::ingress::Upstream>>,
}

/// The pump of one session: it ends with the session, at whichever of its returns.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub ping: Duration,
    pub silent: Duration,
    pub welcome: Duration,
    pub max_backoff: Duration,
    pub idle_check: Duration,
    pub health: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            ping: Duration::from_secs(30),
            silent: Duration::from_secs(75),
            welcome: Duration::from_secs(10),
            max_backoff: Duration::from_secs(300),
            idle_check: Duration::from_secs(60),
            health: Duration::from_secs(60),
        }
    }
}

/// How one connection ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Ended {
    /// 4403: the node was revoked. The uplink waits for a new registration.
    Revoked(String),
    /// 4401: authenticate again (a new key, an expired token).
    Reauth(String),
    /// Anything else: retried with backoff.
    Closed(String),
}

/// Per channel: what `lgr-server status` shows.
pub type Status = Arc<Mutex<serde_json::Value>>;

fn set(status: &Status, ch: &str, value: serde_json::Value) {
    let mut s = status.lock().unwrap();
    if !s.is_object() {
        *s = serde_json::json!({});
    }
    s[ch] = value;
}

pub(crate) fn patch(status: &Status, ch: &str, key: &str, value: serde_json::Value) {
    let mut s = status.lock().unwrap();
    if let Some(obj) = s.get_mut(ch).and_then(|c| c.as_object_mut()) {
        obj.insert(key.to_string(), value);
    }
}

pub(crate) fn now_iso() -> String {
    time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default()
}

/// Full jitter: anywhere from nothing to `min(max, 1 s · 2^attempt)`, so a fleet that lost global at
/// once does not come back at once.
pub fn backoff(attempt: u32, max: Duration) -> Duration {
    use rand::Rng;
    let cap = Duration::from_secs(1).saturating_mul(2u32.saturating_pow(attempt.min(20))).min(max);
    Duration::from_millis(rand::thread_rng().gen_range(0..=cap.as_millis() as u64))
}

fn close_ended(code: u16, reason: &str) -> Ended {
    match code {
        4403 => Ended::Revoked(if reason.is_empty() { "revoked".into() } else { reason.into() }),
        4401 => Ended::Reauth(if reason.is_empty() { "unauthenticated".into() } else { reason.into() }),
        _ => Ended::Closed(format!("closed {code}{}", if reason.is_empty() { String::new() } else { format!(" {reason}") })),
    }
}

/// The `health` frame (FR-20.57): the supervisor's status (with the API's account of itself, as
/// `status_with_api` gives it), the data volume's free space, and where the LAN ingress answers
/// (`state/lan.json`, when it is on): FR-20.82's re-point names that address, and pins that CA, for
/// an org's desktops when the org moves here. Global keeps known fields only.
/// What the machine says of itself beside the supervisor's status (FR-20.101's alarms need it).
#[derive(Debug, Default, Clone, Copy)]
pub struct Machine {
    /// The data volume's free and total bytes.
    pub disk: Option<(u64, u64)>,
    /// How far back the oplog reaches, in seconds (`mongod::OplogWindow`).
    pub oplog_window_secs: Option<u64>,
}

pub fn health_frame(status: &serde_json::Value, machine: Machine, lan: Option<&serde_json::Value>) -> serde_json::Value {
    let children: Vec<serde_json::Value> = status["children"]
        .as_array()
        .map(|cs| cs.iter().map(|c| serde_json::json!({ "name": c["name"], "state": c["state"], "failures": c["failures"] })).collect())
        .unwrap_or_default();
    let mut frame = serde_json::json!({
        "t": "health",
        "versions": { "app": env!("CARGO_PKG_VERSION"), "protocol": 1 },
        "uptimeSecs": status["uptimeSecs"],
        "children": children,
        "disk": { "freeBytes": machine.disk.map(|d| d.0), "totalBytes": machine.disk.map(|d| d.1) },
        // FR-20.101 (P3-8): a history lost past this is a reconcile; under seven days, an alarm.
        "oplogWindowSecs": machine.oplog_window_secs,
        // This machine's clock as the frame leaves: global reads the skew off it.
        "clock": now_iso(),
        "api": {
            "ok": status["api"]["ok"],
            "posOpen": status["api"]["posOpen"],
            "fiscalInFlight": status["api"]["fiscalInFlight"],
            "clockTrusted": status["api"]["clock"]["trusted"],
            // FR-20.100/101: the last backup of the orgs written here, the orgs fenced here, and
            // what waits to go to the internet.
            "lastBackupAt": status["api"]["lastBackupAt"],
            "fenced": status["api"]["fenced"],
            "outboxQueued": status["api"]["outboxQueued"],
        },
        // FR-20.20: what runs, what is available, and an update kept out by open tills (the alarm).
        "update": status["update"],
        // #356/#380: the address watch, and another machine claiming this server's address (an alarm on
        // lgrai.app, "probably a clone" when an advert named this server there from another start).
        "address": address_of(&status["addressCheck"]),
        // #373: replaced libraries waiting for the night restart, and the alarm after seven nights of
        // open tills.
        "nightRestart": night_restart_of(&status["nightRestart"]),
    });
    if let Some(lan) = lan.filter(|l| l["url"].is_string() && l["caFingerprint"].is_string()) {
        frame["lan"] = serde_json::json!({ "url": lan["url"], "caFingerprint": lan["caFingerprint"] });
    }
    frame
}

/// What the health frame says of the address watch: whether it runs, why not, and the conflict as
/// recorded, without the interface's name.
fn address_of(check: &serde_json::Value) -> serde_json::Value {
    if !check.is_object() {
        return serde_json::Value::Null;
    }
    let c = &check["conflict"];
    let conflict = if c.is_object() {
        serde_json::json!({ "address": c["address"], "otherMac": c["otherMac"], "firstSeen": c["firstSeen"], "at": c["at"], "probableClone": c["probableClone"] })
    } else {
        serde_json::Value::Null
    };
    serde_json::json!({ "on": check["on"], "reason": check["reason"], "conflict": conflict })
}

/// What the health frame says of the night restart: only while something waits for it, and without
/// the libraries' paths.
fn night_restart_of(n: &serde_json::Value) -> serde_json::Value {
    if n["pending"] != true {
        return serde_json::Value::Null;
    }
    serde_json::json!({ "pending": true, "since": n["since"], "waiting": n["waiting"], "blockedNights": n["blockedNights"], "alarm": n["alarm"] })
}

/// `state/lan.json` as the supervisor last wrote it, while the LAN ingress is on.
pub fn read_lan(file: Option<&std::path::Path>) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(file?).ok()?).ok()
}

/// An interactive ping unanswered this long while measuring: a sample of at least that, and the next goes out.
const PING_GIVE_UP: Duration = Duration::from_secs(10);

/// One connection on an open stream: `hello`, `welcome`, then pings and frames until it ends.
pub async fn session<S>(url: &str, stream: S, hello: serde_json::Value, ch: &str, timing: Timing, status: &Status, hooks: Hooks) -> Ended
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut ws = match tokio_tungstenite::client_async(url, stream).await {
        Ok((ws, _)) => ws,
        Err(e) => return Ended::Closed(format!("the WebSocket handshake failed: {e}")),
    };
    if let Err(e) = ws.send(Message::text(hello.to_string())).await {
        return Ended::Closed(format!("hello was not sent: {e}"));
    }
    let mut suspended = false;
    // Set by `welcome`, the one way out of the loop below that does not return.
    let outdated: bool;
    let welcomed: serde_json::Value;
    let deadline = Instant::now() + timing.welcome;
    // `welcome` within 10 s. A `clone-alarm` may come before it.
    loop {
        let frame = match tokio::time::timeout_at(deadline.into(), ws.next()).await {
            Err(_) => return Ended::Closed("no welcome within 10 s".into()),
            Ok(None) => return Ended::Closed("the socket ended before welcome".into()),
            Ok(Some(Err(e))) => return Ended::Closed(format!("{e}")),
            Ok(Some(Ok(m))) => m,
        };
        match frame {
            Message::Text(t) => {
                let v: serde_json::Value = serde_json::from_str(t.as_str()).unwrap_or_default();
                match v["t"].as_str() {
                    Some("clone-alarm") => suspended = true,
                    Some("welcome") => {
                        suspended |= v["suspended"].as_bool().unwrap_or(false);
                        // The licences are kept, and left out of the status: a JWS is noise there.
                        let mut orgs = v["orgs"].clone();
                        for org in orgs.as_array_mut().into_iter().flatten() {
                            if let (Some(jws), Some(keep)) = (org["entitlements"].as_str(), &hooks.licence) {
                                keep(jws);
                            }
                            if let Some(o) = org.as_object_mut() {
                                o.remove("entitlements");
                            }
                        }
                        outdated = v["outdated"].as_bool().unwrap_or(false);
                        welcomed = orgs.clone();
                        set(status, ch, serde_json::json!({
                            "state": "connected",
                            "since": now_iso(),
                            "suspended": suspended,
                            "outdated": outdated,
                            "orgs": orgs,
                            "minMasterVersion": v["minMasterVersion"],
                        }));
                        if suspended {
                            tracing::error!(ch, "CLONE ALARM: another machine is connected as this server; global trusts neither until an administrator registers the real one again");
                        }
                        break;
                    }
                    Some("revoked") => return Ended::Revoked(v["message"].as_str().unwrap_or("revoked").into()),
                    _ => {}
                }
            }
            Message::Close(f) => return f.map(|f| close_ended(u16::from(f.code), f.reason.as_str())).unwrap_or(Ended::Closed("closed".into())),
            _ => {}
        }
    }

    // FR-20.64: the mirror's pages, on the bulk socket of a master linked at Full.
    // FR-20.69: and the org's files behind them, with the words that go with them.
    let (page_tx, mut page_rx) = tokio::sync::mpsc::channel::<crate::replication::Out>(1);
    let (answer_tx, answer_rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
    let mut pumping = false;
    let _pump = match &hooks.pages {
        Some(p) if ch == "bulk" && !suspended && !outdated => {
            let starts = crate::replication::starts(&welcomed, &p.node_id);
            if starts.is_empty() {
                None
            } else {
                pumping = true;
                Some(AbortOnDrop(tokio::spawn(crate::replication::pump(starts, p.source.clone(), page_tx, answer_rx, status.clone(), crate::replication::PumpTiming::default(), hooks.pacer.clone()))))
            }
        }
        _ => None,
    };

    // FR-20.73 (P3-4c): the tunnel to the orgs' addresses, on the interactive socket of a server global
    // trusts. Its frames go out through `tun_rx`, below; a clone alarm ends it with every stream it carries.
    let (tun_tx, mut tun_rx) = tokio::sync::mpsc::channel::<Message>(64);
    let mut tunnel = match &hooks.tunnel {
        Some(up) if ch == "interactive" && !suspended && !outdated => Some(crate::tunnel::Tunnel::new(up.clone(), tun_tx).until_setup_complete(hooks.setup_marker.clone())),
        _ => None,
    };

    // FR-20.52: the interactive socket times its pings for the bulk socket's pacer. Numbered, so a
    // late pong is still timed for its own ping (a global that does not echo the number: only a
    // ping alone in flight is timed).
    let pacer = if ch == "interactive" { hooks.pacer.clone() } else { None };
    let mut ping_n: u64 = 0;
    let mut in_flight: std::collections::VecDeque<(u64, Instant)> = std::collections::VecDeque::new();
    let mut last_ping = Instant::now();
    // The first health soon after welcome, then once a minute.
    let mut health_tick = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(2).min(timing.health), timing.health);
    let mut last = Instant::now();
    loop {
        let now = Instant::now();
        let measuring = pacer.as_ref().is_some_and(|p| p.wants_samples(now));
        let every = if measuring { crate::pacing::SAMPLE_EVERY.min(timing.ping) } else { timing.ping };
        // While measuring, one ping at a time: a second behind the first would time the queue twice.
        // One unanswered for ten seconds is a ten-second sample already, and the next goes out.
        let oldest = in_flight.front().map(|(_, at)| *at);
        let waiting = measuring && oldest.is_some_and(|at| now.duration_since(at) < PING_GIVE_UP);
        let due = if waiting { oldest.expect("waiting") + PING_GIVE_UP } else { last_ping + every };
        // Woken at least every second: bulk may start while a slow ping is due.
        let wake = due.min(now + Duration::from_secs(1));
        tokio::select! {
            _ = tokio::time::sleep_until(wake.into()) => {
                let now = Instant::now();
                if now < due {
                    continue;
                }
                if let (Some(p), Some(at)) = (&pacer, oldest) {
                    if measuring && now.duration_since(at) >= PING_GIVE_UP {
                        p.sample(now.duration_since(at), now);
                    }
                }
                ping_n += 1;
                if let Err(e) = ws.send(Message::text(format!(r#"{{"t":"ping","n":{ping_n}}}"#))).await {
                    return Ended::Closed(format!("a ping was not sent: {e}"));
                }
                in_flight.push_back((ping_n, Instant::now()));
                while in_flight.len() > 8 {
                    in_flight.pop_front();
                }
                last_ping = Instant::now();
            }
            _ = health_tick.tick(), if hooks.health.is_some() => {
                let frame = (hooks.health.as_ref().expect("guarded"))().await;
                if let Err(e) = ws.send(Message::text(frame.to_string())).await {
                    return Ended::Closed(format!("health was not sent: {e}"));
                }
                patch(status, ch, "lastHealthAt", now_iso().into());
            }
            Some(frame) = tun_rx.recv(), if tunnel.is_some() => {
                if let Err(e) = ws.send(frame).await {
                    return Ended::Closed(format!("a tunnel frame was not sent: {e}"));
                }
            }
            Some(frame) = page_rx.recv(), if pumping => {
                let sent = match frame {
                    crate::replication::Out::Binary(bytes) => ws.send(Message::binary(bytes)).await,
                    crate::replication::Out::Text(word) => ws.send(Message::text(word)).await,
                };
                if let Err(e) = sent {
                    return Ended::Closed(format!("a mirror frame was not sent: {e}"));
                }
            }
            _ = tokio::time::sleep_until((last + timing.silent).into()) => {
                let _ = ws.close(None).await;
                return Ended::Closed(format!("nothing heard for {} s", timing.silent.as_secs()));
            }
            frame = ws.next() => {
                last = Instant::now();
                match frame {
                    None => return Ended::Closed("the socket ended".into()),
                    Some(Err(e)) => return Ended::Closed(format!("{e}")),
                    Some(Ok(Message::Text(t))) => {
                        let v: serde_json::Value = serde_json::from_str(t.as_str()).unwrap_or_default();
                        match v["t"].as_str() {
                            Some("pong") => {
                                patch(status, ch, "lastPongAt", now_iso().into());
                                let sent = match v["n"].as_u64() {
                                    Some(n) => in_flight.iter().position(|(k, _)| *k == n).and_then(|i| in_flight.remove(i)).map(|(_, at)| at),
                                    // A global that echoes no number: only a ping alone in flight is timed.
                                    None if in_flight.len() == 1 => in_flight.pop_front().map(|(_, at)| at),
                                    None => {
                                        in_flight.clear();
                                        None
                                    }
                                };
                                if let (Some(p), Some(at)) = (&pacer, sent) {
                                    let now = Instant::now();
                                    p.sample(now.duration_since(at), now);
                                    patch(status, "bulk", "pacing", p.snapshot());
                                }
                            }
                            Some("clone-alarm") => {
                                patch(status, ch, "suspended", true.into());
                                // Global carries nothing more for a socket it does not trust.
                                tunnel = None;
                                tracing::error!(ch, "CLONE ALARM: another machine is connected as this server; global trusts neither until an administrator registers the real one again");
                            }
                            Some("revoked") => return Ended::Revoked(v["message"].as_str().unwrap_or("revoked").into()),
                            Some("master_outdated") => {
                                patch(status, ch, "outdated", true.into());
                                patch(status, ch, "minMasterVersion", v["minMasterVersion"].clone());
                                tracing::warn!(ch, "global: {}", v["message"].as_str().unwrap_or("this server is older than lgrai.app's minimum"));
                            }
                            Some("entitlements") => {
                                if let (Some(jws), Some(keep)) = (v["jws"].as_str(), &hooks.licence) {
                                    keep(jws);
                                }
                            }
                            Some("page-ack" | "page-refused" | "page-error" | "blob-want" | "blob-ack" | "blob-refused" | "blob-error") => {
                                let _ = answer_tx.send(v);
                            }
                            Some(t) if t.starts_with("tun-") => {
                                if let Some(tn) = tunnel.as_mut() {
                                    tn.control(&v);
                                }
                            }
                            Some("error") => tracing::warn!(ch, code = v["code"].as_str().unwrap_or(""), "global: {}", v["message"].as_str().unwrap_or("")),
                            _ => {}
                        }
                    }
                    Some(Ok(Message::Binary(b))) if crate::tunnel::is_frame(&b) => {
                        if let Some(tn) = tunnel.as_mut() {
                            tn.data(&b);
                        }
                    }
                    Some(Ok(Message::Close(f))) => return f.map(|f| close_ended(u16::from(f.code), f.reason.as_str())).unwrap_or(Ended::Closed("closed".into())),
                    Some(Ok(_)) => {}
                }
            }
        }
    }
}

/// One connection to the registration's server: a token, the stream, then the session.
async fn once(registrar: &Registrar, reg: &register::Registration, ch: &str, boot_nonce: &str, timing: Timing, status: &Status, wants: Wants) -> Result<Ended> {
    let key = NodeKey::load_or_create(&registrar.data)?;
    let token = register::fetch_token(&reg.server, &reg.node_id, &key, &registrar.client).await?;
    let (host, port, _) = crate::https::split_url(&reg.server)?;
    let stream = registrar.client.connect(&host, port).await?;
    let authority = if port == 443 { host.clone() } else { format!("{host}:{port}") };
    let url = format!("wss://{authority}/api/node/v1/uplink?ch={ch}");
    let hello = serde_json::json!({
        "t": "hello",
        "v": 1,
        "ch": ch,
        "token": token,
        "bootNonce": boot_nonce,
        "versions": { "app": env!("CARGO_PKG_VERSION"), "protocol": 1 },
        "orgs": [],
        "clock": now_iso(),
    });
    let hooks = Hooks {
        health: wants.health,
        licence: Some(licence_hook(registrar.data.clone(), reg.node_id.clone())),
        pages: wants.pages.map(|source| PagesHook { source, node_id: reg.node_id.clone() }),
        pacer: wants.pacer,
        tunnel: wants.tunnel,
        setup_marker: Some(registrar.data.join("state").join("setup-complete")),
    };
    Ok(session(&url, stream, hello, ch, timing, status, hooks).await)
}

/// A licence from global: verified and kept, and said in the log either way. A bad one changes
/// nothing: the master keeps the licence it holds.
fn licence_hook(data: std::path::PathBuf, node: String) -> LicenceFn {
    Arc::new(move |jws: &str| match crate::licence::keep(&data, jws, &node) {
        Ok(k) if k.changed => tracing::info!(org = %k.licence.org, plan = %k.licence.plan, paid_through = %k.licence.paid_through, "a licence from global was kept"),
        Ok(_) => {}
        Err(e) => tracing::warn!("a licence from global was not kept: {e:#}"),
    })
}

/// One channel, for as long as the supervisor runs. `health` and `tunnel` only on the interactive
/// channel, `pages` only on the bulk one; `pacer` on both (the interactive one feeds it, the bulk one
/// is paced by it).
#[allow(clippy::too_many_arguments)]
pub async fn run(registrar: Arc<Registrar>, ch: &'static str, boot_nonce: String, status: Status, timing: Timing, health: Option<HealthFn>, pages: Option<Arc<dyn crate::replication::PageSource>>, pacer: Option<Arc<crate::pacing::Pacer>>, tunnel: Option<Arc<crate::ingress::Upstream>>) {
    let wants = Wants { health, pages, pacer, tunnel };
    let mut attempt: u32 = 0;
    // The registration a 4403 ended: the uplink waits for a newer one.
    let mut revoked: Option<i64> = None;
    loop {
        let Some(reg) = register::current(&registrar.data) else {
            set(&status, ch, serde_json::json!({ "state": "not_registered" }));
            wait(&registrar, timing.idle_check).await;
            continue;
        };
        if revoked == Some(reg.registered_at) {
            wait(&registrar, timing.idle_check).await;
            continue;
        }
        set(&status, ch, serde_json::json!({ "state": "connecting", "since": now_iso() }));
        let started = Instant::now();
        match once(&registrar, &reg, ch, &boot_nonce, timing, &status, wants.clone()).await {
            Ok(Ended::Revoked(why)) => {
                tracing::error!(ch, "the uplink was refused (revoked): {why}. The shop keeps working; register this server again to link it");
                set(&status, ch, serde_json::json!({ "state": "revoked", "since": now_iso(), "error": why }));
                revoked = Some(reg.registered_at);
                attempt = 0;
            }
            ended => {
                let why = match ended {
                    Ok(Ended::Reauth(w)) | Ok(Ended::Closed(w)) => w,
                    Ok(Ended::Revoked(_)) => unreachable!(),
                    Err(e) => format!("{e:#}"),
                };
                // A connection that lasted resets the backoff: one drop after an hour is not a storm.
                if started.elapsed() > Duration::from_secs(60) {
                    attempt = 0;
                }
                let delay = backoff(attempt, timing.max_backoff);
                attempt = attempt.saturating_add(1);
                tracing::warn!(ch, retry_in_ms = delay.as_millis() as u64, "the uplink is down: {why}");
                set(&status, ch, serde_json::json!({ "state": "backoff", "since": now_iso(), "error": why, "retryInSecs": delay.as_secs() }));
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = registrar.wake.notified() => attempt = 0,
                }
            }
        }
    }
}

/// Until `d` passes or a registration wakes the uplink.
async fn wait(registrar: &Registrar, d: Duration) {
    tokio::select! {
        _ = tokio::time::sleep(d) => {}
        _ = registrar.wake.notified() => {}
    }
}

/// Fresh per supervisor start: the same across this boot's reconnects, never across machines.
pub fn boot_nonce() -> Result<String> {
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::thread_rng().try_fill_bytes(&mut b).context("no randomness for the boot nonce")?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

    fn quick() -> Timing {
        Timing { ping: Duration::from_millis(100), silent: Duration::from_millis(600), welcome: Duration::from_secs(2), max_backoff: Duration::from_secs(1), idle_check: Duration::from_millis(100), health: Duration::from_millis(150) }
    }

    /// A fake global: accepts one socket, checks the hello, then plays `script`.
    async fn fake_global(script: fn(serde_json::Value) -> Vec<Option<Message>>) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let mut heard = vec![];
            let hello = match ws.next().await {
                Some(Ok(Message::Text(t))) => t.to_string(),
                other => panic!("no hello: {other:?}"),
            };
            heard.push(hello.clone());
            for step in script(serde_json::from_str(&hello).unwrap()) {
                match step {
                    // `None`: answer whatever comes next, with a pong if it is a ping.
                    None => {
                        if let Some(Ok(Message::Text(t))) = ws.next().await {
                            heard.push(t.to_string());
                            if t.as_str().contains("ping") {
                                let _ = ws.send(Message::text(r#"{"t":"pong"}"#)).await;
                            }
                        }
                    }
                    Some(m) => {
                        let _ = ws.send(m).await;
                    }
                }
            }
            // Then hold the socket, silent, until the client leaves.
            while let Some(Ok(_)) = ws.next().await {}
            heard
        });
        (format!("ws://{addr}/api/node/v1/uplink?ch=interactive"), task)
    }

    fn welcome() -> Message {
        Message::text(serde_json::json!({ "t": "welcome", "suspended": false, "orgs": [{ "orgId": "o1" }] }).to_string())
    }

    fn hello() -> serde_json::Value {
        serde_json::json!({ "t": "hello", "v": 1, "ch": "interactive", "token": "tok", "bootNonce": "boot-test" })
    }

    async fn run_session(url: &str, status: &Status) -> Ended {
        let addr = url.trim_start_matches("ws://").split('/').next().unwrap().to_string();
        let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
        session(url, tcp, hello(), "interactive", quick(), status, Hooks::default()).await
    }

    #[tokio::test]
    async fn a_welcomed_session_pings_and_ends_when_revoked() {
        let (url, server) = fake_global(|hello| {
            assert_eq!((hello["t"].as_str(), hello["bootNonce"].as_str()), (Some("hello"), Some("boot-test")));
            vec![
                Some(welcome()),
                None,
                Some(Message::text(r#"{"t":"revoked","message":"This server has been removed."}"#)),
                Some(Message::Close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame { code: CloseCode::from(4403), reason: "node_revoked".into() }))),
            ]
        })
        .await;
        let status: Status = Arc::new(Mutex::new(serde_json::json!({})));
        let ended = run_session(&url, &status).await;
        assert_eq!(ended, Ended::Revoked("This server has been removed.".into()));
        let s = status.lock().unwrap().clone();
        assert_eq!((s["interactive"]["state"].as_str(), s["interactive"]["suspended"].as_bool()), (Some("connected"), Some(false)));
        assert!(s["interactive"]["lastPongAt"].is_string(), "{s}");
        let heard = server.await.unwrap();
        assert!(heard.iter().any(|h| h.contains("\"ping\"")), "{heard:?}");
    }

    #[tokio::test]
    async fn a_close_4401_asks_for_a_new_token_and_4403_stops() {
        assert_eq!(close_ended(4401, ""), Ended::Reauth("unauthenticated".into()));
        assert_eq!(close_ended(4403, "node_revoked"), Ended::Revoked("node_revoked".into()));
        assert_eq!(close_ended(4409, "replaced"), Ended::Closed("closed 4409 replaced".into()));
        let (url, _server) = fake_global(|_| vec![Some(Message::Close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame { code: CloseCode::from(4401), reason: "unauthenticated".into() })))]).await;
        let status: Status = Arc::new(Mutex::new(serde_json::json!({})));
        assert_eq!(run_session(&url, &status).await, Ended::Reauth("unauthenticated".into()));
    }

    #[tokio::test]
    async fn a_clone_alarm_before_welcome_marks_the_channel_suspended() {
        let (url, _server) = fake_global(|_| vec![Some(Message::text(r#"{"t":"clone-alarm"}"#)), Some(welcome())]).await;
        let status: Status = Arc::new(Mutex::new(serde_json::json!({})));
        // The fake goes silent after: the session ends on its own after `silent`.
        assert!(matches!(run_session(&url, &status).await, Ended::Closed(why) if why.starts_with("nothing heard")));
        assert_eq!(status.lock().unwrap()["interactive"]["suspended"].as_bool(), Some(true));
    }

    #[tokio::test]
    async fn health_goes_out_on_its_tick_and_master_outdated_is_shown() {
        let (url, server) = fake_global(|_| {
            vec![
                Some(Message::text(serde_json::json!({ "t": "welcome", "outdated": true, "minMasterVersion": "9.0.0", "orgs": [] }).to_string())),
                Some(Message::text(r#"{"t":"master_outdated","minMasterVersion":"9.0.0","message":"update it"}"#)),
                None,
                None,
                None,
                None,
            ]
        })
        .await;
        let status: Status = Arc::new(Mutex::new(serde_json::json!({})));
        let addr = url.trim_start_matches("ws://").split('/').next().unwrap().to_string();
        let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
        let lan = serde_json::json!({ "url": "https://192.168.8.115:4443", "caFingerprint": "sha256:J4_Wvnqz" });
        let health: HealthFn = Arc::new(move || {
            let lan = lan.clone();
            let api = serde_json::json!({ "ok": true, "posOpen": 2, "clock": { "trusted": true }, "lastBackupAt": "2026-10-27T02:00:00Z", "fenced": 0, "outboxQueued": 3 });
            Box::pin(async move { health_frame(&serde_json::json!({ "uptimeSecs": 5, "children": [{ "name": "api", "state": "running", "failures": 0 }], "api": api }), Machine { disk: Some((123, 1000)), oplog_window_secs: Some(9 * 86_400) }, Some(&lan)) })
        });
        let mut t = quick();
        t.health = Duration::from_millis(50);
        let ended = session(&url, tcp, hello(), "interactive", t, &status, Hooks { health: Some(health), ..Default::default() }).await;
        assert!(matches!(ended, Ended::Closed(_)));
        let s = status.lock().unwrap()["interactive"].clone();
        assert_eq!((s["outdated"].as_bool(), s["minMasterVersion"].as_str()), (Some(true), Some("9.0.0")));
        let heard = server.await.unwrap();
        let h: serde_json::Value = heard.iter().filter_map(|f| serde_json::from_str::<serde_json::Value>(f).ok()).find(|v| v["t"] == "health").expect("a health frame");
        assert_eq!((h["disk"]["freeBytes"].as_u64(), h["api"]["posOpen"].as_u64(), h["api"]["clockTrusted"].as_bool()), (Some(123), Some(2), Some(true)));
        // P3-8: what the alarms are read from.
        assert_eq!((h["disk"]["totalBytes"].as_u64(), h["oplogWindowSecs"].as_u64()), (Some(1000), Some(9 * 86_400)));
        assert_eq!((h["api"]["lastBackupAt"].as_str(), h["api"]["fenced"].as_u64(), h["api"]["outboxQueued"].as_u64()), (Some("2026-10-27T02:00:00Z"), Some(0), Some(3)));
        assert!(h["clock"].as_str().is_some_and(|c| c.starts_with("20")));
        assert_eq!(h["children"][0]["name"], "api");
        assert_eq!((h["lan"]["url"].as_str(), h["lan"]["caFingerprint"].as_str()), (Some("https://192.168.8.115:4443"), Some("sha256:J4_Wvnqz")));
    }

    #[test]
    fn the_lan_rides_in_health_only_when_the_ingress_names_an_address() {
        let st = serde_json::json!({});
        assert!(health_frame(&st, Machine::default(), None).get("lan").is_none());
        // No address yet (no default route): nothing to re-point a desktop to.
        assert!(health_frame(&st, Machine::default(), Some(&serde_json::json!({ "url": null, "caFingerprint": "sha256:x" }))).get("lan").is_none());
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("lan.json");
        assert!(read_lan(Some(&file)).is_none());
        std::fs::write(&file, r#"{"url":"https://10.0.0.5:4443","caFingerprint":"sha256:abc","extra":1}"#).unwrap();
        let f = health_frame(&st, Machine::default(), read_lan(Some(&file)).as_ref());
        assert_eq!(f["lan"], serde_json::json!({ "url": "https://10.0.0.5:4443", "caFingerprint": "sha256:abc" }));
    }

    #[test]
    fn the_address_watch_and_a_waiting_night_restart_ride_in_health() {
        let st = serde_json::json!({
            "addressCheck": { "on": true, "address": "10.0.0.5", "interface": "enp1s0", "conflict": {
                "at": "2026-10-30T02:00:00Z", "firstSeen": "2026-10-30T01:58:00Z", "address": "10.0.0.5",
                "otherMac": "52:54:00:ab:cd:ef", "interface": "enp1s0", "probableClone": true } },
            "nightRestart": { "pending": true, "since": "2026-10-22T07:00:00Z", "waiting": "waits: 2 POS session(s) open",
                "blockedNights": 7, "alarm": true, "libraries": ["/usr/lib/x86_64-linux-gnu/libssl.so.3"], "processes": ["lgr-server"] },
        });
        let f = health_frame(&st, Machine::default(), None);
        assert_eq!(f["address"], serde_json::json!({ "on": true, "reason": null, "conflict": {
            "address": "10.0.0.5", "otherMac": "52:54:00:ab:cd:ef", "firstSeen": "2026-10-30T01:58:00Z", "at": "2026-10-30T02:00:00Z", "probableClone": true } }));
        assert_eq!(f["nightRestart"], serde_json::json!({ "pending": true, "since": "2026-10-22T07:00:00Z", "waiting": "waits: 2 POS session(s) open", "blockedNights": 7, "alarm": true }));
        // Off Linux there is no watch; nothing waits, nothing is said.
        let quiet = health_frame(&serde_json::json!({ "addressCheck": null, "nightRestart": { "pending": false } }), Machine::default(), None);
        assert!(quiet["address"].is_null() && quiet["nightRestart"].is_null());
        // Watched, no conflict, and why not when it is off.
        let off = health_frame(&serde_json::json!({ "addressCheck": { "on": false, "reason": "no file capability", "conflict": null } }), Machine::default(), None);
        assert_eq!(off["address"], serde_json::json!({ "on": false, "reason": "no file capability", "conflict": null }));
    }

    #[tokio::test]
    async fn licences_in_welcome_and_in_an_entitlements_frame_are_kept_and_kept_out_of_the_status() {
        let (url, _server) = fake_global(|_| {
            vec![
                Some(Message::text(serde_json::json!({ "t": "welcome", "orgs": [{ "orgId": "o1", "entitlements": "jws-in-welcome" }] }).to_string())),
                Some(Message::text(r#"{"t":"entitlements","orgId":"o1","jws":"jws-later"}"#)),
            ]
        })
        .await;
        let status: Status = Arc::new(Mutex::new(serde_json::json!({})));
        let got: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let sink = got.clone();
        let hooks = Hooks { licence: Some(Arc::new(move |j: &str| sink.lock().unwrap().push(j.to_string()))), ..Default::default() };
        let addr = url.trim_start_matches("ws://").split('/').next().unwrap().to_string();
        let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
        let _ = session(&url, tcp, hello(), "interactive", quick(), &status, hooks).await;
        assert_eq!(*got.lock().unwrap(), vec!["jws-in-welcome".to_string(), "jws-later".to_string()]);
        let s = status.lock().unwrap().clone();
        assert_eq!(s["interactive"]["orgs"][0]["orgId"], "o1");
        assert!(s["interactive"]["orgs"][0].get("entitlements").is_none(), "{s}");
    }

    /// The API as the pump sees it: a first page, then one only from the point global acknowledged.
    struct TwoPages(Mutex<Vec<(u64, String)>>);

    impl crate::replication::PageSource for TwoPages {
        fn page<'a>(&'a self, _org: &'a str, after: u64, after_hash: &'a str) -> crate::replication::BoxFut<'a, Result<crate::replication::Built>> {
            Box::pin(async move {
                self.0.lock().unwrap().push((after, after_hash.to_string()));
                Ok(match (after, after_hash) {
                    (0, "") => crate::replication::Built::Page { bytes: b"first".to_vec(), to_seq: 4 },
                    (4, "h4") => crate::replication::Built::Page { bytes: b"second".to_vec(), to_seq: 9 },
                    _ => crate::replication::Built::Empty,
                })
            })
        }
        fn resend<'a>(&'a self, _ask: serde_json::Value) -> crate::replication::BoxFut<'a, Result<()>> {
            Box::pin(async { Ok(()) })
        }
    }

    #[tokio::test]
    async fn on_the_bulk_socket_pages_go_out_as_binary_and_the_acks_come_back_to_the_pump() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        // A global that welcomes one org this master is home of at Full, acknowledges the first page,
        // and keeps the second.
        let global = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let _hello = ws.next().await;
            let welcome = serde_json::json!({ "t": "welcome", "orgs": [
                { "orgId": "o1", "home": "master-me", "linkLevel": "full", "state": "active", "mirror": { "watermark": 0, "chainHash": "" } },
                { "orgId": "o2", "home": "master-me", "linkLevel": "control", "state": "active" },
            ] });
            ws.send(Message::text(welcome.to_string())).await.unwrap();
            let mut pages = vec![];
            while pages.len() < 2 {
                match ws.next().await {
                    Some(Ok(Message::Binary(b))) => {
                        pages.push(b.to_vec());
                        if pages.len() == 1 {
                            let ack = serde_json::json!({ "t": "page-ack", "orgId": "o1", "toSeq": 4, "watermark": 4, "chainHash": "h4", "resend": [] });
                            ws.send(Message::text(ack.to_string())).await.unwrap();
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => break,
                }
            }
            pages
        });
        let source = Arc::new(TwoPages(Mutex::new(vec![])));
        let hooks = Hooks { pages: Some(PagesHook { source: source.clone(), node_id: "master-me".into() }), ..Default::default() };
        let status: Status = Arc::new(Mutex::new(serde_json::json!({})));
        let url = format!("ws://{addr}/api/node/v1/uplink?ch=bulk");
        let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
        let hello = serde_json::json!({ "t": "hello", "v": 1, "ch": "bulk", "token": "tok", "bootNonce": "boot-test" });
        let running = tokio::spawn({
            let status = status.clone();
            async move { session(&url, tcp, hello, "bulk", quick(), &status, hooks).await }
        });
        let pages = tokio::time::timeout(Duration::from_secs(5), global).await.expect("both pages in time").unwrap();
        running.abort();
        assert_eq!(pages, vec![b"first".to_vec(), b"second".to_vec()]);
        // Only the org at Full was paged, and the second page was built from what global acknowledged.
        assert_eq!(source.0.lock().unwrap()[..2], [(0, String::new()), (4, "h4".to_string())]);
        let s = status.lock().unwrap()["bulk"]["replication"].clone();
        assert!(s["o1"].is_object() && s["o2"].is_null(), "{s}");
    }

    /// A fake global for the pacer: welcomes, then answers each ping with its number, `delay` later
    /// (the queue on the line). Returns the pings it heard.
    async fn echoing_global(delay: Duration) -> (String, Arc<Mutex<Vec<serde_json::Value>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let pings = Arc::new(Mutex::new(vec![]));
        let heard = pings.clone();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let (mut tx, mut rx) = ws.split();
            let _hello = rx.next().await;
            let (pong_tx, mut pong_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            let _ = pong_tx.send(serde_json::json!({ "t": "welcome", "suspended": false, "orgs": [] }).to_string());
            tokio::spawn(async move {
                while let Some(m) = pong_rx.recv().await {
                    if tx.send(Message::text(m)).await.is_err() {
                        break;
                    }
                }
            });
            while let Some(Ok(Message::Text(t))) = rx.next().await {
                let v: serde_json::Value = serde_json::from_str(t.as_str()).unwrap_or_default();
                if v["t"] == "ping" {
                    heard.lock().unwrap().push(v.clone());
                    let tx = pong_tx.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(delay).await;
                        let _ = tx.send(serde_json::json!({ "t": "pong", "n": v["n"] }).to_string());
                    });
                }
            }
        });
        (format!("ws://{addr}/api/node/v1/uplink?ch=interactive"), pings)
    }

    /// An interactive session that pings every 3 s unless the pacer wants samples, for `for_`.
    async fn measured_session(url: &str, pacer: Arc<crate::pacing::Pacer>, for_: Duration) -> Status {
        let addr = url.trim_start_matches("ws://").split('/').next().unwrap().to_string();
        let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
        // The bulk channel's own session made its status object; the pacing goes into it.
        let status: Status = Arc::new(Mutex::new(serde_json::json!({ "bulk": {} })));
        let t = Timing { ping: Duration::from_secs(3), silent: Duration::from_secs(60), welcome: Duration::from_secs(2), max_backoff: Duration::from_secs(1), idle_check: Duration::from_millis(100), health: Duration::from_secs(60) };
        let hooks = Hooks { pacer: Some(pacer), ..Default::default() };
        let _ = tokio::time::timeout(for_, session(url, tcp, hello(), "interactive", t, &status, hooks)).await;
        status
    }

    #[tokio::test]
    async fn while_bulk_has_work_the_interactive_socket_times_its_pings_for_the_pacer() {
        let (url, pings) = echoing_global(Duration::from_millis(300)).await;
        let pacer = Arc::new(crate::pacing::Pacer::new(Instant::now()));
        // Bulk sends: the pacer wants the line measured.
        let _ = pacer.reserve(crate::pacing::PIECE_MIN, Instant::now());
        let status = measured_session(&url, pacer.clone(), Duration::from_millis(4_700)).await;
        let heard = pings.lock().unwrap().clone();
        // Every two seconds, not the session's three, each with its number.
        assert_eq!(heard.iter().map(|p| p["n"].as_u64()).collect::<Vec<_>>(), vec![Some(1), Some(2)], "{heard:?}");
        let rtt = pacer.snapshot()["lastRttMs"].as_u64().unwrap();
        assert!((250..1_500).contains(&rtt), "{rtt}");
        // And `lgr-server status` says it.
        assert_eq!(status.lock().unwrap()["bulk"]["pacing"]["lastRttMs"].as_u64(), Some(rtt));
    }

    #[tokio::test]
    async fn while_measuring_one_ping_at_a_time_a_queued_one_is_not_timed_twice() {
        // The line's queue holds each pong three seconds: the second ping waits for the first's.
        let (url, pings) = echoing_global(Duration::from_secs(3)).await;
        let pacer = Arc::new(crate::pacing::Pacer::new(Instant::now()));
        let _ = pacer.reserve(crate::pacing::PIECE_MIN, Instant::now());
        measured_session(&url, pacer.clone(), Duration::from_millis(4_700)).await;
        // The first went at two seconds; the second was due at four, and waits for the first's pong.
        assert_eq!(pings.lock().unwrap().len(), 1);
        assert!(pacer.snapshot()["lastRttMs"].is_null());
    }

    #[test]
    fn backoff_is_full_jitter_up_to_five_minutes() {
        for attempt in 0..30 {
            let d = backoff(attempt, Duration::from_secs(300));
            assert!(d <= Duration::from_secs(1).saturating_mul(2u32.saturating_pow(attempt.min(20))).min(Duration::from_secs(300)));
        }
        assert!(backoff(0, Duration::from_secs(300)) <= Duration::from_secs(1));
        assert_ne!(boot_nonce().unwrap(), boot_nonce().unwrap());
    }
}
