//! The tunnel, this master's side (FR-20.73, plan step P3-4c): what reaches an org's address,
//! `<label>.lgrai.app`, comes over the interactive uplink as streams, and goes to the API like any
//! other request, as the `tunnel` source (FR-20.16).
//!
//! - **The wire** is `services/biz/tunnel/tunnel-frame.ts`'s: JSON control frames (`tun-open`,
//!   `tun-credit`, `tun-cancel`, `tun-ws-close` in; `tun-head`, `tun-ws-open`, `tun-credit`,
//!   `tun-error`, `tun-ws-close` out) and binary `LGRT` data frames.
//! - **One task per stream.** An HTTP stream sends its request to the API, the body as global sends
//!   it, granting global credit as the API takes each chunk; the answer goes back within the credit
//!   global grants as the browser reads. A WebSocket stream opens one to the API and carries whole
//!   messages both ways.
//! - **The same API, the same rules** as a LAN request (`ingress::stamp`, `Source::Tunnel`): the
//!   client's `X-LGR-*` and forwarding headers dropped, the front secret, the source and the client's
//!   address stamped, and the org's address as `Host`. The API allows that name only for this source,
//!   and never the desktop-credential gate's LAN rule (`front-guard.ts`).
//! - ⚠ Nothing here waits on the socket's outbound channel from the session's own loop, which is what
//!   drains it: an immediate answer from the loop goes through a spawned send.

use crate::ingress::{stamp, Source, Upstream};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Empty, StreamBody};
use hyper::body::Frame;
use hyper::header::{HeaderMap, HeaderName, HeaderValue};
use hyper::{Method, Request};
use hyper_util::rt::TokioIo;
use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

pub const MAGIC: [u8; 4] = *b"LGRT";
pub const VERSION: u8 = 1;
pub const HEADER: usize = 11;
pub const KIND_BODY: u8 = 0;
pub const KIND_WS_TEXT: u8 = 1;
pub const KIND_WS_BINARY: u8 = 2;
pub const FLAG_END: u8 = 1;
/// The most one data frame carries.
pub const CHUNK: usize = 64 * 1024;
/// What each side may have in flight per stream before the other grants more.
pub const WINDOW: u64 = 256 * 1024;
/// Streams open at once through this server's tunnel.
pub const MAX_STREAMS: usize = 256;
/// The largest WebSocket message carried.
const WS_MESSAGE_MAX: usize = 1024 * 1024;

pub fn is_frame(b: &[u8]) -> bool {
    b.len() >= HEADER && b[..4] == MAGIC
}

