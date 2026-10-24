//! The master's own TLS identity on the LAN (FR-20.30, plan steps P1-3c and P1-4).
//!
//! - **A CA of its own**, made once at the first start (`keys/lan-ca.key`, `keys/lan-ca.crt`): ECDSA
//!   P-256, valid for 20 years. Desktops pin it at pairing (FR-20.31), so it is never replaced
//!   here: a new CA would unpair every till. Its rotation, announced a week ahead, is P1-4.
//! - **A server certificate it signs** (`keys/lan-server.key`, `keys/lan-server.crt`): ECDSA P-256,
//!   397 days, naming the machine, `<machine>.local`, `LGR_LAN_NAMES`, every LAN address, `localhost`,
//!   127.0.0.1 and ::1. It is re-issued when that set of names changes (an address from DHCP) and
//!   30 days before it expires.
//! - **The CA's fingerprint**: SHA-256 of its SubjectPublicKeyInfo, `sha256:<base64url>`, what a
//!   desktop pins (FR-20.29). It is in `status`, and the API puts it in every pairing code.
//!
//! The CA's name is derived from its own key (`LGR Server CA <first 6 digest bytes, hex>`), so a later
//! certificate is signed from the key alone, with nothing to parse. What the server certificate
//! names, and until when, is kept beside it (`lan-server.json`) for the same reason.
//!
//! ⚠ None of it is in a backup (FR-20.21): a replaced master is a new node, and its desktops pair
//! again.

use anyhow::{Context, Result};
use base64::Engine;
use rcgen::{BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair, KeyUsagePurpose, PublicKeyData};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use time::{Duration, OffsetDateTime};

const SERVER_DAYS: i64 = 397;
const RENEW_DAYS: i64 = 30;

