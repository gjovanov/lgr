// SPDX-License-Identifier: MPL-2.0
// Copyright (C) 2026 G ROX EOOD
//! The release `.asc`, verified against a key compiled in (FR-20.20, plan step P1-8c): a Linux
//! master's platform signature. Ported from roomler-ai `agents/roomlerd/src/pgp_verify.rs`, which
//! verifies the same key's signatures on roomlerd's packages; here the artifact is read in chunks
//! (a server bundle is a few hundred megabytes) and the digests are ring's.
//!
//! Deliberately NOT an OpenPGP implementation: it verifies exactly what the release workflow emits
//! (`gpg --armor --detach-sign`, an ed25519 key): one v4 signature packet, class 0x00 (binary
//! document), algorithm 22 (EdDSA), SHA-256 or SHA-512. Anything else is refused, naming what was
//! found.
//!
//! ⚠ The key is a constant, so rotating it takes a release: ship releases signed by the old key that
//! carry the new pin, then switch the signing key once the fleet has updated past them. The pin is
//! checked against the committed public key (`keys/roomler-release-pubkey.asc`) by a test.

use anyhow::{bail, Context, Result};
use std::io::Read;

/// The ed25519 point of roomler's release SIGNING subkey: `Roomler Release Signing
/// <releases@roomler.ai>`, subkey `5DB8221F546288DE780C10D3A2C53E5FE6FA485A` (key id
/// `A2C53E5FE6FA485A`), certified by the offline primary `D654B016256FD92A81634A0E2AD1E9F025973A7F`.
/// The same pin roomlerd carries.
pub const PINNED_RELEASE_SIGNING_KEY: [u8; 32] = [
    0xc2, 0x7e, 0x10, 0x54, 0xd2, 0x42, 0x57, 0xdc, 0x8d, 0x66, 0x00, 0x50, 0x15, 0xf0, 0xdb, 0x31, 0x9b, 0x7a, 0xf4, 0x47, 0xa0, 0x38, 0x77, 0x3c,
    0xc0, 0x11, 0xff, 0xfa, 0x8b, 0xa6, 0xd9, 0xfa,
];

/// Verify what `artifact` reads against the armored detached signature `asc`, with the pinned key.
/// The error is the refusal, in words.
pub fn verify_release_artifact(artifact: impl Read, asc: &str) -> Result<()> {
    verify_detached(artifact, asc, &PINNED_RELEASE_SIGNING_KEY)
}

/// The armor (RFC 4880 §6.2) off, the CRC-24 checked when present: it names truncation and
/// copy-paste damage better than "bad signature".
fn dearmor(asc: &str) -> Result<Vec<u8>> {
    use base64::Engine as _;
    let std = base64::engine::general_purpose::STANDARD;
    let (mut in_body, mut seen_begin) = (false, false);
    let mut b64 = String::new();
    let mut crc_line: Option<String> = None;
    for line in asc.lines() {
        let line = line.trim_end_matches('\r');
        if line.starts_with("-----BEGIN PGP ") {
            seen_begin = true;
            continue;
        }
        if line.starts_with("-----END PGP ") {
            break;
        }
        if !seen_begin {
            continue;
        }
        if !in_body {
            // Armor headers run to the first empty line; a body with none starts at once.
            if line.is_empty() {
                in_body = true;
                continue;
            }
            if line.contains(": ") {
                continue;
            }
            in_body = true;
        }
        if let Some(crc) = line.strip_prefix('=') {
            crc_line = Some(crc.to_string());
            continue;
        }
        b64.push_str(line);
    }
    if !seen_begin {
        bail!("not an ASCII-armored PGP block (no BEGIN line)");
    }
    let data = std.decode(b64.as_bytes()).context("the armor's body is not base64")?;
    if let Some(crc) = crc_line {
        let want = std.decode(crc.as_bytes()).context("the armor's CRC line is not base64")?;
        if want.len() != 3 || want != crc24(&data) {
            bail!("the armor's CRC-24 does not match: the signature file is damaged or cut short");
        }
    }
    Ok(data)
}

