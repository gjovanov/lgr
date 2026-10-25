//! A node access token for the API (FR-20.86, plan step P2-6): the outbox worker presents it to
//! global's relay, through the egress proxy, to send the mail this master queued.
//!
//! The supervisor holds the node key (DPAPI at machine scope, or `0600`) and never hands it out. It
//! hands out a token instead: 15 minutes long, refreshed every 10 minutes while the master is
//! registered, in `state/node-token.json` (`LGR_NODE_TOKEN_FILE`). Unregistered, there is no file.
//! A token lets the API act as this master on `/api/node/v1/*` and on nothing else.

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
    let (token, expires_in) = register::fetch_token_expiring(&reg.server, &reg.node_id, &key, &registrar.client).await?;
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
}
