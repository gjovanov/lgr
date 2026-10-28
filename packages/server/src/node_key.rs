//! The master's Ed25519 node key (FR-20.2, plan step P2-1b): what it proves to global that it is
//! itself with, made once and never sent anywhere.
//!
//! Kept in `keys/node.key`:
//! - **Windows:** sealed with DPAPI at machine scope. The bytes on disk open on this machine only,
//!   by the service, whatever the file's ACL lets someone copy.
//! - **Linux and macOS:** a `0600` file, in a data directory only root can read. FR-20.2 asks for
//!   the System keychain on macOS. The macOS server waits on its signing identity (Q6) and on
//!   macOS this is the same `0600` file until then.
//!
//! ⚠ Never derived from the host name (cloned shop PCs share one), and never in a bundle or backup:
//! a new key means registering again, which an admin does from lgrai.app's Servers page.

use anyhow::{bail, Context, Result};
use base64::Engine;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use std::path::Path;

/// Ed25519's SPKI DER header: the 12 bytes before the 32-byte public key.
const ED25519_SPKI_PREFIX: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
/// What a node assertion may live: global refuses more (FR-14.20's 60 s).
pub const ASSERTION_LIFETIME_SECS: i64 = 60;

pub struct NodeKey {
    pair: Ed25519KeyPair,
}

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const B64URL: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

impl NodeKey {
    /// The key in `<data>/keys/node.key`, made there the first time.
    ///
    /// ⚠ A file that is there but does not open is a refusal, never a reason to make a new key: a
    /// new key would leave the master registered with one it no longer holds.
    pub fn load_or_create(data: &Path) -> Result<Self> {
        let file = data.join("keys").join("node.key");
        match std::fs::read_to_string(&file) {
            Ok(text) => {
                let stored: serde_json::Value = serde_json::from_str(&text).with_context(|| format!("{} is not a node key", file.display()))?;
                let sealed = B64.decode(stored["key"].as_str().unwrap_or_default()).with_context(|| format!("{} holds no key", file.display()))?;
                let pkcs8 = match stored["protection"].as_str() {
                    Some("dpapi-machine") => unseal(&sealed).with_context(|| format!("{} does not open on this machine", file.display()))?,
                    Some("file") => sealed,
                    other => bail!("{} is protected by {other:?}, which this build does not know", file.display()),
                };
                let pair = Ed25519KeyPair::from_pkcs8(&pkcs8).map_err(|e| anyhow::anyhow!("{} is not an Ed25519 key: {e}", file.display()))?;
                Ok(Self { pair })
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).map_err(|_| anyhow::anyhow!("no randomness for a node key"))?;
                let (protection, stored) = seal(pkcs8.as_ref())?;
                crate::config::write_private(&file, &serde_json::json!({ "v": 1, "protection": protection, "key": B64.encode(stored) }).to_string())?;
                let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).map_err(|e| anyhow::anyhow!("a fresh node key does not load: {e}"))?;
                tracing::info!(protection, "this master's node key was made");
                Ok(Self { pair })
            }
            Err(e) => Err(e).with_context(|| format!("reading {}", file.display())),
        }
    }

    /// The public half as global takes it: base64 SPKI DER, always 60 characters.
    pub fn public_spki_b64(&self) -> String {
        let mut der = ED25519_SPKI_PREFIX.to_vec();
        der.extend_from_slice(self.pair.public_key().as_ref());
        B64.encode(der)
    }

    /// A compact EdDSA JWS: `{sub, aud, iat, exp: iat + 60, jti}`, as `/api/node/v1/enroll` (its
    /// `proof`) and `/api/node/v1/token` take it.
    pub fn assertion(&self, sub: &str, aud: &str, now: i64) -> String {
        self.assertion_with(sub, aud, now, None)
    }

    /// The same, with this master's seal key as the `seal` claim (FR-20.40, plan step P2-4c): the
    /// node key vouches for the key global seals people's local credentials to. The API made it;
    /// this key only signs it, so a proxy that sees a node token cannot put its own in its place.
    pub fn assertion_with(&self, sub: &str, aud: &str, now: i64, seal: Option<&str>) -> String {
        use rand::RngCore;
        let mut jti = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut jti);
        let header = B64URL.encode(br#"{"alg":"EdDSA","typ":"JWT"}"#);
        let mut claims = serde_json::json!({
            "sub": sub,
            "aud": aud,
            "iat": now,
            "exp": now + ASSERTION_LIFETIME_SECS,
            "jti": jti.iter().map(|b| format!("{b:02x}")).collect::<String>(),
        });
        if let Some(seal) = seal {
            claims["seal"] = serde_json::Value::String(seal.to_string());
        }
        let payload = B64URL.encode(claims.to_string());
        let signature = self.pair.sign(format!("{header}.{payload}").as_bytes());
        format!("{header}.{payload}.{}", B64URL.encode(signature.as_ref()))
    }
}

