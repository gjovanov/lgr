//! FR-20.32 — the loopback proxy: how `lgr-web` reaches a master.
//!
//! A desktop registered to lgrai.app loads `https://lgrai.app` straight. A desktop paired with a
//! master cannot: the webview trusts the OS store, and the master's certificate comes from its own
//! CA, pinned in `trust.rs` and installed nowhere. So the window loads `http://127.0.0.1:<port>`, a
//! secure context by definition, and this forwards each request to the master over TLS pinned to
//! that CA. It adds the desktop's token in `X-LGR-Desktop-Token`, which the master's LAN listener
//! asks every request for; the user's own session is checked on top, as everywhere.
//!
//! Every process on the machine can reach a loopback port, and so can every page in every browser
//! on it. So (FR-16.16):
//! - **`Host` must be `127.0.0.1:<port>`.** A page that points its own name at 127.0.0.1 (DNS
//!   rebinding) still sends that name.
//! - **A per-launch secret**, in an `HttpOnly; SameSite=Strict` cookie. The window gets it at
//!   `/__lgr/boot#<secret>`: a fragment never leaves the webview, and the page posts it here and drops
//!   it from the address. A request without it is refused, so another program on the till cannot
//!   borrow the desktop's credential through this port.
//! - **`Origin`, when sent, must be this one.**
//! - **The same port for the installation** (`settings.proxyPort`), so the window's per-origin storage
//!   survives a restart. On a re-point the shell clears that storage (`web.rs`).
//! - **WebSocket upgrades** are forwarded too, as a byte pipe once the master has answered 101.
//!
//! ⚠ The window only. The shell's own clients (enrollment, presence, the bridge, the updater) reach
//! the master through `trust.rs` directly, never through this.
//!
//! ⚠ One upstream connection per request, as the master's own ingress does. On a LAN that costs a
//! TCP and a TLS handshake (resumed: the config keeps its session cache), and it rules out the
//! request that dies on a keep-alive the master closed while it was idle, which for a POST is a sale
//! nobody can safely retry.

use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Empty, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{
    HeaderMap, HeaderName, HeaderValue, CACHE_CONTROL, CONNECTION, CONTENT_TYPE, COOKIE, HOST, LOCATION, ORIGIN,
    REFERER, SET_COOKIE, UPGRADE,
};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use sha2::{Digest, Sha256};

pub type Body = BoxBody<Bytes, hyper::Error>;

/// The proxy's own page: where the window learns the launch secret.
pub const BOOT_PATH: &str = "/__lgr/boot";
/// The cookie that carries the launch secret. Never forwarded to the master.
pub const LAUNCH_COOKIE: &str = "lgr_launch";

/// Headers that describe one hop, never the request (RFC 9110 §7.6.1).
const HOP_BY_HOP: &[&str] = &[
    "connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer",
    "transfer-encoding", "upgrade",
];

/// Where the window's requests go, and with what.
pub struct Upstream {
    /// The master, as paired: `https://192.168.1.10:4443`.
    pub origin: url::Url,
    /// TLS pinned to its CA (`trust::pinned_tls`).
    pub tls: Arc<rustls::ClientConfig>,
    /// The desktop's token. A function, so the tests can hand in their own; the shell's mints one
    /// (`enroll::mint_token`, blocking: it is called off the runtime's threads).
    pub token: Arc<dyn Fn() -> Result<String, String> + Send + Sync>,
}

type Log = Arc<dyn Fn(&str) + Send + Sync>;

struct State {
    port: u16,
    secret: String,
    up: Upstream,
    /// Where the master answers now: `up.origin` until DHCP moves it (`Running::retarget`).
    origin: std::sync::RwLock<url::Url>,
    /// The token and when it was minted. ⚠ A token lives 15 minutes (`config.desktop.tokenTtlSec`);
    /// it is replaced after 10, and at once when the master refuses it.
    token: tokio::sync::Mutex<Option<(String, Instant)>>,
    log: Log,
}

