//! The supervisor's account of itself, written for the API (FR-20.98, plan step P3-8b): a master's
//! own status page reads it, offline above all, when nothing of it reaches lgrai.app.
//!
//! - Every 30 s, whether the uplink is up or not, and atomically (a temporary file, then a rename):
//!   the account `lgr-server status` gives, with the data volume's space and the oplog's reach
//!   beside it, and when it was written (a page that finds it old says the supervisor is not
//!   writing).
//! - Nothing secret is in it: the front's secrets and the node key are never in the supervisor's
//!   status. The API still shows an org's admin only what concerns that org.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;

use crate::mongod::OplogWindow;
use crate::supervisor::Supervisor;
use crate::uplink::now_iso;

pub const EVERY: Duration = Duration::from_secs(30);

/// Write `state/status.json` every `every`, for as long as the supervisor runs.
pub async fn run(sup: Arc<Supervisor>, file: PathBuf, data: PathBuf, oplog: Option<Arc<OplogWindow>>, every: Duration) {
    let mut failing = false;
    loop {
        let oplog_window_secs = match &oplog {
            Some(o) => o.secs().await,
            None => None,
        };
        let status = account(sup.status(), crate::preflight::disk_space(&data), oplog_window_secs);
        match write(&file, &status) {
            Ok(()) => failing = false,
            // Once, not every half minute: a reader holding the file a moment is no news.
            Err(e) if !failing => {
                failing = true;
                tracing::warn!(error = %format!("{e:#}"), file = %file.display(), "the status file was not written: the status page shows the last one");
            }
            Err(_) => {}
        }
        tokio::time::sleep(every).await;
    }
}

/// The supervisor's status, with the machine's facts beside it.
pub fn account(mut status: serde_json::Value, disk: Option<(u64, u64)>, oplog_window_secs: Option<u64>) -> serde_json::Value {
    status["disk"] = serde_json::json!({ "freeBytes": disk.map(|d| d.0), "totalBytes": disk.map(|d| d.1) });
    status["oplogWindowSecs"] = oplog_window_secs.into();
    status["writtenAt"] = now_iso().into();
    status
}

/// Whole or not at all: the API never reads half a file.
pub fn write(file: &Path, v: &serde_json::Value) -> Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(v)?)?;
    std::fs::rename(&tmp, file)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_account_carries_the_machine_and_is_written_whole() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state").join("status.json");
        let v = account(serde_json::json!({ "service": "lgr-server", "version": "1.2.3", "uplink": { "bulk": { "state": "connected" } } }), Some((10, 100)), None);
        write(&file, &v).unwrap();
        let back: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(back["version"], "1.2.3");
        assert_eq!(back["uplink"]["bulk"]["state"], "connected");
        assert_eq!((back["disk"]["freeBytes"].as_u64(), back["disk"]["totalBytes"].as_u64()), (Some(10), Some(100)));
        assert!(back["oplogWindowSecs"].is_null());
        assert!(back["writtenAt"].as_str().is_some_and(|w| w.starts_with("20")));
        // Written again over itself, and no temporary file left behind.
        write(&file, &account(serde_json::json!({ "version": "1.2.4" }), None, Some(9))).unwrap();
        let again: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!((again["version"].as_str(), again["oplogWindowSecs"].as_u64()), (Some("1.2.4"), Some(9)));
        assert!(!file.with_extension("json.tmp").exists());
    }
}