/// CRC-24, RFC 4880 §6.1.
fn crc24(data: &[u8]) -> Vec<u8> {
    const INIT: u32 = 0x00B7_04CE;
    const POLY: u32 = 0x0186_4CFB;
    let mut crc = INIT;
    for &b in data {
        crc ^= (b as u32) << 16;
        for _ in 0..8 {
            crc <<= 1;
            if crc & 0x0100_0000 != 0 {
                crc ^= POLY;
            }
        }
    }
    vec![(crc >> 16) as u8, (crc >> 8) as u8, crc as u8]
}

struct SigPacket {
    hash_algo: u8,
    /// Verbatim: these bytes are part of what was signed.
    hashed_subpackets: Vec<u8>,
    /// The digest's first 16 bits: a swapped artifact reads as "wrong digest", not "bad signature".
    left16: [u8; 2],
    /// R ‖ S, each MPI left-padded to 32 bytes.
    signature: [u8; 64],
}

/// The one signature packet the release emits. Trailing packets are refused: not ours.
fn parse_signature_packet(data: &[u8]) -> Result<SigPacket> {
    let mut r = Reader(data);
    let ctb = r.u8().context("empty signature data")?;
    if ctb & 0x80 == 0 {
        bail!("not an OpenPGP packet (CTB 0x{ctb:02x})");
    }
    let (tag, body_len) = if ctb & 0x40 == 0 {
        let tag = (ctb >> 2) & 0x0f;
        let len = match ctb & 0x03 {
            0 => r.u8()? as usize,
            1 => r.u16()? as usize,
            2 => r.u32()? as usize,
            _ => bail!("an indeterminate-length packet is not a detached signature"),
        };
        (tag, len)
    } else {
        let tag = ctb & 0x3f;
        let first = r.u8()?;
        let len = match first {
            0..=191 => first as usize,
            192..=223 => (((first as usize) - 192) << 8) + r.u8()? as usize + 192,
            255 => r.u32()? as usize,
            _ => bail!("a partial-length packet is not a detached signature"),
        };
        (tag, len)
    };
    if tag != 2 {
        bail!("expected a signature packet (tag 2), found tag {tag}");
    }
    let body = r.take(body_len).context("the signature packet is cut short")?;
    if !r.0.is_empty() {
        bail!("{} bytes after the signature packet: not a plain detached signature", r.0.len());
    }
    let mut b = Reader(body);
    let version = b.u8()?;
    if version != 4 {
        bail!("signature version {version} (the release signs v4)");
    }
    let class = b.u8()?;
    if class != 0x00 {
        bail!("signature class 0x{class:02x} (expected 0x00, a binary document)");
    }
    let pk = b.u8()?;
    if pk != 22 {
        bail!("public-key algorithm {pk} (expected 22, EdDSA)");
    }
    let hash_algo = b.u8()?;
    if hash_algo != 8 && hash_algo != 10 {
        bail!("hash algorithm {hash_algo} (expected SHA-256 or SHA-512)");
    }
    let hashed_len = b.u16()? as usize;
    let hashed_subpackets = b.take(hashed_len).context("the hashed subpackets are cut short")?.to_vec();
    let unhashed_len = b.u16()? as usize;
    b.take(unhashed_len).context("the unhashed subpackets are cut short")?;
    let left16 = [b.u8()?, b.u8()?];
    let mut signature = [0u8; 64];
    for half in 0..2 {
        let bits = b.u16()? as usize;
        let bytes = bits.div_ceil(8);
        if bytes > 32 {
            bail!("a {bytes}-byte signature MPI is not an ed25519 scalar");
        }
        let mpi = b.take(bytes).context("a signature MPI is cut short")?;
        signature[half * 32 + (32 - bytes)..half * 32 + 32].copy_from_slice(mpi);
    }
    Ok(SigPacket { hash_algo, hashed_subpackets, left16, signature })
}