/// The LAN addresses a desktop may reach this machine on: up, not loopback, not link-local.
pub fn lan_addresses() -> Vec<IpAddr> {
    let Ok(ifaces) = if_addrs::get_if_addrs() else { return vec![] };
    let mut out: Vec<IpAddr> = ifaces
        .into_iter()
        .map(|i| i.ip())
        .filter(|ip| !ip.is_loopback() && !ip.is_unspecified())
        .filter(|ip| match ip {
            IpAddr::V4(v4) => !v4.is_link_local(),
            // fe80::/10 needs a zone to be dialled, which no certificate can name.
            IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) != 0xfe80,
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// The IPv4 address this machine reaches the internet from: the source the OS picks for its
/// default route. A UDP `connect` sends nothing; it only asks the routing table. On a machine with
/// Hyper-V, VPN or WSL adapters, "the first private address" is often not the LAN at all.
pub fn default_route_v4() -> Option<std::net::Ipv4Addr> {
    let s = std::net::UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    s.connect(("1.1.1.1", 53)).ok()?;
    match s.local_addr().ok()?.ip() {
        IpAddr::V4(v4) if !v4.is_unspecified() && !v4.is_loopback() => Some(v4),
        _ => None,
    }
}

/// The address a pairing code names (FR-20.29): the default route's address if it is one of this
/// machine's LAN addresses, else the first private IPv4 one, else `<machine>.local`. DHCP may move it
/// later; a paired desktop finds its master by identity, not by address (FR-20.28).
pub fn lan_url(addresses: &[IpAddr], route: Option<std::net::Ipv4Addr>, machine: Option<&str>, port: u16) -> Option<String> {
    let lan_v4 = |a: &IpAddr| match a {
        IpAddr::V4(v) if v.is_private() => Some(*v),
        _ => None,
    };
    let chosen = route.filter(|r| addresses.contains(&IpAddr::V4(*r))).or_else(|| addresses.iter().find_map(lan_v4));
    match (chosen, machine) {
        (Some(v4), _) => Some(format!("https://{v4}:{port}")),
        (None, Some(m)) => Some(format!("https://{m}.local:{port}")),
        (None, None) => None,
    }
}

/// Every name the server certificate carries: `hosts` (the front's), the addresses, and loopback.
pub fn wanted_names(hosts: &[String], addresses: &[IpAddr]) -> Vec<String> {
    let mut names: Vec<String> = hosts.iter().map(|h| h.to_ascii_lowercase()).collect();
    names.extend(addresses.iter().map(IpAddr::to_string));
    names.extend(["localhost".to_string(), "127.0.0.1".to_string(), "::1".to_string()]);
    names.sort();
    names.dedup();
    names
}

fn spki_digest(key: &impl PublicKeyData) -> [u8; 32] {
    let digest = ring::digest::digest(&ring::digest::SHA256, &key.subject_public_key_info());
    digest.as_ref().try_into().expect("SHA-256 is 32 bytes")
}

/// The pin: the SHA-256 of a key's SubjectPublicKeyInfo, written `sha256:<base64url, no padding>`.
/// It is what a pairing code carries (FR-20.29), and what the API turns into six words
/// (`services/biz/desktop/fingerprint-words.ts`).
pub fn spki_fingerprint(key: &impl PublicKeyData) -> String {
    format!("sha256:{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(spki_digest(key)))
}

/// The CA's parameters, rebuilt from its key: the same name and key usages every time, so it signs
/// the same way it did when it was made. ⚠ The name is drawn from the digest itself, never from how
/// the fingerprint happens to be written, so a change of notation cannot change the CA's name.
fn ca_params(key: &impl PublicKeyData) -> Result<CertificateParams> {
    let mut p = CertificateParams::new(Vec::<String>::new())?;
    let short: String = spki_digest(key)[..6].iter().map(|b| format!("{b:02x}")).collect();
    p.distinguished_name.push(DnType::CommonName, format!("LGR Server CA {short}"));
    p.distinguished_name.push(DnType::OrganizationName, "LGR");
    p.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    p.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign, KeyUsagePurpose::DigitalSignature];
    Ok(p)
}

struct Files {
    ca_key: PathBuf,
    ca_crt: PathBuf,
    key: PathBuf,
    crt: PathBuf,
    meta: PathBuf,
}

impl Files {
    fn in_dir(keys: &Path) -> Self {
        Self {
            ca_key: keys.join("lan-ca.key"),
            ca_crt: keys.join("lan-ca.crt"),
            key: keys.join("lan-server.key"),
            crt: keys.join("lan-server.crt"),
            meta: keys.join("lan-server.json"),
        }
    }
}

/// Replace `file` with `text`: written beside it, then renamed over it, so a power cut leaves the
/// old file or the new one. Readable by its owner only on Unix; on Windows, the data directory's ACL.
fn replace_private(file: &Path, text: &str) -> Result<()> {
    let tmp = file.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    crate::config::write_private(&tmp, text)?;
    std::fs::rename(&tmp, file).with_context(|| format!("writing {}", file.display()))
}

/// Whether the server certificate in `keys` must be (re-)issued for `names`.
fn needs_new_server_cert(keys: &Path, names: &[String]) -> bool {
    let f = Files::in_dir(keys);
    if !f.key.exists() || !f.crt.exists() {
        return true;
    }
    let Some(meta) = std::fs::read_to_string(&f.meta).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else {
        return true;
    };
    let renew_at = meta["notAfter"].as_i64().unwrap_or(0) - RENEW_DAYS * 86_400;
    names_of(&meta) != names || OffsetDateTime::now_utc().unix_timestamp() >= renew_at
}

fn names_of(meta: &serde_json::Value) -> Vec<String> {
    meta["names"].as_array().into_iter().flatten().filter_map(|n| n.as_str().map(String::from)).collect()
}

fn issue(keys: &Path, ca_key: &KeyPair, names: &[String]) -> Result<()> {
    let f = Files::in_dir(keys);
    let issuer = Issuer::new(ca_params(ca_key)?, ca_key);
    let key = KeyPair::generate().context("making the server certificate's key")?;
    let mut params = CertificateParams::new(names.to_vec()).context("naming the server certificate")?;
    params.distinguished_name.push(DnType::CommonName, names.first().cloned().unwrap_or_else(|| "lgr-server".into()));
    params.is_ca = IsCa::ExplicitNoCa;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.use_authority_key_identifier_extension = true;
    let not_after = OffsetDateTime::now_utc() + Duration::days(SERVER_DAYS);
    params.not_before = OffsetDateTime::now_utc() - Duration::days(1);
    params.not_after = not_after;
    let cert = params.signed_by(&key, &issuer)?;
    replace_private(&f.crt, &cert.pem())?;
    replace_private(&f.key, &key.serialize_pem())?;
    replace_private(&f.meta, &serde_json::json!({ "names": names, "notAfter": not_after.unix_timestamp() }).to_string())?;
    tracing::info!(?names, "issued the LAN server certificate");
    Ok(())
}

/// The server certificate in `keys`, with the CA after it, ready to serve; and the names it carries.
fn load(keys: &Path, ca_pem: &str) -> Result<(rustls::sign::CertifiedKey, Vec<String>)> {
    use rustls::pki_types::pem::PemObject;
    let f = Files::in_dir(keys);
    let key = KeyPair::from_pem(&std::fs::read_to_string(&f.key)?).context("reading the server certificate's key")?;
    let server = CertificateDer::from_pem_slice(std::fs::read_to_string(&f.crt)?.as_bytes()).context("reading the server certificate")?;
    let ca = CertificateDer::from_pem_slice(ca_pem.as_bytes()).context("reading the LAN CA's certificate")?;
    let provider = rustls::crypto::ring::default_provider();
    let certified = rustls::sign::CertifiedKey::from_der(vec![server, ca], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())), &provider)?;
    let names = std::fs::read_to_string(&f.meta).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).map(|m| names_of(&m)).unwrap_or_default();
    Ok((certified, names))
}