pub fn encode(kind: u8, sid: u32, end: bool, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER + payload.len());
    out.extend_from_slice(&MAGIC);
    out.push(VERSION);
    out.push(kind);
    out.push(if end { FLAG_END } else { 0 });
    out.extend_from_slice(&sid.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// `(kind, sid, end, payload)`, or None when these bytes are not a frame this version reads.
pub fn decode(b: &[u8]) -> Option<(u8, u32, bool, &[u8])> {
    if !is_frame(b) || b[4] != VERSION || b[5] > KIND_WS_BINARY {
        return None;
    }
    let sid = u32::from_be_bytes([b[7], b[8], b[9], b[10]]);
    Some((b[5], sid, b[6] & FLAG_END != 0, &b[HEADER..]))
}

/// What a stream's task hears from global.
enum Inbound {
    Body(Bytes, bool),
    Credit(u64),
    WsText(String),
    WsBinary(Bytes),
    WsClose(u16, String),
}

/// A stream's task: it ends when its handle is dropped (a cancel, the session's end).
struct Handle {
    tx: mpsc::UnboundedSender<Inbound>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// What `tun-open` asked for.
#[derive(Debug, Clone)]
struct Open {
    method: String,
    path: String,
    host: String,
    headers: Vec<(String, String)>,
    client: IpAddr,
    body: bool,
}

impl Open {
    fn from(v: &serde_json::Value) -> Option<Self> {
        let path = v["path"].as_str().filter(|p| p.starts_with('/') && p.len() <= 8192)?.to_string();
        let host = v["host"].as_str().map(|h| h.trim().to_ascii_lowercase()).filter(|h| !h.is_empty() && h.len() <= 255 && h.bytes().all(|b| b.is_ascii_alphanumeric() || b".-:".contains(&b)))?;
        let headers = v["headers"]
            .as_array()
            .map(|a| {
                a.iter()
                    .take(200)
                    .filter_map(|p| Some((p.get(0)?.as_str()?.to_string(), p.get(1)?.as_str()?.to_string())))
                    .collect()
            })
            .unwrap_or_default();
        Some(Open {
            method: v["method"].as_str().unwrap_or("GET").to_string(),
            path,
            host,
            headers,
            client: v["client"]["ip"].as_str().and_then(|ip| ip.parse().ok()).unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED)),
            body: v["body"].as_bool().unwrap_or(false),
        })
    }

    /// The headers the API gets: the browser's as global passed them, cleaned and stamped as every
    /// ingress does, with the org's address as `Host`.
    fn api_headers(&self, up: &Upstream) -> HeaderMap {
        let mut client = HeaderMap::with_capacity(self.headers.len());
        for (k, v) in &self.headers {
            if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
                client.append(name, value);
            }
        }
        let mut out = stamp(&client, Source::Tunnel, self.client, up, true);
        if let Ok(host) = HeaderValue::from_str(&self.host) {
            out.insert(hyper::header::HOST, host);
        }
        out
    }
}

/// The tunnel of one interactive session: its streams, by global's id for them.
pub struct Tunnel {
    up: Arc<Upstream>,
    out: mpsc::Sender<Message>,
    streams: HashMap<u32, Handle>,
    /// FR-20.18: `state/setup-complete`. While it does not exist the tunnel carries nothing, and
    /// says so to global for every stream.
    setup_marker: Option<std::path::PathBuf>,
}

fn text(v: serde_json::Value) -> Message {
    Message::text(v.to_string())
}

fn error(sid: u32, code: &str, message: &str) -> Message {
    text(serde_json::json!({ "t": "tun-error", "sid": sid, "code": code, "message": message }))
}

impl Tunnel {
    pub fn new(up: Arc<Upstream>, out: mpsc::Sender<Message>) -> Self {
        Self { up, out, streams: HashMap::new(), setup_marker: None }
    }

    /// Carry nothing until `marker` exists (FR-20.18: "the uplink carries no tunnel traffic until
    /// setup is complete"). Read at every stream, so `setup reset` closes it at once.
    pub fn until_setup_complete(mut self, marker: Option<std::path::PathBuf>) -> Self {
        self.setup_marker = marker;
        self
    }

    /// From the session's loop, which drains `out`: never awaited there.
    fn answer_later(&self, m: Message) {
        let out = self.out.clone();
        tokio::spawn(async move {
            let _ = out.send(m).await;
        });
    }

    fn deliver(&mut self, sid: u32, ev: Inbound) {
        if let Some(h) = self.streams.get(&sid) {
            if h.tx.send(ev).is_err() {
                self.streams.remove(&sid);
            }
        }
    }

    /// A control frame from global (`t` starting with `tun-`).
    pub fn control(&mut self, v: &serde_json::Value) {
        let Some(sid) = v["sid"].as_u64().and_then(|s| u32::try_from(s).ok()) else { return };
        match v["t"].as_str() {
            Some("tun-open") => self.open(sid, v),
            Some("tun-credit") => {
                if let Some(n) = v["bytes"].as_u64().filter(|n| *n > 0 && *n <= 64 * WINDOW) {
                    self.deliver(sid, Inbound::Credit(n));
                }
            }
            // Dropping the handle ends the stream's task, and with it the API's request.
            Some("tun-cancel") => {
                self.streams.remove(&sid);
            }
            Some("tun-ws-close") => {
                let code = v["code"].as_u64().and_then(|c| u16::try_from(c).ok()).unwrap_or(1000);
                let reason = v["reason"].as_str().unwrap_or("").chars().take(120).collect();
                self.deliver(sid, Inbound::WsClose(code, reason));
            }
            _ => {}
        }
    }

