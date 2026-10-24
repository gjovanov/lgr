//! FR-20.31 — one HTTP client, one trust policy per server.
//!
//! - **lgrai.app, and any name a public CA can vouch for:** the OS trust store and the system proxy
//!   (FR-14.32, unchanged), so a TLS-inspecting corporate middlebox whose root came by GPO just works.
//! - **A master** (an on-premises LGR Server, FR-20): the CA it was paired with, and nothing else.
//!   Not the OS store, and never a proxy ("no proxy to the master", FR-20.31). rustls with a root
//!   store holding that one certificate, so the rule is the same on every OS.
//!
//! **How the CA is learned** (FR-20.29). At pairing, [`probe`] fetches it once from the master's LAN
//! ingress (`/__lgr/ca.pem`) over a connection that verifies nothing. It is then checked against the
//! fingerprint the pairing code's link carries, or a person compares the six words with the ones the
//! master's Desktops page shows. From then on every call to that master goes through [`client_for`]
//! and [`ws_connect`], which trust that CA alone. The download is only transport: someone in the
//! middle of it cannot produce a CA that matches the fingerprint.
//!
//! **Pins live in a registry keyed by the server's origin**, filled from the settings at start and on
//! every (re-)pairing ([`set_pin`]). That is how every client in the shell (enrollment, tokens,
//! presence, the bridge, the updater) gets the same policy without each one carrying it.
//!
//! ⚠ **A pin only ever applies to a LAN name** ([`may_pin`]): a private, loopback or link-local
//! address, a single-label name, or a `.local`-style name. No public CA can certify any of those, so
//! a pin never REPLACES public trust. Without that rule a deep link is enough to take over a till: a
//! link is attacker-controlled input, and `lgr://enroll?server=https://lgrai.app&fp=<theirs>`, with
//! the attacker in the middle of the shop's network, would pin the cloud's own name to the
//! attacker's CA. The window would keep showing the real lgrai.app (the webview trusts the OS store)
//! while the fiscal bridge took its commands from the attacker.
//!
//! **A master also asks for the desktop's credential on every request** (FR-20.32): its LAN ingress
//! refuses a request without `X-LGR-Desktop-Token`, the reachability probe, enrollment and token
//! minting aside. [`desktop_headers`] adds it beside the `Authorization` the desktop routes take.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, TcpStream};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use rustls::pki_types::{pem::PemObject, CertificateDer, ServerName};
use sha2::{Digest, Sha256};

/// Where a master's LAN ingress hands out its CA (`packages/server/src/ingress.rs`).
pub const CA_PATH: &str = "/__lgr/ca.pem";

/// The credential a master's LAN ingress asks every request for (FR-20.32).
pub const DESKTOP_TOKEN_HEADER: &str = "x-lgr-desktop-token";

/// A WebSocket as presence and the bridge hold one.
pub type Socket = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>;

// ── Fingerprints and words ──────────────────────────────────────────────────────────────────

/// A master's CA, as pinned at pairing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterPin {
    pub ca_pem: String,
    /// `sha256:<base64url of the CA SubjectPublicKeyInfo's SHA-256, no padding>`.
    pub fingerprint: String,
}

impl MasterPin {
    /// A pin, only if the certificate is the one its fingerprint names.
    pub fn new(ca_pem: &str, fingerprint: &str) -> Result<Self, String> {
        if fingerprint_of_pem(ca_pem)? != fingerprint.trim() {
            return Err("fingerprint_mismatch".into());
        }
        Ok(Self { ca_pem: ca_pem.trim().to_string(), fingerprint: fingerprint.trim().to_string() })
    }
}

/// The one certificate in `pem`. ⚠ Exactly one: what is fingerprinted and what is trusted must be
/// the same certificate, and a bundle would leave the two to whichever block each reader took.
fn single_cert(pem: &str) -> Result<CertificateDer<'static>, String> {
    let bad = || "bad_certificate".to_string();
    let mut certs = CertificateDer::pem_slice_iter(pem.as_bytes());
    let first = certs.next().ok_or_else(bad)?.map_err(|_| bad())?;
    if certs.next().is_some() {
        return Err(bad());
    }
    Ok(first)
}

