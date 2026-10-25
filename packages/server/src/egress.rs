//! The API's one way out (FR-20.53, plan step P1-3d): a CONNECT proxy on loopback that applies the
//! machine's proxy rules, and the OS's trusted roots handed to the API.
//!
//! On a master the API makes no direct internet call. Bun's `fetch` carries its own CA bundle and no
//! PAC (FR-16.55's warning), so behind a corporate proxy or a TLS-inspecting middlebox it would just
//! fail. Instead the supervisor gives the API:
//! - `HTTPS_PROXY` / `HTTP_PROXY`: this proxy, with a per-boot credential in the URL (any process on
//!   the machine can reach a loopback port; only the API knows the credential). `NO_PROXY` keeps
//!   loopback direct;
//! - `NODE_EXTRA_CA_CERTS`: the OS's trusted roots, exported at every start (`run/os-roots.pem`), so
//!   a middlebox whose root came by GPO is trusted as the machine's browser trusts it.
//!
//! Bun 1.4.4 honours all four for `fetch`, credentials included (measured).
//!
//! Upstream, for each CONNECT, in order:
//! 1. `EGRESS_PROXY` (`config/api.env`): `http://host:port`, set in setup (FR-20.53), with
//!    `EGRESS_PROXY_AUTH=user:password` for Basic;
//! 2. on Windows, WinHTTP: the machine's setting (`netsh winhttp set proxy`), else WPAD and the PAC
//!    it names, or `EGRESS_PAC`. Read as the service account, which has no user settings to read.
//!    An answer is kept for 5 minutes, and "no WPAD here" for 10: detection can take seconds;
//! 3. direct.
//!
//! `EGRESS_BYPASS` and WinHTTP's own bypass list go direct.
//!
//! ⚠ Not yet: Negotiate (Kerberos/NTLM) proxy authentication. A proxy that asks for it answers 407,
//! and the call fails with that reason in the log and to the API. Plain-HTTP requests through the
//! proxy are refused (501), never sent direct behind its back.

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Where one CONNECT goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Direct,
    /// Through an upstream proxy, `host:port`, with its Basic credential if it needs one.
    Proxy { host: String, port: u16, basic: Option<String> },
}

/// The machine's rules, read once at start; WinHTTP's automatic answers are cached as they come.
pub struct Rules {
    explicit: Option<Route>,
    bypass: Vec<String>,
    #[cfg_attr(not(windows), allow(dead_code))]
    pac: Option<String>,
    #[cfg_attr(not(windows), allow(dead_code))]
    cache: Mutex<HashMap<String, (Route, Instant)>>,
}

/// `host:port`, an optional `http://`, and a default port.
fn host_port(entry: &str, default: u16) -> Option<(String, u16)> {
    let e = entry.trim().trim_start_matches("http://").trim_start_matches("https://").trim_end_matches('/');
    if e.is_empty() {
        return None;
    }
    if let Some(rest) = e.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        let port = after.strip_prefix(':').map(|p| p.parse().ok()).unwrap_or(Some(default))?;
        return Some((host.to_string(), port));
    }
    match e.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => Some((h.to_string(), p.parse().ok()?)),
        _ => Some((e.to_string(), default)),
    }
}

/// WinHTTP's proxy list (`host:port`, `host:port;other:port`, `http=a:80;https=b:8080`): the proxy
/// for an `https` URL, which is what a CONNECT carries.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_proxy_list(list: &str) -> Option<(String, u16)> {
    let entries: Vec<&str> = list.split([';', ' ']).map(str::trim).filter(|e| !e.is_empty()).collect();
    let scheme = |s: &str| entries.iter().find_map(|e| e.strip_prefix(s));
    if let Some(e) = scheme("https=") {
        return host_port(e, 80);
    }
    if entries.iter().any(|e| e.contains('=')) {
        // Only other schemes' proxies (`http=…`, `socks=…`): none for HTTPS, which goes direct.
        return None;
    }
    entries.first().and_then(|e| host_port(e, 80))
}

/// Whether `host` matches a bypass entry: `<local>` (a name with no dot), `*.corp.lan`, `10.*`,
/// `.corp.lan`, or the name itself.
pub fn bypassed(host: &str, bypass: &[String]) -> bool {
    let host = host.to_ascii_lowercase();
    bypass.iter().any(|b| {
        let b = b.trim().to_ascii_lowercase();
        if b.is_empty() {
            false
        } else if b == "<local>" {
            !host.contains('.')
        } else if let Some(suffix) = b.strip_prefix('*') {
            host.ends_with(suffix)
        } else if let Some(prefix) = b.strip_suffix('*') {
            host.starts_with(prefix)
        } else if b.starts_with('.') {
            host.ends_with(&b)
        } else {
            host == b
        }
    })
}

