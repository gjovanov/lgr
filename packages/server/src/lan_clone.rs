//! FR-20.51 (plan step P3-7, AC 50) — a clone seen on the shop's network: another machine answering as
//! this server. Two machines with one node identity are two homes for every org they hold, each issuing
//! the same legal numbers. Global catches the pair once both are linked (two live uplinks); this
//! catches it on the LAN, linked or not.
//!
//! - **The advert carries this start's nonce** (`boot`, `advert.rs`), the one the uplink says hello
//!   with: this machine's own advert names its own nonce.
//! - **Every few minutes the supervisor browses** `_lgr-server._tcp` for adverts naming this node with
//!   ANOTHER nonce, at ANOTHER address.
//! - ⚠ **An advert is proof of nothing.** Anyone on the LAN can send one, and a crash leaves this
//!   machine's own TXT record in caches for up to 75 minutes (RFC 6762), after a DHCP change at another
//!   address. So a candidate is PROBED: a TLS handshake with its LAN ingress that trusts only this
//!   server's own LAN CA, and checks no name (a clone's certificate names its own address). Only a
//!   machine holding this server's CA key, or its certificate's key, completes it: a copy of this disk.
//!   A stale record answers nothing, and a forged one cannot answer that.
//! - **Confirmed, it is recorded** in `state/clone.json` (`at` renewed at every sighting). The API
//!   reads it every minute and locks legal numbering with it (`series-lock.service#lanCloneTick`): until
//!   a person records the last numbers, and again while the clone goes on answering after that.
//!
//! Only while the LAN ingress is on: a server that advertises nothing is found by nobody on the LAN.

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{pem::PemObject, CertificateDer, ServerName, TrustAnchor, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};

use crate::advert::Heard;
use crate::certs::LanIdentity;

/// The first look, a minute after the start: the network has heard this start's advert by then.
pub const FIRST_LOOK: Duration = Duration::from_secs(60);
/// Then every five minutes.
pub const EVERY: Duration = Duration::from_secs(300);
/// How long one browse listens.
pub const LISTEN: Duration = Duration::from_secs(3);
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Who this server is on the LAN now.
#[derive(Debug, Clone)]
pub struct Me {
    pub node: String,
    pub boot: String,
    pub ip: Option<Ipv4Addr>,
}

/// An advert naming this node from another start, at another address: a clone, or a stale record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    /// None for a server too old to say its nonce: the probe decides alone.
    pub boot: Option<String>,
    pub ip: Ipv4Addr,
    pub port: u16,
}

/// The adverts heard that could be a clone of `me`. Never this start's own, and never this machine's
/// own address (its advert from before a restart, still in caches).
pub fn candidates(me: &Me, heard: &[Heard]) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = Vec::new();
    for h in heard {
        let get = |k: &str| h.txt.iter().find(|(key, _)| key.eq_ignore_ascii_case(k)).map(|(_, v)| v.trim());
        if get("v") != Some("1") || get("node") != Some(me.node.as_str()) || h.port == 0 {
            continue;
        }
        let boot = get("boot").filter(|b| !b.is_empty()).map(str::to_string);
        if boot.as_deref() == Some(me.boot.as_str()) {
            continue;
        }
        let Some(ip) = get("ip").and_then(|s| s.parse::<Ipv4Addr>().ok()).or(h.ip) else { continue };
        if Some(ip) == me.ip || ip.is_loopback() || ip.is_unspecified() {
            continue;
        }
        let c = Candidate { boot, ip, port: h.port };
        if !out.contains(&c) {
            out.push(c);
        }
    }
    out
}