/// The fingerprint of a certificate: the SHA-256 of its SubjectPublicKeyInfo, written as a pairing
/// code writes it.
pub fn fingerprint_of_pem(pem: &str) -> Result<String, String> {
    use x509_cert::der::{Decode, Encode};
    let der = single_cert(pem)?;
    let cert = x509_cert::Certificate::from_der(der.as_ref()).map_err(|_| "bad_certificate".to_string())?;
    let spki = cert
        .tbs_certificate
        .subject_public_key_info
        .to_der()
        .map_err(|_| "bad_certificate".to_string())?;
    Ok(format!("sha256:{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(&spki))))
}

/// Whether `fp` is a fingerprint as a pairing code writes it.
pub fn is_fingerprint(fp: &str) -> bool {
    fingerprint_digest(fp).is_some()
}

fn fingerprint_digest(fp: &str) -> Option<[u8; 32]> {
    let b64 = fp.trim().strip_prefix("sha256:")?;
    if b64.len() != 43 || !b64.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return None;
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(b64).ok()?.try_into().ok()
}

/// The word list the master's API draws from: the same file (`services/biz/desktop/
/// fingerprint-words.txt`), so the two sides cannot disagree about a word.
const WORDS: &str = include_str!("../../../services/src/biz/desktop/fingerprint-words.txt");

/// The six words for a fingerprint (FR-20.29): its first 66 bits, eleven to a word, from BIP-39
/// English. What a person compares with the master's Desktops page for a code typed by hand.
pub fn fingerprint_words(fp: &str) -> Option<Vec<&'static str>> {
    let digest = fingerprint_digest(fp)?;
    let list: Vec<&'static str> = WORDS.lines().map(str::trim).filter(|w| !w.is_empty()).collect();
    if list.len() != 2048 {
        return None;
    }
    let mut bits: u128 = 0;
    for b in &digest[..9] {
        bits = (bits << 8) | u128::from(*b);
    }
    bits >>= 6;
    Some((0..6).rev().map(|k| list[((bits >> (11 * k)) & 0x7ff) as usize]).collect())
}

// ── Which servers may be pinned ─────────────────────────────────────────────────────────────

/// The suffixes no public CA can issue for: mDNS (RFC 6762, what a master's certificate names),
/// home networks (RFC 8375), ICANN's private-use TLD (2024) and loopback names (RFC 6761).
///
/// ⚠ Deliberately short. `.lan`, `.corp` and `.home` are common on shop networks but not reserved,
/// and a TLD delegated later would turn this rule into a hole. A master on such a name is paired by
/// its address instead, which its certificate also names.
const LAN_SUFFIXES: [&str; 4] = ["local", "home.arpa", "internal", "localhost"];

fn lan_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    // 100.64.0.0/10 is shared address space (RFC 6598): carrier NAT and overlay networks.
    ip.is_private() || ip.is_loopback() || ip.is_link_local() || (a == 100 && (b & 0xc0) == 64)
}

fn lan_v6(ip: Ipv6Addr) -> bool {
    let first = ip.segments()[0];
    // Unique local fc00::/7, link-local fe80::/10.
    ip.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
}

/// Whether `server` may be trusted by a pin (see the module note): `https`, on a name no public CA
/// can certify.
pub fn may_pin(server: &str) -> bool {
    let Ok(u) = url::Url::parse(server) else { return false };
    if u.scheme() != "https" && u.scheme() != "wss" {
        return false;
    }
    match u.host() {
        Some(url::Host::Ipv4(ip)) => lan_v4(ip),
        Some(url::Host::Ipv6(ip)) => match ip.to_ipv4_mapped() {
            Some(v4) => lan_v4(v4),
            None => lan_v6(ip),
        },
        Some(url::Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            !d.is_empty()
                && (!d.contains('.') || LAN_SUFFIXES.iter().any(|s| d == *s || d.ends_with(&format!(".{s}"))))
        }
        None => false,
    }
}

// ── The registry ────────────────────────────────────────────────────────────────────────────

