//! The supervisor's ingresses (FR-20.16, plan step P1-3b): every way into a master is here.
//!
//! The API listens on 127.0.0.1 only and answers nothing that did not come through one of these
//! (`portal-api/src/front/front-guard.ts`). Each is an HTTP/1.1 reverse proxy that, on every
//! request:
//! 1. strips whatever `X-LGR-*` the client sent, the hop-by-hop headers, and the forwarding headers
//!    a client can write to pass for a proxy (`X-Real-IP`, `X-Forwarded-*`, `Forwarded`);
//! 2. stamps the per-boot front secret, where the request came from, and the address this socket
//!    saw it from;
//! 3. passes WebSocket upgrades through, as a byte pipe once the API has answered 101, so
//!    `/ws/fiscal-bridge`, `/ws/desktop` and `/ws/tasks` work through it (AC 48).
//!
//! ⚠ The one client header carried over is the LAN's desktop credential (`X-LGR-Desktop-Token`,
//! FR-20.32). It is a credential the API verifies against its row, never a stamp it trusts.
//!
//! The console (setup, FR-20.18) is [`Console`]: loopback only, its own address in `Host` only, and a
//! session that only the one-time setup token opens.

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Empty, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{HeaderMap, HeaderName, HeaderValue, CONNECTION, CONTENT_TYPE, COOKIE, HOST, SET_COOKIE, UPGRADE};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::collections::HashSet;
use std::convert::Infallible;
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};

pub type Body = BoxBody<Bytes, hyper::Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Lan,
    /// Stamped by the uplink's ingress (P3); the API already knows it.
    #[allow(dead_code)]
    Tunnel,
    Console,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Lan => "lan",
            Source::Tunnel => "tunnel",
            Source::Console => "console",
        }
    }
}

/// Where every ingress sends what it accepts: the API's loopback port, and the secret it requires.
pub struct Upstream {
    pub port: u16,
    pub secret: String,
}

pub const DESKTOP_TOKEN: &str = "x-lgr-desktop-token";

/// Headers that describe one hop, never the request (RFC 9110 §7.6.1).
const HOP_BY_HOP: &[&str] = &[
    "connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer",
    "transfer-encoding", "upgrade",
];
/// What a client could write to pass for a proxy in front of the API.
const FORWARDING: &[&str] = &["x-real-ip", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "forwarded"];

fn tokens(headers: &HeaderMap, name: HeaderName) -> impl Iterator<Item = String> + '_ {
    headers
        .get_all(name)
        .into_iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| !t.is_empty())
}

/// The headers a request carries on to the API: the client's, cleaned, then the ingress's stamps.
pub fn stamp(client: &HeaderMap, source: Source, peer: IpAddr, upstream: &Upstream, tls: bool) -> HeaderMap {
    // A header named in `Connection` is hop-by-hop too, whatever it is called (never `Host`).
    let named: HashSet<String> = tokens(client, CONNECTION).filter(|t| t != "host").collect();
    let mut out = HeaderMap::with_capacity(client.len() + 4);
    for (name, value) in client {
        let n = name.as_str();
        if n.starts_with("x-lgr-") || HOP_BY_HOP.contains(&n) || FORWARDING.contains(&n) || named.contains(n) {
            continue;
        }
        out.append(name.clone(), value.clone());
    }
    if source == Source::Lan {
        if let Some(token) = client.get(DESKTOP_TOKEN) {
            out.insert(HeaderName::from_static(DESKTOP_TOKEN), token.clone());
        }
    }
    out.insert("x-lgr-front", HeaderValue::from_str(&upstream.secret).expect("the secret is base64url"));
    out.insert("x-lgr-source", HeaderValue::from_static(source.as_str()));
    out.insert("x-lgr-client-ip", HeaderValue::from_str(&peer.to_string()).expect("an address is ASCII"));
    out.insert("x-forwarded-proto", HeaderValue::from_static(if tls { "https" } else { "http" }));
    out
}

