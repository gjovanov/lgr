//! This master's licences (FR-20.55, plan step P2-3b): one per org, in `<data>/state/licences/`, as
//! global sends them over the uplink or an operator imports one (`lgr-server licence import <file>`,
//! for an air-gapped master).
//!
//! A licence is a JWS (EdDSA) that global signs. It is verified here, against the public keys built
//! into this release (`config/src/licence-keys.json`, which the API reads too), before it is kept:
//! - it must name **this master**, and its org id becomes the file's name only once verified;
//! - a newer licence (by `iat`) replaces an older one, never the reverse: a replayed old licence
//!   cannot shorten or lengthen what is held.
//!
//! ⚠ What is kept here is not trusted for being here. The API verifies each file again whenever it
//! changes, and it is the API that restricts a till (`master-licence.service.ts`); this check is
//! for the operator, who learns at import that a file is wrong, and for global's bugs.

use anyhow::{anyhow, bail, Result};
use base64::Engine;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const KEYS: &str = include_str!("../../config/src/licence-keys.json");
const MAX_JWS: usize = 8192;
const TYPE: &str = "lgr-licence+jws";
/// An Ed25519 SubjectPublicKeyInfo is these 12 bytes and the 32-byte key.
const SPKI_PREFIX: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
const B64URL: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// One writer at a time: the uplink and an import must not race their check and their rename.
static WRITING: Mutex<()> = Mutex::new(());

pub fn dir(data: &Path) -> PathBuf {
    data.join("state").join("licences")
}

/// What a licence says.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Licence {
    pub org_id: String,
    pub org: String,
    pub node: String,
    pub plan: String,
    pub paid_through: String,
    pub grace_days: i64,
    pub iat: i64,
}

/// What keeping one did.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kept {
    pub licence: Licence,
    /// False when the same licence was there already.
    pub changed: bool,
}

/// A key's id: the first 16 characters of the base64url SHA-256 of its SPKI DER, as the API computes it.
fn kid_of(der: &[u8]) -> String {
    B64URL.encode(ring::digest::digest(&ring::digest::SHA256, der).as_ref())[..16].to_string()
}

/// The keys built into this release: `(kid, raw Ed25519 public key)`.
pub fn built_in_keys() -> Vec<(String, Vec<u8>)> {
    let file: serde_json::Value = serde_json::from_str(KEYS).expect("licence-keys.json is JSON");
    file["keys"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|k| {
            let der = base64::engine::general_purpose::STANDARD.decode(k["spki"].as_str()?).ok()?;
            (der.len() == 44 && der[..12] == SPKI_PREFIX).then(|| (kid_of(&der), der[12..].to_vec()))
        })
        .collect()
}

fn hex24(s: &str) -> bool {
    s.len() == 24 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn node_id(s: &str) -> bool {
    s.strip_prefix("master-").is_some_and(|t| t.len() == 16 && t.bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b)))
}

/// Verify `jws` against `keys`: the type, a known key, the signature, and only then the claims.
pub fn verify_with(jws: &str, keys: &[(String, Vec<u8>)]) -> Result<Licence> {
    let jws = jws.trim();
    if jws.len() > MAX_JWS {
        bail!("not a licence: it is too long");
    }
    let parts: Vec<&str> = jws.split('.').collect();
    if parts.len() != 3 {
        bail!("not a licence: a licence is three parts joined by dots");
    }
    let header: serde_json::Value = B64URL.decode(parts[0]).ok().and_then(|b| serde_json::from_slice(&b).ok()).ok_or_else(|| anyhow!("not a licence: its header does not read"))?;
    if header["alg"] != "EdDSA" || header["typ"] != TYPE {
        bail!("not an LGR licence");
    }
    let kid = header["kid"].as_str().unwrap_or_default();
    let Some((_, key)) = keys.iter().find(|(k, _)| k == kid) else {
        bail!("signed with a key this release does not know (key {kid}): it was not issued by lgrai.app, or it needs a newer release");
    };
    let signature = B64URL.decode(parts[2]).map_err(|_| anyhow!("not a licence: its signature does not read"))?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
        .map_err(|_| anyhow!("the licence's signature does not verify: it was altered, or not issued by lgrai.app"))?;
    let c: serde_json::Value = B64URL.decode(parts[1]).ok().and_then(|b| serde_json::from_slice(&b).ok()).ok_or_else(|| anyhow!("the licence's claims do not read"))?;
    let text = |k: &str| c[k].as_str().unwrap_or_default().to_string();
    let licence = Licence {
        org_id: text("sub"),
        org: text("org"),
        node: text("node"),
        plan: text("plan"),
        paid_through: text("paidThrough"),
        grace_days: c["graceDays"].as_i64().unwrap_or(-1),
        iat: c["iat"].as_i64().unwrap_or(0),
    };
    if c["v"] != 1 || !hex24(&licence.org_id) || !node_id(&licence.node) || !["enterprise", "pilot"].contains(&licence.plan.as_str())
        || licence.paid_through.is_empty() || !(0..=366).contains(&licence.grace_days) || licence.iat <= 0
    {
        bail!("the licence's claims are not ones this release understands");
    }
    Ok(licence)
}

