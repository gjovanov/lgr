//! What the supervisor and its API agree on for one boot (FR-20.16, plan step P1-3b).
//!
//! - **The front secret**: made at every boot, kept in memory, handed to the API in its
//!   environment. Every request an ingress forwards carries it, and the API answers nothing that
//!   does not (`portal-api/src/front/front-guard.ts`). Any other process on the machine can reach
//!   the API's loopback port; none of them knows this.
//! - **The front port**: the API's one listener, on 127.0.0.1, picked free at boot. Nothing outside
//!   the supervisor needs to know it.
//! - **The control socket**: `<data>/run/api.sock`, AF_UNIX, in a directory only the service and
//!   administrators can open (`control.rs`).
//! - **The names** a request may carry in `Host`: this machine's, and the operator's
//!   (`LGR_LAN_NAMES`). Any IP literal is allowed besides (DNS rebinding always uses a name).
//! - **The setup console**: its port (`SETUP_PORT`, 4480) and its one-time token
//!   (`keys/setup-token`, FR-20.18), until `state/setup-complete` exists.

use anyhow::{bail, Context, Result};
use base64::Engine;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::config::Paths;

pub const DEFAULT_SETUP_PORT: u16 = 4480;

#[derive(Clone)]
pub struct Front {
    pub secret: String,
    pub port: u16,
    pub socket: PathBuf,
    pub hosts: Vec<String>,
    pub setup_port: u16,
    /// The egress proxy's loopback port and the credential only the API is given (FR-20.53).
    pub egress_port: u16,
    pub egress_secret: String,
    /// The OS's trusted roots, exported for the API (`NODE_EXTRA_CA_CERTS`), once they are.
    pub roots: Option<PathBuf>,
    /// With the LAN ingress open: the address a pairing code names, and the CA a desktop pins
    /// (FR-20.29). The API puts both into every code it mints.
    pub lan_url: Option<String>,
    pub lan_fingerprint: Option<String>,
    /// Where both are published while the supervisor runs (`state/lan.json`): a DHCP move or a CA
    /// rotation changes them, and the API reads them there rather than from its environment.
    pub lan_state: Option<PathBuf>,
}

/// Never the secret: a `Front` printed in a log must not carry it.
impl std::fmt::Debug for Front {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Front")
            .field("port", &self.port)
            .field("socket", &self.socket)
            .field("hosts", &self.hosts)
            .field("egress_port", &self.egress_port)
            .finish_non_exhaustive()
    }
}

pub fn random_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/// Two free ports on 127.0.0.1, distinct: both are held while the second is chosen.
fn free_loopback_ports() -> Result<(u16, u16)> {
    let a = std::net::TcpListener::bind(("127.0.0.1", 0)).context("finding a free loopback port for the API")?;
    let b = std::net::TcpListener::bind(("127.0.0.1", 0)).context("finding a free loopback port for the egress")?;
    Ok((a.local_addr()?.port(), b.local_addr()?.port()))
}

/// This machine's name, lowercase: `kasa-1`.
pub fn hostname() -> Option<String> {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } != 0 {
            return None;
        }
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        let name = String::from_utf8_lossy(&buf[..end]).trim().to_ascii_lowercase();
        (!name.is_empty()).then_some(name)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{ComputerNameDnsHostname, GetComputerNameExW};
        let mut buf = [0u16; 256];
        let mut len = buf.len() as u32;
        if unsafe { GetComputerNameExW(ComputerNameDnsHostname, buf.as_mut_ptr(), &mut len) } == 0 {
            return None;
        }
        let name = String::from_utf16_lossy(&buf[..len as usize]).trim().to_ascii_lowercase();
        (!name.is_empty()).then_some(name)
    }
}

/// The names the API may answer to: the machine's, its `.local` (mDNS), and the operator's.
pub fn host_names(machine: Option<&str>, operator: &BTreeMap<String, String>) -> Vec<String> {
    let mut names: Vec<String> = vec![];
    if let Some(m) = machine {
        names.push(m.to_string());
        names.push(format!("{m}.local"));
    }
    for n in operator.get("LGR_LAN_NAMES").map(String::as_str).unwrap_or("").split(',') {
        let n = n.trim().to_ascii_lowercase();
        if !n.is_empty() && !names.contains(&n) {
            names.push(n);
        }
    }
    names
}