/// A WebSocket upgrade, the one upgrade passed through (an `h2c` one is served as a plain request).
fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    tokens(headers, CONNECTION).any(|t| t == "upgrade") && tokens(headers, UPGRADE).any(|t| t == "websocket")
}

fn strip_hop_by_hop(headers: &mut HeaderMap) {
    let named: Vec<String> = tokens(headers, CONNECTION).collect();
    for n in HOP_BY_HOP.iter().copied().map(String::from).chain(named) {
        if let Ok(name) = HeaderName::from_bytes(n.as_bytes()) {
            headers.remove(name);
        }
    }
}

pub fn text(status: StatusCode, message: &str) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::from(message.to_string())).map_err(|never| match never {}).boxed());
    *r.status_mut() = status;
    r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    r
}

fn empty() -> Body {
    Empty::<Bytes>::new().map_err(|never| match never {}).boxed()
}

/// Send `req` to the API and its answer back. A WebSocket upgrade becomes a byte pipe between the
/// client and the API once the API has answered 101.
pub async fn forward(mut req: Request<Incoming>, source: Source, peer: SocketAddr, up: &Upstream, tls: bool) -> Response<Body> {
    let upgrade = is_websocket_upgrade(req.headers());
    let mut headers = stamp(req.headers(), source, peer.ip(), up, tls);
    if upgrade {
        headers.insert(CONNECTION, HeaderValue::from_static("upgrade"));
        headers.insert(UPGRADE, HeaderValue::from_static("websocket"));
    }
    let path = req.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".into());
    let from_client = upgrade.then(|| hyper::upgrade::on(&mut req));
    let mut outgoing = match Request::builder().method(req.method().clone()).uri(path).body(req.into_body()) {
        Ok(r) => r,
        Err(_) => return text(StatusCode::BAD_REQUEST, "The request cannot be forwarded."),
    };
    *outgoing.headers_mut() = headers;

    let unavailable = || text(StatusCode::BAD_GATEWAY, "The server is starting or restarting. Try again in a moment.");
    let Ok(stream) = TcpStream::connect(("127.0.0.1", up.port)).await else { return unavailable() };
    let Ok((mut sender, conn)) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await else { return unavailable() };
    tokio::spawn(async move {
        let _ = conn.with_upgrades().await;
    });
    let Ok(mut resp) = sender.send_request(outgoing).await else { return unavailable() };

    if let (StatusCode::SWITCHING_PROTOCOLS, Some(from_client)) = (resp.status(), from_client) {
        let from_api = hyper::upgrade::on(&mut resp);
        tokio::spawn(async move {
            if let (Ok(client), Ok(api)) = (from_client.await, from_api.await) {
                let _ = tokio::io::copy_bidirectional(&mut TokioIo::new(client), &mut TokioIo::new(api)).await;
            }
        });
        // The API's 101 as it is: `Connection`, `Upgrade` and `Sec-WebSocket-Accept` belong to it.
        let (parts, _) = resp.into_parts();
        return Response::from_parts(parts, empty());
    }
    let (mut parts, body) = resp.into_parts();
    strip_hop_by_hop(&mut parts.headers);
    Response::from_parts(parts, body.boxed())
}

/// One connection: its requests go to `handle` with the peer's address, and its WebSocket upgrades
/// stay open past the response.
async fn serve_connection<S, H, F>(stream: S, peer: SocketAddr, handle: H)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    H: Fn(Request<Incoming>, SocketAddr) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = Response<Body>> + Send + 'static,
{
    let service = hyper::service::service_fn(move |req| {
        let handle = handle.clone();
        async move { Ok::<_, Infallible>(handle(req, peer).await) }
    });
    let _ = hyper::server::conn::http1::Builder::new()
        .timer(TokioTimer::new())
        // A client that never finishes its headers must not hold a connection forever.
        .header_read_timeout(Duration::from_secs(30))
        .serve_connection(TokioIo::new(stream), service)
        .with_upgrades()
        .await;
}