/// A server's origin, with a WebSocket URL read as the HTTP origin it upgrades from: presence and
/// the bridge connect to `wss://` and must find the pin that `https://` was paired under.
fn origin_of(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    let scheme = match u.scheme() {
        "https" | "wss" => "https",
        "http" | "ws" => "http",
        _ => return None,
    };
    let host = match u.host()? {
        url::Host::Domain(d) => d.trim_end_matches('.').to_ascii_lowercase(),
        url::Host::Ipv4(ip) => ip.to_string(),
        url::Host::Ipv6(ip) => format!("[{ip}]"),
    };
    let port = u.port_or_known_default()?;
    Some(format!("{scheme}://{host}:{port}"))
}

fn pins() -> &'static Mutex<HashMap<String, MasterPin>> {
    static PINS: OnceLock<Mutex<HashMap<String, MasterPin>>> = OnceLock::new();
    PINS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Pin `server`'s origin to `pin`, or forget it with `None`. A pin for a server that may not be
/// pinned, or whose certificate is not the one its fingerprint names, is refused (`false`): the
/// settings file it may have come from is not proof of anything.
pub fn set_pin(server: &str, pin: Option<MasterPin>) -> bool {
    let Some(origin) = origin_of(server) else { return false };
    let mut map = pins().lock().unwrap_or_else(|p| p.into_inner());
    match pin {
        Some(p) => {
            if !may_pin(server) || MasterPin::new(&p.ca_pem, &p.fingerprint).is_err() {
                return false;
            }
            map.insert(origin, p);
        }
        None => {
            map.remove(&origin);
        }
    }
    true
}

/// The pin for `server`, if it is a master this desktop was paired with.
pub fn pin_for(server: &str) -> Option<MasterPin> {
    pins().lock().unwrap_or_else(|p| p.into_inner()).get(&origin_of(server)?).cloned()
}

// ── Clients ─────────────────────────────────────────────────────────────────────────────────

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn rustls_config(pin: &MasterPin) -> Result<rustls::ClientConfig, String> {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(single_cert(&pin.ca_pem)?).map_err(|_| "bad_certificate".to_string())?;
    Ok(rustls::ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth())
}

/// The TLS a client of `server` must use when it is a paired master: the pinned CA alone. `None`
/// means the server is not one, and the OS store applies. The updater plugin builds its own client
/// and takes this through `configure_client`.
pub fn pinned_tls(server: &str) -> Result<Option<rustls::ClientConfig>, String> {
    pin_for(server).map(|p| rustls_config(&p)).transpose()
}

/// The one HTTP client for `server`: pinned to its CA and never proxied when it is a paired master,
/// the OS store and the system proxy otherwise.
pub fn client_for(server: &str, timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    let builder = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .user_agent(concat!("lgr-desktop/", env!("CARGO_PKG_VERSION")));
    let builder = match pinned_tls(server)? {
        None => builder,
        Some(tls) => builder.no_proxy().use_preconfigured_tls(tls),
    };
    builder.build().map_err(|_| "client_build_failed".to_string())
}

/// Add a desktop's credential to a request: `Authorization` as the desktop routes take it, and for a
/// master also `X-LGR-Desktop-Token`, which its LAN ingress asks every request for (FR-20.32).
pub fn desktop_headers(
    builder: reqwest::blocking::RequestBuilder,
    server: &str,
    token: &str,
) -> reqwest::blocking::RequestBuilder {
    let builder = builder.bearer_auth(token);
    if pin_for(server).is_some() {
        builder.header(DESKTOP_TOKEN_HEADER, token)
    } else {
        builder
    }
}

