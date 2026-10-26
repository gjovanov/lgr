//! FR-20.82 (plan step P3-6b): an org that moved to its master takes its desktops with it.
//!
//! lgrai.app sends each of the org's desktops a **re-point** on `/ws/desktop`: an EdDSA JWS (typ
//! `lgr-repoint+jws`) naming this desktop, its org, the master, the move's epoch, where the master
//! answers on the shop's LAN and the pin of its CA. This module decides whether to believe it.
//!
//! ⚠ **Only the keys built into this binary** (`config/src/repoint-keys.json`) are trusted. That is
//! the whole point of the signature: this desktop reaches lgrai.app through the machine's trust
//! store, so a TLS-inspecting middlebox it trusts could otherwise hand it a server of its own,
//! which this desktop would then pin and send its tills' traffic to.
//!
//! What it checks, in this order: the shape, the type, a known key, the signature, and only then the
//! claims: this desktop and its org, a master id, an epoch above the last one followed (a replayed
//! instruction cannot send it back), a LAN address a pin may apply to (`trust::may_pin`), a pin in
//! the shape `trust` computes, and the dates (a till's clock may be a day out either way).

use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

const KEYS: &str = include_str!("../../../config/src/repoint-keys.json");
pub const TYPE: &str = "lgr-repoint+jws";
const MAX_JWS: usize = 8192;
/// An Ed25519 SubjectPublicKeyInfo is these 12 bytes and the 32-byte key.
const SPKI_PREFIX: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
/// How far ahead of this machine's clock an instruction may have been issued.
const ISSUED_AHEAD_SEC: i64 = 24 * 3600;
const B64URL: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// What a verified instruction says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repoint {
    pub org: String,
    pub node: String,
    pub epoch: i64,
    /// `https://<LAN host>[:port]`, where the master's LAN ingress answers.
    pub server: String,
    /// `sha256:<base64url>`, the pin of the master's LAN CA.
    pub fingerprint: String,
}

/// A key's id: the first 16 characters of the base64url SHA-256 of its SPKI DER, as global computes it.
fn kid_of(der: &[u8]) -> String {
    B64URL.encode(Sha256::digest(der))[..16].to_string()
}

/// `(kid, key)` for every Ed25519 key in a key file (`{"keys": [{"spki": base64 DER}]}`).
pub fn keys_from(file: &str) -> Vec<(String, VerifyingKey)> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(file) else { return vec![] };
    v["keys"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|k| {
            let der = base64::engine::general_purpose::STANDARD.decode(k["spki"].as_str()?).ok()?;
            if der.len() != 44 || der[..12] != SPKI_PREFIX {
                return None;
            }
            let raw: [u8; 32] = der[12..].try_into().ok()?;
            Some((kid_of(&der), VerifyingKey::from_bytes(&raw).ok()?))
        })
        .collect()
}

/// The keys built into this release.
pub fn built_in_keys() -> Vec<(String, VerifyingKey)> {
    keys_from(KEYS)
}

fn hex24(s: &str) -> bool {
    s.len() == 24 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn node_id(s: &str) -> bool {
    s.strip_prefix("master-").is_some_and(|t| t.len() == 16 && t.bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b)))
}

fn pin_shaped(s: &str) -> bool {
    s.strip_prefix("sha256:").is_some_and(|t| t.len() == 43 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
}

/// Only an origin: `https`, a host, maybe a port; no path, query, or credentials.
fn bare_origin(server: &str) -> bool {
    url::Url::parse(server).is_ok_and(|u| {
        u.scheme() == "https" && u.username().is_empty() && u.password().is_none() && u.path() == "/" && u.query().is_none() && u.fragment().is_none()
            && !server.ends_with('/')
    })
}

/// Believe `jws` for this desktop (`desktop_id`, `org_id`), against `keys`, if its epoch is above
/// `last_epoch`. Returns why not as a stable code.
pub fn verify_with(jws: &str, keys: &[(String, VerifyingKey)], desktop_id: &str, org_id: &str, last_epoch: i64, now_sec: i64) -> Result<Repoint, &'static str> {
    let jws = jws.trim();
    if jws.len() > MAX_JWS {
        return Err("malformed");
    }
    let parts: Vec<&str> = jws.split('.').collect();
    if parts.len() != 3 {
        return Err("malformed");
    }
    let header: serde_json::Value = B64URL.decode(parts[0]).ok().and_then(|b| serde_json::from_slice(&b).ok()).ok_or("malformed")?;
    if header["alg"] != "EdDSA" || header["typ"] != TYPE {
        return Err("malformed");
    }
    let kid = header["kid"].as_str().unwrap_or_default();
    let Some((_, key)) = keys.iter().find(|(k, _)| k == kid) else { return Err("unknown_key") };
    let sig = B64URL.decode(parts[2]).ok().and_then(|b| Signature::from_slice(&b).ok()).ok_or("bad_signature")?;
    key.verify_strict(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).map_err(|_| "bad_signature")?;

    let c: serde_json::Value = B64URL.decode(parts[1]).ok().and_then(|b| serde_json::from_slice(&b).ok()).ok_or("bad_claims")?;
    let text = |k: &str| c[k].as_str().unwrap_or_default().to_string();
    let r = Repoint { org: text("org"), node: text("node"), epoch: c["epoch"].as_i64().unwrap_or(0), server: text("server"), fingerprint: text("fp") };
    if c["v"] != 1 || c["iss"] != "lgrai.app" || !hex24(&text("sub")) || !hex24(&r.org) || !node_id(&r.node) || r.epoch <= 0
        || !bare_origin(&r.server) || !pin_shaped(&r.fingerprint)
    {
        return Err("bad_claims");
    }
    if text("sub") != desktop_id {
        return Err("not_this_desktop");
    }
    if r.org != org_id {
        return Err("not_this_org");
    }
    // ⚠ A pin may only be taken for a name no public CA can certify: the same rule a pairing keeps.
    if !crate::trust::may_pin(&r.server) {
        return Err("pin_not_allowed");
    }
    let (iat, exp) = (c["iat"].as_i64().unwrap_or(0), c["exp"].as_i64().unwrap_or(0));
    if exp <= now_sec - ISSUED_AHEAD_SEC || iat > now_sec + ISSUED_AHEAD_SEC {
        return Err("expired");
    }
    if r.epoch <= last_epoch {
        return Err("stale");
    }
    Ok(r)
}