/// The pin-free core: tests use a throwaway key.
fn verify_detached(mut artifact: impl Read, asc: &str, pubkey: &[u8; 32]) -> Result<()> {
    let sig = parse_signature_packet(&dearmor(asc)?)?;
    // RFC 4880 §5.2.4: the artifact, the packet's v4 prefix through its hashed subpackets, then
    // 0x04 0xFF and that prefix's length.
    let hashed_len = sig.hashed_subpackets.len();
    let mut trailer = Vec::with_capacity(12 + hashed_len);
    trailer.extend_from_slice(&[0x04, 0x00, 22, sig.hash_algo]);
    trailer.extend_from_slice(&(hashed_len as u16).to_be_bytes());
    trailer.extend_from_slice(&sig.hashed_subpackets);
    let prefix_len = trailer.len() as u32;
    trailer.extend_from_slice(&[0x04, 0xFF]);
    trailer.extend_from_slice(&prefix_len.to_be_bytes());

    let algo = match sig.hash_algo {
        8 => &ring::digest::SHA256,
        _ => &ring::digest::SHA512,
    };
    let mut ctx = ring::digest::Context::new(algo);
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = artifact.read(&mut buf).context("reading the artifact")?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
    }
    ctx.update(&trailer);
    let digest = ctx.finish();
    let digest = digest.as_ref();
    if digest[..2] != sig.left16 {
        bail!(
            "the signature is for other bytes than this artifact (its digest starts {:02x}{:02x}, this one {:02x}{:02x})",
            sig.left16[0],
            sig.left16[1],
            digest[0],
            digest[1]
        );
    }
    // OpenPGP EdDSA signs the digest itself.
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, pubkey)
        .verify(digest, &sig.signature)
        .map_err(|_| anyhow::anyhow!("the signature does not verify against the pinned release key: this was not signed by Roomler Release Signing"))
}

