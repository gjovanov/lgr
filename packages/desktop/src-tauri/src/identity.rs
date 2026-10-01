//! C11 — this desktop's cryptographic identity (FR-14.19, FR-14.20).
//!
//! The keypair, the public key in the shape the server validates, and the signed client
//! assertion it exchanges for an access token.
//!
//! ⚠ Every format here is pinned by a verifier that already exists on the server
//! (`services/biz/desktop/desktop-crypto.ts`). This module is a deliberate mirror of it, not an
//! independent invention — the two cannot be allowed to disagree about what an assertion is:
//!
//!   · the public key is **base64 SPKI DER**, which for Ed25519 is always 44 bytes → 60 chars,
//!     and the server checks both the length and `asymmetricKeyType == 'ed25519'`;
//!   · the assertion is a compact JWS with header `{"alg":"EdDSA"}` — the server pins `alg`
//!     and refuses anything else, because `alg: none` and HMAC-with-the-public-key both live
//!     in that field;
//!   · `exp - iat` must be **≤ 60 s**, and `aud` must be the exact token URL, which is what
//!     stops an assertion minted for one endpoint being replayed at another.

use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use base64::Engine as _;
use ed25519_dalek::pkcs8::EncodePublicKey;
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};

/// FR-14.20 — an assertion may claim at most this much life. The server refuses more.
pub const ASSERTION_LIFETIME_SEC: i64 = 60;

/// The desktop's keypair. The private half exists only here and in the OS keystore.
pub struct Identity {
    signing: SigningKey,
}

impl Identity {
    /// A fresh keypair, from the OS CSPRNG.
    pub fn generate() -> Self {
        let mut bytes = [0u8; 32];
        // `rand::rngs::OsRng` is the operating system's generator — not a seeded PRNG, and not
        // anything derived from the machine id, which is public.
        use rand::RngCore as _;
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        Self { signing: SigningKey::from_bytes(&bytes) }
    }

    /// Restore from the 32 secret bytes the keystore holds.
    pub fn from_secret_bytes(bytes: &[u8]) -> Option<Self> {
        let arr: [u8; 32] = bytes.try_into().ok()?;
        Some(Self { signing: SigningKey::from_bytes(&arr) })
    }

    /// The 32 secret bytes, for the keystore and nowhere else.
    ///
    /// ⚠ The only way out of this type. Every other method returns something public, which is
    /// what keeps "the private key never leaves the keystore" checkable by reading call sites.
    pub fn secret_bytes(&self) -> [u8; 32] {
        self.signing.to_bytes()
    }

    /// Base64 SPKI DER, exactly as `isValidDesktopPublicKey` expects it.
    pub fn public_key_b64(&self) -> String {
        let der = self
            .signing
            .verifying_key()
            .to_public_key_der()
            .expect("ed25519 public keys always encode to SPKI");
        B64.encode(der.as_bytes())
    }

