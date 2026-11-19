//! The master registers with global (FR-20.2, plan step P2-1b): an org admin minted a code on
//! lgrai.app's Servers page, and `lgr-server register --code …` redeems it. A field lane's throwaway
//! master registers with a reusable enrollment key instead (`--key`, plan step T-4). Global takes a
//! key only where the org turned such keys on, and the server it registers is ephemeral: removed
//! after 24 h without contact.
//!
//! What it sends: the code or the key, this master's own node id (`state/node.json`), its
//! installation id (`state/installation.json`, random, made once), its node key's public half, and
//! a `proof` signed by that key. Then it proves the registration works: a token for a signed
//! assertion, and global's account of the node (`/api/node/v1/self`), which is what
//! `state/registration.json` keeps and the status shows.
//!
//! ⚠ It runs inside the service, never in the operator's shell: the key in `keys/` opens for the
//! service alone (DPAPI on Windows, root's `0600` file elsewhere). The command only passes the code
//! or the key. Neither is ever printed or written: each travels as a `Secret`, whose `Debug` is
//! `<redacted>`, and nothing keeps it after the enroll request.

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
    pub credential: Credential,
    pub link_level: String,
    pub name: String,
}

/// A registration code or an enrollment key: what lets this master in. Serde carries it as the plain
/// string (the control channel's line, the enroll body), and `Debug` never prints it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The value, for the one place that sends it (the enroll body).
    fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

/// Where a lane may put the enrollment key instead of `--key`, so it stays out of the process list.
pub const ENROLLMENT_KEY_ENV: &str = "LGR_ENROLLMENT_KEY";

/// The longest enrollment key global takes (`node-v1.controller.ts`). A minted one is 43 characters.
const MAX_KEY_CHARS: usize = 128;

/// How this master proves that an org admin let it register (FR-20.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Credential {
    /// The single-use code from the org's Servers page.
    Code(Secret),
    /// A reusable enrollment key (plan step T-4): the field lanes' throwaway masters. Global takes it
    /// only where the org turned such keys on, and the server it registers is ephemeral.
    Key(Secret),
}

impl Credential {
    /// What the operator gave: `--code`, `--key`, or the key in `LGR_ENROLLMENT_KEY` when neither
    /// flag is given (`env_key`). A flag's key wins over the variable's.
    ///
    /// ⚠ A code while the variable holds a key is refused rather than decided between: the two
    /// register different servers (a shop's permanent one, a lane's ephemeral one).
    pub fn from_cli(code: Option<String>, key: Option<String>, env_key: Option<String>) -> Result<Self> {
        let env_key = env_key.filter(|k| !k.trim().is_empty());
        let credential = match (code, key) {
            (Some(_), Some(_)) => bail!("give a registration code (--code) or an enrollment key (--key), not both"),
            (Some(_), None) if env_key.is_some() => {
                bail!("{ENROLLMENT_KEY_ENV} holds an enrollment key: unset it to register with a code")
            }
            (Some(code), None) => Self::Code(Secret::new(code)),
            (None, Some(key)) => Self::Key(Secret::new(key)),
            (None, None) => match env_key {
                Some(key) => Self::Key(Secret::new(key)),
                None => bail!(
                    "give the registration code from the org's Servers page (--code), or an enrollment key (--key or {ENROLLMENT_KEY_ENV})"
                ),
            },
        };
        credential.check()?;
        Ok(credential)
    }

    /// The control channel's two fields, as the service receives them: exactly one is given.
    pub fn from_parts(code: Option<Secret>, key: Option<Secret>) -> Result<Self> {
        let credential = match (code, key) {
            (Some(code), None) => Self::Code(code),
            (None, Some(key)) => Self::Key(key),
            (Some(_), Some(_)) => bail!("a registration takes a code or an enrollment key, not both"),
            (None, None) => bail!("a registration needs a code or an enrollment key"),
        };
        credential.check()?;
        Ok(credential)
    }

    /// The other way, for the control channel: `(code, enrollmentKey)`.
    pub fn into_parts(self) -> (Option<Secret>, Option<Secret>) {
        match self {
            Self::Code(code) => (Some(code), None),
            Self::Key(key) => (None, Some(key)),
        }
    }

    /// What it is, for the log and the messages: never its value.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Code(_) => "registration code",
            Self::Key(_) => "enrollment key",
        }
    }

    /// Refused before anything is sent: an empty one, and a key longer than global takes. No message
    /// names the value.
    fn check(&self) -> Result<()> {
        let (_, value) = self.body_field();
        if value.is_empty() {
            bail!("the {} is empty", self.kind());
        }
        let chars = value.chars().count();
        if matches!(self, Self::Key(_)) && chars > MAX_KEY_CHARS {
            bail!("an enrollment key is at most {MAX_KEY_CHARS} characters; this one has {chars}");
        }
        Ok(())
    }

    /// The enroll body's field for it, and its value trimmed (a pasted code often carries a newline).
    fn body_field(&self) -> (&'static str, &str) {
        match self {
            Self::Code(code) => ("code", code.expose().trim()),
            Self::Key(key) => ("enrollmentKey", key.expose().trim()),
        }
    }
}