/// `verify_with` against the keys built into this release.
pub fn verify(jws: &str, desktop_id: &str, org_id: &str, last_epoch: i64, now_sec: i64) -> Result<Repoint, &'static str> {
    verify_with(jws, &built_in_keys(), desktop_id, org_id, last_epoch, now_sec)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTOR: &str = include_str!("repoint-vector.json");

    fn vector() -> (serde_json::Value, Vec<(String, VerifyingKey)>) {
        let mut v: serde_json::Value = serde_json::from_str(VECTOR).unwrap();
        // Stored as its three parts, so no scanner takes the file for a leaked token.
        let jws = v["jwsParts"].as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect::<Vec<_>>().join(".");
        v["jws"] = jws.into();
        let keys = keys_from(&serde_json::json!({ "keys": [{ "spki": v["spki"] }] }).to_string());
        (v, keys)
    }

    #[test]
    fn the_built_in_keys_parse() {
        assert!(!built_in_keys().is_empty(), "repoint-keys.json names no key this build can use");
    }

    #[test]
    fn an_instruction_global_signed_is_believed_for_this_desktop_and_its_org() {
        let (v, keys) = vector();
        let now = v["nowSec"].as_i64().unwrap();
        let got = verify_with(v["jws"].as_str().unwrap(), &keys, v["desktopId"].as_str().unwrap(), v["orgId"].as_str().unwrap(), 0, now).unwrap();
        assert_eq!(
            got,
            Repoint {
                org: v["orgId"].as_str().unwrap().into(),
                node: "master-repointtestaaaaa".into(),
                epoch: 3,
                server: "https://192.168.8.115:4443".into(),
                fingerprint: v["claims"]["fp"].as_str().unwrap().into(),
            }
        );
    }

    #[test]
    fn anything_else_is_refused_with_its_reason() {
        let (v, keys) = vector();
        let (jws, d, o, now) = (v["jws"].as_str().unwrap(), v["desktopId"].as_str().unwrap(), v["orgId"].as_str().unwrap(), v["nowSec"].as_i64().unwrap());
        // Another desktop, another org, an epoch already followed.
        assert_eq!(verify_with(jws, &keys, "6adfc8812f1f3960552daa99", o, 0, now), Err("not_this_desktop"));
        assert_eq!(verify_with(jws, &keys, d, "6adfc8812f1f3960552daa99", 0, now), Err("not_this_org"));
        assert_eq!(verify_with(jws, &keys, d, o, 3, now), Err("stale"));
        // A key this build does not know: the built-in ones never signed the vector.
        assert_eq!(verify_with(jws, &built_in_keys(), d, o, 0, now), Err("unknown_key"));
        // Altered on the way: another server under the same signature.
        let parts: Vec<&str> = jws.split('.').collect();
        let mut claims: serde_json::Value = serde_json::from_slice(&B64URL.decode(parts[1]).unwrap()).unwrap();
        claims["server"] = "https://10.6.6.6:4443".into();
        let forged = format!("{}.{}.{}", parts[0], B64URL.encode(claims.to_string()), parts[2]);
        assert_eq!(verify_with(&forged, &keys, d, o, 0, now), Err("bad_signature"));
        // Another type: a licence or an identity assertion never passes for a re-point.
        let mut header: serde_json::Value = serde_json::from_slice(&B64URL.decode(parts[0]).unwrap()).unwrap();
        header["typ"] = "lgr-idp+jws".into();
        assert_eq!(verify_with(&format!("{}.{}.{}", B64URL.encode(header.to_string()), parts[1], parts[2]), &keys, d, o, 0, now), Err("malformed"));
        // Long expired, or issued far in this machine's future.
        assert_eq!(verify_with(jws, &keys, d, o, 0, now + 40 * 24 * 3600), Err("expired"));
        assert_eq!(verify_with(jws, &keys, d, o, 0, now - 3 * 24 * 3600), Err("expired"));
        assert_eq!(verify_with("a.b", &keys, d, o, 0, now), Err("malformed"));
    }

    #[test]
    fn only_a_bare_lan_origin_and_a_well_formed_pin_are_claims() {
        assert!(bare_origin("https://192.168.8.115:4443") && bare_origin("https://kasa.local"));
        for s in ["http://192.168.8.115", "https://192.168.8.115/x", "https://u:p@192.168.8.115", "https://192.168.8.115/", "https://192.168.8.115?a=1"] {
            assert!(!bare_origin(s), "{s}");
        }
        assert!(pin_shaped("sha256:J4_Wvnqz8vXcWsR1nM0aB2cD3eF4gH5iJ6kL7mN8oP9"));
        assert!(!pin_shaped("sha256:short") && !pin_shaped("md5:J4_Wvnqz8vXcWsR1nM0aB2cD3eF4gH5iJ6kL7mN8oP9"));
        // A public name is never pinned, signed or not.
        assert!(!crate::trust::may_pin("https://lgrai.app"));
    }
}