/// The master's LAN identity, its server certificate re-issued when the names change.
pub struct LanIdentity {
    pub ca_pem: String,
    pub fingerprint: String,
    pub names: Vec<String>,
    certified: Arc<RwLock<Arc<rustls::sign::CertifiedKey>>>,
    keys: PathBuf,
}

impl LanIdentity {
    /// Load it from `keys`, making what is missing: the CA on first start, the server certificate
    /// when it is missing, names something else, or expires within 30 days.
    pub fn ensure(keys: &Path, names: &[String]) -> Result<Self> {
        std::fs::create_dir_all(keys).with_context(|| format!("creating {}", keys.display()))?;
        let f = Files::in_dir(keys);
        let ca_key = if f.ca_key.exists() {
            KeyPair::from_pem(&std::fs::read_to_string(&f.ca_key)?).context("reading the LAN CA's key")?
        } else {
            let key = KeyPair::generate().context("making the LAN CA's key")?;
            let mut params = ca_params(&key)?;
            params.not_before = OffsetDateTime::now_utc() - Duration::days(1);
            params.not_after = OffsetDateTime::now_utc() + Duration::days(365 * 20);
            let cert = params.self_signed(&key)?;
            // The certificate first: a key without its certificate is remade, the other way round never.
            replace_private(&f.ca_crt, &cert.pem())?;
            replace_private(&f.ca_key, &key.serialize_pem())?;
            tracing::info!(fingerprint = %spki_fingerprint(&key), "made the master's LAN CA");
            key
        };
        let fingerprint = spki_fingerprint(&ca_key);
        let ca_pem = std::fs::read_to_string(&f.ca_crt).context("reading the LAN CA's certificate")?;
        if needs_new_server_cert(keys, names) {
            issue(keys, &ca_key, names)?;
        }
        let (certified, names) = load(keys, &ca_pem)?;
        Ok(Self { ca_pem, fingerprint, names, certified: Arc::new(RwLock::new(Arc::new(certified))), keys: keys.to_path_buf() })
    }

    /// Re-issue the server certificate if `names` are no longer what it says (or it is near its end),
    /// and serve the new one from the next handshake on. Open connections keep the one they began with.
    pub fn refresh(&mut self, names: &[String]) -> Result<bool> {
        if !needs_new_server_cert(&self.keys, names) {
            return Ok(false);
        }
        let ca_key = KeyPair::from_pem(&std::fs::read_to_string(Files::in_dir(&self.keys).ca_key)?)?;
        issue(&self.keys, &ca_key, names)?;
        let (certified, names) = load(&self.keys, &self.ca_pem)?;
        *self.certified.write().unwrap() = Arc::new(certified);
        self.names = names;
        Ok(true)
    }

    /// The TLS configuration the LAN ingress serves: HTTP/1.1 only, this identity, read again on
    /// every handshake.
    pub fn server_config(&self) -> Result<Arc<rustls::ServerConfig>> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut config = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()?
            .with_no_client_auth()
            .with_cert_resolver(Arc::new(Current(self.certified.clone())));
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(Arc::new(config))
    }
}

/// The server certificate in force, for each new handshake.
#[derive(Debug)]
struct Current(Arc<RwLock<Arc<rustls::sign::CertifiedKey>>>);

