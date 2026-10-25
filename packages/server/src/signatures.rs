//! The two signatures an update carries before the helper installs it (FR-20.20, plan step P1-8c).
//! Both fail closed, and both are checked against what THIS binary carries, never against anything
//! that came with the update: the offer, the transport and lgrai.app are not trust boundaries
//! (FR-20.53 lets a TLS-inspecting proxy in).
//!
//! - **The update signature:** minisign, with the desktop updater's key (FR-14.28,
//!   `packages/desktop/src-tauri/updater.pub`), over the bundle's bytes. The release checks every
//!   signature it publishes against the same file.
//! - **The platform signature:** on Windows, Authenticode on the version's `lgr-server.exe` (inside
//!   the minisigned bundle, so a swapped exe already fails the first check), trusted by Windows AND
//!   signed by exactly `G ROX LTD`: any commercial code-signing certificate chains to a root Windows
//!   trusts, so the name is what makes it ours. On Linux, the release GPG key over the bundle
//!   (`pgp.rs`).
//!
//! ⚠ Rotating either key takes a release that carries the new one, signed by the old.

use anyhow::{Context, Result};
use std::path::Path;

/// The minisign public key every update is signed with: base64 of minisign's key file, as Tauri
/// writes it.
pub const UPDATER_PUB: &str = include_str!("../../desktop/src-tauri/updater.pub");

/// Who signs our Windows binaries (roomler's identity, FR-14.3). Matched exactly.
#[cfg_attr(not(windows), allow(dead_code))]
pub const EXPECTED_PUBLISHER: &str = "G ROX LTD";

fn b64_text(what: &str, b64: &str) -> Result<String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).with_context(|| format!("the {what} is not base64"))?;
    String::from_utf8(bytes).with_context(|| format!("the {what} is not text"))
}

/// Verify `file` against `signature` (a `.sig`'s content: base64 of a minisign signature) with the
/// updater key this binary carries. Read in chunks: a bundle is a few hundred megabytes.
pub fn verify_update_signature(file: &Path, signature: &str) -> Result<()> {
    verify_minisign(file, signature, UPDATER_PUB)
}

fn verify_minisign(file: &Path, signature: &str, public_key: &str) -> Result<()> {
    use std::io::Read;
    let key = minisign_verify::PublicKey::decode(&b64_text("updater key", public_key)?).map_err(|e| anyhow::anyhow!("the updater key does not decode: {e}"))?;
    let sig = minisign_verify::Signature::decode(&b64_text("update signature", signature)?).map_err(|e| anyhow::anyhow!("the update signature does not decode: {e}"))?;
    // ⚠ Prehashed only (what `tauri signer` writes): the legacy mode signs raw bytes and is refused.
    let mut v = key.verify_stream(&sig).map_err(|e| anyhow::anyhow!("the update signature is not for this key: {e}"))?;
    let mut f = std::fs::File::open(file).with_context(|| format!("opening {}", file.display()))?;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        v.update(&buf[..n]);
    }
    v.finalize().map_err(|e| anyhow::anyhow!("{} does not verify against the updater key: {e}", file.display()))
}

/// Linux: the release GPG key over the bundle.
#[cfg_attr(windows, allow(dead_code))]
pub fn verify_platform_signature(file: &Path, asc: &str) -> Result<()> {
    let f = std::fs::File::open(file).with_context(|| format!("opening {}", file.display()))?;
    crate::pgp::verify_release_artifact(std::io::BufReader::new(f), asc)
}

/// Windows: `exe` carries a trusted Authenticode signature by exactly [`EXPECTED_PUBLISHER`].
/// Returns the signer's name.
#[cfg(windows)]
pub fn verify_publisher(exe: &Path) -> Result<String> {
    win::verify_trust(exe)?;
    let signer = win::signer_name(exe)?;
    if signer != EXPECTED_PUBLISHER {
        anyhow::bail!("{} is signed by {signer:?}, not {EXPECTED_PUBLISHER:?}", exe.display());
    }
    Ok(signer)
}

#[cfg(windows)]
mod win {
    //! After roomler-ai `agents/roomlerd/src/code_signature.rs`: `WinVerifyTrust` with the generic
    //! Authenticode policy, then the signer certificate's simple display name.
    use anyhow::{bail, Result};
    use std::ffi::OsStr;
    use std::iter::once;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{CRYPT_E_SECURITY_SETTINGS, ERROR_SUCCESS, TRUST_E_EXPLICIT_DISTRUST, TRUST_E_NOSIGNATURE, TRUST_E_SUBJECT_NOT_TRUSTED};
    use windows_sys::Win32::Security::Cryptography::{
        CertCloseStore, CertFindCertificateInStore, CertFreeCertificateContext, CertGetNameStringW, CryptMsgClose, CryptMsgGetParam, CryptQueryObject,
        CERT_FIND_SUBJECT_CERT, CERT_INFO, CERT_NAME_SIMPLE_DISPLAY_TYPE, CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED, CERT_QUERY_FORMAT_FLAG_BINARY,
        CERT_QUERY_OBJECT_FILE, CMSG_SIGNER_INFO, CMSG_SIGNER_INFO_PARAM,
    };
    use windows_sys::Win32::Security::WinTrust::{
        WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CHOICE_FILE, WTD_REVOKE_NONE,
        WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
    };