/// A WebSocket to `url` (`wss://…`) with the same trust as [`client_for`]: pinned to the master's CA,
/// straight to it and carrying its desktop credential, or through the OS store for anything else.
///
/// ⚠ The socket comes back with NO read timeout, as `tungstenite::connect`'s does: presence blocks on
/// its reads, and a timeout left over from the handshake would end its connection every few seconds.
pub fn ws_connect(url: &str, token: &str) -> Result<Socket, String> {
    use tungstenite::client::IntoClientRequest;
    let Some(pin) = pin_for(url) else {
        return tungstenite::connect(url).map(|(socket, _)| socket).map_err(|e| e.to_string());
    };
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    request
        .headers_mut()
        .insert(DESKTOP_TOKEN_HEADER, token.parse().map_err(|_| "bad_token".to_string())?);

    let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
    let name = server_name(&parsed)?;
    let tcp = connect_tcp(&parsed, Duration::from_secs(10))?;
    tcp.set_read_timeout(Some(Duration::from_secs(15))).map_err(|e| e.to_string())?;
    let conn = rustls::ClientConnection::new(Arc::new(rustls_config(&pin)?), name).map_err(|e| e.to_string())?;
    let tls = rustls::StreamOwned::new(conn, tcp);
    let (socket, _) = tungstenite::client(request, tungstenite::stream::MaybeTlsStream::Rustls(tls))
        .map_err(|e| match e {
            tungstenite::HandshakeError::Failure(f) => f.to_string(),
            tungstenite::HandshakeError::Interrupted(_) => "handshake_interrupted".to_string(),
        })?;
    if let tungstenite::stream::MaybeTlsStream::Rustls(s) = socket.get_ref() {
        s.get_ref().set_read_timeout(None).map_err(|e| e.to_string())?;
    }
    Ok(socket)
}

/// The name TLS checks the master's certificate against. ⚠ An address is an address: rustls checks
/// it against the certificate's IP entries, which is what a master's certificate carries for its LAN
/// addresses (`packages/server/src/certs.rs`).
fn server_name(u: &url::Url) -> Result<ServerName<'static>, String> {
    match u.host().ok_or("invalid_server_url")? {
        url::Host::Ipv4(ip) => Ok(ServerName::IpAddress(IpAddr::V4(ip).into())),
        url::Host::Ipv6(ip) => Ok(ServerName::IpAddress(IpAddr::V6(ip).into())),
        url::Host::Domain(d) => ServerName::try_from(d.to_string()).map_err(|_| "invalid_server_url".to_string()),
    }
}

fn connect_tcp(u: &url::Url, timeout: Duration) -> Result<TcpStream, String> {
    let addrs = u.socket_addrs(|| None).map_err(|_| "server_unreachable".to_string())?;
    let mut last = "server_unreachable".to_string();
    for a in addrs {
        match TcpStream::connect_timeout(&a, timeout) {
            Ok(s) => return Ok(s),
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

// ── Pairing ─────────────────────────────────────────────────────────────────────────────────

/// What a server is, as far as trusting it goes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ServerKind {
    /// A name a public CA can vouch for (lgrai.app): the OS store decides. Nothing was fetched.
    Public,
    /// A LAN name that hands out no LGR Server CA: a developer's hub on loopback, or a server the OS
    /// store already trusts. The OS store decides.
    Plain,
    /// An LGR Server on this network. Trusted only once its fingerprint is confirmed.
    #[serde(rename_all = "camelCase")]
    Master {
        fingerprint: String,
        words: Vec<&'static str>,
        #[serde(skip)]
        ca_pem: String,
    },
}

/// Ask `server` what it is: for a LAN name, fetch its CA over a connection that verifies nothing,
/// and say what that CA is.
///
/// ⚠ Nothing fetched here is trusted until its fingerprint is compared: with the pairing code's `fp`,
/// or by a person with the six words. Only the CA is fetched; no credential goes this way.
pub fn probe(server: &str) -> Result<ServerKind, String> {
    if !may_pin(server) {
        return Ok(ServerKind::Public);
    }
    let unverified = rustls::ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Unverified(provider())))
        .with_no_client_auth();
    let res = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(concat!("lgr-desktop/", env!("CARGO_PKG_VERSION")))
        .no_proxy()
        .use_preconfigured_tls(unverified)
        .build()
        .map_err(|_| "client_build_failed".to_string())?
        .get(format!("{}{CA_PATH}", server.trim_end_matches('/')))
        .send()
        .map_err(|e| if e.is_timeout() { "server_timeout".to_string() } else { "server_unreachable".to_string() })?;
    if !res.status().is_success() {
        return Ok(ServerKind::Plain);
    }
    // A certificate is a few kilobytes; anything much bigger is not one.
    let body = res.text().map_err(|_| "server_unreachable".to_string())?;
    if body.len() > 16 * 1024 {
        return Ok(ServerKind::Plain);
    }
    match fingerprint_of_pem(&body) {
        Ok(fingerprint) => {
            let words = fingerprint_words(&fingerprint).ok_or("bad_certificate")?;
            Ok(ServerKind::Master { fingerprint, words, ca_pem: body.trim().to_string() })
        }
        // An SPA shell, a 200 that is not a certificate: not an LGR Server's LAN ingress.
        Err(_) => Ok(ServerKind::Plain),
    }
}