/// The control socket's path. ⚠ AF_UNIX paths are short (`sun_path`): a data directory deep enough
/// to break one is a configuration error, said in words, not a bind failure in the API's log.
pub fn socket_path(data: &Path) -> Result<PathBuf> {
    let socket = data.join("run").join("api.sock");
    if socket.as_os_str().len() > crate::control::MAX_SOCKET_PATH {
        bail!(
            "{} is too long for a control socket (at most {} bytes): set LGR_SERVER_DATA to a shorter path",
            socket.display(),
            crate::control::MAX_SOCKET_PATH
        );
    }
    let dir = socket.parent().expect("run/ has a parent");
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    #[cfg(unix)]
    std::fs::set_permissions(dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    Ok(socket)
}

/// This boot's front.
pub fn prepare(paths: &Paths, operator: &BTreeMap<String, String>) -> Result<Front> {
    let setup_port = match operator.get("SETUP_PORT") {
        Some(p) => p.parse().with_context(|| format!("SETUP_PORT={p} is not a port"))?,
        None => DEFAULT_SETUP_PORT,
    };
    let (port, egress_port) = free_loopback_ports()?;
    Ok(Front {
        secret: random_token(),
        port,
        socket: socket_path(&paths.data)?,
        hosts: host_names(hostname().as_deref(), operator),
        setup_port,
        egress_port,
        egress_secret: random_token(),
        roots: None,
        lan_url: None,
        lan_fingerprint: None,
        lan_state: None,
    })
}

/// This master's identity: `master-<16 base32>`, made at its first start and kept in
/// `state/node.json` (FR-20.5). The API is given it as `LGR_NODE_ID`, and every `OrgHome` row on
/// this master names it: the orgs it is home of.
///
/// ⚠ It NEVER changes. A new id would leave every one of those rows naming a node that is no longer
/// this one, and the master could then write none of its orgs. So a file that cannot be read is a
/// configuration error (exit 7), never a reason to make a fresh id. When the master registers with
/// lgrai.app (P2), global records this id; it does not hand out another.
pub fn node_id(data: &Path) -> Result<String> {
    let file = data.join("state").join("node.json");
    match std::fs::read_to_string(&file) {
        Ok(text) => {
            let id = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v["nodeId"].as_str().map(String::from))
                .filter(|id| valid_node_id(id));
            match id {
                Some(id) => Ok(id),
                None => bail!("{} names no valid node id: restore it from a backup; a new id would orphan every org this master holds", file.display()),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            use rand::Rng;
            const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz234567";
            let mut rng = rand::thread_rng();
            let tail: String = (0..16).map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char).collect();
            let id = format!("master-{tail}");
            // ⚠ Durably (`config::write_durable`): the first start's power cut must not leave an
            // empty file here, which a later start could only refuse.
            crate::config::write_private(&file, &serde_json::json!({ "nodeId": id, "createdAt": chrono_like_now() }).to_string())?;
            tracing::info!(node = %id, "this master's identity was made");
            Ok(id)
        }
        Err(e) => Err(e).with_context(|| format!("reading {}", file.display())),
    }
}

/// When this master's identity was made (seconds since the epoch, `state/node.json`): where an org
/// with no licence counts its 30-day evaluation from (FR-20.55). None when the file does not say.
pub fn node_created_at(data: &Path) -> Option<u64> {
    let text = std::fs::read_to_string(data.join("state").join("node.json")).ok()?;
    serde_json::from_str::<serde_json::Value>(&text).ok()?["createdAt"].as_u64().filter(|t| *t > 0)
}

fn valid_node_id(id: &str) -> bool {
    id.strip_prefix("master-").is_some_and(|t| t.len() == 16 && t.bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b)))
}

/// Seconds since the epoch, for the record: when the identity was made.
fn chrono_like_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Setup is done once its last step said so (`setup.rs`, FR-20.18): from then on there is no
/// console, registering an org is off, and the tunnel carries traffic. `setup reset` removes it.
pub fn setup_complete(data: &Path) -> bool {
    data.join("state").join("setup-complete").exists()
}

/// The one-time setup token: made on first use, then kept until setup is complete. The installer
/// prints it, and `lgr-server setup-token` shows it again to an administrator.
pub fn setup_token(data: &Path) -> Result<String> {
    let file = data.join("keys").join("setup-token");
    match std::fs::read_to_string(&file) {
        Ok(t) if !t.trim().is_empty() => return Ok(t.trim().to_string()),
        Ok(_) => bail!("{} is empty: delete it and a new one is made", file.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e).with_context(|| format!("reading {}", file.display())),
    }
    let keys = file.parent().expect("keys/ has a parent");
    std::fs::create_dir_all(keys)?;
    let token = random_token();
    crate::config::write_private(&file, &format!("{token}\n"))?;
    give_to_keys_owner(keys, &file)?;
    Ok(token)
}