    fn wide(path: &Path) -> Vec<u16> {
        OsStr::new(path).encode_wide().chain(once(0)).collect()
    }

    pub(super) fn verify_trust(path: &Path) -> Result<()> {
        let file = wide(path);
        let mut file_info = WINTRUST_FILE_INFO { cbStruct: size_of::<WINTRUST_FILE_INFO>() as _, pcwszFilePath: file.as_ptr(), hFile: null_mut(), pgKnownSubject: null_mut() };
        let mut data = WINTRUST_DATA {
            cbStruct: size_of::<WINTRUST_DATA>() as _,
            pPolicyCallbackData: null_mut(),
            pSIPClientData: null_mut(),
            dwUIChoice: WTD_UI_NONE,
            // Offline by design: a master updates on a LAN with no route to a CRL. The timestamp keeps
            // a signature valid past its certificate.
            fdwRevocationChecks: WTD_REVOKE_NONE,
            dwUnionChoice: WTD_CHOICE_FILE,
            Anonymous: WINTRUST_DATA_0 { pFile: &mut file_info },
            dwStateAction: WTD_STATEACTION_VERIFY,
            hWVTStateData: null_mut(),
            pwszURLReference: null_mut(),
            dwProvFlags: 0,
            dwUIContext: 0,
            pSignatureSettings: null_mut(),
        };
        let mut guid = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        // SAFETY: every pointer is to a live local; the state is closed whatever the verdict.
        let status = unsafe { WinVerifyTrust(null_mut(), &mut guid as *mut _, &mut data as *mut _ as *mut core::ffi::c_void) };
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        unsafe { WinVerifyTrust(null_mut(), &mut guid as *mut _, &mut data as *mut _ as *mut core::ffi::c_void) };
        const OK: i32 = ERROR_SUCCESS as i32;
        // The file no longer hashes to what was signed (not re-exported by windows-sys 0.59).
        const TRUST_E_BAD_DIGEST: i32 = 0x8009_6010_u32 as i32;
        match status {
            OK => Ok(()),
            TRUST_E_BAD_DIGEST => bail!("{} was changed after it was signed", path.display()),
            TRUST_E_NOSIGNATURE => bail!("{} is not signed", path.display()),
            TRUST_E_EXPLICIT_DISTRUST => bail!("{}'s signature is explicitly distrusted", path.display()),
            TRUST_E_SUBJECT_NOT_TRUSTED => bail!("{}'s signature is not trusted", path.display()),
            CRYPT_E_SECURITY_SETTINGS => bail!("local policy rejected {}'s publisher", path.display()),
            other => bail!("WinVerifyTrust refused {}: 0x{other:08X}", path.display()),
        }
    }