/// The pin for pairing with `server`, once its CA is shown to be the one `fp` names (FR-20.29).
///
/// ⚠ The CA is fetched again HERE, never taken from the page: the page only says which fingerprint a
/// person confirmed (or the link carried), and what this desktop then trusts is what the server
/// itself hands out and that fingerprint names.
pub fn confirm(server: &str, fp: &str) -> Result<MasterPin, String> {
    if !is_fingerprint(fp) {
        return Err("invalid_fingerprint".into());
    }
    if !may_pin(server) {
        return Err("pin_not_allowed".into());
    }
    match probe(server)? {
        ServerKind::Master { fingerprint, ca_pem, .. } if fingerprint == fp.trim() => MasterPin::new(&ca_pem, &fingerprint),
        ServerKind::Master { .. } => Err("fingerprint_mismatch".into()),
        ServerKind::Public | ServerKind::Plain => Err("not_a_master".into()),
    }
}

/// The probe's verifier: accepts any certificate, still checks the handshake's signatures. ⚠ Used for
/// one unauthenticated GET of a public certificate, and for nothing else.
#[derive(Debug)]
struct Unverified(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for Unverified {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The vector `packages/tests/src/unit/fingerprint-words.test.ts` holds the API to: the two sides
    /// draw the same words, or one of the two tests fails.
    const VECTOR: (&str, [&str; 6]) = (
        "sha256:J4_WvnqzMeCTJR5MsUknM6BG3BhVB2WJ7UdM0ERAY5k",
        ["chest", "leaf", "question", "voice", "credit", "utility"],
    );

    /// A throwaway CA made for these tests with `openssl req -x509 -newkey ec` (P-256, like a
    /// master's), its key discarded. `test-ca.fp` was computed with `openssl pkey -pubin -outform der |
    /// openssl dgst -sha256`, independently of the code under test.
    const CA_PEM: &str = include_str!("../testdata/test-ca.pem");
    const CA_FP: &str = include_str!("../testdata/test-ca.fp");

    #[test]
    fn the_words_are_the_masters_words() {
        assert_eq!(fingerprint_words(VECTOR.0).unwrap(), VECTOR.1);
        let zero = format!("sha256:{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([0u8; 32]));
        assert_eq!(fingerprint_words(&zero).unwrap(), ["abandon"; 6]);
    }

    #[test]
    fn the_word_file_is_bip39_english() {
        // ⚠ Hashed with LF line ends, which is what `.gitattributes` keeps the file at on every
        // checkout. A CRLF checkout would still read the same words (`lines()`), but not this hash.
        assert_eq!(WORDS.lines().filter(|w| !w.trim().is_empty()).count(), 2048);
        assert_eq!(
            format!("{:x}", Sha256::digest(WORDS.replace("\r\n", "\n").as_bytes())),
            "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"
        );
    }

    #[test]
    fn only_a_fingerprint_is_one() {
        assert!(is_fingerprint(VECTOR.0));
        for bad in [
            "",
            "sha256:",
            "sha1:J4_WvnqzMeCTJR5MsUknM6BG3BhVB2WJ7UdM0ERAY5k",
            "sha256:J4/WvnqzMeCTJR5MsUknM6BG3BhVB2WJ7UdM0ERAY5k",
            "sha256:J4_Wvnqz",
        ] {
            assert!(!is_fingerprint(bad), "{bad}");
            assert!(fingerprint_words(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn a_certificates_fingerprint_is_its_public_keys() {
        assert_eq!(fingerprint_of_pem(CA_PEM).unwrap(), CA_FP.trim());
        assert!(MasterPin::new(CA_PEM, CA_FP).is_ok());
        assert_eq!(MasterPin::new(CA_PEM, VECTOR.0), Err("fingerprint_mismatch".into()));
        // Exactly one certificate: what is fingerprinted is what is trusted.
        assert!(fingerprint_of_pem(&format!("{CA_PEM}\n{CA_PEM}")).is_err());
        assert!(fingerprint_of_pem("").is_err());
        assert!(fingerprint_of_pem("<!doctype html><html></html>").is_err());
    }

    #[test]
    fn only_a_lan_name_may_be_pinned() {
        for ok in [
            "https://192.168.1.10:4443",
            "https://10.0.0.5",
            "https://172.16.0.1:4443",
            "https://100.64.1.2:4443",
            "https://127.0.0.1:4443",
            "https://169.254.10.10",
            "https://[::1]:4443",
            "https://[fd12:3456::1]:4443",
            "https://[fe80::1]",
            "https://[::ffff:192.168.1.10]",
            "https://kasa-1:4443",
            "https://kasa-1.local:4443",
            "https://KASA-1.LOCAL.",
            "https://server.home.arpa",
            "https://lgr.shop.internal",
            "https://localhost:4443",
            "wss://192.168.1.10:4443/ws/desktop",
        ] {
            assert!(may_pin(ok), "should allow {ok}");
        }
        for no in [
            // The cloud, and anything else a public CA can certify: a pin must never replace that.
            "https://lgrai.app",
            "https://lgrai.app.",
            "https://example.com",
            "https://kasa-1.shop.lan",
            "https://8.8.8.8",
            "https://[2001:4860::8888]",
            "https://[::ffff:8.8.8.8]",
            "https://100.128.0.1",
            // Not TLS, so nothing to pin.
            "http://192.168.1.10:4001",
            "http://localhost:4001",
            "not a url",
        ] {
            assert!(!may_pin(no), "should refuse {no}");
        }
    }

    #[test]
    fn a_pin_is_per_origin_and_reaches_the_sockets() {
        let pin = MasterPin::new(CA_PEM, CA_FP).unwrap();
        assert!(set_pin("https://192.168.77.10:4443/somewhere", Some(pin.clone())));
        assert_eq!(pin_for("https://192.168.77.10:4443/api/desktop/v1/token"), Some(pin.clone()));
        // Presence and the bridge connect to wss:// on the same origin.
        assert_eq!(pin_for("wss://192.168.77.10:4443/ws/fiscal-bridge"), Some(pin.clone()));
        assert_eq!(pin_for("https://192.168.77.10:4444"), None);
        assert_eq!(pin_for("http://192.168.77.10:4443"), None);
        assert_eq!(pin_for("https://lgrai.app"), None);
        assert!(set_pin("https://192.168.77.10:4443", None));
        assert_eq!(pin_for("https://192.168.77.10:4443"), None);
    }

    #[test]
    fn a_pin_that_proves_nothing_is_refused() {
        let pin = MasterPin::new(CA_PEM, CA_FP).unwrap();
        // ⚠ The deep-link attack: the cloud's own name, pinned to someone's CA.
        assert!(!set_pin("https://lgrai.app", Some(pin.clone())));
        assert_eq!(pin_for("https://lgrai.app"), None);
        // A settings file whose certificate is not the one its fingerprint names.
        let forged = MasterPin { ca_pem: CA_PEM.into(), fingerprint: VECTOR.0.into() };
        assert!(!set_pin("https://192.168.77.11:4443", Some(forged)));
        assert_eq!(pin_for("https://192.168.77.11:4443"), None);
    }

    #[test]
    fn a_pinned_client_builds_for_a_master_and_not_for_the_cloud() {
        let pin = MasterPin::new(CA_PEM, CA_FP).unwrap();
        assert!(set_pin("https://192.168.77.12:4443", Some(pin)));
        assert!(pinned_tls("https://192.168.77.12:4443").unwrap().is_some());
        assert!(pinned_tls("https://lgrai.app").unwrap().is_none());
        // ⚠ Building the pinned client is where a rustls mismatch between this crate and reqwest
        // would show: `use_preconfigured_tls` takes `Any` and fails at build time, not compile time.
        assert!(client_for("https://192.168.77.12:4443", Duration::from_secs(5)).is_ok());
        assert!(client_for("https://lgrai.app", Duration::from_secs(5)).is_ok());
        set_pin("https://192.168.77.12:4443", None);
    }

    #[test]
    fn a_public_name_is_never_probed() {
        // No network: the answer comes from the name alone.
        assert_eq!(probe("https://lgrai.app"), Ok(ServerKind::Public));
        assert_eq!(probe("https://example.com:8443"), Ok(ServerKind::Public));
    }

    #[test]
    fn pairing_refuses_before_it_fetches_anything() {
        // No network either: a bad fingerprint, or a name a pin may not apply to, is refused first.
        assert_eq!(confirm("https://192.168.77.13:4443", "sha256:nope"), Err("invalid_fingerprint".into()));
        assert_eq!(confirm("https://lgrai.app", VECTOR.0), Err("pin_not_allowed".into()));
        assert_eq!(confirm("http://localhost:4001", VECTOR.0), Err("pin_not_allowed".into()));
    }

    #[test]
    fn a_masters_kind_names_its_words_and_never_its_certificate() {
        let kind = ServerKind::Master { fingerprint: VECTOR.0.into(), words: VECTOR.1.to_vec(), ca_pem: CA_PEM.into() };
        let json = serde_json::to_value(&kind).unwrap();
        assert_eq!(json["kind"], "master");
        assert_eq!(json["fingerprint"], VECTOR.0);
        assert_eq!(json["words"][0], "chest");
        assert!(json.get("caPem").is_none() && json.get("ca_pem").is_none());
        assert_eq!(serde_json::to_value(ServerKind::Public).unwrap()["kind"], "public");
    }

    /// Against a real LGR Server (set `LGR_TEST_MASTER` to its LAN URL and `LGR_TEST_MASTER_FP` to the
    /// fingerprint its Desktops page shows): the probe finds the CA, and the pinned client and socket
    /// reach it. `cargo test -- --ignored a_real_master`.
    #[test]
    #[ignore]
    fn a_real_master() {
        let server = std::env::var("LGR_TEST_MASTER").expect("LGR_TEST_MASTER");
        let fp = std::env::var("LGR_TEST_MASTER_FP").expect("LGR_TEST_MASTER_FP");
        let ServerKind::Master { fingerprint, ca_pem, .. } = probe(&server).unwrap() else {
            panic!("{server} is not a master")
        };
        assert_eq!(fingerprint, fp);
        assert_eq!(confirm(&server, VECTOR.0), Err("fingerprint_mismatch".into()));
        assert_eq!(confirm(&server, &fp).unwrap().fingerprint, fp);
        // Unpinned, the OS store refuses the master's certificate.
        let health = format!("{server}/api/health");
        assert!(client_for(&server, Duration::from_secs(10)).unwrap().get(&health).send().is_err());
        assert!(set_pin(&server, Some(MasterPin::new(&ca_pem, &fp).unwrap())));
        let res = client_for(&server, Duration::from_secs(10)).unwrap().get(&health).send().unwrap();
        assert!(res.status().is_success(), "{}", res.status());
        // Without a desktop credential the LAN answers 401 (FR-20.32): TLS held, the gate spoke.
        let res = client_for(&server, Duration::from_secs(10)).unwrap().get(format!("{server}/api/auth/me")).send().unwrap();
        assert_eq!(res.status().as_u16(), 401);
        // The socket: TLS through the pin, then the gate refuses an upgrade with a forged token.
        let ws = format!("{}/ws/desktop", server.replacen("https://", "wss://", 1));
        match ws_connect(&ws, "a.b.c") {
            Ok(_) => panic!("the gate let a forged token upgrade"),
            Err(err) => assert!(err.contains("401"), "{err}"),
        }
    }
}