/// Where the LAN ingress hands out the master's CA (FR-20.29).
pub const CA_PATH: &str = "/__lgr/ca.pem";

/// The master's CA certificate, for a desktop pairing with it. The desktop fetches it once over a
/// connection it does not trust yet, then checks it against the fingerprint its pairing code carries,
/// or a person compares the six words. Public data: a CA certificate, never its key. Answered here,
/// never by the API, and needs no desktop credential: it comes before there is one.
pub fn lan_ca_answer(req: &Request<Incoming>, ca_pem: &str) -> Option<Response<Body>> {
    if req.method() != Method::GET || req.uri().path() != CA_PATH {
        return None;
    }
    let mut r = text(StatusCode::OK, ca_pem);
    r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/x-pem-file"));
    r.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
    Some(r)
}

/// Accept on `listener` forever, each connection on its own task.
pub async fn serve<H, F>(listener: TcpListener, handle: H)
where
    H: Fn(Request<Incoming>, SocketAddr) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = Response<Body>> + Send + 'static,
{
    loop {
        let Ok((stream, peer)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        };
        tokio::spawn(serve_connection(stream, peer, handle.clone()));
    }
}

/// [`serve`] behind TLS: the LAN ingress (FR-20.30), on the master's own certificate, which the
/// supervisor holds and the API never sees.
pub async fn serve_tls<H, F>(listener: TcpListener, tls: Arc<rustls::ServerConfig>, handle: H)
where
    H: Fn(Request<Incoming>, SocketAddr) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = Response<Body>> + Send + 'static,
{
    let acceptor = tokio_rustls::TlsAcceptor::from(tls);
    loop {
        let Ok((tcp, peer)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        };
        let (acceptor, handle) = (acceptor.clone(), handle.clone());
        tokio::spawn(async move {
            // A handshake that never finishes must not hold a connection either.
            if let Ok(Ok(stream)) = tokio::time::timeout(Duration::from_secs(10), acceptor.accept(tcp)).await {
                serve_connection(stream, peer, handle).await;
            }
        });
    }
}

/// The setup console (FR-20.18): on loopback, during setup only.
///
/// - **Its own address only** in `Host` (`127.0.0.1:<port>`, `localhost:<port>`): a page that
///   rebinds its name to this machine is refused before anything else.
/// - **The one-time token opens a session.** `GET /__lgr/setup` serves a page that reads the token
///   from the URL's fragment (never sent to any server, never logged) and trades it for an
///   `HttpOnly` cookie. Every other request needs that cookie, which is stripped before the API
///   sees the request.
/// - **It closes itself** once `state/setup-complete` exists: setup is over, and so is the console.
pub struct Console {
    pub port: u16,
    pub token: String,
    pub upstream: Arc<Upstream>,
    pub marker: PathBuf,
    sessions: Mutex<HashSet<String>>,
}

pub const SESSION_COOKIE: &str = "lgr_setup";