/// The enroll request (`POST /api/node/v1/enroll`): the credential under its own field, never one in
/// the other's place, and everything else as for any master.
fn enroll_body(credential: &Credential, node_id: &str, installation_id: &str, name: &str, public_key: &str, proof: &str, link_level: &str) -> serde_json::Value {
    let (field, value) = credential.body_field();
    let mut body = serde_json::json!({
        "nodeId": node_id,
        "installationId": installation_id,
        "name": name,
        "publicKey": public_key,
        "proof": proof,
        "linkLevel": link_level,
        "os": { "platform": std::env::consts::OS, "arch": std::env::consts::ARCH },
        "versions": { "app": env!("CARGO_PKG_VERSION"), "protocol": 1 },
    });
    body[field] = serde_json::Value::String(value.to_string());
    body
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
    ask.credential.check()?;
    let node_id = crate::front::node_id(data)?;
    let installation_id = installation_id(data)?;
    let key = NodeKey::load_or_create(data)?;

    let enroll_url = format!("{server}/api/node/v1/enroll");
    let proof = key.assertion(&node_id, &enroll_url, now());
    let body = enroll_body(&ask.credential, &node_id, &installation_id, &ask.name, &key.public_spki_b64(), &proof, &ask.link_level);
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
    crate::config::write_private(&registration_file(data), &serde_json::to_string_pretty(&registration)?)?;
    tracing::info!(server = %registration.server, orgs = registration.orgs.len(), credential = ask.credential.kind(), "registered with global");
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

    #[test]
    fn a_code_or_a_key_never_prints() {
        let code = Credential::Code(Secret::new("ABCD-EFGH"));
        let key = Credential::Key(Secret::new("k3y-s3cr3t-value"));
        for (credential, secret) in [(&code, "ABCD-EFGH"), (&key, "k3y-s3cr3t-value")] {
            let ask = Ask { server: DEFAULT_SERVER.into(), credential: credential.clone(), link_level: "control".into(), name: "Shop".into() };
            let shown = format!("{credential:?} {ask:?} {:?}", credential.clone().into_parts());
            assert!(!shown.contains(secret), "{shown}");
            assert!(shown.contains("<redacted>"), "{shown}");
        }
    }

    #[test]
    fn the_body_carries_the_credential_under_its_own_field() {
        let body = |c: &Credential| enroll_body(c, "master-abcdefghijklmnop", "0123456789abcdef", "Shop", "pk", "proof", "control");
        let by_code = body(&Credential::Code(Secret::new(" ABCD-EFGH\n")));
        assert_eq!(by_code["code"], "ABCD-EFGH");
        assert!(by_code.get("enrollmentKey").is_none());
        let by_key = body(&Credential::Key(Secret::new("k3y-s3cr3t-value\n")));
        assert_eq!(by_key["enrollmentKey"], "k3y-s3cr3t-value");
        assert!(by_key.get("code").is_none());
        // Everything else is the same for both.
        for b in [&by_code, &by_key] {
            assert_eq!(b["nodeId"], "master-abcdefghijklmnop");
            assert_eq!(b["installationId"], "0123456789abcdef");
            assert_eq!(b["name"], "Shop");
            assert_eq!(b["publicKey"], "pk");
            assert_eq!(b["proof"], "proof");
            assert_eq!(b["linkLevel"], "control");
            assert_eq!(b["versions"]["protocol"], 1);
        }
    }

    #[test]
    fn the_command_takes_a_code_or_a_key() {
        let s = |v: &str| Some(v.to_string());
        assert_eq!(Credential::from_cli(s("ABCD-EFGH"), None, None).unwrap(), Credential::Code(Secret::new("ABCD-EFGH")));
        assert_eq!(Credential::from_cli(None, s("flag-key"), None).unwrap(), Credential::Key(Secret::new("flag-key")));
        // The variable stands in for --key, and the flag wins over it.
        assert_eq!(Credential::from_cli(None, None, s("env-key")).unwrap(), Credential::Key(Secret::new("env-key")));
        assert_eq!(Credential::from_cli(None, s("flag-key"), s("env-key")).unwrap(), Credential::Key(Secret::new("flag-key")));
        // Refused: both flags, a code while the variable holds a key, nothing at all, an empty one.
        assert!(Credential::from_cli(s("ABCD-EFGH"), s("flag-key"), None).is_err());
        assert!(Credential::from_cli(s("ABCD-EFGH"), None, s("env-key")).is_err());
        assert!(Credential::from_cli(None, None, None).is_err());
        assert!(Credential::from_cli(None, None, s(" \n")).is_err());
        assert!(Credential::from_cli(s(" "), None, None).is_err());
        assert!(Credential::from_cli(None, s(""), None).is_err());
        // A key global would not take is refused here, and the refusal does not repeat it.
        let long = "k".repeat(MAX_KEY_CHARS + 1);
        let refusal = Credential::from_cli(None, Some(long.clone()), None).unwrap_err().to_string();
        assert!(!refusal.contains(&long), "{refusal}");
        assert!(Credential::from_cli(None, Some("k".repeat(MAX_KEY_CHARS)), None).is_ok());
        // An empty variable is no key.
        assert!(Credential::from_cli(s("ABCD-EFGH"), None, s("")).is_ok());
    }

    #[test]
    fn the_control_channel_carries_exactly_one() {
        let code = Some(Secret::new("ABCD-EFGH"));
        let key = Some(Secret::new("k3y-s3cr3t-value"));
        assert_eq!(Credential::from_parts(code.clone(), None).unwrap().into_parts(), (code.clone(), None));
        assert_eq!(Credential::from_parts(None, key.clone()).unwrap().into_parts(), (None, key.clone()));
        assert!(Credential::from_parts(code, key).is_err());
        assert!(Credential::from_parts(None, None).is_err());
        assert!(Credential::from_parts(None, Some(Secret::new("  "))).is_err());
    }
}