    /// A compact JWS client assertion (FR-14.20).
    ///
    /// `now_sec` is the CORRECTED time — see `ClockOffset`. ⚠ The system clock is never changed
    /// to make this right; a till's clock drives fiscal device time sync, which is
    /// Bulgarian-time-sensitive, and moving it to fix an HTTP call would break receipts.
    pub fn sign_assertion(&self, desktop_id: &str, audience: &str, now_sec: i64, jti: &str) -> String {
        let header = B64URL.encode(br#"{"alg":"EdDSA","typ":"JWT"}"#);
        let payload = B64URL.encode(
            serde_json::json!({
                "sub": desktop_id,
                "aud": audience,
                "iat": now_sec,
                "exp": now_sec + ASSERTION_LIFETIME_SEC,
                "jti": jti,
            })
            .to_string()
            .as_bytes(),
        );
        let signing_input = format!("{header}.{payload}");
        let sig = self.signing.sign(signing_input.as_bytes());
        format!("{signing_input}.{}", B64URL.encode(sig.to_bytes()))
    }
}

/// A random 128-bit identifier for this installation, persisted non-roaming (FR-14.19).
///
/// ⚠ Not derived from anything about the machine. `machineId` is a hash of public facts and two
/// identical VMs produce the same one; `installationId` is what distinguishes two installs, and
/// re-enrolling with the same one is what revives a revoked row rather than creating a second.
pub fn new_installation_id() -> String {
    let mut bytes = [0u8; 16];
    use rand::RngCore as _;
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex(&bytes)
}

/// A random 128-bit `jti`, so two assertions in the same second are still distinguishable.
pub fn new_jti() -> String {
    new_installation_id()
}

/// SHA-256 of `hostname|platform|arch` — display only, never a credential.
///
/// ⚠ Byte-identical to the server's `computeMachineId`, including the separator. A different
/// separator here would silently produce a different id for the same machine, and the symptom
/// would be duplicate rows on the Desktops page rather than an error anybody could read.
pub fn machine_id(hostname: &str, platform: &str, arch: &str) -> String {
    let mut h = Sha256::new();
    h.update(format!("{hostname}|{platform}|{arch}").as_bytes());
    hex(&h.finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A PKCE verifier/challenge pair (FR-14.14, RFC 7636).
///
/// ⚠ The verifier is the ONLY thing that makes the `lgr://login` delivery safe. That scheme can
/// be registered by any program on the machine, so a thief gets the code — and without a
/// preimage of the S256 challenge it is not redeemable. The verifier therefore never travels
/// anywhere except into a URL **fragment**, which no server and no log ever receives.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    pub fn generate() -> Self {
        use rand::RngCore as _;
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        // 32 random bytes as base64url is 43 characters — exactly RFC 7636's minimum, and what
        // the server's body schema refuses to go below.
        let verifier = B64URL.encode(bytes);
        let mut h = Sha256::new();
        h.update(verifier.as_bytes());
        let challenge = B64URL.encode(h.finalize());
        Self { verifier, challenge }
    }
}

/// The difference between this machine's clock and the server's (FR-14.20).
///
/// ⚠ The Win11 image the field lanes use runs about **+3 h** off until `w32time` resyncs. Without
/// correcting `iat`, a 10-minute enrollment code looks expired and a 60-second assertion looks
/// absurd in both directions. The server tolerates the skew ONCE (its `ASSERTION_CLOCK_SKEW_SEC`
/// is 4 h) so the first assertion gets through; after that the desktop is expected to have
/// learned the offset from `serverTime` and to apply it.
#[derive(Debug, Clone, Copy, Default)]
pub struct ClockOffset {
    /// server − local, in milliseconds.
    pub millis: i64,
}

impl ClockOffset {
    /// Learn the offset from a `serverTime` the server just sent.
    pub fn learn(server_time_ms: i64, local_now_ms: i64) -> Self {
        Self { millis: server_time_ms - local_now_ms }
    }

    /// The corrected time, in whole seconds, for `iat`.
    pub fn now_sec(&self, local_now_ms: i64) -> i64 {
        (local_now_ms + self.millis) / 1000
    }