    /// A data frame from global: a request body chunk, or a WebSocket message.
    pub fn data(&mut self, bytes: &[u8]) {
        let Some((kind, sid, end, payload)) = decode(bytes) else { return };
        let ev = match kind {
            KIND_BODY => Inbound::Body(Bytes::copy_from_slice(payload), end),
            KIND_WS_TEXT => match std::str::from_utf8(payload) {
                Ok(t) => Inbound::WsText(t.to_string()),
                Err(_) => return,
            },
            _ => Inbound::WsBinary(Bytes::copy_from_slice(payload)),
        };
        self.deliver(sid, ev);
    }

    fn open(&mut self, sid: u32, v: &serde_json::Value) {
        self.streams.retain(|_, h| !h.tx.is_closed());
        if self.streams.contains_key(&sid) {
            return;
        }
        if self.streams.len() >= MAX_STREAMS {
            self.answer_later(error(sid, "busy", "This server has too many requests open."));
            return;
        }
        if self.setup_marker.as_ref().is_some_and(|m| !m.exists()) {
            self.answer_later(error(sid, "setup_incomplete", "This server is being set up: it serves nothing through lgrai.app until setup is complete."));
            return;
        }
        let Some(open) = Open::from(v) else {
            self.answer_later(error(sid, "bad_request", "The request cannot be read."));
            return;
        };
        let (tx, rx) = mpsc::unbounded_channel();
        let (up, out) = (self.up.clone(), self.out.clone());
        let task = match v["kind"].as_str() {
            Some("ws") => tokio::spawn(ws_stream(sid, open, up, rx, out)),
            _ => tokio::spawn(http_stream(sid, open, up, rx, out)),
        };
        self.streams.insert(sid, Handle { tx, task });
    }

    /// Streams open now.
    #[cfg(test)]
    pub fn open_streams(&mut self) -> usize {
        self.streams.retain(|_, h| !h.tx.is_closed());
        self.streams.len()
    }
}