impl Rules {
    pub fn from_operator(operator: &BTreeMap<String, String>) -> Result<Self> {
        let explicit = match operator.get("EGRESS_PROXY").map(|v| v.trim()).filter(|v| !v.is_empty()) {
            None => None,
            Some(v) => {
                let (host, port) = host_port(v, 80).with_context(|| format!("EGRESS_PROXY={v} is not host:port"))?;
                let basic = operator
                    .get("EGRESS_PROXY_AUTH")
                    .filter(|a| !a.is_empty())
                    .map(|a| base64::engine::general_purpose::STANDARD.encode(a.as_bytes()));
                Some(Route::Proxy { host, port, basic })
            }
        };
        let bypass = operator.get("EGRESS_BYPASS").map(|b| b.split([',', ';']).map(|s| s.trim().to_string()).collect()).unwrap_or_default();
        let pac = operator.get("EGRESS_PAC").map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
        Ok(Self { explicit, bypass, pac, cache: Mutex::new(HashMap::new()) })
    }

    /// Where a CONNECT to `host` goes.
    pub async fn route(self: &Arc<Self>, host: &str) -> Route {
        if bypassed(host, &self.bypass) {
            return Route::Direct;
        }
        if let Some(r) = &self.explicit {
            return r.clone();
        }
        #[cfg(windows)]
        {
            let key = host.to_ascii_lowercase();
            if let Some((route, until)) = self.cache.lock().unwrap().get(&key) {
                if Instant::now() < *until {
                    return route.clone();
                }
            }
            let (pac, h) = (self.pac.clone(), key.clone());
            let found = tokio::task::spawn_blocking(move || winhttp::route_for(&h, pac.as_deref())).await.unwrap_or((Route::Direct, Duration::from_secs(60)));
            self.cache.lock().unwrap().insert(key, (found.0.clone(), Instant::now() + found.1));
            found.0
        }
        #[cfg(not(windows))]
        {
            Route::Direct
        }
    }
}

/// The OS's trusted roots as one PEM file, for `NODE_EXTRA_CA_CERTS`. Returns how many.
pub fn export_os_roots(file: &Path) -> Result<usize> {
    let found = rustls_native_certs::load_native_certs();
    for e in &found.errors {
        tracing::warn!(error = %e, "an OS trust store could not be read in full");
    }
    let mut pem = String::new();
    for cert in &found.certs {
        let b64 = base64::engine::general_purpose::STANDARD.encode(cert.as_ref());
        pem.push_str("-----BEGIN CERTIFICATE-----\n");
        for line in b64.as_bytes().chunks(64) {
            pem.push_str(std::str::from_utf8(line).expect("base64 is ASCII"));
            pem.push('\n');
        }
        pem.push_str("-----END CERTIFICATE-----\n");
    }
    if found.certs.is_empty() {
        bail!("the OS trust store has no roots to give the API");
    }
    let tmp = file.with_extension("tmp");
    std::fs::write(&tmp, pem).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, file).with_context(|| format!("writing {}", file.display()))?;
    Ok(found.certs.len())
}

