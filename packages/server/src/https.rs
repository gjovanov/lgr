//! The supervisor's own calls to global (FR-20.53, plan step P2-1b): HTTPS/1.1 with JSON, routed by
//! the machine's proxy rules (`egress::Rules`, the same ones the API's egress uses) and verified
//! against the OS's trust store, so a TLS-inspecting middlebox whose CA the machine trusts works and
//! nothing else does. The uplink (P2-2) grows from this.

use anyhow::{anyhow, bail, Context, Result};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use std::sync::Arc;
use std::time::Duration;

use crate::egress::{Route, Rules};

/// No answer from global is this large; one that is, is not global.
const MAX_BODY: usize = 1 << 20;
const TIMEOUT: Duration = Duration::from_secs(30);

pub struct Https {
    tls: tokio_rustls::TlsConnector,
    rules: Arc<Rules>,
}

/// `https://host[:port]` and the path, split. Plain `http://` is refused: these calls carry a code
/// and a key's assertions.
pub fn split_url(url: &str) -> Result<(String, u16, String)> {
    let rest = url.strip_prefix("https://").ok_or_else(|| anyhow!("{url} is not an https:// URL"))?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().with_context(|| format!("{url}: {p} is not a port"))?),
        None => (authority, 443),
    };
    if host.is_empty() {
        bail!("{url} names no host");
    }
    Ok((host.to_ascii_lowercase(), port, path.to_string()))
}

impl Https {
    /// Verified against the OS's trusted roots.
    pub fn with_os_roots(rules: Arc<Rules>) -> Result<Self> {
        let mut roots = rustls::RootCertStore::empty();
        let found = rustls_native_certs::load_native_certs();
        for cert in found.certs {
            let _ = roots.add(cert);
        }
        if roots.is_empty() {
            bail!("the OS trusts no root certificate this process can read");
        }
        Self::with_roots(roots, rules)
    }

    pub fn with_roots(roots: rustls::RootCertStore, rules: Arc<Rules>) -> Result<Self> {
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()?
            .with_root_certificates(roots)
            .with_no_client_auth();
        Ok(Self { tls: tokio_rustls::TlsConnector::from(Arc::new(config)), rules })
    }

    /// One request, and the status with the body as JSON (`Null` when it is not JSON).
    pub async fn json(&self, method: &str, url: &str, bearer: Option<&str>, body: Option<&serde_json::Value>) -> Result<(u16, serde_json::Value)> {
        tokio::time::timeout(TIMEOUT, self.json_now(method, url, bearer, body))
            .await
            .map_err(|_| anyhow!("{url} did not answer within {} s", TIMEOUT.as_secs()))?
    }

    /// A TLS stream to `host:port`, through the machine's proxy when its rules say so: what a request
    /// and the uplink's WebSocket (P2-2b) both ride on.
    pub async fn connect(&self, host: &str, port: u16) -> Result<tokio_rustls::client::TlsStream<tokio::net::TcpStream>> {
        let tcp = match self.rules.route(host).await {
            Route::Direct => tokio::net::TcpStream::connect((host, port)).await.with_context(|| format!("connecting to {host}:{port}"))?,
            Route::Proxy { host: ph, port: pp, basic } => crate::egress::connect_via(&ph, pp, basic.as_deref(), host, port).await?,
        };
        let name = rustls::pki_types::ServerName::try_from(host.to_string()).with_context(|| format!("{host} is not a server name"))?;
        self.tls.connect(name, tcp).await.with_context(|| format!("the TLS handshake with {host}"))
    }