    pub(super) fn signer_name(path: &Path) -> Result<String> {
        let file = wide(path);
        let (mut encoding, mut content_type, mut format_type) = (0u32, 0u32, 0u32);
        let (mut store, mut msg) = (null_mut(), null_mut());
        // SAFETY: out-pointers to locals; the store and the message are closed below.
        let ok = unsafe {
            CryptQueryObject(
                CERT_QUERY_OBJECT_FILE,
                file.as_ptr() as *const core::ffi::c_void,
                CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
                CERT_QUERY_FORMAT_FLAG_BINARY,
                0,
                &mut encoding,
                &mut content_type,
                &mut format_type,
                &mut store,
                &mut msg,
                null_mut(),
            )
        };
        if ok == 0 {
            bail!("{}'s signature cannot be read: {}", path.display(), std::io::Error::last_os_error());
        }
        let result = (|| -> Result<String> {
            let mut len = 0u32;
            if unsafe { CryptMsgGetParam(msg, CMSG_SIGNER_INFO_PARAM, 0, null_mut(), &mut len) } == 0 || (len as usize) < size_of::<CMSG_SIGNER_INFO>() {
                bail!("{}'s signer is unavailable", path.display());
            }
            // u64-aligned: CMSG_SIGNER_INFO holds pointers.
            let mut buf = vec![0u64; (len as usize).div_ceil(8)];
            if unsafe { CryptMsgGetParam(msg, CMSG_SIGNER_INFO_PARAM, 0, buf.as_mut_ptr() as *mut core::ffi::c_void, &mut len) } == 0 {
                bail!("{}'s signer is unreadable", path.display());
            }
            let signer = buf.as_ptr() as *const CMSG_SIGNER_INFO;
            // The signer's certificate, found in the message's own store by issuer and serial.
            let mut want: CERT_INFO = unsafe { std::mem::zeroed() };
            unsafe {
                want.Issuer = (*signer).Issuer;
                want.SerialNumber = (*signer).SerialNumber;
            }
            let cert = unsafe { CertFindCertificateInStore(store, encoding, 0, CERT_FIND_SUBJECT_CERT, &want as *const _ as *const core::ffi::c_void, null_mut()) };
            if cert.is_null() {
                bail!("{}'s signer certificate is not in its signature", path.display());
            }
            let needed = unsafe { CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, null_mut(), null_mut(), 0) };
            let mut name = vec![0u16; needed.max(1) as usize];
            let written = unsafe { CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, null_mut(), name.as_mut_ptr(), needed) };
            unsafe { CertFreeCertificateContext(cert) };
            if needed == 0 || written == 0 {
                bail!("{}'s signer has no name", path.display());
            }
            Ok(String::from_utf16_lossy(&name[..(written as usize).saturating_sub(1)]))
        })();
        unsafe {
            CryptMsgClose(msg);
            CertCloseStore(store, 0);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    fn b64(s: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(s)
    }

    // minisign-verify's own prehashed vector (key E7620F1842B4E81F, message "test"), wrapped the way
    // Tauri writes key and signature files: base64 of the text.
    const PUB: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
    const SIG: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n";
    // The same vector's legacy (not prehashed) signature: a mode the updater never accepts.
    const LEGACY_SIG: &str = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==\n";

    fn file(body: &[u8]) -> tempfile::NamedTempFile {
        let f = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(f.path(), body).unwrap();
        f
    }

    #[test]
    fn a_minisigned_file_verifies_and_a_changed_one_does_not() {
        verify_minisign(file(b"test").path(), &b64(SIG), &b64(PUB)).unwrap();
        assert!(verify_minisign(file(b"Test").path(), &b64(SIG), &b64(PUB)).is_err());
        assert!(verify_minisign(file(b"test\n").path(), &b64(SIG), &b64(PUB)).is_err());
    }

    #[test]
    fn the_legacy_mode_and_another_key_are_refused() {
        assert!(verify_minisign(file(b"test").path(), &b64(LEGACY_SIG), &b64(PUB)).is_err());
        // The updater's real key did not make this signature.
        assert!(verify_update_signature(file(b"test").path(), &b64(SIG)).unwrap_err().to_string().contains("not for this key"));
        assert!(verify_minisign(file(b"test").path(), "not base64 at all!", &b64(PUB)).is_err());
    }

    #[test]
    fn the_updater_key_this_binary_carries_decodes() {
        let text = b64_text("updater key", UPDATER_PUB).unwrap();
        assert!(minisign_verify::PublicKey::decode(&text).is_ok(), "{text}");
    }

    /// The real thing: `LGR_TEST_SIGNED_BUNDLE=<bundle>` with `<bundle>.sig` (and, on Linux,
    /// `<bundle>.asc`) beside it, from a signed release run's `signed` artifact.
    #[test]
    #[ignore = "needs a bundle the release signed"]
    fn a_released_bundle_verifies_and_a_flipped_byte_does_not() {
        let path = std::path::PathBuf::from(std::env::var("LGR_TEST_SIGNED_BUNDLE").unwrap());
        let sig = std::fs::read_to_string(format!("{}.sig", path.display())).unwrap();
        verify_update_signature(&path, &sig).unwrap();
        let mut bytes = std::fs::read(&path).unwrap();
        let mid = bytes.len() / 2;
        bytes[mid] ^= 1;
        let flipped = file(&bytes);
        assert!(verify_update_signature(flipped.path(), &sig).is_err());
        #[cfg(unix)]
        {
            let asc = std::fs::read_to_string(format!("{}.asc", path.display())).unwrap();
            verify_platform_signature(&path, &asc).unwrap();
            assert!(verify_platform_signature(flipped.path(), &asc).is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    fn an_unsigned_exe_is_refused_by_name() {
        // This test binary is not signed by anyone.
        let me = std::env::current_exe().unwrap();
        assert!(verify_publisher(&me).is_err());
    }

    /// `LGR_TEST_SIGNED_EXE=<lgr-server.exe>` from a signed release run.
    #[cfg(windows)]
    #[test]
    #[ignore = "needs an exe the release signed"]
    fn a_released_exe_is_signed_by_g_rox_ltd() {
        let exe = std::path::PathBuf::from(std::env::var("LGR_TEST_SIGNED_EXE").unwrap());
        assert_eq!(verify_publisher(&exe).unwrap(), EXPECTED_PUBLISHER);
    }
}