/// Read a request or response head: up to and including the blank line, at most 8 KB. Returns the
/// head and whatever came after it.
async fn read_head(s: &mut TcpStream, timeout: Duration) -> Result<(String, Vec<u8>)> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buf.split_off(end + 4);
            return Ok((String::from_utf8_lossy(&buf).into_owned(), rest));
        }
        if buf.len() > 8192 {
            bail!("a head larger than 8 KB");
        }
        let n = tokio::time::timeout_at(deadline, s.read(&mut chunk)).await.map_err(|_| anyhow!("no complete head within {timeout:?}"))??;
        if n == 0 {
            bail!("the connection closed before its head was complete");
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

async fn answer(s: &mut TcpStream, status: &str, extra: &str, body: &str) {
    let _ = s
        .write_all(format!("HTTP/1.1 {status}\r\n{extra}Content-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes())
        .await;
}

/// A tunnel to `host:port` through an upstream proxy.
pub(crate) async fn connect_via(proxy_host: &str, proxy_port: u16, basic: Option<&str>, host: &str, port: u16) -> Result<TcpStream> {
    let mut s = tokio::time::timeout(Duration::from_secs(10), TcpStream::connect((proxy_host, proxy_port)))
        .await
        .map_err(|_| anyhow!("the proxy {proxy_host}:{proxy_port} did not answer within 10 s"))?
        .with_context(|| format!("connecting to the proxy {proxy_host}:{proxy_port}"))?;
    let auth = basic.map(|b| format!("Proxy-Authorization: Basic {b}\r\n")).unwrap_or_default();
    s.write_all(format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n{auth}\r\n").as_bytes()).await?;
    let (head, _) = read_head(&mut s, Duration::from_secs(15)).await?;
    let status = head.lines().next().unwrap_or("").to_string();
    if status.split_whitespace().nth(1) != Some("200") {
        bail!("the proxy {proxy_host}:{proxy_port} refused the tunnel: {status}");
    }
    Ok(s)
}

async fn tunnel(mut client: TcpStream, secret: Arc<String>, rules: Arc<Rules>) -> Result<()> {
    let (head, early) = read_head(&mut client, Duration::from_secs(10)).await?;
    let mut lines = head.lines();
    let request = lines.next().unwrap_or("");
    let mut parts = request.split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    // The per-boot credential, `Basic base64("lgr:<secret>")`: only the API holds it.
    let expected = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("lgr:{secret}")));
    let given = lines.find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case("proxy-authorization")).map(|(_, v)| v.trim().to_string()));
    let authorised = given.is_some_and(|g| g.len() == expected.len() && g.bytes().zip(expected.bytes()).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0);
    if !authorised {
        answer(&mut client, "407 Proxy Authentication Required", "Proxy-Authenticate: Basic realm=\"lgr-server\"\r\n", "This proxy carries the LGR API's calls only.").await;
        return Ok(());
    }
    if !method.eq_ignore_ascii_case("CONNECT") {
        answer(&mut client, "501 Not Implemented", "", "Only https:// calls are carried; plain HTTP is not.").await;
        return Ok(());
    }
    let Some((host, port)) = host_port(target, 443) else {
        answer(&mut client, "400 Bad Request", "", "CONNECT needs host:port.").await;
        return Ok(());
    };
    let route = rules.route(&host).await;
    let upstream = match &route {
        Route::Direct => tokio::time::timeout(Duration::from_secs(10), TcpStream::connect((host.as_str(), port)))
            .await
            .map_err(|_| anyhow!("{host}:{port} did not answer within 10 s"))
            .and_then(|r| r.with_context(|| format!("connecting to {host}:{port}"))),
        Route::Proxy { host: ph, port: pp, basic } => connect_via(ph, *pp, basic.as_deref(), &host, port).await,
    };
    let mut upstream = match upstream {
        Ok(u) => u,
        Err(e) => {
            tracing::warn!(%host, port, ?route, error = %format!("{e:#}"), "an outbound call could not be carried");
            answer(&mut client, "502 Bad Gateway", "", &format!("{e:#}")).await;
            return Ok(());
        }
    };
    client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await?;
    if !early.is_empty() {
        upstream.write_all(&early).await?;
    }
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    Ok(())
}

/// Carry the API's CONNECTs on `listener` until aborted.
pub async fn serve(listener: TcpListener, secret: String, rules: Arc<Rules>) {
    let secret = Arc::new(secret);
    loop {
        let Ok((client, _)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        };
        let (secret, rules) = (secret.clone(), rules.clone());
        tokio::spawn(async move {
            if let Err(e) = tunnel(client, secret, rules).await {
                tracing::debug!(error = %format!("{e:#}"), "an egress connection ended badly");
            }
        });
    }
}

/// The proxy URL the API is given: `http://lgr:<secret>@127.0.0.1:<port>`.
pub fn proxy_url(port: u16, secret: &str) -> String {
    format!("http://lgr:{secret}@127.0.0.1:{port}")
}

#[cfg(windows)]
mod winhttp {
    use super::{parse_proxy_list, Route};
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{GetLastError, GlobalFree};
    use windows_sys::Win32::Networking::WinHttp::*;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Read a WinHTTP-allocated string and free it.
    unsafe fn take(p: windows_sys::core::PWSTR) -> Option<String> {
        if p.is_null() {
            return None;
        }
        let mut len = 0;
        while *p.add(len) != 0 {
            len += 1;
        }
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
        GlobalFree(p.cast());
        Some(s)
    }