const SETUP_PAGE: &str = r#"<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>LGR Server setup</title>
<body style="font-family:system-ui,sans-serif;margin:3rem;max-width:40rem">
<p id="m">Opening setup…</p>
<script>
const token = location.hash.slice(1)
history.replaceState(null, '', location.pathname)
fetch('/__lgr/setup/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
  .then(r => { if (r.ok) location.replace('/'); else throw new Error() })
  .catch(() => { document.getElementById('m').textContent = 'This setup link does not open setup. As an administrator, run "lgr-server setup-token" for the current one.' })
</script>
"#;

/// Equal, in time that depends on the length only.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl Console {
    pub fn new(port: u16, token: String, upstream: Arc<Upstream>, marker: PathBuf) -> Self {
        Self { port, token, upstream, marker, sessions: Mutex::new(HashSet::new()) }
    }

    fn host_is_mine(&self, headers: &HeaderMap) -> bool {
        let Some(host) = headers.get(HOST).and_then(|h| h.to_str().ok()) else { return false };
        let host = host.trim().to_ascii_lowercase();
        [format!("127.0.0.1:{}", self.port), format!("localhost:{}", self.port), format!("[::1]:{}", self.port)].contains(&host)
    }

    /// The session cookie's value, if the request carries one this console issued.
    fn session_of(&self, headers: &HeaderMap) -> Option<String> {
        let sessions = self.sessions.lock().unwrap();
        headers
            .get_all(COOKIE)
            .into_iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(';'))
            .filter_map(|c| c.trim().split_once('='))
            .filter(|(k, _)| *k == SESSION_COOKIE)
            .map(|(_, v)| v.to_string())
            .find(|v| sessions.iter().any(|s| same(s.as_bytes(), v.as_bytes())))
    }

    async fn open_session(&self, req: Request<Incoming>) -> Response<Body> {
        let refused = || text(StatusCode::FORBIDDEN, "This setup link does not open setup.");
        let Ok(body) = Limited::new(req.into_body(), 4096).collect().await else { return refused() };
        let given = serde_json::from_slice::<serde_json::Value>(&body.to_bytes())
            .ok()
            .and_then(|v| v["token"].as_str().map(String::from))
            .unwrap_or_default();
        if !same(given.as_bytes(), self.token.as_bytes()) {
            tracing::warn!("a setup session was refused: the token did not match");
            return refused();
        }
        let session = crate::front::random_token();
        self.sessions.lock().unwrap().insert(session.clone());
        tracing::info!("a setup session was opened on the console");
        let mut r = text(StatusCode::NO_CONTENT, "");
        r.headers_mut().insert(
            SET_COOKIE,
            HeaderValue::from_str(&format!("{SESSION_COOKIE}={session}; Path=/; HttpOnly; SameSite=Strict")).expect("ASCII"),
        );
        r
    }

    pub async fn handle(self: Arc<Self>, mut req: Request<Incoming>, peer: SocketAddr) -> Response<Body> {
        if !self.host_is_mine(req.headers()) {
            return text(StatusCode::FORBIDDEN, "The setup console answers to its own address only.");
        }
        match (req.method(), req.uri().path()) {
            (&Method::GET, "/__lgr/setup") => {
                let mut r = text(StatusCode::OK, SETUP_PAGE);
                r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
                r.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
                return r;
            }
            (&Method::POST, "/__lgr/setup/session") => return self.open_session(req).await,
            _ => {}
        }
        if self.session_of(req.headers()).is_none() {
            return text(StatusCode::FORBIDDEN, "Setup needs its link. As an administrator, run \"lgr-server setup-token\".");
        }
        // The supervisor's credential, not the API's: it stops here.
        let kept: Vec<String> = req
            .headers()
            .get_all(COOKIE)
            .into_iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(';'))
            .map(str::trim)
            .filter(|c| !c.starts_with(&format!("{SESSION_COOKIE}=")) && !c.is_empty())
            .map(String::from)
            .collect();
        req.headers_mut().remove(COOKIE);
        if !kept.is_empty() {
            req.headers_mut().insert(COOKIE, HeaderValue::from_str(&kept.join("; ")).expect("it came in as a header"));
        }
        forward(req, Source::Console, peer, &self.upstream, false).await
    }

    /// Serve on 127.0.0.1 until setup is complete, then stop listening.
    pub async fn run(self: Arc<Self>) {
        match TcpListener::bind(("127.0.0.1", self.port)).await {
            Ok(listener) => {
                tracing::info!(port = self.port, "the setup console is open on loopback");
                self.serve_until_complete(listener, Duration::from_secs(2)).await;
            }
            Err(e) => tracing::error!(port = self.port, error = %e, "the setup console cannot listen (is SETUP_PORT in use?)"),
        }
    }

    async fn serve_until_complete(self: Arc<Self>, listener: TcpListener, check: Duration) {
        let me = self.clone();
        let accepting = tokio::spawn(serve(listener, move |req, peer| me.clone().handle(req, peer)));
        while !self.marker.exists() {
            tokio::time::sleep(check).await;
        }
        accepting.abort();
        tracing::info!("setup is complete: the console is closed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn up() -> Upstream {
        Upstream { port: 1, secret: "the-front-secret".into() }
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(HeaderName::from_bytes(k.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn a_forged_stamp_never_reaches_the_api() {
        let client = headers(&[
            ("host", "kasa-1.local:4443"),
            ("x-lgr-front", "guessed"),
            ("x-lgr-source", "console"),
            ("x-lgr-client-ip", "10.0.0.1"),
            ("X-LGR-Anything", "x"),
            ("x-real-ip", "6.6.6.6"),
            ("x-forwarded-for", "7.7.7.7"),
            ("forwarded", "for=8.8.8.8"),
            ("cookie", "a=1"),
            ("authorization", "Bearer user-session"),
        ]);
        let out = stamp(&client, Source::Tunnel, "93.152.1.2".parse().unwrap(), &up(), false);
        assert_eq!(out["x-lgr-front"], "the-front-secret");
        assert_eq!(out["x-lgr-source"], "tunnel");
        assert_eq!(out["x-lgr-client-ip"], "93.152.1.2");
        assert_eq!(out.get_all("x-lgr-source").iter().count(), 1);
        assert!(out.get("x-lgr-anything").is_none());
        for gone in ["x-real-ip", "x-forwarded-for", "forwarded"] {
            assert!(out.get(gone).is_none(), "{gone}");
        }
        // What the request is about stays: its host, its session, its cookies.
        assert_eq!(out["host"], "kasa-1.local:4443");
        assert_eq!(out["authorization"], "Bearer user-session");
        assert_eq!(out["cookie"], "a=1");
        assert_eq!(out["x-forwarded-proto"], "http");
    }

    #[test]
    fn the_desktop_credential_crosses_the_lan_ingress_only() {
        let client = headers(&[("host", "kasa-1.local"), ("x-lgr-desktop-token", "a.b.c")]);
        assert_eq!(stamp(&client, Source::Lan, "192.168.1.20".parse().unwrap(), &up(), true)["x-lgr-desktop-token"], "a.b.c");
        assert!(stamp(&client, Source::Tunnel, "1.2.3.4".parse().unwrap(), &up(), false).get("x-lgr-desktop-token").is_none());
        assert!(stamp(&client, Source::Console, "127.0.0.1".parse().unwrap(), &up(), false).get("x-lgr-desktop-token").is_none());
        assert_eq!(stamp(&client, Source::Lan, "192.168.1.20".parse().unwrap(), &up(), true)["x-forwarded-proto"], "https");
    }

    #[test]
    fn hop_by_hop_headers_stop_at_the_ingress_but_host_never_does() {
        let client = headers(&[("host", "kasa-1"), ("connection", "keep-alive, X-Secret-Hop, host"), ("keep-alive", "timeout=5"), ("x-secret-hop", "1"), ("te", "trailers")]);
        let out = stamp(&client, Source::Lan, "192.168.1.2".parse().unwrap(), &up(), true);
        for gone in ["connection", "keep-alive", "x-secret-hop", "te"] {
            assert!(out.get(gone).is_none(), "{gone}");
        }
        assert_eq!(out["host"], "kasa-1");
    }

    #[test]
    fn only_a_websocket_upgrade_is_one() {
        assert!(is_websocket_upgrade(&headers(&[("connection", "keep-alive, Upgrade"), ("upgrade", "websocket")])));
        assert!(!is_websocket_upgrade(&headers(&[("connection", "Upgrade"), ("upgrade", "h2c")])));
        assert!(!is_websocket_upgrade(&headers(&[("upgrade", "websocket")])));
    }

    #[test]
    fn same_is_exact() {
        assert!(same(b"token", b"token"));
        assert!(!same(b"token", b"tokeN"));
        assert!(!same(b"token", b"token2"));
        assert!(!same(b"", b"x"));
    }

    // ── End to end: a real upstream, real sockets ────────────────────────────────────────────────

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// An upstream standing in for the API: every request is answered with the headers and body it
    /// arrived with, as JSON; a WebSocket upgrade is answered 101 and then echoes raw bytes back.
    async fn echo_upstream() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let service = hyper::service::service_fn(|mut req: Request<Incoming>| async move {
                        if is_websocket_upgrade(req.headers()) {
                            let upgraded = hyper::upgrade::on(&mut req);
                            tokio::spawn(async move {
                                let mut io = TokioIo::new(upgraded.await.unwrap());
                                let mut buf = [0u8; 64];
                                let n = io.read(&mut buf).await.unwrap();
                                io.write_all(&buf[..n]).await.unwrap();
                            });
                            let mut r = Response::new(empty());
                            *r.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
                            r.headers_mut().insert(CONNECTION, HeaderValue::from_static("upgrade"));
                            r.headers_mut().insert(UPGRADE, HeaderValue::from_static("websocket"));
                            return Ok::<_, Infallible>(r);
                        }
                        let seen: serde_json::Map<String, serde_json::Value> =
                            req.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").into())).collect();
                        let body = req.into_body().collect().await.map(|b| b.to_bytes()).unwrap_or_default();
                        Ok(text(StatusCode::OK, &serde_json::json!({ "headers": seen, "body": String::from_utf8_lossy(&body) }).to_string()))
                    });
                    let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service).with_upgrades().await;
                });
            }
        });
        port
    }

    /// An ingress of `source` in front of `api`, on a port of its own.
    async fn ingress(source: Source, api: u16) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let up = Arc::new(Upstream { port: api, secret: "the-front-secret".into() });
        tokio::spawn(serve(listener, move |req, peer| {
            let up = up.clone();
            async move { forward(req, source, peer, &up, source == Source::Lan).await }
        }));
        port
    }

    /// One raw HTTP/1.1 exchange, `Connection: close`: (status, head, body).
    async fn raw(port: u16, request: &str) -> (u16, String, String) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(request.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        tokio::time::timeout(Duration::from_secs(10), s.read_to_end(&mut out)).await.unwrap().unwrap();
        let text = String::from_utf8_lossy(&out).into_owned();
        let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
        let status = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        (status, head.to_string(), body.to_string())
    }

    #[tokio::test]
    async fn a_request_reaches_the_api_cleaned_stamped_and_whole() {
        let lan = ingress(Source::Lan, echo_upstream().await).await;
        let (status, _, body) = raw(
            lan,
            "POST /api/x?y=1 HTTP/1.1\r\nHost: kasa-1.local:4443\r\nX-LGR-Source: console\r\nX-LGR-Front: guessed\r\n\
             X-Forwarded-For: 6.6.6.6\r\nX-LGR-Desktop-Token: a.b.c\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let seen: serde_json::Value = serde_json::from_str(&body).unwrap();
        let h = &seen["headers"];
        assert_eq!(h["x-lgr-source"], "lan");
        assert_eq!(h["x-lgr-front"], "the-front-secret");
        assert_eq!(h["x-lgr-client-ip"], "127.0.0.1");
        assert_eq!(h["x-lgr-desktop-token"], "a.b.c");
        assert_eq!(h["x-forwarded-proto"], "https");
        assert_eq!(h["host"], "kasa-1.local:4443");
        assert!(h.get("x-forwarded-for").is_none());
        assert_eq!(seen["body"], "hello");
    }

    #[tokio::test]
    async fn a_websocket_upgrade_becomes_a_pipe_to_the_api() {
        let lan = ingress(Source::Lan, echo_upstream().await).await;
        let mut s = TcpStream::connect(("127.0.0.1", lan)).await.unwrap();
        s.write_all(
            b"GET /ws/tasks HTTP/1.1\r\nHost: kasa-1.local\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\
              Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        )
        .await
        .unwrap();
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            s.read_exact(&mut byte).await.unwrap();
            head.push(byte[0]);
        }
        assert!(String::from_utf8_lossy(&head).starts_with("HTTP/1.1 101"), "{}", String::from_utf8_lossy(&head));
        // Past the 101 it is the API's socket, byte for byte.
        s.write_all(b"ping").await.unwrap();
        let mut echo = [0u8; 4];
        tokio::time::timeout(Duration::from_secs(5), s.read_exact(&mut echo)).await.unwrap().unwrap();
        assert_eq!(&echo, b"ping");
    }

    #[tokio::test]
    async fn an_api_that_is_not_up_is_a_502_at_once() {
        let nothing = TcpListener::bind(("127.0.0.1", 0)).await.unwrap().local_addr().unwrap().port();
        let lan = ingress(Source::Lan, nothing).await;
        let (status, _, body) = raw(lan, "GET / HTTP/1.1\r\nHost: kasa-1\r\nConnection: close\r\n\r\n").await;
        assert_eq!(status, 502);
        assert!(body.contains("starting"), "{body}");
    }

    #[tokio::test]
    async fn the_console_opens_with_its_token_only_and_keeps_its_session_to_itself() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("setup-complete");
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let up = Arc::new(Upstream { port: echo_upstream().await, secret: "the-front-secret".into() });
        let console = Arc::new(Console::new(port, "the-setup-token".into(), up, marker.clone()));
        let closed = tokio::spawn(console.serve_until_complete(listener, Duration::from_millis(100)));
        let host = format!("127.0.0.1:{port}");
        let get = |path: &str, extra: &str| format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n{extra}Connection: close\r\n\r\n");

        // Its own address only: a page that rebinds its name to this machine is refused first.
        let (status, _, _) = raw(port, &format!("GET /__lgr/setup HTTP/1.1\r\nHost: attacker.example:{port}\r\nConnection: close\r\n\r\n")).await;
        assert_eq!(status, 403);
        // The page that trades the fragment's token for a session.
        let (status, head, page) = raw(port, &get("/__lgr/setup", "")).await;
        assert_eq!(status, 200);
        assert!(head.to_ascii_lowercase().contains("text/html") && page.contains("/__lgr/setup/session"));
        // Nothing else without a session.
        assert_eq!(raw(port, &get("/", "")).await.0, 403);

        let session = |token: &str| {
            let body = serde_json::json!({ "token": token }).to_string();
            format!("POST /__lgr/setup/session HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
        };
        assert_eq!(raw(port, &session("a-guess")).await.0, 403);
        let (status, head, _) = raw(port, &session("the-setup-token")).await;
        assert_eq!(status, 204);
        let cookie = head
            .lines()
            .find_map(|l| l.strip_prefix("set-cookie: ").or_else(|| l.strip_prefix("Set-Cookie: ")))
            .and_then(|c| c.split(';').next())
            .unwrap()
            .to_string();
        assert!(cookie.starts_with("lgr_setup="), "{cookie}");
        assert!(head.contains("HttpOnly") && head.contains("SameSite=Strict"), "{head}");

        // With it, the request reaches the API stamped `console`, and the session stops here.
        let (status, _, body) = raw(port, &get("/api/auth/register", &format!("Cookie: theme=dark; {cookie}\r\nX-LGR-Source: lan\r\n"))).await;
        assert_eq!(status, 200, "{body}");
        let h = &serde_json::from_str::<serde_json::Value>(&body).unwrap()["headers"];
        assert_eq!(h["x-lgr-source"], "console");
        assert_eq!(h["cookie"], "theme=dark");
        // A made-up session is no session.
        assert_eq!(raw(port, &get("/", "Cookie: lgr_setup=made-up\r\n")).await.0, 403);

        // Setup complete: the console closes itself.
        std::fs::write(&marker, "").unwrap();
        tokio::time::timeout(Duration::from_secs(5), closed).await.unwrap().unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err(), "the console still listens");
    }

    #[tokio::test]
    async fn the_lan_ingress_speaks_tls_on_the_masters_own_certificate() {
        let dir = tempfile::tempdir().unwrap();
        let names = crate::certs::wanted_names(&["kasa-1".into(), "kasa-1.local".into()], &[]);
        let identity = crate::certs::LanIdentity::ensure(dir.path(), &names).unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let up = Arc::new(Upstream { port: echo_upstream().await, secret: "the-front-secret".into() });
        let ca_pem = Arc::new(identity.ca_pem.clone());
        tokio::spawn(serve_tls(listener, identity.server_config().unwrap(), move |req, peer| {
            let (up, ca_pem) = (up.clone(), ca_pem.clone());
            async move {
                if let Some(answer) = lan_ca_answer(&req, &ca_pem) {
                    return answer;
                }
                forward(req, Source::Lan, peer, &up, true).await
            }
        }));

        let connect = |roots: rustls::RootCertStore, name: &'static str| async move {
            let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_root_certificates(roots)
                .with_no_client_auth();
            let tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let server = rustls::pki_types::ServerName::try_from(name).unwrap();
            tokio_rustls::TlsConnector::from(Arc::new(config)).connect(server, tcp).await
        };
        // Pinned to the master's CA, by name and by address.
        let mut pinned = rustls::RootCertStore::empty();
        use rustls::pki_types::pem::PemObject;
        pinned.add(rustls::pki_types::CertificateDer::from_pem_slice(identity.ca_pem.as_bytes()).unwrap()).unwrap();
        for name in ["kasa-1.local", "127.0.0.1"] {
            let mut tls = connect(pinned.clone(), name).await.unwrap_or_else(|e| panic!("{name}: {e}"));
            tls.write_all(format!("GET /api/x HTTP/1.1\r\nHost: {name}:{port}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            let mut out = Vec::new();
            let _ = tls.read_to_end(&mut out).await;
            let text = String::from_utf8_lossy(&out);
            assert!(text.starts_with("HTTP/1.1 200"), "{name}: {text}");
            let body = text.split_once("\r\n\r\n").unwrap().1;
            let h = &serde_json::from_str::<serde_json::Value>(body).unwrap()["headers"];
            assert_eq!(h["x-lgr-source"], "lan");
            assert_eq!(h["x-forwarded-proto"], "https");
        }
        // The CA, for a desktop pairing with this master: answered by the ingress itself, exactly the
        // CA it is pinned to, and to GET only (anything else goes to the API as usual).
        let mut tls = connect(pinned.clone(), "kasa-1.local").await.unwrap();
        tls.write_all(format!("GET {CA_PATH} HTTP/1.1\r\nHost: kasa-1.local:{port}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut out = Vec::new();
        let _ = tls.read_to_end(&mut out).await;
        let text = String::from_utf8_lossy(&out);
        assert!(text.starts_with("HTTP/1.1 200"), "{text}");
        assert!(text.to_ascii_lowercase().contains("application/x-pem-file"), "{text}");
        assert_eq!(text.split_once("\r\n\r\n").unwrap().1, identity.ca_pem);
        let mut tls = connect(pinned.clone(), "kasa-1.local").await.unwrap();
        tls.write_all(format!("POST {CA_PATH} HTTP/1.1\r\nHost: kasa-1.local:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut out = Vec::new();
        let _ = tls.read_to_end(&mut out).await;
        assert!(String::from_utf8_lossy(&out).contains("x-lgr-source"), "a POST is the API's");

        // A name the certificate does not carry, and a client that does not trust the CA: no handshake.
        assert!(connect(pinned.clone(), "attacker.example").await.is_err());
        assert!(connect(rustls::RootCertStore::empty(), "kasa-1.local").await.is_err());
    }
}