/// Headers that describe one hop, never the answer.
const HOP: &[&str] = &["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];

fn header_pairs(h: &HeaderMap) -> Vec<(String, String)> {
    h.iter()
        .filter(|(n, _)| !HOP.contains(&n.as_str()))
        .filter_map(|(n, v)| Some((n.as_str().to_string(), v.to_str().ok()?.to_string())))
        .collect()
}

type ReqBody = UnsyncBoxBody<Bytes, Infallible>;

/// One HTTP request through the tunnel.
async fn http_stream(sid: u32, open: Open, up: Arc<Upstream>, mut rx: mpsc::UnboundedReceiver<Inbound>, out: mpsc::Sender<Message>) {
    let Ok(method) = Method::from_bytes(open.method.as_bytes()) else {
        let _ = out.send(error(sid, "bad_request", "The method cannot be read.")).await;
        return;
    };
    let (body_tx, body_rx) = mpsc::channel::<Result<Frame<Bytes>, Infallible>>(1);
    let body: ReqBody = if open.body {
        StreamBody::new(futures_util::stream::unfold(body_rx, |mut rx| async move { rx.recv().await.map(|f| (f, rx)) })).boxed_unsync()
    } else {
        Empty::<Bytes>::new().boxed_unsync()
    };
    let mut req = match Request::builder().method(method).uri(open.path.as_str()).body(body) {
        Ok(r) => r,
        Err(_) => {
            let _ = out.send(error(sid, "bad_request", "The request cannot be read.")).await;
            return;
        }
    };
    *req.headers_mut() = open.api_headers(&up);

    let api_down = || error(sid, "api_down", "The server is starting or restarting. Try again in a moment.");
    let Ok(tcp) = TcpStream::connect(("127.0.0.1", up.port)).await else {
        let _ = out.send(api_down()).await;
        return;
    };
    let Ok((mut sender, conn)) = hyper::client::conn::http1::handshake::<_, ReqBody>(TokioIo::new(tcp)).await else {
        let _ = out.send(api_down()).await;
        return;
    };
    tokio::spawn(async move {
        let _ = conn.await;
    });

    // The request body, as global sends it: held here until the API takes each chunk, then granted
    // back. Global sends no more than the window, so this queue is bounded by it.
    let mut body_tx = open.body.then_some(body_tx);
    let mut pending: VecDeque<Bytes> = VecDeque::new();
    let mut body_ended = false;
    let mut credit: u64 = WINDOW;
    let mut out_pending: Option<Bytes> = None;
    let response = sender.send_request(req);
    tokio::pin!(response);
    let mut head: Option<hyper::body::Incoming> = None;

    loop {
        // What global granted, spent on what the API answered: a frame at a time, never past it.
        while let Some(data) = out_pending.take() {
            if credit == 0 {
                out_pending = Some(data);
                break;
            }
            let n = data.len().min(CHUNK).min(credit as usize);
            if out.send(Message::binary(encode(KIND_BODY, sid, false, &data[..n]))).await.is_err() {
                return;
            }
            credit -= n as u64;
            if n < data.len() {
                out_pending = Some(data.slice(n..));
            }
        }
        let body_ready = body_tx.is_some() && !pending.is_empty();
        // Reserved on a clone: the permit must not borrow what the arm below may drop.
        let feeder = body_tx.clone();
        let reading = head.is_some() && out_pending.is_none() && credit > 0;
        tokio::select! {
            ev = rx.recv() => match ev {
                None => return,
                Some(Inbound::Body(chunk, end)) => {
                    if !chunk.is_empty() {
                        pending.push_back(chunk);
                    }
                    body_ended |= end;
                }
                Some(Inbound::Credit(n)) => credit = credit.saturating_add(n),
                Some(_) => {}
            },
            permit = async { feeder.as_ref().expect("guarded").reserve().await }, if body_ready => {
                match permit {
                    Ok(permit) => {
                        let chunk = pending.pop_front().expect("guarded");
                        let n = chunk.len();
                        permit.send(Ok(Frame::data(chunk)));
                        if out.send(text(serde_json::json!({ "t": "tun-credit", "sid": sid, "bytes": n }))).await.is_err() {
                            return;
                        }
                    }
                    // The API stopped reading the body: what is left of it goes nowhere.
                    Err(_) => {
                        body_tx = None;
                        pending.clear();
                    }
                }
            }
            r = &mut response, if head.is_none() => match r {
                Ok(resp) => {
                    let (parts, body) = resp.into_parts();
                    let msg = serde_json::json!({ "t": "tun-head", "sid": sid, "status": parts.status.as_u16(), "headers": header_pairs(&parts.headers) });
                    if out.send(text(msg)).await.is_err() {
                        return;
                    }
                    head = Some(body);
                }
                Err(_) => {
                    let _ = out.send(api_down()).await;
                    return;
                }
            },
            frame = async { head.as_mut().expect("guarded").frame().await }, if reading => match frame {
                None => {
                    let _ = out.send(Message::binary(encode(KIND_BODY, sid, true, &[]))).await;
                    return;
                }
                Some(Ok(f)) => {
                    if let Ok(data) = f.into_data() {
                        if !data.is_empty() {
                            out_pending = Some(data);
                        }
                    }
                }
                Some(Err(_)) => {
                    let _ = out.send(error(sid, "api_error", "The server's answer broke off.")).await;
                    return;
                }
            },
        }
        // The whole body has been taken: the API sees its end.
        if body_ended && pending.is_empty() && body_tx.is_some() {
            body_tx = None;
        }
    }
}

/// One WebSocket through the tunnel: opened on the API with the same stamps, then whole messages.
async fn ws_stream(sid: u32, open: Open, up: Arc<Upstream>, mut rx: mpsc::UnboundedReceiver<Inbound>, out: mpsc::Sender<Message>) {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let api_down = || error(sid, "api_down", "The server is starting or restarting. Try again in a moment.");
    let Ok(mut request) = format!("ws://127.0.0.1:{}{}", up.port, open.path).into_client_request() else {
        let _ = out.send(error(sid, "bad_request", "The request cannot be read.")).await;
        return;
    };
    for (name, value) in open.api_headers(&up).iter() {
        request.headers_mut().insert(name.clone(), value.clone());
    }
    let Ok(tcp) = TcpStream::connect(("127.0.0.1", up.port)).await else {
        let _ = out.send(api_down()).await;
        return;
    };
    let (mut api, response) = match tokio_tungstenite::client_async(request, tcp).await {
        Ok(x) => x,
        Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => {
            let msg = serde_json::json!({ "t": "tun-head", "sid": sid, "status": resp.status().as_u16(), "headers": header_pairs(resp.headers()) });
            let _ = out.send(text(msg)).await;
            return;
        }
        Err(_) => {
            let _ = out.send(api_down()).await;
            return;
        }
    };
    let protocol = response.headers().get("sec-websocket-protocol").and_then(|v| v.to_str().ok()).map(String::from);
    if out.send(text(serde_json::json!({ "t": "tun-ws-open", "sid": sid, "protocol": protocol }))).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                None => {
                    let _ = api.close(None).await;
                    return;
                }
                Some(Inbound::WsText(t)) => {
                    if api.send(Message::text(t)).await.is_err() {
                        break;
                    }
                }
                Some(Inbound::WsBinary(b)) => {
                    if api.send(Message::binary(b)).await.is_err() {
                        break;
                    }
                }
                Some(Inbound::WsClose(code, reason)) => {
                    let _ = api.close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() })).await;
                    return;
                }
                Some(_) => {}
            },
            m = api.next() => match m {
                Some(Ok(Message::Text(t))) if t.len() <= WS_MESSAGE_MAX => {
                    if out.send(Message::binary(encode(KIND_WS_TEXT, sid, false, t.as_bytes()))).await.is_err() {
                        return;
                    }
                }
                Some(Ok(Message::Binary(b))) if b.len() <= WS_MESSAGE_MAX => {
                    if out.send(Message::binary(encode(KIND_WS_BINARY, sid, false, &b))).await.is_err() {
                        return;
                    }
                }
                Some(Ok(Message::Close(f))) => {
                    let (code, reason) = f.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or((1000, String::new()));
                    let _ = out.send(text(serde_json::json!({ "t": "tun-ws-close", "sid": sid, "code": code, "reason": reason }))).await;
                    return;
                }
                Some(Ok(Message::Text(_) | Message::Binary(_))) => break,
                Some(Ok(_)) => {}
                None | Some(Err(_)) => break,
            },
        }
    }
    let _ = out.send(text(serde_json::json!({ "t": "tun-ws-close", "sid": sid, "code": 1011, "reason": "the server's socket ended" }))).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn frames_round_trip_and_refuse_what_is_not_one() {
        let f = encode(KIND_WS_TEXT, 0xdead_beef, false, b"hi");
        assert_eq!(decode(&f), Some((KIND_WS_TEXT, 0xdead_beef, false, &b"hi"[..])));
        assert_eq!(decode(&encode(KIND_BODY, 7, true, &[])), Some((KIND_BODY, 7, true, &[][..])));
        let mut bad = f.clone();
        bad[4] = 2;
        assert_eq!(decode(&bad), None, "a version this one does not read");
        let mut kind = f.clone();
        kind[5] = 9;
        assert_eq!(decode(&kind), None);
        assert!(!is_frame(b"LGRB-a-blob-frame"));
    }

    /// What the stand-in API heard of one request: its first line and headers, and its body.
    #[derive(Default, Clone)]
    struct Heard {
        head: String,
        body: Vec<u8>,
    }

    /// A stand-in API: one connection, one request (a fixed-length body), then `answer` as it is.
    async fn api(answer: &'static [u8]) -> (u16, Arc<Mutex<Heard>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let heard = Arc::new(Mutex::new(Heard::default()));
        let h = heard.clone();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![];
            let mut chunk = [0u8; 65536];
            let head_end = loop {
                let n = s.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
                if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
            let lower = head.to_ascii_lowercase();
            let mut body = buf[head_end..].to_vec();
            if lower.contains("transfer-encoding: chunked") {
                // Read chunks to the terminating one.
                while !body.windows(5).any(|w| w == b"0\r\n\r\n") {
                    let n = s.read(&mut chunk).await.unwrap();
                    body.extend_from_slice(&chunk[..n]);
                }
                body = dechunk(&body);
            } else if let Some(len) = lower.lines().find_map(|l| l.strip_prefix("content-length: ").and_then(|v| v.trim().parse::<usize>().ok())) {
                while body.len() < len {
                    let n = s.read(&mut chunk).await.unwrap();
                    body.extend_from_slice(&chunk[..n]);
                }
            }
            *h.lock().unwrap() = Heard { head, body };
            s.write_all(answer).await.unwrap();
            s.flush().await.unwrap();
        });
        (port, heard)
    }

    fn dechunk(b: &[u8]) -> Vec<u8> {
        let mut out = vec![];
        let mut i = 0;
        while let Some(rel) = b[i..].windows(2).position(|w| w == b"\r\n") {
            let size = usize::from_str_radix(std::str::from_utf8(&b[i..i + rel]).unwrap().trim(), 16).unwrap();
            i += rel + 2;
            if size == 0 {
                break;
            }
            out.extend_from_slice(&b[i..i + size]);
            i += size + 2;
        }
        out
    }

    fn open_frame(sid: u32, method: &str, body: bool) -> serde_json::Value {
        serde_json::json!({
            "t": "tun-open", "sid": sid, "kind": "http", "method": method, "path": "/api/things?x=1", "host": "shop-a.lgrai.app",
            "headers": [["authorization", "Bearer tok"], ["x-lgr-source", "lan"], ["x-forwarded-for", "10.0.0.1"], ["accept", "application/json"]],
            "client": { "ip": "203.0.113.9" }, "body": body,
        })
    }

    async fn next_out(rx: &mut mpsc::Receiver<Message>) -> Message {
        tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("nothing came back").expect("closed")
    }

    #[tokio::test]
    async fn a_request_reaches_the_api_stamped_and_its_answer_comes_back_in_frames() {
        let (port, heard) = api(b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\nset-cookie: __Host-auth=a; Path=/\r\ncontent-length: 5\r\nconnection: close\r\n\r\nhello").await;
        let (tx, mut rx) = mpsc::channel(64);
        let mut t = Tunnel::new(Arc::new(Upstream { port, secret: "the-front-secret".into() }), tx);
        t.control(&open_frame(1, "GET", false));
        let head: serde_json::Value = match next_out(&mut rx).await {
            Message::Text(s) => serde_json::from_str(s.as_str()).unwrap(),
            other => panic!("{other:?}"),
        };
        assert_eq!((head["t"].as_str(), head["status"].as_u64()), (Some("tun-head"), Some(200)));
        let names: Vec<&str> = head["headers"].as_array().unwrap().iter().map(|p| p[0].as_str().unwrap()).collect();
        assert!(names.contains(&"set-cookie") && !names.contains(&"connection"), "{names:?}");
        let mut body = vec![];
        loop {
            match next_out(&mut rx).await {
                Message::Binary(b) => {
                    let (kind, sid, end, payload) = decode(&b).unwrap();
                    assert_eq!((kind, sid), (KIND_BODY, 1));
                    body.extend_from_slice(payload);
                    if end {
                        break;
                    }
                }
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(body, b"hello");
        let head = heard.lock().unwrap().head.to_ascii_lowercase();
        assert!(head.starts_with("get /api/things?x=1 http/1.1"), "{head}");
        for line in ["host: shop-a.lgrai.app", "x-lgr-front: the-front-secret", "x-lgr-source: tunnel", "x-lgr-client-ip: 203.0.113.9", "x-forwarded-proto: https", "authorization: bearer tok"] {
            assert!(head.contains(line), "missing {line}: {head}");
        }
        assert!(!head.contains("x-lgr-source: lan") && !head.contains("x-forwarded-for"), "{head}");
    }

    #[tokio::test]
    async fn a_body_reaches_the_api_and_each_chunk_it_takes_is_granted_back() {
        let (port, heard) = api(b"HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n").await;
        let (tx, mut rx) = mpsc::channel(64);
        let mut t = Tunnel::new(Arc::new(Upstream { port, secret: "s".into() }), tx);
        t.control(&open_frame(3, "POST", true));
        let payload: Vec<u8> = (0..150_000u32).map(|i| (i % 251) as u8).collect();
        for (i, piece) in payload.chunks(CHUNK).enumerate() {
            let last = (i + 1) * CHUNK >= payload.len();
            t.data(&encode(KIND_BODY, 3, last, piece));
        }
        let (mut granted, mut head) = (0u64, None);
        while head.is_none() || granted < payload.len() as u64 {
            match next_out(&mut rx).await {
                Message::Text(s) => {
                    let v: serde_json::Value = serde_json::from_str(s.as_str()).unwrap();
                    match v["t"].as_str() {
                        Some("tun-credit") => granted += v["bytes"].as_u64().unwrap(),
                        Some("tun-head") => head = v["status"].as_u64(),
                        other => panic!("{other:?}"),
                    }
                }
                Message::Binary(b) => assert!(decode(&b).unwrap().2, "only the end of a 204's body"),
                other => panic!("{other:?}"),
            }
        }
        assert_eq!((head, granted), (Some(204), payload.len() as u64));
        assert_eq!(heard.lock().unwrap().body, payload);
    }

    #[tokio::test]
    async fn a_large_answer_stops_at_the_window_until_global_grants_more() {
        let body: Vec<u8> = (0..600 * 1024u32).map(|i| (i % 253) as u8).collect();
        let mut answer = format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len()).into_bytes();
        answer.extend_from_slice(&body);
        let (port, _) = api(Box::leak(answer.into_boxed_slice())).await;
        let (tx, mut rx) = mpsc::channel(64);
        let mut t = Tunnel::new(Arc::new(Upstream { port, secret: "s".into() }), tx);
        t.control(&open_frame(5, "GET", false));
        assert!(matches!(next_out(&mut rx).await, Message::Text(s) if s.as_str().contains("tun-head")));
        let mut got: Vec<u8> = vec![];
        // Up to the window, and then nothing until the grant.
        while (got.len() as u64) < WINDOW {
            if let Message::Binary(b) = next_out(&mut rx).await {
                got.extend_from_slice(decode(&b).unwrap().3);
            }
        }
        assert_eq!(got.len() as u64, WINDOW);
        assert!(tokio::time::timeout(Duration::from_millis(200), rx.recv()).await.is_err(), "nothing past the window");
        t.control(&serde_json::json!({ "t": "tun-credit", "sid": 5, "bytes": 1024 * 1024 }));
        loop {
            if let Message::Binary(b) = next_out(&mut rx).await {
                let (_, _, end, payload) = decode(&b).unwrap();
                got.extend_from_slice(payload);
                if end {
                    break;
                }
            }
        }
        assert_eq!(got, body);
    }

    #[tokio::test]
    async fn a_websocket_opens_on_the_api_stamped_and_carries_whole_messages_both_ways() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(String::new()));
        let s = seen.clone();
        let api = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            #[allow(clippy::result_large_err)]
            let callback = move |req: &tokio_tungstenite::tungstenite::handshake::server::Request, resp| {
                *s.lock().unwrap() = format!("{} {:?}", req.uri(), req.headers());
                Ok(resp)
            };
            let mut ws = tokio_tungstenite::accept_hdr_async(tcp, callback).await.unwrap();
            // Echo, then close when told to.
            while let Some(Ok(m)) = ws.next().await {
                match m {
                    Message::Text(t) => ws.send(Message::text(format!("echo:{}", t.as_str()))).await.unwrap(),
                    Message::Close(f) => return f.map(|f| (u16::from(f.code), f.reason.to_string())),
                    _ => {}
                }
            }
            None
        });
        let (tx, mut rx) = mpsc::channel(64);
        let mut t = Tunnel::new(Arc::new(Upstream { port, secret: "front-secret".into() }), tx);
        let mut open = open_frame(7, "GET", false);
        open["kind"] = "ws".into();
        open["path"] = "/ws/tasks".into();
        t.control(&open);
        assert!(matches!(next_out(&mut rx).await, Message::Text(s) if s.as_str().contains("tun-ws-open")));
        let head = seen.lock().unwrap().to_ascii_lowercase();
        assert!(head.starts_with("/ws/tasks") && head.contains("\"x-lgr-source\": \"tunnel\"") && head.contains("\"host\": \"shop-a.lgrai.app\"") && head.contains("\"x-lgr-front\": \"front-secret\""), "{head}");
        t.data(&encode(KIND_WS_TEXT, 7, false, b"hello"));
        match next_out(&mut rx).await {
            Message::Binary(b) => assert_eq!(decode(&b), Some((KIND_WS_TEXT, 7, false, &b"echo:hello"[..]))),
            other => panic!("{other:?}"),
        }
        t.control(&serde_json::json!({ "t": "tun-ws-close", "sid": 7, "code": 4001, "reason": "bye" }));
        assert_eq!(tokio::time::timeout(Duration::from_secs(5), api).await.unwrap().unwrap(), Some((4001, "bye".to_string())));
    }

    #[tokio::test]
    async fn the_api_down_is_an_error_and_a_cancel_ends_the_stream() {
        // A port nothing listens on.
        let port = { TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port() };
        let (tx, mut rx) = mpsc::channel(64);
        let mut t = Tunnel::new(Arc::new(Upstream { port, secret: "s".into() }), tx);
        t.control(&open_frame(9, "GET", false));
        match next_out(&mut rx).await {
            Message::Text(s) => assert!(s.as_str().contains(r#""code":"api_down""#), "{s}"),
            other => panic!("{other:?}"),
        }
        // A stream waiting on an API that never answers ends with global's cancel.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let silent = listener.local_addr().unwrap().port();
        let _held = tokio::spawn(async move {
            let (_s, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let mut t = Tunnel::new(Arc::new(Upstream { port: silent, secret: "s".into() }), mpsc::channel(4).0);
        t.control(&open_frame(10, "GET", false));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(t.open_streams(), 1);
        t.control(&serde_json::json!({ "t": "tun-cancel", "sid": 10 }));
        assert_eq!(t.open_streams(), 0);
        // Nonsense opens nothing.
        t.control(&serde_json::json!({ "t": "tun-open", "sid": 11, "kind": "http", "path": "no-slash", "host": "x" }));
        assert_eq!(t.open_streams(), 0);
    }

    #[tokio::test]
    async fn until_setup_is_complete_the_tunnel_carries_nothing_and_says_why() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("setup-complete");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, mut rx) = mpsc::channel(64);
        let mut t = Tunnel::new(Arc::new(Upstream { port, secret: "s".into() }), tx).until_setup_complete(Some(marker.clone()));
        t.control(&open_frame(1, "GET", false));
        match next_out(&mut rx).await {
            Message::Text(s) => assert!(s.as_str().contains(r#""code":"setup_incomplete""#), "{s}"),
            other => panic!("{other:?}"),
        }
        assert_eq!(t.open_streams(), 0, "nothing reached the API");
        // Read at every stream: the moment setup is complete, the next one goes through.
        std::fs::write(&marker, "{}").unwrap();
        t.control(&open_frame(2, "GET", false));
        assert_eq!(t.open_streams(), 1);
    }
}