    /// The route for `host`, and how long to keep that answer.
    pub fn route_for(host: &str, pac: Option<&str>) -> (Route, Duration) {
        const KEEP: Duration = Duration::from_secs(300);
        unsafe {
            // 1. The machine's own setting: `netsh winhttp set proxy`.
            let mut info: WINHTTP_PROXY_INFO = std::mem::zeroed();
            if WinHttpGetDefaultProxyConfiguration(&mut info) != 0 {
                let proxy = take(info.lpszProxy);
                let bypass: Vec<String> = take(info.lpszProxyBypass).map(|b| b.split([';', ' ']).map(String::from).collect()).unwrap_or_default();
                if info.dwAccessType == WINHTTP_ACCESS_TYPE_NAMED_PROXY {
                    if super::bypassed(host, &bypass) {
                        return (Route::Direct, KEEP);
                    }
                    if let Some((h, p)) = proxy.as_deref().and_then(parse_proxy_list) {
                        return (Route::Proxy { host: h, port: p, basic: None }, KEEP);
                    }
                }
            }
            // 2. WPAD, and the PAC it names (or the one setup named).
            let agent = wide("lgr-server");
            let session = WinHttpOpen(agent.as_ptr(), WINHTTP_ACCESS_TYPE_NO_PROXY, std::ptr::null(), std::ptr::null(), 0);
            if session.is_null() {
                return (Route::Direct, Duration::from_secs(60));
            }
            let url = wide(&format!("https://{host}/"));
            let pac_w = pac.map(wide);
            let mut options: WINHTTP_AUTOPROXY_OPTIONS = std::mem::zeroed();
            options.dwFlags = if pac_w.is_some() { WINHTTP_AUTOPROXY_CONFIG_URL } else { WINHTTP_AUTOPROXY_AUTO_DETECT };
            options.dwAutoDetectFlags = WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A;
            options.lpszAutoConfigUrl = pac_w.as_ref().map_or(std::ptr::null(), |w| w.as_ptr());
            options.fAutoLogonIfChallenged = 1;
            let mut found: WINHTTP_PROXY_INFO = std::mem::zeroed();
            let ok = WinHttpGetProxyForUrl(session, url.as_ptr(), &mut options, &mut found) != 0;
            let error = GetLastError();
            WinHttpCloseHandle(session);
            if !ok {
                // No WPAD here: the usual answer on a shop network. Asked again in 10 minutes.
                let keep = if error == ERROR_WINHTTP_AUTODETECTION_FAILED { Duration::from_secs(600) } else { Duration::from_secs(60) };
                return (Route::Direct, keep);
            }
            let proxy = take(found.lpszProxy);
            let _ = take(found.lpszProxyBypass);
            match (found.dwAccessType, proxy.as_deref().and_then(parse_proxy_list)) {
                (WINHTTP_ACCESS_TYPE_NAMED_PROXY, Some((h, p))) => (Route::Proxy { host: h, port: p, basic: None }, KEEP),
                _ => (Route::Direct, KEEP),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn winhttp_proxy_lists_are_read_for_https() {
        assert_eq!(parse_proxy_list("proxy.corp:8080"), Some(("proxy.corp".into(), 8080)));
        assert_eq!(parse_proxy_list("a:3128; b:3128"), Some(("a".into(), 3128)));
        assert_eq!(parse_proxy_list("http=a:80;https=b:8443"), Some(("b".into(), 8443)));
        assert_eq!(parse_proxy_list("http=a:80;socks=c:1080"), None);
        assert_eq!(parse_proxy_list("http://proxy.corp:8080/"), Some(("proxy.corp".into(), 8080)));
        assert_eq!(parse_proxy_list(""), None);
    }

    #[test]
    fn the_bypass_list_reads_as_winhttp_writes_it() {
        let b: Vec<String> = ["<local>", "*.corp.lan", "10.*", ".shop.lan", "exact.example"].iter().map(|s| s.to_string()).collect();
        for direct in ["intranet", "a.corp.lan", "10.1.2.3", "x.shop.lan", "EXACT.example"] {
            assert!(bypassed(direct, &b), "{direct}");
        }
        for proxied in ["lgrai.app", "corp.lan.evil.example", "110.1.2.3", "sub.exact.example"] {
            assert!(!bypassed(proxied, &b), "{proxied}");
        }
    }

    #[test]
    fn the_explicit_proxy_comes_from_setup_with_its_credential() {
        let op = BTreeMap::from([
            ("EGRESS_PROXY".to_string(), "http://proxy.corp:3128".to_string()),
            ("EGRESS_PROXY_AUTH".to_string(), "shop:pa ss".to_string()),
        ]);
        let rules = Rules::from_operator(&op).unwrap();
        assert_eq!(rules.explicit, Some(Route::Proxy { host: "proxy.corp".into(), port: 3128, basic: Some(base64::engine::general_purpose::STANDARD.encode("shop:pa ss")) }));
        assert!(Rules::from_operator(&BTreeMap::from([("EGRESS_PROXY".to_string(), "http://:x".to_string())])).is_err());
    }

    #[test]
    fn the_os_roots_are_exported_as_pem() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("os-roots.pem");
        let n = export_os_roots(&file).unwrap();
        assert!(n > 10, "only {n} roots");
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(text.matches("-----BEGIN CERTIFICATE-----").count(), n);
    }

    // ── End to end over real sockets ─────────────────────────────────────────────────────────────

    /// A TCP echo standing in for an internet host.
    async fn echo_host() -> u16 {
        let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = l.accept().await.unwrap();
                tokio::spawn(async move {
                    let mut buf = [0u8; 64];
                    if let Ok(n) = s.read(&mut buf).await {
                        let _ = s.write_all(&buf[..n]).await;
                    }
                });
            }
        });
        port
    }

    async fn egress(rules: Rules) -> u16 {
        let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(serve(l, "per-boot".into(), Arc::new(rules)));
        port
    }

    fn auth() -> String {
        format!("Proxy-Authorization: Basic {}\r\n", base64::engine::general_purpose::STANDARD.encode("lgr:per-boot"))
    }

    /// Send a head; return the status line and the open stream.
    async fn ask(port: u16, head: &str) -> (String, TcpStream) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(head.as_bytes()).await.unwrap();
        let (reply, _) = read_head(&mut s, Duration::from_secs(10)).await.unwrap();
        (reply.lines().next().unwrap_or("").to_string(), s)
    }

    #[tokio::test]
    async fn a_connect_with_the_credential_becomes_a_tunnel() {
        let host = echo_host().await;
        let proxy = egress(Rules::from_operator(&BTreeMap::new()).unwrap()).await;
        let (status, mut s) = ask(proxy, &format!("CONNECT 127.0.0.1:{host} HTTP/1.1\r\nHost: 127.0.0.1:{host}\r\n{}\r\n", auth())).await;
        assert_eq!(status, "HTTP/1.1 200 Connection Established");
        s.write_all(b"ping").await.unwrap();
        let mut echo = [0u8; 4];
        s.read_exact(&mut echo).await.unwrap();
        assert_eq!(&echo, b"ping");
    }

    #[tokio::test]
    async fn without_the_credential_or_with_plain_http_nothing_is_carried() {
        let host = echo_host().await;
        let proxy = egress(Rules::from_operator(&BTreeMap::new()).unwrap()).await;
        let (status, _) = ask(proxy, &format!("CONNECT 127.0.0.1:{host} HTTP/1.1\r\n\r\n")).await;
        assert!(status.starts_with("HTTP/1.1 407"), "{status}");
        let wrong = format!("Proxy-Authorization: Basic {}\r\n", base64::engine::general_purpose::STANDARD.encode("lgr:guessed"));
        let (status, _) = ask(proxy, &format!("CONNECT 127.0.0.1:{host} HTTP/1.1\r\n{wrong}\r\n")).await;
        assert!(status.starts_with("HTTP/1.1 407"), "{status}");
        let (status, _) = ask(proxy, &format!("GET http://127.0.0.1:{host}/ HTTP/1.1\r\n{}\r\n", auth())).await;
        assert!(status.starts_with("HTTP/1.1 501"), "{status}");
    }

    #[tokio::test]
    async fn an_explicit_upstream_proxy_carries_the_tunnel_and_a_refusal_is_a_502() {
        let host = echo_host().await;
        // The upstream: this same proxy, whose credential the explicit route then carries.
        let upstream = egress(Rules::from_operator(&BTreeMap::new()).unwrap()).await;
        let op = BTreeMap::from([
            ("EGRESS_PROXY".to_string(), format!("127.0.0.1:{upstream}")),
            ("EGRESS_PROXY_AUTH".to_string(), "lgr:per-boot".to_string()),
        ]);
        let proxy = egress(Rules::from_operator(&op).unwrap()).await;
        let (status, mut s) = ask(proxy, &format!("CONNECT 127.0.0.1:{host} HTTP/1.1\r\n{}\r\n", auth())).await;
        assert_eq!(status, "HTTP/1.1 200 Connection Established");
        s.write_all(b"pong").await.unwrap();
        let mut echo = [0u8; 4];
        s.read_exact(&mut echo).await.unwrap();
        assert_eq!(&echo, b"pong");

        // An upstream that wants a credential we do not have: the API is told why.
        let op = BTreeMap::from([("EGRESS_PROXY".to_string(), format!("127.0.0.1:{upstream}"))]);
        let proxy = egress(Rules::from_operator(&op).unwrap()).await;
        let (status, _) = ask(proxy, &format!("CONNECT 127.0.0.1:{host} HTTP/1.1\r\n{}\r\n", auth())).await;
        assert!(status.starts_with("HTTP/1.1 502"), "{status}");
    }
}
