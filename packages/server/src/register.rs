//! The master registers with global (FR-20.2, plan step P2-1b): an org admin minted a code on
//! lgrai.app's Servers page, and `lgr-server register --code …` redeems it.
//!
//! What it sends: the code, this master's own node id (`state/node.json`), its installation id
//! (`state/installation.json`, random, made once), its node key's public half, and a `proof`
//! signed by that key. Then it proves the registration works: a token for a signed assertion,
//! and global's account of the node (`/api/node/v1/self`), which is what `state/registration.json`
//! keeps and the status shows.
//!
//! ⚠ It runs inside the service, never in the operator's shell: the key in `keys/` opens for the
//! service alone (DPAPI on Windows, root's `0600` file elsewhere). The command only passes the code.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::https::Https;
use crate::node_key::NodeKey;

/// lgrai.app. A test global or a throwaway one (global-eph) is named with `--server`.
pub const DEFAULT_SERVER: &str = "https://lgrai.app";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    pub server: String,
    pub node_id: String,
    pub link_level: String,
    /// What global answered for `/self`: the orgs this master may act for, by id, slug and name.
    pub orgs: Vec<serde_json::Value>,
    pub registered_at: i64,
}

/// What the operator asked for.
#[derive(Debug, Clone)]
pub struct Ask {
    pub server: String,
    pub code: String,
    pub link_level: String,
    pub name: String,
}

pub fn registration_file(data: &Path) -> PathBuf {
    data.join("state").join("registration.json")
}

/// The registration on record, when this master has one.
pub fn current(data: &Path) -> Option<Registration> {
    serde_json::from_str(&std::fs::read_to_string(registration_file(data)).ok()?).ok()
}

/// Random, made at the first registration and kept: the registry refuses a second ACTIVE node with
/// the same one (a cloned disk), so it must never be derived from the machine.
pub fn installation_id(data: &Path) -> Result<String> {
    let file = data.join("state").join("installation.json");
    if let Ok(text) = std::fs::read_to_string(&file) {
        if let Some(id) = serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| v["installationId"].as_str().map(String::from)) {
            return Ok(id);
        }
        bail!("{} names no installation id", file.display());
    }
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    std::fs::create_dir_all(file.parent().expect("state/ has a parent"))?;
    crate::config::write_private(&file, &serde_json::json!({ "installationId": id }).to_string())?;
    Ok(id)
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Global's refusal in its own words: `code` and `message`, as every node route answers.
fn refusal(what: &str, status: u16, body: &serde_json::Value) -> anyhow::Error {
    let message = body["message"].as_str().unwrap_or("");
    let code = body["code"].as_str().unwrap_or("");
    anyhow::anyhow!("{what}: global answered {status}{}{}", if code.is_empty() { String::new() } else { format!(" {code}") }, if message.is_empty() { String::new() } else { format!(": {message}") })
}