/// Keep `jws` for this master (`this_node`), verified with the built-in keys.
pub fn keep(data: &Path, jws: &str, this_node: &str) -> Result<Kept> {
    keep_with(data, jws, this_node, &built_in_keys())
}

pub fn keep_with(data: &Path, jws: &str, this_node: &str, keys: &[(String, Vec<u8>)]) -> Result<Kept> {
    let licence = verify_with(jws, keys)?;
    if licence.node != this_node {
        bail!("this licence is for {}; this server is {this_node}", licence.node);
    }
    let _one = WRITING.lock().unwrap_or_else(|p| p.into_inner());
    let dir = dir(data);
    let file = dir.join(format!("{}.jws", licence.org_id));
    let jws = jws.trim();
    if let Ok(held) = std::fs::read_to_string(&file) {
        if held.trim() == jws {
            return Ok(Kept { licence, changed: false });
        }
        if let Ok(old) = verify_with(&held, keys) {
            if old.iat > licence.iat {
                bail!("an older licence than the one held (issued at {} against {}): kept the newer", licence.iat, old.iat);
            }
        }
    }
    crate::config::write_durable(&file, jws.as_bytes(), 0o644)?;
    Ok(Kept { licence, changed: true })
}

/// What `lgr-server status` shows: every licence held, or why a file is not one.
pub fn list(data: &Path) -> serde_json::Value {
    let keys = built_in_keys();
    let mut out = vec![];
    for entry in std::fs::read_dir(dir(data)).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(org) = name.strip_suffix(".jws") else { continue };
        let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
        out.push(match verify_with(&text, &keys) {
            Ok(l) if l.org_id == org => serde_json::to_value(&l).unwrap_or_default(),
            Ok(_) => serde_json::json!({ "orgId": org, "error": "the file is named for another org" }),
            Err(e) => serde_json::json!({ "orgId": org, "error": format!("{e:#}") }),
        });
    }
    serde_json::Value::Array(out)
}

#[cfg(test)]
pub(crate) mod testkit {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    /// A key of the tests' own, and the signer that goes with it.
    pub struct Signer {
        pair: Ed25519KeyPair,
        pub kid: String,
    }

    impl Signer {
        pub fn new() -> Self {
            let pkcs8 = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
            let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
            let mut der = SPKI_PREFIX.to_vec();
            der.extend_from_slice(pair.public_key().as_ref());
            Self { kid: kid_of(&der), pair }
        }

        pub fn keys(&self) -> Vec<(String, Vec<u8>)> {
            vec![(self.kid.clone(), self.pair.public_key().as_ref().to_vec())]
        }

        pub fn sign(&self, claims: serde_json::Value) -> String {
            let h = B64URL.encode(serde_json::json!({ "alg": "EdDSA", "typ": TYPE, "kid": self.kid }).to_string());
            let p = B64URL.encode(claims.to_string());
            let s = B64URL.encode(self.pair.sign(format!("{h}.{p}").as_bytes()).as_ref());
            format!("{h}.{p}.{s}")
        }
    }