/// ⚠ `lgr-server setup-token` (and `setup reset`) run as root, and the service as `lgr`: a token
/// file root makes is `0600 root`, which the service then cannot read, so its console never opens and
/// the start gives up (exit 7, which systemd does not retry). The file goes to whoever owns `keys/`.
#[cfg(unix)]
fn give_to_keys_owner(keys: &Path, file: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let (dir, made) = (std::fs::metadata(keys)?, std::fs::metadata(file)?);
    if (dir.uid(), dir.gid()) != (made.uid(), made.gid()) {
        std::os::unix::fs::chown(file, Some(dir.uid()), Some(dir.gid())).with_context(|| format!("giving {} to the owner of {}", file.display(), keys.display()))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn give_to_keys_owner(_keys: &Path, _file: &Path) -> Result<()> {
    Ok(())
}

/// `setup reset`: the old link stops working. The next [`setup_token`] makes a new one.
pub fn forget_setup_token(data: &Path) -> Result<()> {
    let file = data.join("keys").join("setup-token");
    match std::fs::remove_file(&file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("removing {}", file.display())),
    }
}

/// The console's session for `token`: what its cookie carries once the token opened it.
///
/// Derived from the token rather than drawn at random, so a session outlives the supervisor's
/// restart in place (setup applies its settings that way, FR-20.18), and a new token (`setup reset`)
/// ends every session the old one opened. ⚠ Never the token itself: the cookie is sent with every
/// request, and the token is what opens setup again from a new browser.
pub fn setup_session(token: &str) -> String {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, token.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(ring::hmac::sign(&key, b"lgr setup console session").as_ref())
}

/// What an administrator opens to set the server up. The token rides in the fragment, which no
/// server and no log ever sees.
pub fn setup_url(port: u16, token: &str) -> String {
    format!("http://127.0.0.1:{port}/__lgr/setup#{token}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_names_are_the_machines_its_local_and_the_operators() {
        let op = BTreeMap::from([("LGR_LAN_NAMES".to_string(), " Kasa.Shop.lan, kasa-1 ,,".to_string())]);
        assert_eq!(host_names(Some("kasa-1"), &op), vec!["kasa-1", "kasa-1.local", "kasa.shop.lan"]);
        assert!(host_names(None, &BTreeMap::new()).is_empty());
    }

    #[test]
    fn a_socket_path_too_long_for_sun_path_is_refused_in_words() {
        let deep = PathBuf::from("/").join("x".repeat(120));
        let err = socket_path(&deep).unwrap_err().to_string();
        assert!(err.contains("too long for a control socket"), "{err}");
    }

    #[test]
    fn the_setup_token_is_made_once_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let first = setup_token(dir.path()).unwrap();
        assert_eq!(first.len(), 43);
        assert_eq!(setup_token(dir.path()).unwrap(), first);
        assert!(!setup_complete(dir.path()));
        std::fs::create_dir_all(dir.path().join("state")).unwrap();
        std::fs::write(dir.path().join("state").join("setup-complete"), "").unwrap();
        assert!(setup_complete(dir.path()));
        assert!(setup_url(4480, &first).ends_with(&format!("/__lgr/setup#{first}")));
    }

    #[test]
    fn the_node_id_is_made_once_and_never_made_again() {
        let dir = tempfile::tempdir().unwrap();
        let first = node_id(dir.path()).unwrap();
        assert!(valid_node_id(&first), "{first}");
        assert_eq!(node_id(dir.path()).unwrap(), first);
        // A record that cannot be read is an error to fix, never a reason for a new identity.
        let file = dir.path().join("state").join("node.json");
        std::fs::write(&file, "{\"nodeId\":\"garbage\"}").unwrap();
        let err = node_id(dir.path()).unwrap_err().to_string();
        assert!(err.contains("orphan every org"), "{err}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\"nodeId\":\"garbage\"}");
    }

    #[test]
    fn a_front_never_prints_its_secret() {
        let f = Front {
            secret: "a-secret-value".into(),
            port: 1,
            socket: PathBuf::from("s"),
            hosts: vec![],
            setup_port: 2,
            egress_port: 3,
            egress_secret: "an-egress-secret".into(),
            roots: None,
            lan_url: None,
            lan_fingerprint: None,
            lan_state: None,
        };
        assert!(!format!("{f:?}").contains("a-secret-value"));
        assert!(!format!("{f:?}").contains("an-egress-secret"));
    }
}