#[cfg(windows)]
mod dpapi {
    use anyhow::{bail, Result};
    use windows_sys::Win32::Foundation::{LocalFree, HLOCAL};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    /// Bound into every blob, so a blob sealed for another purpose on this machine does not open as a key.
    const ENTROPY: &[u8] = b"lgr-server node key v1";

    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 }
    }

    fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: on success the API hands back `cbData` bytes it allocated with LocalAlloc.
        let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
        unsafe { LocalFree(out.pbData as HLOCAL) };
        v
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>> {
        let (input, entropy) = (blob(plain), blob(ENTROPY));
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: every pointer is to a live local for the duration of the call.
        let ok = unsafe {
            CryptProtectData(&input, std::ptr::null(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        if ok == 0 {
            bail!("DPAPI refused to seal the node key: {}", std::io::Error::last_os_error());
        }
        Ok(take(out))
    }

    pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>> {
        let (input, entropy) = (blob(sealed), blob(ENTROPY));
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: as above.
        let ok = unsafe {
            CryptUnprotectData(&input, std::ptr::null_mut(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        if ok == 0 {
            bail!("DPAPI refused to open it: {}", std::io::Error::last_os_error());
        }
        Ok(take(out))
    }
}

#[cfg(windows)]
fn seal(pkcs8: &[u8]) -> Result<(&'static str, Vec<u8>)> {
    Ok(("dpapi-machine", dpapi::protect(pkcs8)?))
}
#[cfg(windows)]
fn unseal(sealed: &[u8]) -> Result<Vec<u8>> {
    dpapi::unprotect(sealed)
}
#[cfg(not(windows))]
fn seal(pkcs8: &[u8]) -> Result<(&'static str, Vec<u8>)> {
    Ok(("file", pkcs8.to_vec()))
}
#[cfg(not(windows))]
fn unseal(_sealed: &[u8]) -> Result<Vec<u8>> {
    bail!("a DPAPI-sealed key opens only on the Windows machine that sealed it")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{UnparsedPublicKey, ED25519};

    #[test]
    fn the_key_is_made_once_and_opens_again() {
        let dir = tempfile::tempdir().unwrap();
        let made = NodeKey::load_or_create(dir.path()).unwrap();
        let again = NodeKey::load_or_create(dir.path()).unwrap();
        assert_eq!(made.public_spki_b64(), again.public_spki_b64());
        let spki = B64.decode(made.public_spki_b64()).unwrap();
        assert_eq!((made.public_spki_b64().len(), spki.len()), (60, 44));
        assert_eq!(&spki[..12], &ED25519_SPKI_PREFIX);

        let stored: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("keys").join("node.key")).unwrap()).unwrap();
        if cfg!(windows) {
            // Sealed: the bytes on disk are not the key.
            assert_eq!(stored["protection"], "dpapi-machine");
            let on_disk = B64.decode(stored["key"].as_str().unwrap()).unwrap();
            assert!(Ed25519KeyPair::from_pkcs8(&on_disk).is_err());
        } else {
            assert_eq!(stored["protection"], "file");
        }
    }

    #[test]
    fn a_key_that_does_not_open_is_a_refusal_never_a_new_key() {
        let dir = tempfile::tempdir().unwrap();
        NodeKey::load_or_create(dir.path()).unwrap();
        let file = dir.path().join("keys").join("node.key");
        std::fs::write(&file, r#"{"v":1,"protection":"dpapi-machine","key":"AAAA"}"#).unwrap();
        assert!(NodeKey::load_or_create(dir.path()).is_err());
        assert!(file.exists(), "the file is left for an operator to look at");
    }

    #[test]
    fn its_assertions_verify_with_the_public_half() {
        let dir = tempfile::tempdir().unwrap();
        let key = NodeKey::load_or_create(dir.path()).unwrap();
        let jws = key.assertion("master-abcdefghijklmnop", "https://lgrai.app/api/node/v1/token", 1_800_000_000);
        let parts: Vec<&str> = jws.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: serde_json::Value = serde_json::from_slice(&B64URL.decode(parts[0]).unwrap()).unwrap();
        assert_eq!(header["alg"], "EdDSA");
        let claims: serde_json::Value = serde_json::from_slice(&B64URL.decode(parts[1]).unwrap()).unwrap();
        assert_eq!((claims["sub"].as_str(), claims["iat"].as_i64(), claims["exp"].as_i64()), (Some("master-abcdefghijklmnop"), Some(1_800_000_000), Some(1_800_000_060)));
        assert_eq!(claims["jti"].as_str().unwrap().len(), 24);
        let public = &B64.decode(key.public_spki_b64()).unwrap()[12..];
        UnparsedPublicKey::new(&ED25519, public)
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &B64URL.decode(parts[2]).unwrap())
            .expect("signed by this key");
        // A fresh jti every time.
        assert_ne!(jws, key.assertion("master-abcdefghijklmnop", "https://lgrai.app/api/node/v1/token", 1_800_000_000));
        assert!(claims.get("seal").is_none(), "no seal unless one is given");

        // FR-20.40: the seal key rides inside the signed claims.
        let sealed = key.assertion_with("master-abcdefghijklmnop", "https://lgrai.app/api/node/v1/token", 1_800_000_000, Some("SEAL"));
        let parts: Vec<&str> = sealed.split('.').collect();
        let claims: serde_json::Value = serde_json::from_slice(&B64URL.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["seal"].as_str(), Some("SEAL"));
        UnparsedPublicKey::new(&ED25519, public)
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &B64URL.decode(parts[2]).unwrap())
            .expect("the seal claim is signed too");
    }
}