    pub fn claims(org: &str, node: &str, iat: i64) -> serde_json::Value {
        serde_json::json!({ "v": 1, "sub": org, "org": "acme-corp", "orgName": "Acme", "node": node, "plan": "pilot", "paidThrough": "2026-12-31T23:59:59.999Z", "graceDays": 30, "iat": iat, "jti": "j" })
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::*;
    use super::*;

    const ORG: &str = "0123456789abcdef01234567";
    const NODE: &str = "master-abcdefghijklmnop";

    #[test]
    fn the_built_in_key_reads_and_has_the_id_the_api_gives_it() {
        let keys = built_in_keys();
        assert!(!keys.is_empty());
        // The same derivation as licence-token.ts#kidOf, computed there for this key.
        assert_eq!(keys[0].0, "XJ8Nns0gqH9HSjOZ");
        assert_eq!(keys[0].1.len(), 32);
    }

    #[test]
    fn only_a_signature_by_a_known_key_on_well_formed_claims_verifies() {
        let s = Signer::new();
        let jws = s.sign(claims(ORG, NODE, 100));
        let l = verify_with(&jws, &s.keys()).unwrap();
        assert_eq!((l.org_id.as_str(), l.node.as_str(), l.plan.as_str(), l.iat), (ORG, NODE, "pilot", 100));
        // Another key's licence, a tampered payload, a wrong type, junk.
        assert!(verify_with(&jws, &Signer::new().keys()).unwrap_err().to_string().contains("does not know"));
        assert!(verify_with(&jws, &built_in_keys()).is_err(), "a test key is never a built-in one");
        let parts: Vec<&str> = jws.split('.').collect();
        let forged = format!("{}.{}.{}", parts[0], B64URL.encode(claims(ORG, NODE, 999).to_string()), parts[2]);
        assert!(verify_with(&forged, &s.keys()).unwrap_err().to_string().contains("does not verify"));
        assert!(verify_with("a.b", &s.keys()).is_err());
        assert!(verify_with(&s.sign(serde_json::json!({ "v": 1, "sub": "../../etc", "node": NODE })), &s.keys()).unwrap_err().to_string().contains("claims"));
    }

    #[test]
    fn a_licence_is_kept_for_this_master_only_and_never_replaced_by_an_older_one() {
        let s = Signer::new();
        let data = tempfile::tempdir().unwrap();
        let kept = keep_with(data.path(), &s.sign(claims(ORG, NODE, 200)), NODE, &s.keys()).unwrap();
        assert!(kept.changed);
        assert!(dir(data.path()).join(format!("{ORG}.jws")).exists());
        // The same again changes nothing; an older one is refused; a newer one replaces it.
        assert!(!keep_with(data.path(), &std::fs::read_to_string(dir(data.path()).join(format!("{ORG}.jws"))).unwrap(), NODE, &s.keys()).unwrap().changed);
        assert!(keep_with(data.path(), &s.sign(claims(ORG, NODE, 100)), NODE, &s.keys()).unwrap_err().to_string().contains("older"));
        assert!(keep_with(data.path(), &s.sign(claims(ORG, NODE, 300)), NODE, &s.keys()).unwrap().changed);
        // Another master's licence is never kept here.
        let err = keep_with(data.path(), &s.sign(claims(ORG, "master-zzzzzzzzzzzzzzzz", 400)), NODE, &s.keys()).unwrap_err();
        assert!(err.to_string().contains("this server is"), "{err}");
        // No temporary file is left behind.
        let names: Vec<String> = std::fs::read_dir(dir(data.path())).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec![format!("{ORG}.jws")]);
    }

    #[test]
    fn the_status_lists_what_is_held_and_says_what_is_wrong() {
        let data = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir(data.path())).unwrap();
        std::fs::write(dir(data.path()).join(format!("{ORG}.jws")), "not.a.licence").unwrap();
        let listed = list(data.path());
        assert_eq!(listed[0]["orgId"], ORG);
        assert!(listed[0]["error"].is_string());
    }
}