/// A bounds-checked cursor: a truncated or hostile `.asc` is an error, never a panic.
struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn u8(&mut self) -> Result<u8> {
        let (&b, rest) = self.0.split_first().context("unexpected end of packet")?;
        self.0 = rest;
        Ok(b)
    }
    fn u16(&mut self) -> Result<u16> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }
    fn u32(&mut self) -> Result<u32> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.0.len() < n {
            bail!("unexpected end of packet (wanted {n} bytes, have {})", self.0.len());
        }
        let (head, rest) = self.0.split_at(n);
        self.0 = rest;
        Ok(head)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // roomlerd's fixture: a throwaway ed25519 key and a message it signed (gpg 2.4.8, an isolated
    // GNUPGHOME). Test vectors, not secrets.
    const FIXTURE_MSG: &[u8] = b"roomler pgp_verify fixture message v1\n";
    const FIXTURE_KEY: [u8; 32] = [
        0xeb, 0x45, 0x29, 0xff, 0x24, 0xe9, 0xf6, 0xb7, 0x21, 0x20, 0x7a, 0x34, 0x08, 0x01, 0xa2, 0x6b, 0xf7, 0x0f, 0xe4, 0x2d, 0xc4, 0xdf, 0x3e,
        0xd3, 0xc3, 0x19, 0x5d, 0xc1, 0xcc, 0xbe, 0xce, 0x4e,
    ];
    const FIXTURE_ASC: &str = "-----BEGIN PGP SIGNATURE-----\n\n\
iHUEABYKAB0WIQR+gSR1LCoEVCK5rt+0sI1x14/rFgUCao7qAAAKCRC0sI1x14/r\n\
Fib9AQC7rcJIbBRX9OLFsijHeAtLA78lEFbZECl0rBM3Ui3ECAEAzAZhKfTmb0nJ\n\
hV/0cAHGFizJ3Gl+qz5YZ4IEbnnXtgs=\n\
=wJg0\n\
-----END PGP SIGNATURE-----\n";

    #[test]
    fn the_fixture_verifies_read_in_chunks() {
        verify_detached(FIXTURE_MSG, FIXTURE_ASC, &FIXTURE_KEY).unwrap();
        // One byte at a time is the same digest.
        struct Trickle<'a>(&'a [u8]);
        impl Read for Trickle<'_> {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.0.is_empty() || buf.is_empty() {
                    return Ok(0);
                }
                buf[0] = self.0[0];
                self.0 = &self.0[1..];
                Ok(1)
            }
        }
        verify_detached(Trickle(FIXTURE_MSG), FIXTURE_ASC, &FIXTURE_KEY).unwrap();
    }

    #[test]
    fn a_changed_artifact_is_refused() {
        let mut msg = FIXTURE_MSG.to_vec();
        msg[0] ^= 1;
        let err = verify_detached(msg.as_slice(), FIXTURE_ASC, &FIXTURE_KEY).unwrap_err();
        assert!(err.to_string().contains("other bytes"), "{err}");
    }

    #[test]
    fn a_changed_signature_is_refused() {
        assert!(verify_detached(FIXTURE_MSG, &FIXTURE_ASC.replace("Fib9AQC7", "Fib9AQC8"), &FIXTURE_KEY).is_err());
    }

    #[test]
    fn another_key_is_refused() {
        let err = verify_detached(FIXTURE_MSG, FIXTURE_ASC, &PINNED_RELEASE_SIGNING_KEY).unwrap_err();
        assert!(err.to_string().contains("pinned release key"), "{err}");
    }

    #[test]
    fn garbage_is_an_error_never_a_panic() {
        assert!(verify_detached(&b"x"[..], "not armor at all", &FIXTURE_KEY).is_err());
        assert!(verify_detached(&b"x"[..], "-----BEGIN PGP SIGNATURE-----\n\naGVsbG8=\n-----END PGP SIGNATURE-----\n", &FIXTURE_KEY).is_err());
        assert!(verify_detached(&b"x"[..], "-----BEGIN PGP SIGNATURE-----\n\niHU=\n-----END PGP SIGNATURE-----\n", &FIXTURE_KEY).is_err());
    }

    /// The pin agrees with the committed public key: its signing subkey's ed25519 point (primary
    /// key 6, user id 13, certification 2, subkey 14).
    #[test]
    fn the_pin_is_the_committed_public_keys_signing_subkey() {
        let data = dearmor(include_str!("../keys/roomler-release-pubkey.asc")).unwrap();
        let mut r = Reader(&data);
        let mut point: Option<[u8; 32]> = None;
        while !r.0.is_empty() {
            let ctb = r.u8().unwrap();
            assert_ne!(ctb & 0x80, 0);
            let (tag, len) = if ctb & 0x40 == 0 {
                let len = match ctb & 0x03 {
                    0 => r.u8().unwrap() as usize,
                    1 => r.u16().unwrap() as usize,
                    _ => panic!("unexpected length type"),
                };
                ((ctb >> 2) & 0x0f, len)
            } else {
                let first = r.u8().unwrap();
                let len = match first {
                    0..=191 => first as usize,
                    192..=223 => (((first as usize) - 192) << 8) + r.u8().unwrap() as usize + 192,
                    255 => r.u32().unwrap() as usize,
                    _ => panic!("unexpected length"),
                };
                (ctb & 0x3f, len)
            };
            let body = r.take(len).unwrap();
            if tag == 14 {
                assert_eq!((body[0], body[5]), (4, 22), "a v4 EdDSA subkey");
                let mpi = 7 + body[6] as usize + 2;
                assert_eq!(body[mpi], 0x40, "a compressed point");
                point = Some(body[mpi + 1..mpi + 33].try_into().unwrap());
            }
        }
        assert_eq!(point.expect("a signing subkey"), PINNED_RELEASE_SIGNING_KEY, "rotated on purpose? Update the pin AND read the module's rotation note");
    }

    /// A real release asset against the real pin: `LGR_TEST_ASC_ARTIFACT=<file>` with `<file>.asc`
    /// beside it (`gh release download server-v0.1.0 --repo gjovanov/lgr`).
    #[test]
    #[ignore = "needs a downloaded release asset"]
    fn a_real_release_asset_verifies_and_a_flipped_byte_does_not() {
        let path = std::env::var("LGR_TEST_ASC_ARTIFACT").unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let asc = std::fs::read_to_string(format!("{path}.asc")).unwrap();
        verify_release_artifact(bytes.as_slice(), &asc).unwrap();
        let mut flipped = bytes;
        let mid = flipped.len() / 2;
        flipped[mid] ^= 1;
        assert!(verify_release_artifact(flipped.as_slice(), &asc).is_err());
    }
}