/// Register, then prove it: a token, and global's account of this node.
pub async fn register(data: &Path, client: &Https, ask: &Ask) -> Result<Registration> {
    let server = ask.server.trim_end_matches('/').to_string();
    crate::https::split_url(&server).with_context(|| format!("--server {server}"))?;
    if !["control", "full"].contains(&ask.link_level.as_str()) {
        bail!("the link level is control or full (an Air-gapped master does not register), not {}", ask.link_level);
    }
    let node_id = crate::front::node_id(data)?;
    let installation_id = installation_id(data)?;
    let key = NodeKey::load_or_create(data)?;

    let enroll_url = format!("{server}/api/node/v1/enroll");
    let body = serde_json::json!({
        "code": ask.code.trim(),
        "nodeId": node_id,
        "installationId": installation_id,
        "name": ask.name,
        "publicKey": key.public_spki_b64(),
        "proof": key.assertion(&node_id, &enroll_url, now()),
        "linkLevel": ask.link_level,
        "os": { "platform": std::env::consts::OS, "arch": std::env::consts::ARCH },
        "versions": { "app": env!("CARGO_PKG_VERSION"), "protocol": 1 },
    });
    let (status, answer) = client.json("POST", &enroll_url, None, Some(&body)).await?;
    if status != 200 {
        return Err(refusal("the registration was refused", status, &answer));
    }

    let self_view = whoami(&server, &node_id, &key, client).await.context("registered, but the first token failed")?;
    let registration = Registration {
        server,
        node_id,
        link_level: self_view["linkLevel"].as_str().unwrap_or(&ask.link_level).to_string(),
        orgs: self_view["orgs"].as_array().cloned().unwrap_or_default(),
        registered_at: now(),
    };
    let file = registration_file(data);
    let tmp = file.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    crate::config::write_private(&tmp, &serde_json::to_string_pretty(&registration)?)?;
    std::fs::rename(&tmp, &file).with_context(|| format!("writing {}", file.display()))?;
    tracing::info!(server = %registration.server, orgs = registration.orgs.len(), "registered with global");
    Ok(registration)
}

/// A 15-minute node token for a fresh assertion: what `/self` and the uplink's `hello` carry.
pub async fn fetch_token(server: &str, node_id: &str, key: &NodeKey, client: &Https) -> Result<String> {
    Ok(fetch_token_expiring(server, node_id, key, client).await?.0)
}

/// The token and how many seconds it lives (`expiresIn`; 15 minutes when global does not say).
pub async fn fetch_token_expiring(server: &str, node_id: &str, key: &NodeKey, client: &Https) -> Result<(String, u64)> {
    fetch_token_sealed(server, node_id, key, client, None).await
}

/// The same, signing the API's seal key into the assertion (FR-20.40), which global then records.
pub async fn fetch_token_sealed(server: &str, node_id: &str, key: &NodeKey, client: &Https, seal: Option<&str>) -> Result<(String, u64)> {
    let token_url = format!("{server}/api/node/v1/token");
    let assertion = key.assertion_with(node_id, &token_url, now(), seal);
    let (status, token) = client.json("POST", &token_url, None, Some(&serde_json::json!({ "assertion": assertion }))).await?;
    if status != 200 {
        return Err(refusal("no token", status, &token));
    }
    let access = token["accessToken"].as_str().context("the token answer carries no token")?.to_string();
    Ok((access, token["expiresIn"].as_u64().unwrap_or(900)))
}

/// A token for a fresh assertion, then `/api/node/v1/self` with it.
pub async fn whoami(server: &str, node_id: &str, key: &NodeKey, client: &Https) -> Result<serde_json::Value> {
    let bearer = fetch_token(server, node_id, key, client).await?;
    let (status, me) = client.json("GET", &format!("{server}/api/node/v1/self"), Some(&bearer), None).await?;
    if status != 200 {
        return Err(refusal("global does not know this node", status, &me));
    }
    Ok(me)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_installation_id_is_made_once() {
        let dir = tempfile::tempdir().unwrap();
        let id = installation_id(dir.path()).unwrap();
        assert_eq!(id.len(), 32);
        assert_eq!(installation_id(dir.path()).unwrap(), id);
        std::fs::write(dir.path().join("state").join("installation.json"), "{}").unwrap();
        assert!(installation_id(dir.path()).is_err(), "a damaged file is a refusal, never a new id");
    }

    #[test]
    fn a_refusal_reads_as_globals_own_words() {
        let e = refusal("the registration was refused", 409, &serde_json::json!({ "code": "node_exists", "message": "Remove it first." }));
        assert_eq!(e.to_string(), "the registration was refused: global answered 409 node_exists: Remove it first.");
        assert_eq!(refusal("no token", 502, &serde_json::Value::Null).to_string(), "no token: global answered 502");
    }

    #[test]
    fn no_registration_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(current(dir.path()), None);
    }
}
