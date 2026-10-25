//! A node access token for the API (FR-20.86, plan step P2-6): the outbox worker presents it to
//! global's relay, through the egress proxy, to send the mail this master queued.
//!
//! The supervisor holds the node key (DPAPI at machine scope, or `0600`) and never hands it out. It
//! hands out a token instead: 15 minutes long, refreshed every 10 minutes while the master is
//! registered, in `state/node-token.json` (`LGR_NODE_TOKEN_FILE`). Unregistered, there is no file.
//! A token lets the API act as this master on `/api/node/v1/*` and on nothing else.
//!
//! The same fetch carries the API's SEAL key (FR-20.40, plan step P2-4c). The API makes it and puts
//! its public half in `state/seal-pub.json` (`LGR_NODE_SEAL_PUB_FILE`); this signs it into the token
//! assertion with the node key, and global seals the people's local credentials to it from then on.

use anyhow::Result;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::node_key::NodeKey;
use crate::register;
use crate::supervisor::Registrar;

pub const EVERY: Duration = Duration::from_secs(600);

pub fn file(data: &Path) -> PathBuf {
    data.join("state").join("node-token.json")
}

/// Where the API puts its seal key's public half.
pub fn seal_pub_file(data: &Path) -> PathBuf {
    data.join("state").join("seal-pub.json")
}

/// The API's seal key, when it has published one that is an X25519 key: base64url of 32 bytes, not
/// all zeros. Anything else is not signed: the node key vouches only for what could be a key.
pub fn read_seal_pub(data: &Path) -> Option<String> {
    use base64::Engine as _;
    let text = std::fs::read_to_string(seal_pub_file(data)).ok()?;
    let seal = serde_json::from_str::<serde_json::Value>(&text).ok()?["seal"].as_str()?.to_string();
    if seal.len() != 43 || !seal.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return None;
    }
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&seal).ok()?;
    (raw.len() == 32 && raw.iter().any(|b| *b != 0)).then_some(seal)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Write `{server, token, expiresAt}` beside the file and rename it over: the API never reads half.
pub fn write(data: &Path, server: &str, token: &str, expires_at: u64) -> Result<()> {
    let file = file(data);
    std::fs::create_dir_all(file.parent().expect("state/ has a parent"))?;
    let tmp = file.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    crate::config::write_private(&tmp, &serde_json::json!({ "server": server, "token": token, "expiresAt": expires_at }).to_string())?;
    std::fs::rename(&tmp, &file)?;
    Ok(())
}

/// One refresh. False when there is nothing to do: not registered (and then no file is left).
pub async fn refresh_once(registrar: &Registrar) -> Result<bool> {
    let Some(reg) = register::current(&registrar.data) else {
        let _ = std::fs::remove_file(file(&registrar.data));
        return Ok(false);
    };
    let key = NodeKey::load_or_create(&registrar.data)?;
    let seal = read_seal_pub(&registrar.data);
    let (token, expires_in) = register::fetch_token_sealed(&reg.server, &reg.node_id, &key, &registrar.client, seal.as_deref()).await?;
    write(&registrar.data, &reg.server, &token, now_secs() + expires_in)?;
    Ok(true)
}

/// For as long as the supervisor runs. A registration wakes it at once.
pub async fn run(registrar: Arc<Registrar>, every: Duration) {
    loop {
        if let Err(e) = refresh_once(&registrar).await {
            // The token in the file runs out by itself; the outbox waits for the next one.
            tracing::warn!("no node token for the API this round: {e:#}");
        }
        tokio::select! {
            _ = tokio::time::sleep(every) => {}
            _ = registrar.wake.notified() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_file_is_written_whole_and_replaced() {
        let data = tempfile::tempdir().unwrap();
        write(data.path(), "https://lgrai.app", "tok-1", 100).unwrap();
        write(data.path(), "https://lgrai.app", "tok-2", 200).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(file(data.path())).unwrap()).unwrap();
        assert_eq!((v["server"].as_str(), v["token"].as_str(), v["expiresAt"].as_u64()), (Some("https://lgrai.app"), Some("tok-2"), Some(200)));
        assert!(!file(data.path()).with_extension("tmp").exists());
    }

    #[test]
    fn only_a_key_shaped_seal_is_read() {
        let data = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(data.path().join("state")).unwrap();
        let put = |v: serde_json::Value| std::fs::write(seal_pub_file(data.path()), v.to_string()).unwrap();
        assert_eq!(read_seal_pub(data.path()), None, "nothing published yet");
        let key = "5Ec5QnD0sQ9uBoVlP_2KylUbM1G8F7mN3cVxO4eTq1A";
        put(serde_json::json!({ "v": 1, "seal": key }));
        assert_eq!(read_seal_pub(data.path()).as_deref(), Some(key));
        for bad in ["", "short", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "5Ec5QnD0sQ9uBoVlP+2KylUbM1G8F7mN3cVxO4eTq1A", "5Ec5QnD0sQ9uBoVlP_2KylUbM1G8F7mN3cVxO4eTq1AB"] {
            put(serde_json::json!({ "v": 1, "seal": bad }));
            assert_eq!(read_seal_pub(data.path()), None, "{bad:?} is not a key");
        }
        std::fs::write(seal_pub_file(data.path()), "not json").unwrap();
        assert_eq!(read_seal_pub(data.path()), None);
    }
}