impl rustls::server::ResolvesServerCert for Current {
    fn resolve(&self, _hello: rustls::server::ClientHello<'_>) -> Option<Arc<rustls::sign::CertifiedKey>> {
        Some(self.0.read().unwrap().clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(extra: &[&str]) -> Vec<String> {
        let hosts: Vec<String> = ["kasa-1", "kasa-1.local"].iter().chain(extra).map(|s| s.to_string()).collect();
        wanted_names(&hosts, &["192.168.1.20".parse().unwrap()])
    }

    #[test]
    fn the_names_are_the_hosts_the_addresses_and_loopback() {
        assert_eq!(names(&[]), vec!["127.0.0.1", "192.168.1.20", "::1", "kasa-1", "kasa-1.local", "localhost"]);
    }

    #[test]
    fn the_ca_is_made_once_and_kept_while_the_server_certificate_follows_the_names() {
        let dir = tempfile::tempdir().unwrap();
        let first = LanIdentity::ensure(dir.path(), &names(&[])).unwrap();
        let ca_key = std::fs::read_to_string(dir.path().join("lan-ca.key")).unwrap();
        let server_crt = std::fs::read_to_string(dir.path().join("lan-server.crt")).unwrap();
        assert!(first.fingerprint.starts_with("sha256:"), "{}", first.fingerprint);
        assert_eq!(first.fingerprint.len(), "sha256:".len() + 43);

        // A restart with the same names: nothing is remade.
        let again = LanIdentity::ensure(dir.path(), &names(&[])).unwrap();
        assert_eq!(again.fingerprint, first.fingerprint);
        assert_eq!(std::fs::read_to_string(dir.path().join("lan-server.crt")).unwrap(), server_crt);

        // A new address: a new server certificate, signed by the same CA.
        let mut moved = LanIdentity::ensure(dir.path(), &names(&[])).unwrap();
        assert!(moved.refresh(&names(&["kasa.shop.lan"])).unwrap());
        assert_ne!(std::fs::read_to_string(dir.path().join("lan-server.crt")).unwrap(), server_crt);
        assert_eq!(std::fs::read_to_string(dir.path().join("lan-ca.key")).unwrap(), ca_key);
        assert_eq!(moved.fingerprint, first.fingerprint);
        assert!(moved.names.contains(&"kasa.shop.lan".to_string()));
        assert!(!moved.refresh(&names(&["kasa.shop.lan"])).unwrap());
    }

    #[test]
    fn a_pairing_code_names_the_lan_the_machine_routes_from() {
        let ips: Vec<IpAddr> = ["100.65.0.5", "192.168.128.1", "192.168.8.115", "fd7a::1"].iter().map(|a| a.parse().unwrap()).collect();
        // The default route's address wins over the first private one (a Hyper-V switch here).
        assert_eq!(lan_url(&ips, Some("192.168.8.115".parse().unwrap()), Some("kasa-1"), 4443).as_deref(), Some("https://192.168.8.115:4443"));
        // A route through an address that is not one of ours (a tunnel) is not trusted for it.
        assert_eq!(lan_url(&ips, Some("10.9.9.9".parse().unwrap()), Some("kasa-1"), 4443).as_deref(), Some("https://192.168.128.1:4443"));
        // No private IPv4 at all: the machine's mDNS name.
        let public: Vec<IpAddr> = vec!["100.65.0.5".parse().unwrap()];
        assert_eq!(lan_url(&public, None, Some("kasa-1"), 4443).as_deref(), Some("https://kasa-1.local:4443"));
        assert_eq!(lan_url(&[], None, None, 4443), None);
    }

    #[test]
    fn the_fingerprint_is_the_one_the_api_reads() {
        let dir = tempfile::tempdir().unwrap();
        let id = LanIdentity::ensure(dir.path(), &names(&[])).unwrap();
        // sha256:<43 base64url>, the form fingerprint-words.ts takes: no '+', '/' or '='.
        let b64 = id.fingerprint.strip_prefix("sha256:").unwrap();
        assert_eq!(b64.len(), 43);
        assert!(b64.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "{b64}");
    }

    #[test]
    fn a_server_certificate_near_its_end_is_renewed() {
        let dir = tempfile::tempdir().unwrap();
        let mut id = LanIdentity::ensure(dir.path(), &names(&[])).unwrap();
        let meta = dir.path().join("lan-server.json");
        let soon = OffsetDateTime::now_utc().unix_timestamp() + 10 * 86_400;
        std::fs::write(&meta, serde_json::json!({ "names": names(&[]), "notAfter": soon }).to_string()).unwrap();
        assert!(id.refresh(&names(&[])).unwrap());
    }
}