impl State {
    fn origin(&self) -> url::Url {
        self.origin.read().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

/// A running proxy. `stop` ends it; dropping the handle does not.
pub struct Running {
    pub port: u16,
    secret: String,
    /// The master it forwards to, as an origin.
    pub master: String,
    stop: tokio::sync::watch::Sender<bool>,
    state: Arc<State>,
}

impl Running {
    /// FR-20.28 — the same master, found at a new address after a DHCP change: forward there from
    /// now on. ⚠ Same port, same secret, same pin: the window keeps its origin and its sessions, and
    /// what proves the master is still the CA it was paired with.
    pub fn retarget(&mut self, origin: url::Url) {
        self.master = origin.origin().ascii_serialization();
        *self.state.origin.write().unwrap_or_else(|p| p.into_inner()) = origin;
    }

    /// The window's origin.
    pub fn origin(&self) -> String {
        origin_for(self.port)
    }

    /// What the window opens: the boot page, the secret in its FRAGMENT (never sent anywhere), and
    /// the path to go on to.
    pub fn boot_url(&self, path: &str) -> String {
        let to: String = url::form_urlencoded::byte_serialize(path.as_bytes()).collect();
        format!("{}{BOOT_PATH}?to={to}#{}", self.origin(), self.secret)
    }

    pub fn stop(&self) {
        let _ = self.stop.send(true);
    }
}

fn origin_for(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn new_secret() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Open the proxy on `127.0.0.1:<preferred>`, or on a port the OS picks when that one is taken (or
/// `0`). The caller keeps the port it got (`settings.proxyPort`): a new port is a new origin, and
/// the window's storage starts over.
pub fn start(up: Upstream, preferred: u16, log: Log) -> Result<Running, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", preferred))
        .or_else(|_| std::net::TcpListener::bind(("127.0.0.1", 0)))
        .map_err(|e| format!("cannot open the loopback proxy: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let master = up.origin.origin().ascii_serialization();
    let secret = new_secret();
    let (stop, mut stopped) = tokio::sync::watch::channel(false);
    let state = Arc::new(State {
        port,
        secret: secret.clone(),
        origin: std::sync::RwLock::new(up.origin.clone()),
        up,
        token: tokio::sync::Mutex::new(None),
        log,
    });
    let kept = state.clone();

    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(l) => l,
            Err(e) => return (state.log)(&format!("proxy: cannot listen: {e}")),
        };
        loop {
            tokio::select! {
                _ = stopped.changed() => break,
                accepted = listener.accept() => {
                    let Ok((stream, peer)) = accepted else { continue };
                    // Bound to 127.0.0.1, so nothing else can connect; said again for the reader.
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    tokio::spawn(serve_connection(stream, state.clone()));
                }
            }
        }
        (state.log)("proxy: stopped");
    });
    Ok(Running { port, secret, master, stop, state: kept })
}

async fn serve_connection(stream: tokio::net::TcpStream, state: Arc<State>) {
    let service = hyper::service::service_fn(move |req| {
        let state = state.clone();
        async move { Ok::<_, std::convert::Infallible>(handle(req, state).await) }
    });
    let _ = hyper::server::conn::http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(Duration::from_secs(30))
        .serve_connection(TokioIo::new(stream), service)
        .with_upgrades()
        .await;
}

// ── The checks ─────────────────────────────────────────────────────────────────────────────────

/// `Host` is this proxy's own address, exactly.
fn host_ok(headers: &HeaderMap, port: u16) -> bool {
    headers.get(HOST).and_then(|h| h.to_str().ok()) == Some(format!("127.0.0.1:{port}").as_str())
}

/// `Origin`, when a request carries one, is this proxy's.
fn origin_ok(headers: &HeaderMap, port: u16) -> bool {
    match headers.get(ORIGIN) {
        None => true,
        Some(o) => o.to_str().ok() == Some(origin_for(port).as_str()),
    }
}

fn cookie_pairs(headers: &HeaderMap) -> impl Iterator<Item = (&str, &str)> {
    headers
        .get_all(COOKIE)
        .into_iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
}

/// Constant-time, so the comparison says nothing about how much of a guess was right.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The request carries this launch's secret.
fn launch_cookie_ok(headers: &HeaderMap, secret: &str) -> bool {
    cookie_pairs(headers).any(|(k, v)| k == LAUNCH_COOKIE && same(v.as_bytes(), secret.as_bytes()))
}

fn tokens(headers: &HeaderMap, name: HeaderName) -> impl Iterator<Item = String> + '_ {
    headers
        .get_all(name)
        .into_iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| !t.is_empty())
}

fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    tokens(headers, CONNECTION).any(|t| t == "upgrade") && tokens(headers, UPGRADE).any(|t| t == "websocket")
}

fn is_navigation(headers: &HeaderMap) -> bool {
    headers.get("sec-fetch-mode").and_then(|v| v.to_str().ok()) == Some("navigate")
        || headers.get("accept").and_then(|v| v.to_str().ok()).is_some_and(|a| a.contains("text/html"))
}

/// The headers a request carries on to the master: the window's, cleaned (hop-by-hop, any
/// `X-LGR-*`, the launch cookie), its `Host`, `Origin` and `Referer` moved to the master's origin,
/// and the desktop's token added.
fn upstream_headers(client: &HeaderMap, port: u16, master: &url::Url, token: &str) -> HeaderMap {
    let named: Vec<String> = tokens(client, CONNECTION).collect();
    let here = origin_for(port);
    let there = master.origin().ascii_serialization();
    let mut out = HeaderMap::with_capacity(client.len() + 2);
    for (name, value) in client {
        let n = name.as_str();
        if n.starts_with("x-lgr-") || HOP_BY_HOP.contains(&n) || named.iter().any(|t| t == n) || name == HOST || name == COOKIE {
            continue;
        }
        if name == ORIGIN {
            // Only ever this proxy's own (`origin_ok`), so it becomes the master's own.
            out.append(ORIGIN, HeaderValue::from_str(&there).expect("an origin is ASCII"));
        } else if name == REFERER {
            if let Some(rest) = value.to_str().ok().and_then(|r| r.strip_prefix(&here)) {
                if let Ok(v) = HeaderValue::from_str(&format!("{there}{rest}")) {
                    out.append(REFERER, v);
                }
            }
        } else {
            out.append(name.clone(), value.clone());
        }
    }
    let kept: Vec<String> = cookie_pairs(client)
        .filter(|(k, _)| *k != LAUNCH_COOKIE)
        .map(|(k, v)| format!("{k}={v}"))
        .collect();
    if !kept.is_empty() {
        if let Ok(v) = HeaderValue::from_str(&kept.join("; ")) {
            out.insert(COOKIE, v);
        }
    }
    if let Ok(v) = HeaderValue::from_str(&host_header(master)) {
        out.insert(HOST, v);
    }
    if let Ok(v) = HeaderValue::from_str(token) {
        out.insert(HeaderName::from_static(crate::trust::DESKTOP_TOKEN_HEADER), v);
    }
    out
}

/// `Host` for the master: its authority, the port left out when it is the default.
pub(crate) fn host_header(master: &url::Url) -> String {
    let host = master.host_str().unwrap_or_default();
    match master.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    }
}

/// A redirect to the master's own origin comes back as a redirect to this proxy's.
fn rewrite_location(value: &str, master: &url::Url, port: u16) -> Option<String> {
    let there = master.origin().ascii_serialization();
    let rest = value.strip_prefix(&there)?;
    (rest.is_empty() || rest.starts_with('/') || rest.starts_with('?')).then(|| format!("{}{rest}", origin_for(port)))
}