    /// What the Overview's banner renders. Positive or negative; the screen takes the modulus.
    pub fn skew_ms(&self) -> i64 {
        -self.millis
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_public_key_is_the_shape_the_server_validates() {
        // ⚠ `isValidDesktopPublicKey` checks `length === 60` BEFORE trying to import, so a key
        // of any other length is refused without a readable reason. Ed25519 SPKI DER is 44
        // bytes, which is 60 characters of standard base64 including its padding.
        let id = Identity::generate();
        let pk = id.public_key_b64();
        assert_eq!(pk.len(), 60, "server refuses anything but 60 chars: {pk}");
        let der = B64.decode(&pk).expect("standard base64, not url-safe");
        assert_eq!(der.len(), 44);
        // The SPKI prefix for Ed25519 (RFC 8410): the server imports this as `spki`/`der`.
        assert_eq!(&der[..12], &[0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
    }

    #[test]
    fn an_assertion_has_three_parts_and_pins_eddsa() {
        let id = Identity::generate();
        let a = id.sign_assertion("desk1", "https://lgrai.app/api/desktop/v1/token", 1_700_000_000, "j1");
        let parts: Vec<&str> = a.split('.').collect();
        assert_eq!(parts.len(), 3);

        let header: serde_json::Value =
            serde_json::from_slice(&B64URL.decode(parts[0]).unwrap()).unwrap();
        assert_eq!(header["alg"], "EdDSA", "the server pins alg and refuses anything else");
    }

    #[test]
    fn the_assertion_lifetime_is_within_what_the_server_allows() {
        let id = Identity::generate();
        let a = id.sign_assertion("desk1", "aud", 1_700_000_000, "j1");
        let payload: serde_json::Value =
            serde_json::from_slice(&B64URL.decode(a.split('.').nth(1).unwrap()).unwrap()).unwrap();
        let iat = payload["iat"].as_i64().unwrap();
        let exp = payload["exp"].as_i64().unwrap();
        assert!(exp > iat, "server refuses exp <= iat");
        assert!(exp - iat <= 60, "server refuses a lifetime over 60s, got {}", exp - iat);
        assert_eq!(payload["sub"], "desk1");
        assert_eq!(payload["aud"], "aud");
        assert_eq!(payload["jti"], "j1");
    }

    #[test]
    fn the_signature_verifies_against_the_published_public_key() {
        use ed25519_dalek::{Signature, Verifier, VerifyingKey};
        let id = Identity::generate();
        let a = id.sign_assertion("d", "aud", 1_700_000_000, "j");
        let (signing_input, sig_b64) = a.rsplit_once('.').unwrap();

        // Reconstruct the key the way the SERVER does: from the published SPKI bytes.
        let der = B64.decode(id.public_key_b64()).unwrap();
        let vk = VerifyingKey::try_from(&der[12..44]).unwrap();
        let sig = Signature::from_slice(&B64URL.decode(sig_b64).unwrap()).unwrap();
        assert!(vk.verify(signing_input.as_bytes(), &sig).is_ok());
    }

    #[test]
    fn a_key_survives_a_round_trip_through_the_keystore() {
        let id = Identity::generate();
        let pk = id.public_key_b64();
        let restored = Identity::from_secret_bytes(&id.secret_bytes()).unwrap();
        assert_eq!(restored.public_key_b64(), pk, "the same key must come back");
    }

    #[test]
    fn rubbish_secret_bytes_are_refused_rather_than_panicking() {
        assert!(Identity::from_secret_bytes(&[]).is_none());
        assert!(Identity::from_secret_bytes(&[1, 2, 3]).is_none());
        assert!(Identity::from_secret_bytes(&[0u8; 64]).is_none());
    }

    #[test]
    fn machine_id_matches_the_servers_formula() {
        // ⚠ Pinned against the server's `computeMachineId('host','windows','x86_64')`, which is
        // sha256 of "host|windows|x86_64". A drift here produces duplicate Desktops rows, not
        // an error.
        let got = machine_id("host", "windows", "x86_64");
        assert_eq!(got.len(), 64, "hex sha256");
        assert_eq!(
            got,
            {
                let mut h = Sha256::new();
                h.update(b"host|windows|x86_64");
                hex(&h.finalize())
            },
            "the separator is part of the contract"
        );
    }

    #[test]
    fn installation_ids_are_random_and_not_derived_from_the_machine() {
        let a = new_installation_id();
        let b = new_installation_id();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b, "two installs on one machine must differ");
    }

    #[test]
    fn the_clock_offset_corrects_iat_without_touching_the_system_clock() {
        // The +3 h machine: local says 12:00, the server says 09:00.
        let local_ms = 1_700_000_000_000;
        let server_ms = local_ms - 3 * 60 * 60 * 1000;
        let off = ClockOffset::learn(server_ms, local_ms);
        assert_eq!(off.now_sec(local_ms), server_ms / 1000, "iat is corrected to server time");
        // The Overview reports how far the MACHINE is out, which is the opposite sign.
        assert_eq!(off.skew_ms(), 3 * 60 * 60 * 1000);
    }

    #[test]
    fn a_pkce_verifier_meets_rfc_7636_and_the_servers_floor() {
        let p = Pkce::generate();
        // ⚠ 43 is both RFC 7636's minimum and the server's `minLength`. A shorter verifier is
        // refused by the body schema, which would look like "sign-in is broken".
        assert_eq!(p.verifier.len(), 43, "32 bytes base64url");
        assert!(p.verifier.len() >= 43);
        // base64url, unpadded: no `+`, `/` or `=` to be mangled by a URL.
        for s in [&p.verifier, &p.challenge] {
            assert!(!s.contains('+') && !s.contains('/') && !s.contains('='), "not url-safe: {s}");
        }
    }

    #[test]
    fn the_challenge_is_s256_of_the_verifier() {
        // The server recomputes exactly this and compares in constant time. A different encoding
        // here fails every sign-in with the same opaque "not redeemable" message.
        let p = Pkce::generate();
        let mut h = Sha256::new();
        h.update(p.verifier.as_bytes());
        assert_eq!(p.challenge, B64URL.encode(h.finalize()));
        assert_ne!(p.challenge, p.verifier, "the challenge must not BE the verifier");
    }

    #[test]
    fn two_pkce_pairs_differ() {
        let a = Pkce::generate();
        let b = Pkce::generate();
        assert_ne!(a.verifier, b.verifier);
        assert_ne!(a.challenge, b.challenge);
    }

    #[test]
    fn a_default_offset_is_the_local_clock() {
        let off = ClockOffset::default();
        assert_eq!(off.now_sec(1_700_000_000_000), 1_700_000_000);
        assert_eq!(off.skew_ms(), 0);
    }
}
