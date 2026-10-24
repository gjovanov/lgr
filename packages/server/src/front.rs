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
    })
}

/// Setup is done once the API says so (FR-20.18): from then on, there is no console.
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
    std::fs::create_dir_all(file.parent().expect("keys/ has a parent"))?;
    let token = random_token();
    crate::config::write_private(&file, &format!("{token}\n"))?;
    Ok(token)
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
        };
        assert!(!format!("{f:?}").contains("a-secret-value"));
        assert!(!format!("{f:?}").contains("an-egress-secret"));
    }
}