// ── Answers ────────────────────────────────────────────────────────────────────────────────────

fn full(status: StatusCode, content_type: &'static str, body: String) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::from(body)).map_err(|never| match never {}).boxed());
    *r.status_mut() = status;
    r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    r.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

fn json(status: StatusCode, code: &str, message: &str) -> Response<Body> {
    full(status, "application/json", serde_json::json!({ "code": code, "message": message }).to_string())
}

fn empty() -> Body {
    Empty::<Bytes>::new().map_err(|never| match never {}).boxed()
}

/// A page for a navigation, JSON for anything else: the window shows the one, the app reads the other.
fn refuse(headers: &HeaderMap, status: StatusCode, code: &str, message: &str) -> Response<Body> {
    if is_navigation(headers) {
        let html = format!(
            "<!doctype html><meta charset=\"utf-8\"><title>LGR</title>\
             <body style=\"font:15px system-ui,sans-serif;padding:32px\"><p>{message}</p></body>"
        );
        let mut r = full(status, "text/html; charset=utf-8", html);
        r.headers_mut()
            .insert("content-security-policy", HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'"));
        return r;
    }
    json(status, code, message)
}

/// The boot page's script: post the fragment's secret, drop it from the address, go on.
const BOOT_SCRIPT: &str = "(async () => {\n\
  const secret = location.hash.slice(1)\n\
  history.replaceState(null, '', location.pathname + location.search)\n\
  const to = new URLSearchParams(location.search).get('to') || '/'\n\
  try {\n\
    const r = await fetch('/__lgr/boot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, to }) })\n\
    if (r.ok) { location.replace((await r.json()).to); return }\n\
  } catch (e) {}\n\
  document.getElementById('m').textContent = 'Open LGR from LGR Desktop.'\n\
})()";

fn boot_page() -> Response<Body> {
    let hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(BOOT_SCRIPT.as_bytes()));
    let html = format!("<!doctype html><meta charset=\"utf-8\"><title>LGR</title><p id=\"m\"></p><script>{BOOT_SCRIPT}</script>");
    let mut r = full(StatusCode::OK, "text/html; charset=utf-8", html);
    let csp = format!(
        "default-src 'none'; script-src 'sha256-{hash}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );
    if let Ok(v) = HeaderValue::from_str(&csp) {
        r.headers_mut().insert("content-security-policy", v);
    }
    r.headers_mut().insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    r
}

/// `/__lgr/boot`: the page on GET, the exchange on POST.
async fn boot(req: Request<Incoming>, st: &State) -> Response<Body> {
    match *req.method() {
        Method::GET => boot_page(),
        Method::POST => {
            // The boot page always sends its origin; a POST without one came from somewhere else.
            if req.headers().get(ORIGIN).is_none() || !origin_ok(req.headers(), st.port) {
                return json(StatusCode::FORBIDDEN, "origin_refused", "Not from LGR Desktop's window.");
            }
            let Ok(body) = Limited::new(req.into_body(), 2048).collect().await else {
                return json(StatusCode::BAD_REQUEST, "bad_request", "The request cannot be read.");
            };
            let v: serde_json::Value = serde_json::from_slice(&body.to_bytes()).unwrap_or_default();
            let secret = v.get("secret").and_then(|s| s.as_str()).unwrap_or_default();
            if !same(secret.as_bytes(), st.secret.as_bytes()) {
                return json(StatusCode::FORBIDDEN, "launch_refused", "Open LGR from LGR Desktop.");
            }
            // Where to go on: a path inside this origin, and never back to the proxy's own page.
            let to = v
                .get("to")
                .and_then(|s| s.as_str())
                .filter(|p| !p.is_empty() && crate::validate::is_valid_path(p) && !p.starts_with("/__lgr"))
                .unwrap_or("/");
            let mut r = full(StatusCode::OK, "application/json", serde_json::json!({ "to": to }).to_string());
            let cookie = format!("{LAUNCH_COOKIE}={}; Path=/; HttpOnly; SameSite=Strict", st.secret);
            r.headers_mut().insert(SET_COOKIE, HeaderValue::from_str(&cookie).expect("the secret is base64url"));
            r
        }
        _ => json(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed", "GET or POST."),
    }
}

async fn handle(req: Request<Incoming>, st: Arc<State>) -> Response<Body> {
    if !host_ok(req.headers(), st.port) {
        return json(StatusCode::FORBIDDEN, "host_refused", "This address answers LGR Desktop's window only.");
    }
    if req.uri().path() == BOOT_PATH {
        return boot(req, &st).await;
    }
    if !launch_cookie_ok(req.headers(), &st.secret) {
        return refuse(req.headers(), StatusCode::UNAUTHORIZED, "launch_required", "Open LGR from LGR Desktop.");
    }
    if !origin_ok(req.headers(), st.port) {
        return json(StatusCode::FORBIDDEN, "origin_refused", "Not from LGR Desktop's window.");
    }
    forward(req, &st).await
}

// ── Forwarding ─────────────────────────────────────────────────────────────────────────────────

impl State {
    /// The desktop's token: the cached one while it is under 10 minutes old, a new one otherwise.
    /// ⚠ Behind the lock, so the burst of requests a page load makes mints one token, not twenty.
    async fn token(&self) -> Result<String, String> {
        let mut slot = self.token.lock().await;
        if let Some((t, at)) = slot.as_ref() {
            if at.elapsed() < Duration::from_secs(600) {
                return Ok(t.clone());
            }
        }
        let mint = self.up.token.clone();
        let fresh = tokio::task::spawn_blocking(move || mint()).await.map_err(|e| e.to_string())??;
        *slot = Some((fresh.clone(), Instant::now()));
        Ok(fresh)
    }

    async fn forget_token(&self) {
        *self.token.lock().await = None;
    }
}

async fn connect(origin: &url::Url, tls: &Arc<rustls::ClientConfig>) -> Result<hyper::client::conn::http1::SendRequest<Body>, String> {
    let host = origin.host().ok_or("no host")?;
    let port = origin.port_or_known_default().ok_or("no port")?;
    let (name, tcp) = match host {
        url::Host::Ipv4(ip) => (rustls::pki_types::ServerName::IpAddress(std::net::IpAddr::V4(ip).into()), (ip.to_string(), port)),
        url::Host::Ipv6(ip) => (rustls::pki_types::ServerName::IpAddress(std::net::IpAddr::V6(ip).into()), (ip.to_string(), port)),
        url::Host::Domain(d) => {
            (rustls::pki_types::ServerName::try_from(d.to_string()).map_err(|e| e.to_string())?, (d.to_string(), port))
        }
    };
    let stream = tokio::time::timeout(Duration::from_secs(10), tokio::net::TcpStream::connect((tcp.0.as_str(), tcp.1)))
        .await
        .map_err(|_| "timeout".to_string())?
        .map_err(|e| e.to_string())?;
    let tls = tokio_rustls::TlsConnector::from(tls.clone()).connect(name, stream).await.map_err(|e| e.to_string())?;
    let (sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(tls)).await.map_err(|e| e.to_string())?;
    tokio::spawn(async move {
        let _ = conn.with_upgrades().await;
    });
    Ok(sender)
}

async fn forward(mut req: Request<Incoming>, st: &State) -> Response<Body> {
    let navigation = is_navigation(req.headers());
    let token = match st.token().await {
        Ok(t) => t,
        Err(e) => {
            (st.log)(&format!("proxy: no desktop token: {e}"));
            return refuse(req.headers(), StatusCode::SERVICE_UNAVAILABLE, "desktop_token_failed", "This desktop cannot sign in to its server. See LGR Desktop's Overview.");
        }
    };
    let upgrade = is_websocket_upgrade(req.headers());
    let origin = st.origin();
    let mut headers = upstream_headers(req.headers(), st.port, &origin, &token);
    if upgrade {
        headers.insert(CONNECTION, HeaderValue::from_static("upgrade"));
        headers.insert(UPGRADE, HeaderValue::from_static("websocket"));
    }
    let path = req.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".into());
    let from_client = upgrade.then(|| hyper::upgrade::on(&mut req));
    let Ok(mut outgoing) = Request::builder().method(req.method().clone()).uri(path).body(req.into_body().boxed()) else {
        return json(StatusCode::BAD_REQUEST, "bad_request", "The request cannot be forwarded.");
    };
    *outgoing.headers_mut() = headers;

    let unreachable = |why: String| {
        (st.log)(&format!("proxy: the server did not answer: {why}"));
        if navigation {
            // FR-20.33 — a navigation gets a page that says so and tries again by itself.
            let html = "<!doctype html><meta charset=\"utf-8\"><title>LGR</title><meta http-equiv=\"refresh\" content=\"5\">\
                        <body style=\"font:15px system-ui,sans-serif;padding:32px\"><p>The shop server is not answering. Retrying…</p></body>";
            let mut r = full(StatusCode::BAD_GATEWAY, "text/html; charset=utf-8", html.to_string());
            r.headers_mut()
                .insert("content-security-policy", HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'"));
            return r;
        }
        json(StatusCode::BAD_GATEWAY, "server_unreachable", "The shop server is not answering.")
    };
    let mut sender = match connect(&origin, &st.up.tls).await {
        Ok(s) => s,
        Err(e) => return unreachable(e),
    };
    let mut resp = match sender.send_request(outgoing).await {
        Ok(r) => r,
        Err(e) => return unreachable(e.to_string()),
    };

    if let (StatusCode::SWITCHING_PROTOCOLS, Some(from_client)) = (resp.status(), from_client) {
        let from_master = hyper::upgrade::on(&mut resp);
        tokio::spawn(async move {
            if let (Ok(client), Ok(master)) = (from_client.await, from_master.await) {
                let _ = tokio::io::copy_bidirectional(&mut TokioIo::new(client), &mut TokioIo::new(master)).await;
            }
        });
        let (parts, _) = resp.into_parts();
        return Response::from_parts(parts, empty());
    }

    let (mut parts, body) = resp.into_parts();
    // The master refused the desktop's token (revoked, rotated, or simply older than it thought):
    // the next request mints a new one. The refusal itself goes through to the window as it is.
    if parts.status == StatusCode::UNAUTHORIZED && parts.headers.get(CONTENT_TYPE).is_some_and(|c| c.as_bytes().starts_with(b"application/json")) {
        let bytes = body.collect().await.map(|b| b.to_bytes()).unwrap_or_default();
        if serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|v| v.get("code").and_then(|c| c.as_str()).map(|c| c.starts_with("desktop_")))
            .unwrap_or(false)
        {
            st.forget_token().await;
        }
        strip_hop_by_hop(&mut parts.headers);
        return Response::from_parts(parts, Full::new(bytes).map_err(|never| match never {}).boxed());
    }
    strip_hop_by_hop(&mut parts.headers);
    if let Some(moved) = parts.headers.get(LOCATION).and_then(|l| l.to_str().ok()).and_then(|l| rewrite_location(l, &origin, st.port)) {
        if let Ok(v) = HeaderValue::from_str(&moved) {
            parts.headers.insert(LOCATION, v);
        }
    }
    Response::from_parts(parts, body.boxed())
}

fn strip_hop_by_hop(headers: &mut HeaderMap) {
    let named: Vec<String> = tokens(headers, CONNECTION).collect();
    for n in HOP_BY_HOP.iter().copied().map(String::from).chain(named) {
        if let Ok(name) = HeaderName::from_bytes(n.as_bytes()) {
            headers.remove(name);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    const TOKEN: &str = "test.desktop.token";

    /// What the fake master saw: the request line and the headers, lower-cased.
    #[derive(Debug, Clone)]
    struct Seen {
        line: String,
        headers: Vec<(String, String)>,
    }

    impl Seen {
        fn get(&self, name: &str) -> Option<&str> {
            self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
        }
    }

    /// A master of its own: TLS on 127.0.0.1 with a CA made here. It answers by path:
    /// `/redirect` 302 to its own origin, `/denied` the LAN gate's 401, `/ws` 101 and then an echo,
    /// anything else 200.
    struct FakeMaster {
        port: u16,
        ca_pem: String,
        seen: Arc<Mutex<Vec<Seen>>>,
    }

    fn fake_master() -> FakeMaster {
        let (ca_pem, config) = test_pki();
        fake_master_with(ca_pem, config)
    }

    /// A CA made here, and a server configuration for 127.0.0.1 signed by it.
    fn test_pki() -> (String, Arc<rustls::ServerConfig>) {
        let ca_key = rcgen::KeyPair::generate().unwrap();
        let mut ca = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        ca.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Constrained(0));
        ca.distinguished_name.push(rcgen::DnType::CommonName, "proxy test CA");
        ca.key_usages = vec![rcgen::KeyUsagePurpose::KeyCertSign, rcgen::KeyUsagePurpose::DigitalSignature];
        let ca_cert = ca.self_signed(&ca_key).unwrap();
        let issuer = rcgen::Issuer::new(ca, &ca_key);
        let leaf_key = rcgen::KeyPair::generate().unwrap();
        let mut leaf = rcgen::CertificateParams::new(vec!["127.0.0.1".to_string()]).unwrap();
        leaf.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
        let leaf_cert = leaf.signed_by(&leaf_key, &issuer).unwrap();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![leaf_cert.der().clone()],
                rustls::pki_types::PrivateKeyDer::Pkcs8(leaf_key.serialize_der().into()),
            )
            .unwrap();
        (ca_cert.pem(), Arc::new(config))
    }

    /// A master answering with `config`: two of them on one CA are one master at two addresses.
    fn fake_master_with(ca_pem: String, config: Arc<rustls::ServerConfig>) -> FakeMaster {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (config, log) = (config.clone(), log.clone());
                std::thread::spawn(move || {
                    let conn = rustls::ServerConnection::new(config).unwrap();
                    let mut tls = rustls::StreamOwned::new(conn, stream);
                    let Some(head) = read_head(&mut tls) else { return };
                    let mut lines = head.split("\r\n");
                    let line = lines.next().unwrap_or_default().to_string();
                    let headers = lines
                        .filter_map(|l| l.split_once(':'))
                        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
                        .collect();
                    let req = Seen { line: line.clone(), headers };
                    log.lock().unwrap().push(req.clone());
                    let path = line.split(' ').nth(1).unwrap_or("/");
                    let answer = match path {
                        "/redirect" => format!(
                            "HTTP/1.1 302 Found\r\nLocation: https://127.0.0.1:{port}/next?a=1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        ),
                        "/denied" => {
                            let body = r#"{"code":"desktop_revoked","message":"no"}"#;
                            format!("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
                        }
                        "/ws" => {
                            let _ = tls.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
                            let _ = tls.flush();
                            let mut buf = [0u8; 64];
                            while let Ok(n) = tls.read(&mut buf) {
                                if n == 0 || tls.write_all(&buf[..n]).is_err() || tls.flush().is_err() {
                                    break;
                                }
                            }
                            return;
                        }
                        _ => "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nSet-Cookie: s=1; Path=/; HttpOnly\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_string(),
                    };
                    let _ = tls.write_all(answer.as_bytes());
                    let _ = tls.flush();
                    tls.conn.send_close_notify();
                    let _ = tls.flush();
                });
            }
        });
        FakeMaster { port, ca_pem, seen }
    }

    fn read_head(stream: &mut impl Read) -> Option<String> {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).ok()? == 0 {
                return None;
            }
            head.push(byte[0]);
        }
        String::from_utf8(head).ok()
    }

    struct Fixture {
        master: FakeMaster,
        proxy: Running,
        mints: Arc<AtomicUsize>,
    }

    /// TLS that trusts `ca_pem` alone, as `trust.rs` builds it for a paired master.
    fn pinned(ca_pem: &str) -> Arc<rustls::ClientConfig> {
        let pin = crate::trust::MasterPin { ca_pem: ca_pem.to_string(), fingerprint: String::new() };
        Arc::new(crate::trust::rustls_config(&pin).unwrap())
    }

    fn fixture() -> Fixture {
        let master = fake_master();
        let mints = Arc::new(AtomicUsize::new(0));
        let counter = mints.clone();
        let up = Upstream {
            origin: url::Url::parse(&format!("https://127.0.0.1:{}", master.port)).unwrap(),
            tls: pinned(&master.ca_pem),
            token: Arc::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(TOKEN.to_string())
            }),
        };
        let proxy = start(up, 0, Arc::new(|_| {})).unwrap();
        Fixture { master, proxy, mints }
    }

    /// One HTTP/1.1 exchange with the proxy, written by hand so every header is the test's to choose.
    fn raw(port: u16, request: &str) -> String {
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.write_all(request.as_bytes()).unwrap();
        let mut out = Vec::new();
        let _ = s.read_to_end(&mut out);
        String::from_utf8_lossy(&out).to_string()
    }

    fn get(f: &Fixture, path: &str, extra: &str) -> String {
        let p = f.proxy.port;
        raw(p, &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n{extra}Connection: close\r\n\r\n"))
    }

    fn with_cookie(f: &Fixture) -> String {
        format!("Cookie: {LAUNCH_COOKIE}={}\r\n", f.proxy.secret)
    }

    fn status(response: &str) -> u16 {
        response.split(' ').nth(1).and_then(|s| s.parse().ok()).unwrap_or(0)
    }

    fn header<'a>(response: &'a str, name: &str) -> Option<&'a str> {
        response
            .split("\r\n\r\n")
            .next()?
            .split("\r\n")
            .filter_map(|l| l.split_once(':'))
            .find(|(k, _)| k.trim().eq_ignore_ascii_case(name))
            .map(|(_, v)| v.trim())
    }

    #[test]
    fn a_foreign_host_is_refused() {
        let f = fixture();
        let p = f.proxy.port;
        // DNS rebinding: a page that pointed its own name here sends that name.
        let r = raw(p, &format!("GET / HTTP/1.1\r\nHost: evil.example:{p}\r\n{}Connection: close\r\n\r\n", with_cookie(&f)));
        assert_eq!(status(&r), 403, "{r}");
        let r = raw(p, &format!("GET / HTTP/1.1\r\nHost: localhost:{p}\r\n{}Connection: close\r\n\r\n", with_cookie(&f)));
        assert_eq!(status(&r), 403, "only the exact address: {r}");
        assert!(f.master.seen.lock().unwrap().is_empty(), "nothing reached the master");
    }

    #[test]
    fn nothing_passes_without_the_launch_secret() {
        let f = fixture();
        let r = get(&f, "/api/auth/me", "");
        assert_eq!(status(&r), 401, "{r}");
        assert!(r.contains("launch_required"));
        let r = get(&f, "/api/auth/me", &format!("Cookie: {LAUNCH_COOKIE}=not-the-secret\r\n"));
        assert_eq!(status(&r), 401);
        // A navigation gets a page, not JSON.
        let r = get(&f, "/pos/", "Accept: text/html\r\n");
        assert_eq!(status(&r), 401);
        assert!(header(&r, "content-type").unwrap().starts_with("text/html"), "{r}");
        assert!(f.master.seen.lock().unwrap().is_empty(), "nothing reached the master");
        assert_eq!(f.mints.load(Ordering::SeqCst), 0, "no token was minted for a refused request");
    }

    #[test]
    fn the_boot_page_trades_the_fragment_for_the_cookie() {
        let f = fixture();
        let p = f.proxy.port;
        // The URL the window opens: the secret only after `#`, which never leaves the webview.
        let boot = f.proxy.boot_url("/pos/");
        assert_eq!(boot, format!("http://127.0.0.1:{p}/__lgr/boot?to=%2Fpos%2F#{}", f.proxy.secret));

        let page = get(&f, "/__lgr/boot?to=%2Fpos%2F", "");
        assert_eq!(status(&page), 200);
        let csp = header(&page, "content-security-policy").unwrap();
        let hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(BOOT_SCRIPT.as_bytes()));
        assert!(csp.contains(&format!("'sha256-{hash}'")) && csp.contains("default-src 'none'"), "{csp}");
        assert!(page.contains(BOOT_SCRIPT));

        let post = |origin: Option<&str>, body: &str| {
            let origin = origin.map(|o| format!("Origin: {o}\r\n")).unwrap_or_default();
            raw(p, &format!(
                "POST /__lgr/boot HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n{origin}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ))
        };
        let here = format!("http://127.0.0.1:{p}");
        let good = format!(r#"{{"secret":"{}","to":"/pos/"}}"#, f.proxy.secret);
        assert_eq!(status(&post(None, &good)), 403, "a POST with no Origin came from somewhere else");
        assert_eq!(status(&post(Some("http://127.0.0.1:1"), &good)), 403, "another port is another origin");
        assert_eq!(status(&post(Some(&here), r#"{"secret":"guess","to":"/pos/"}"#)), 403);

        let ok = post(Some(&here), &good);
        assert_eq!(status(&ok), 200, "{ok}");
        let cookie = header(&ok, "set-cookie").unwrap();
        assert_eq!(cookie, format!("{LAUNCH_COOKIE}={}; Path=/; HttpOnly; SameSite=Strict", f.proxy.secret));
        assert!(ok.ends_with(r#"{"to":"/pos/"}"#), "{ok}");

        // Where to go on is a path in this origin, never another site or the proxy's own page.
        for bad in ["//evil.example", "https://evil.example/", "/__lgr/boot", "/pos/?token=x"] {
            let body = format!(r#"{{"secret":"{}","to":"{bad}"}}"#, f.proxy.secret);
            assert!(post(Some(&here), &body).ends_with(r#"{"to":"/"}"#), "{bad}");
        }
        assert!(f.master.seen.lock().unwrap().is_empty(), "the boot page is the proxy's own");
    }

    #[test]
    fn a_request_reaches_the_master_with_the_desktop_token_and_not_the_secret() {
        let f = fixture();
        let p = f.proxy.port;
        let m = f.master.port;
        let r = get(
            &f,
            "/api/org/x/invoices?page=2",
            &format!(
                "Cookie: a=1; {LAUNCH_COOKIE}={}; b=2\r\nOrigin: http://127.0.0.1:{p}\r\nReferer: http://127.0.0.1:{p}/invoicing/\r\n\
                 Authorization: Bearer user.jwt\r\nX-LGR-Desktop-Token: forged\r\nX-LGR-Source: lan\r\n",
                f.proxy.secret
            ),
        );
        assert_eq!(status(&r), 200, "{r}");
        assert!(r.ends_with("ok"));
        // The master's own cookie comes back as it is.
        assert_eq!(header(&r, "set-cookie"), Some("s=1; Path=/; HttpOnly"));

        let seen = f.master.seen.lock().unwrap()[0].clone();
        assert_eq!(seen.line, "GET /api/org/x/invoices?page=2 HTTP/1.1");
        assert_eq!(seen.get("host"), Some(format!("127.0.0.1:{m}").as_str()));
        assert_eq!(seen.get("x-lgr-desktop-token"), Some(TOKEN), "the shell's token, not the page's");
        assert_eq!(seen.get("x-lgr-source"), None, "nothing else X-LGR-* from the page");
        assert_eq!(seen.get("cookie"), Some("a=1; b=2"), "the launch secret never leaves the machine");
        assert_eq!(seen.get("origin"), Some(format!("https://127.0.0.1:{m}").as_str()));
        assert_eq!(seen.get("referer"), Some(format!("https://127.0.0.1:{m}/invoicing/").as_str()));
        assert_eq!(seen.get("authorization"), Some("Bearer user.jwt"), "the user's session is the page's own");

        // A page load is a burst: one token serves it.
        for _ in 0..3 {
            assert_eq!(status(&get(&f, "/x", &with_cookie(&f))), 200);
        }
        assert_eq!(f.mints.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_foreign_origin_is_refused_even_with_the_secret() {
        let f = fixture();
        let r = get(&f, "/api/x", &format!("{}Origin: http://127.0.0.1:9\r\n", with_cookie(&f)));
        assert_eq!(status(&r), 403, "{r}");
        assert!(f.master.seen.lock().unwrap().is_empty());
    }

    #[test]
    fn a_redirect_to_the_master_comes_back_here() {
        let f = fixture();
        let r = get(&f, "/redirect", &with_cookie(&f));
        assert_eq!(status(&r), 302, "{r}");
        assert_eq!(header(&r, "location"), Some(format!("http://127.0.0.1:{}/next?a=1", f.proxy.port).as_str()));
    }

    #[test]
    fn a_refused_token_is_minted_again() {
        let f = fixture();
        let r = get(&f, "/denied", &with_cookie(&f));
        assert_eq!(status(&r), 401);
        assert!(r.ends_with(r#"{"code":"desktop_revoked","message":"no"}"#), "the refusal reaches the window as it is: {r}");
        assert_eq!(status(&get(&f, "/x", &with_cookie(&f))), 200);
        assert_eq!(f.mints.load(Ordering::SeqCst), 2, "the refused token was not used again");
    }

    #[test]
    fn a_websocket_is_piped_through() {
        let f = fixture();
        let p = f.proxy.port;
        let mut s = std::net::TcpStream::connect(("127.0.0.1", p)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let req = format!(
            "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n{}Origin: http://127.0.0.1:{p}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\
             Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            with_cookie(&f)
        );
        s.write_all(req.as_bytes()).unwrap();
        let head = read_head(&mut s).unwrap();
        assert!(head.starts_with("HTTP/1.1 101"), "{head}");
        s.write_all(b"ping-through-the-pin").unwrap();
        let mut buf = [0u8; 20];
        s.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"ping-through-the-pin");
        let seen = f.master.seen.lock().unwrap()[0].clone();
        assert_eq!(seen.get("x-lgr-desktop-token"), Some(TOKEN), "the upgrade carries the token too");
        assert_eq!(seen.get("upgrade"), Some("websocket"));
    }

    #[test]
    fn a_master_that_does_not_answer_is_said_so() {
        let f = fixture();
        // A port nothing listens on, pinned all the same.
        let closed = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        let up = Upstream {
            origin: url::Url::parse(&format!("https://127.0.0.1:{closed}")).unwrap(),
            tls: pinned(&f.master.ca_pem),
            token: Arc::new(|| Ok(TOKEN.to_string())),
        };
        let dead = start(up, 0, Arc::new(|_| {})).unwrap();
        let p = dead.port;
        let cookie = format!("Cookie: {LAUNCH_COOKIE}={}\r\n", dead.secret);
        let r = raw(p, &format!("GET /api/x HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n{cookie}Connection: close\r\n\r\n"));
        assert_eq!(status(&r), 502, "{r}");
        assert!(r.contains("server_unreachable"));
        let r = raw(p, &format!("GET /pos/ HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n{cookie}Accept: text/html\r\nConnection: close\r\n\r\n"));
        assert_eq!(status(&r), 502);
        assert!(r.contains("http-equiv=\"refresh\""), "a navigation is told, and retries by itself: {r}");
        dead.stop();
    }

    #[test]
    fn a_certificate_the_pin_does_not_name_is_refused() {
        let f = fixture();
        // Pinned to ANOTHER CA: the TLS handshake fails, and nothing is sent.
        let other = fake_master();
        let up = Upstream {
            origin: url::Url::parse(&format!("https://127.0.0.1:{}", f.master.port)).unwrap(),
            tls: pinned(&other.ca_pem),
            token: Arc::new(|| Ok(TOKEN.to_string())),
        };
        let wrong = start(up, 0, Arc::new(|_| {})).unwrap();
        let p = wrong.port;
        let r = raw(p, &format!("GET /api/x HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nCookie: {LAUNCH_COOKIE}={}\r\nConnection: close\r\n\r\n", wrong.secret));
        assert_eq!(status(&r), 502, "{r}");
        assert!(f.master.seen.lock().unwrap().is_empty(), "no request went over an unpinned connection");
        wrong.stop();
    }

    #[test]
    fn the_port_is_kept_when_it_is_free() {
        let f = fixture();
        let up = || Upstream {
            origin: url::Url::parse(&format!("https://127.0.0.1:{}", f.master.port)).unwrap(),
            tls: pinned(&f.master.ca_pem),
            token: Arc::new(|| Ok(TOKEN.to_string())),
        };
        // A port that was free a moment ago: the proxy takes it.
        let free = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        let a = start(up(), free, Arc::new(|_| {})).unwrap();
        assert_eq!(a.port, free);
        // Taken: another one, rather than no window at all.
        let b = start(up(), free, Arc::new(|_| {})).unwrap();
        assert_ne!(b.port, free);
        a.stop();
        b.stop();
    }

    /// The window's path against a real LGR Server: pair (as `trust`'s end-to-end test does), start
    /// the proxy the shell would start, write its boot URL to `LGR_TEST_PROXY_OUT`, and keep it up
    /// until `LGR_TEST_PROXY_DONE` exists, while a browser drives the master's own pages through it.
    /// Needs the variables `a_real_master_pairs_end_to_end` needs. `cargo test -- --ignored the_window`.
    #[test]
    #[ignore]
    fn the_window_reaches_a_real_master_through_the_proxy() {
        let scratch = std::env::var("LOCALAPPDATA").unwrap_or_default();
        assert!(scratch.contains("lgr-desktop-test"), "LOCALAPPDATA must be a scratch lgr-desktop-test dir, not {scratch}");
        let server = std::env::var("LGR_TEST_MASTER").expect("LGR_TEST_MASTER");
        let fp = std::env::var("LGR_TEST_MASTER_FP").expect("LGR_TEST_MASTER_FP");
        let code = std::env::var("LGR_TEST_MASTER_CODE").expect("LGR_TEST_MASTER_CODE");
        let out = std::env::var("LGR_TEST_PROXY_OUT").expect("LGR_TEST_PROXY_OUT");
        let done = std::env::var("LGR_TEST_PROXY_DONE").expect("LGR_TEST_PROXY_DONE");

        assert!(crate::trust::set_pin(&server, Some(crate::trust::confirm(&server, &fp).unwrap())));
        crate::enroll::enroll(&server, &code, "P1-6C-TEST", env!("CARGO_PKG_VERSION")).expect("enrolls");
        let token_server = server.clone();
        let mints = Arc::new(AtomicUsize::new(0));
        let counter = mints.clone();
        let up = Upstream {
            origin: url::Url::parse(&server).unwrap(),
            tls: Arc::new(crate::trust::pinned_tls(&server).unwrap().unwrap()),
            token: Arc::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                crate::enroll::mint_token(&token_server).map_err(|e| e.to_string())
            }),
        };
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = lines.clone();
        let proxy = start(up, 0, Arc::new(move |m: &str| sink.lock().unwrap().push(m.to_string()))).unwrap();
        std::fs::write(&out, proxy.boot_url("/auth/login")).unwrap();
        let t0 = Instant::now();
        while !std::path::Path::new(&done).exists() {
            assert!(t0.elapsed() < Duration::from_secs(600), "the browser never finished");
            std::thread::sleep(Duration::from_millis(200));
        }
        proxy.stop();
        let log = lines.lock().unwrap().join("\n");
        assert!(!log.contains(&proxy.secret), "the launch secret never reaches the log");
        println!("proxy minted {} token(s); log:\n{log}", mints.load(Ordering::SeqCst));
    }

    #[test]
    fn a_master_that_moved_is_followed_without_a_new_origin() {
        // One master (one CA) at two addresses: DHCP gave it a new one (FR-20.28).
        let (ca_pem, config) = test_pki();
        let before = fake_master_with(ca_pem.clone(), config.clone());
        let after = fake_master_with(ca_pem.clone(), config);
        let up = Upstream {
            origin: url::Url::parse(&format!("https://127.0.0.1:{}", before.port)).unwrap(),
            tls: pinned(&ca_pem),
            token: Arc::new(|| Ok(TOKEN.to_string())),
        };
        let mut proxy = start(up, 0, Arc::new(|_| {})).unwrap();
        let (port, boot) = (proxy.port, proxy.boot_url("/"));
        let cookie = format!("Cookie: {LAUNCH_COOKIE}={}\r\n", proxy.secret);
        let ask = || raw(port, &format!("GET /x HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{cookie}Connection: close\r\n\r\n"));
        assert_eq!(status(&ask()), 200);
        assert_eq!(before.seen.lock().unwrap().len(), 1);

        proxy.retarget(url::Url::parse(&format!("https://127.0.0.1:{}", after.port)).unwrap());
        assert_eq!(status(&ask()), 200);
        assert_eq!(after.seen.lock().unwrap().len(), 1, "the next request goes to the new address");
        assert_eq!(after.seen.lock().unwrap()[0].get("host"), Some(format!("127.0.0.1:{}", after.port).as_str()));
        assert_eq!(before.seen.lock().unwrap().len(), 1);
        // ⚠ The window's origin, its secret and so its sessions are untouched.
        assert_eq!((proxy.port, proxy.boot_url("/")), (port, boot));
        assert_eq!(proxy.master, format!("https://127.0.0.1:{}", after.port));
        proxy.stop();
    }

    #[test]
    fn redirects_elsewhere_are_left_alone() {
        let master = url::Url::parse("https://192.168.1.10:4443").unwrap();
        assert_eq!(rewrite_location("https://192.168.1.10:4443/pos/", &master, 5000).as_deref(), Some("http://127.0.0.1:5000/pos/"));
        assert_eq!(rewrite_location("https://192.168.1.10:4443", &master, 5000).as_deref(), Some("http://127.0.0.1:5000"));
        assert_eq!(rewrite_location("/relative", &master, 5000), None);
        assert_eq!(rewrite_location("https://lgrai.app/x", &master, 5000), None);
        // A prefix is not an origin: `:44430` is another port.
        assert_eq!(rewrite_location("https://192.168.1.10:44430/x", &master, 5000), None);
        assert_eq!(host_header(&master), "192.168.1.10:4443");
        assert_eq!(host_header(&url::Url::parse("https://kasa-1.local").unwrap()), "kasa-1.local");
    }
}
