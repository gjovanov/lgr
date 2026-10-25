//! The uplink, the supervisor's side (FR-20.52, plan step P2-2b): a registered master's two sockets
//! to global, `wss://<server>/api/node/v1/uplink?ch=interactive|bulk`.
//!
//! Each channel is one task, for as long as the supervisor runs:
//! - **Not registered:** it waits, and starts within moments of `lgr-server register`.
//! - **Connecting:** a token for a fresh assertion (`register::fetch_token`), the socket through the
//!   machine's proxy rules and the OS trust store (`Https::connect`), then `hello`, with this boot's
//!   nonce. The URL carries no credential.
//! - **Connected:** a ping every 30 s; a socket that hears nothing for 75 s is dead, and is replaced.
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

fn patch(status: &Status, ch: &str, key: &str, value: serde_json::Value) {
    let mut s = status.lock().unwrap();
    if let Some(obj) = s.get_mut(ch).and_then(|c| c.as_object_mut()) {
        obj.insert(key.to_string(), value);
    }
}

fn now_iso() -> String {
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
/// `status_with_api` gives it) and the data volume's free space. Global keeps known fields only.
pub fn health_frame(status: &serde_json::Value, free_bytes: Option<u64>) -> serde_json::Value {
    let children: Vec<serde_json::Value> = status["children"]
        .as_array()
        .map(|cs| cs.iter().map(|c| serde_json::json!({ "name": c["name"], "state": c["state"], "failures": c["failures"] })).collect())
        .unwrap_or_default();
    serde_json::json!({
        "t": "health",
        "versions": { "app": env!("CARGO_PKG_VERSION"), "protocol": 1 },
        "uptimeSecs": status["uptimeSecs"],
        "children": children,
        "disk": { "freeBytes": free_bytes },
        "api": {
            "ok": status["api"]["ok"],
            "posOpen": status["api"]["posOpen"],
            "fiscalInFlight": status["api"]["fiscalInFlight"],
            "clockTrusted": status["api"]["clock"]["trusted"],
        },
        // FR-20.20: what runs, what is available, and an update kept out by open tills (the alarm).
        "update": status["update"],
    })
}

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
                        set(status, ch, serde_json::json!({
                            "state": "connected",
                            "since": now_iso(),
                            "suspended": suspended,
                            "outdated": v["outdated"].as_bool().unwrap_or(false),
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

    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + timing.ping, timing.ping);
    // The first health soon after welcome, then once a minute.
    let mut health_tick = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(2).min(timing.health), timing.health);
    let mut last = Instant::now();
    loop {
        tokio::select! {
            _ = ping.tick() => {
                if let Err(e) = ws.send(Message::text(r#"{"t":"ping"}"#)).await {
                    return Ended::Closed(format!("a ping was not sent: {e}"));
                }
            }
            _ = health_tick.tick(), if hooks.health.is_some() => {
                let frame = (hooks.health.as_ref().expect("guarded"))().await;
                if let Err(e) = ws.send(Message::text(frame.to_string())).await {
                    return Ended::Closed(format!("health was not sent: {e}"));
                }
                patch(status, ch, "lastHealthAt", now_iso().into());
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
                            Some("pong") => patch(status, ch, "lastPongAt", now_iso().into()),
                            Some("clone-alarm") => {
                                patch(status, ch, "suspended", true.into());
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
                            Some("error") => tracing::warn!(ch, code = v["code"].as_str().unwrap_or(""), "global: {}", v["message"].as_str().unwrap_or("")),
                            _ => {}
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
async fn once(registrar: &Registrar, reg: &register::Registration, ch: &str, boot_nonce: &str, timing: Timing, status: &Status, health: Option<HealthFn>) -> Result<Ended> {
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
    let hooks = Hooks { health, licence: Some(licence_hook(registrar.data.clone(), reg.node_id.clone())) };
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

/// One channel, for as long as the supervisor runs. `health` only on the interactive channel.
pub async fn run(registrar: Arc<Registrar>, ch: &'static str, boot_nonce: String, status: Status, timing: Timing, health: Option<HealthFn>) {
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
        match once(&registrar, &reg, ch, &boot_nonce, timing, &status, health.clone()).await {
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
        let health: HealthFn = Arc::new(|| Box::pin(async { health_frame(&serde_json::json!({ "uptimeSecs": 5, "children": [{ "name": "api", "state": "running", "failures": 0 }], "api": { "ok": true, "posOpen": 2, "clock": { "trusted": true } } }), Some(123)) }));
        let mut t = quick();
        t.health = Duration::from_millis(50);
        let ended = session(&url, tcp, hello(), "interactive", t, &status, Hooks { health: Some(health), licence: None }).await;
        assert!(matches!(ended, Ended::Closed(_)));
        let s = status.lock().unwrap()["interactive"].clone();
        assert_eq!((s["outdated"].as_bool(), s["minMasterVersion"].as_str()), (Some(true), Some("9.0.0")));
        let heard = server.await.unwrap();
        let h: serde_json::Value = heard.iter().filter_map(|f| serde_json::from_str::<serde_json::Value>(f).ok()).find(|v| v["t"] == "health").expect("a health frame");
        assert_eq!((h["disk"]["freeBytes"].as_u64(), h["api"]["posOpen"].as_u64(), h["api"]["clockTrusted"].as_bool()), (Some(123), Some(2), Some(true)));
        assert_eq!(h["children"][0]["name"], "api");
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
        let hooks = Hooks { health: None, licence: Some(Arc::new(move |j: &str| sink.lock().unwrap().push(j.to_string()))) };
        let addr = url.trim_start_matches("ws://").split('/').next().unwrap().to_string();
        let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
        let _ = session(&url, tcp, hello(), "interactive", quick(), &status, hooks).await;
        assert_eq!(*got.lock().unwrap(), vec!["jws-in-welcome".to_string(), "jws-later".to_string()]);
        let s = status.lock().unwrap().clone();
        assert_eq!(s["interactive"]["orgs"][0]["orgId"], "o1");
        assert!(s["interactive"]["orgs"][0].get("entitlements").is_none(), "{s}");
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