/// A server-certificate check that trusts this server's own LAN CA and nothing else, and checks no
/// name: what tells a copy of this disk from everything else on the network.
#[derive(Debug)]
struct OurCaOnly {
    anchor: TrustAnchor<'static>,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl ServerCertVerifier for OurCaOnly {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let cert = webpki::EndEntityCert::try_from(end_entity).map_err(|e| rustls::Error::General(format!("{e:?}")))?;
        cert.verify_for_usage(
            self.provider.signature_verification_algorithms.all,
            std::slice::from_ref(&self.anchor),
            intermediates,
            now,
            webpki::KeyUsage::server_auth(),
            None,
            None,
        )
        .map_err(|e| rustls::Error::General(format!("{e:?}")))?;
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// A TLS client that completes a handshake only with a server holding a certificate of `ca_pem`.
pub fn client_for(ca_pem: &str) -> Result<rustls::ClientConfig> {
    let ca = CertificateDer::from_pem_slice(ca_pem.as_bytes()).context("reading the LAN CA")?;
    let anchor = webpki::anchor_from_trusted_cert(&ca).context("the LAN CA as a trust anchor")?.to_owned();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = Arc::new(OurCaOnly { anchor, provider: provider.clone() });
    Ok(rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth())
}

/// Whether `addr` holds this server's LAN CA: its handshake completes against `client_for`.
pub async fn holds_our_ca(addr: SocketAddr, client: Arc<rustls::ClientConfig>) -> bool {
    let attempt = async {
        let tcp = tokio::net::TcpStream::connect(addr).await.ok()?;
        let name = ServerName::IpAddress(addr.ip().into());
        tokio_rustls::TlsConnector::from(client).connect(name, tcp).await.ok()
    };
    matches!(tokio::time::timeout(PROBE_TIMEOUT, attempt).await, Ok(Some(_)))
}

/// What is recorded of a confirmed clone, in `state/clone.json`.
pub fn record(file: &Path, c: &Candidate, now: SystemTime) -> Result<()> {
    let at = time::OffsetDateTime::from(now).format(&time::format_description::well_known::Rfc3339)?;
    // The first sighting stays: when this began is what a person asks first.
    let first = std::fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .filter(|v| v["otherIp"].as_str() == Some(c.ip.to_string().as_str()))
        .and_then(|v| v["firstSeen"].as_str().map(str::to_string))
        .unwrap_or_else(|| at.clone());
    let text = serde_json::json!({ "at": at, "firstSeen": first, "otherIp": c.ip.to_string(), "otherPort": c.port, "otherBoot": c.boot }).to_string();
    crate::config::write_durable(file, text.as_bytes(), 0o644)
}

/// The watch, for as long as the supervisor runs: browse, probe, record.
pub async fn run(node: String, boot: String, lan: Arc<Mutex<LanIdentity>>, file: PathBuf) {
    tokio::time::sleep(FIRST_LOOK).await;
    loop {
        let me = Me { node: node.clone(), boot: boot.clone(), ip: crate::certs::lan_ip(&crate::certs::lan_addresses(), crate::certs::default_route_v4()) };
        let heard = tokio::task::spawn_blocking(|| crate::advert::browse(LISTEN)).await.unwrap_or_default();
        let found = candidates(&me, &heard);
        if !found.is_empty() {
            let ca = lan.lock().unwrap_or_else(|p| p.into_inner()).ca_pem.clone();
            match client_for(&ca) {
                Err(e) => tracing::warn!(error = %format!("{e:#}"), "the clone watch cannot probe: no TLS client for the LAN CA"),
                Ok(client) => {
                    let client = Arc::new(client);
                    let mut by_ip: BTreeMap<Ipv4Addr, Candidate> = BTreeMap::new();
                    for c in found {
                        by_ip.entry(c.ip).or_insert(c);
                    }
                    for c in by_ip.into_values() {
                        if holds_our_ca(SocketAddr::new(c.ip.into(), c.port), client.clone()).await {
                            tracing::error!(other = %c.ip, port = c.port, "a CLONE of this server answers on the shop's network with its keys: legal numbering locks until a person decides which machine is real, and the other is installed again as a new server");
                            if let Err(e) = record(&file, &c, SystemTime::now()) {
                                tracing::error!(error = %format!("{e:#}"), "the clone could not be recorded");
                            }
                        } else {
                            tracing::info!(other = %c.ip, "an advert named this server from another start, and does not hold its keys: a stale record or a forgery, ignored");
                        }
                    }
                }
            }
        }
        tokio::time::sleep(EVERY).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me() -> Me {
        Me { node: "master-abcdefghijklmnop".into(), boot: "aaaa".into(), ip: Some(Ipv4Addr::new(192, 168, 1, 10)) }
    }

    fn heard(node: &str, boot: Option<&str>, ip: &str) -> Heard {
        let mut txt = vec![("v".to_string(), "1".to_string()), ("node".to_string(), node.to_string()), ("ip".to_string(), ip.to_string())];
        if let Some(b) = boot {
            txt.push(("boot".into(), b.into()));
        }
        Heard { instance: "KASA-1".into(), ip: None, port: 4443, txt }
    }

    #[test]
    fn a_candidate_is_this_node_from_another_start_at_another_address() {
        let found = candidates(&me(), &[
            // This start's own advert.
            heard("master-abcdefghijklmnop", Some("aaaa"), "192.168.1.10"),
            // This machine before a restart, its record still in caches: the same address.
            heard("master-abcdefghijklmnop", Some("bbbb"), "192.168.1.10"),
            // Another server altogether.
            heard("master-qrstuvwxyz234567", Some("cccc"), "192.168.1.30"),
            // The candidate, heard twice.
            heard("master-abcdefghijklmnop", Some("dddd"), "192.168.1.20"),
            heard("master-abcdefghijklmnop", Some("dddd"), "192.168.1.20"),
            // A server too old to say its nonce: the probe decides.
            heard("master-abcdefghijklmnop", None, "192.168.1.21"),
        ]);
        assert_eq!(found, vec![
            Candidate { boot: Some("dddd".into()), ip: Ipv4Addr::new(192, 168, 1, 20), port: 4443 },
            Candidate { boot: None, ip: Ipv4Addr::new(192, 168, 1, 21), port: 4443 },
        ]);
    }

    #[test]
    fn an_advert_without_its_version_port_or_address_is_nothing() {
        let mut no_version = heard("master-abcdefghijklmnop", Some("dddd"), "192.168.1.20");
        no_version.txt.retain(|(k, _)| k != "v");
        let mut no_port = heard("master-abcdefghijklmnop", Some("dddd"), "192.168.1.20");
        no_port.port = 0;
        let mut no_ip = heard("master-abcdefghijklmnop", Some("dddd"), "not-an-address");
        no_ip.ip = None;
        let loopback = heard("master-abcdefghijklmnop", Some("dddd"), "127.0.0.1");
        assert!(candidates(&me(), &[no_version, no_port, no_ip, loopback]).is_empty());
    }

    #[test]
    fn a_clone_is_recorded_with_when_it_began_and_when_it_was_last_seen() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state").join("clone.json");
        let c = Candidate { boot: Some("dddd".into()), ip: Ipv4Addr::new(192, 168, 1, 20), port: 4443 };
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        record(&file, &c, t0).unwrap();
        record(&file, &c, t0 + Duration::from_secs(300)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(v["firstSeen"].as_str(), Some("2027-01-15T08:00:00Z"));
        assert_eq!(v["at"].as_str(), Some("2027-01-15T08:05:00Z"));
        assert_eq!((v["otherIp"].as_str(), v["otherPort"].as_u64(), v["otherBoot"].as_str()), (Some("192.168.1.20"), Some(4443), Some("dddd")));
        // Another machine: its own beginning.
        let other = Candidate { boot: None, ip: Ipv4Addr::new(192, 168, 1, 21), port: 4443 };
        record(&file, &other, t0 + Duration::from_secs(600)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(v["firstSeen"].as_str(), Some("2027-01-15T08:10:00Z"));
    }

    /// A LAN ingress of `ca`'s, on a free port, answering one handshake after another.
    async fn ingress(ca: &LanIdentity) -> SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(ca.server_config().unwrap());
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let _ = acceptor.accept(tcp).await;
                });
            }
        });
        addr
    }

    #[tokio::test]
    async fn only_a_server_holding_this_servers_ca_completes_the_probe() {
        let (ours_dir, theirs_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let ours = LanIdentity::ensure(ours_dir.path(), &["kasa-1".into(), "192.168.1.10".into()]).unwrap();
        let theirs = LanIdentity::ensure(theirs_dir.path(), &["kasa-1".into(), "192.168.1.10".into()]).unwrap();
        // A copy of this disk at another address: same CA, a certificate re-issued for its own names.
        let clone_dir = tempfile::tempdir().unwrap();
        for f in std::fs::read_dir(ours_dir.path()).unwrap() {
            let f = f.unwrap();
            std::fs::copy(f.path(), clone_dir.path().join(f.file_name())).unwrap();
        }
        let clone = LanIdentity::ensure(clone_dir.path(), &["kasa-1-copy".into(), "192.168.1.20".into()]).unwrap();
        assert_eq!(clone.fingerprint, ours.fingerprint, "the clone's CA is this server's");
        let client = Arc::new(client_for(&ours.ca_pem).unwrap());
        assert!(holds_our_ca(ingress(&clone).await, client.clone()).await, "a copy of this disk completes it, whatever names its certificate carries");
        assert!(!holds_our_ca(ingress(&theirs).await, client.clone()).await, "another server's CA does not");
        // Nothing listening: a stale record.
        let gone = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
        assert!(!holds_our_ca(gone, client).await);
    }
}