    async fn json_now(&self, method: &str, url: &str, bearer: Option<&str>, body: Option<&serde_json::Value>) -> Result<(u16, serde_json::Value)> {
        let (host, port, path) = split_url(url)?;
        let tls = self.connect(&host, port).await?;
        let (mut sender, conn) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(tls)).await?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let bytes = body.map(|b| b.to_string()).unwrap_or_default();
        let mut req = hyper::Request::builder()
            .method(method)
            .uri(path.as_str())
            .header(hyper::header::HOST, if port == 443 { host.clone() } else { format!("{host}:{port}") })
            .header(hyper::header::ACCEPT, "application/json")
            .header(hyper::header::USER_AGENT, concat!("lgr-server/", env!("CARGO_PKG_VERSION")));
        if body.is_some() {
            req = req.header(hyper::header::CONTENT_TYPE, "application/json");
        }
        if let Some(token) = bearer {
            req = req.header(hyper::header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let res = sender.send_request(req.body(Full::new(Bytes::from(bytes)))?).await.with_context(|| format!("{method} {url}"))?;
        let status = res.status().as_u16();
        let collected = Limited::new(res.into_body(), MAX_BODY).collect().await.map_err(|e| anyhow!("reading the answer of {url}: {e}"))?;
        let value = serde_json::from_slice(&collected.to_bytes()).unwrap_or(serde_json::Value::Null);
        Ok((status, value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn urls_are_https_only_and_split_into_host_port_path() {
        assert_eq!(split_url("https://lgrai.app/api/node/v1/token").unwrap(), ("lgrai.app".into(), 443, "/api/node/v1/token".into()));
        assert_eq!(split_url("https://Global.Test:8443").unwrap(), ("global.test".into(), 8443, "/".into()));
        assert!(split_url("http://lgrai.app/api").is_err());
        assert!(split_url("https://:443/x").is_err());
    }

    /// A TLS server answering every request with `{"seen": <method path, the auth header>}`, on a
    /// CA the test trusts.
    async fn fake_global() -> (u16, rustls::RootCertStore) {
        let ca_key = rcgen::KeyPair::generate().unwrap();
        let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let ca = ca_params.self_signed(&ca_key).unwrap();
        let issuer = rcgen::Issuer::new(ca_params, &ca_key);
        let leaf_key = rcgen::KeyPair::generate().unwrap();
        let leaf = rcgen::CertificateParams::new(vec!["global.test".to_string()]).unwrap().signed_by(&leaf_key, &issuer).unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(ca.der().clone()).unwrap();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![leaf.der().clone()], rustls::pki_types::PrivateKeyDer::Pkcs8(leaf_key.serialize_der().into()))
            .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let Ok(mut tls) = acceptor.accept(tcp).await else { return };
                    let mut buf = vec![0u8; 8192];
                    let n = tls.read(&mut buf).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]).to_string();
                    let line = head.lines().next().unwrap_or("").to_string();
                    let auth = head.lines().find(|l| l.to_ascii_lowercase().starts_with("authorization:")).unwrap_or("").to_string();
                    let body = serde_json::json!({ "seen": line, "auth": auth }).to_string();
                    let _ = tls.write_all(format!("HTTP/1.1 201 Created\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
                    let _ = tls.shutdown().await;
                });
            }
        });
        (port, roots)
    }

    /// An upstream proxy that carries CONNECTs, counting them.
    async fn fake_proxy(count: Arc<std::sync::atomic::AtomicUsize>) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (mut client, _) = listener.accept().await.unwrap();
                let count = count.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = client.read(&mut buf).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]).to_string();
                    let target = head.split_whitespace().nth(1).unwrap_or("").to_string();
                    let port: u16 = target.rsplit(':').next().unwrap().parse().unwrap();
                    count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let mut upstream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                    client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.unwrap();
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                });
            }
        });
        port
    }

    #[tokio::test]
    async fn a_call_is_verified_against_the_given_roots_and_carries_the_bearer() {
        let (port, roots) = fake_global().await;
        // `global.test` is not resolvable: an explicit route to 127.0.0.1 stands in for DNS here.
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let proxy = fake_proxy(count.clone()).await;
        let rules = Arc::new(Rules::from_operator(&BTreeMap::from([("EGRESS_PROXY".to_string(), format!("127.0.0.1:{proxy}"))])).unwrap());
        let client = Https::with_roots(roots, rules.clone()).unwrap();
        let (status, body) = client
            .json("POST", &format!("https://global.test:{port}/api/node/v1/token"), Some("tok"), Some(&serde_json::json!({ "a": 1 })))
            .await
            .unwrap();
        assert_eq!(status, 201);
        assert_eq!(body["seen"], "POST /api/node/v1/token HTTP/1.1");
        assert_eq!(body["auth"].as_str().unwrap().to_ascii_lowercase(), "authorization: bearer tok");
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 1, "it went through the machine's proxy");

        // A server whose CA the client does not trust is refused at the handshake.
        let stranger = Https::with_roots(fake_global().await.1, rules).unwrap();
        assert!(stranger.json("GET", &format!("https://global.test:{port}/"), None, None).await.is_err());
    }
}
