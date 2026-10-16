//! FR-14.28 — the step `update.rs` stops short of: download an update, prove it is ours, run it.
//!
//! ⚠ **An updater that accepts an artifact it should not is remote code execution on every till
//! in the fleet.** So nothing here runs an installer until BOTH of these pass, each against an
//! anchor compiled into this binary — never one the hub, the manifest or a setting supplies:
//!
//!   1. **minisign**, against `updater.pub`. The plugin checks it while downloading; it is checked
//!      again here, together with the version binding below, because the plugin's own version
//!      binding cannot be used (see `signed_file_matches`).
//!   2. **Authenticode**, against roomler's publisher `G ROX LTD`: a valid chain to a root the OS
//!      trusts, and that subject. A leaked minisign key alone therefore installs nothing.
//!
//! ⚠ Every check fails closed. An empty `updater.pub` (no key generated yet) is
//! `updater_not_configured`; an unreadable signature is a refusal, not a skipped check.
//!
//! ⚠ Windows per-user only. The MSI is per-machine and never self-installs (`update.rs`); macOS
//! needs its Developer ID check written first; Linux deb/rpm would need elevation, and the shell
//! never elevates. The hub offers no manifest for those platforms either.

use base64::Engine;
use tauri::Manager;

/// The updater's public key, from the file the release pipeline signs against.
///
/// ⚠ `include_str!`, so it is fixed at COMPILE time. A key read at runtime — from settings, the
/// environment or the hub — would be a key an attacker could replace.
const UPDATER_PUBKEY: &str = include_str!("../updater.pub");

/// The Authenticode publisher every LGR Desktop installer is signed by (FR-14.3, roomler's Azure
/// Trusted Signing profile). Compared against the certificate subject's CN, exactly.
pub const EXPECTED_PUBLISHER: &str = "G ROX LTD";

/// The pinned key, or `None` while none has been generated (FR-14.28's one-time setup).
pub fn pubkey() -> Option<&'static str> {
    let k = UPDATER_PUBKEY.trim();
    (!k.is_empty()).then_some(k)
}

/// The Tauri `<target>-<arch>` this build can self-install on, as the hub's `/update` names it.
pub fn platform() -> Option<&'static str> {
    if cfg!(all(windows, target_arch = "x86_64")) {
        Some("windows-x86_64")
    } else {
        None
    }
}

/// The installer file name a release names `version`: `LGR Desktop_<version>_x64-setup.exe`.
fn installer_suffix(version: &str) -> String {
    format!("_{version}_x64-setup.exe")
}

/// Check `data` against `signature` (the `.sig` file's base64) with the pinned `pubkey`, and that
/// the signature was made for the installer of `version`.
///
/// ⚠ **The version binding is ours, not the plugin's.** Its `requireSignedVersion` reads a
/// `version:` field from the trusted comment, and the Tauri CLI the release pipeline pins (2.10.1)
/// writes none — its `signer sign` records `timestamp:` and `file:`. Without SOME binding, a
/// tampered manifest could pair "version 9.9.9" with an OLDER genuine installer and its genuine
/// signature, and every till would downgrade to a build with known bugs. The file name carries the
/// version, and the trusted comment is covered by minisign's global signature, so it serves.
pub fn verify_minisign(data: &[u8], signature: &str, pubkey: &str, version: &str) -> Result<(), String> {
    use minisign_verify::{PublicKey, Signature};
    let b64 = base64::engine::general_purpose::STANDARD;
    let decode = |s: &str| -> Result<String, String> {
        let bytes = b64.decode(s.trim()).map_err(|_| "signature_unreadable".to_string())?;
        String::from_utf8(bytes).map_err(|_| "signature_unreadable".to_string())
    };
    let pk = PublicKey::decode(&decode(pubkey)?).map_err(|_| "updater_key_unreadable".to_string())?;
    let sig = Signature::decode(&decode(signature)?).map_err(|_| "signature_unreadable".to_string())?;
    // ⚠ `allow_legacy = false`: Tauri signs prehashed (`ED`) signatures, and accepting the legacy
    // non-prehashed form would only widen what a forged file could be.
    pk.verify(data, &sig, false).map_err(|_| "minisign_invalid".to_string())?;
    // Only NOW is the trusted comment trustworthy: `verify` is what checked the signature over it.
    if !signed_file_matches(sig.trusted_comment(), version) {
        return Err("signed_for_another_version".into());
    }
    Ok(())
}

/// Does the trusted comment's `file:` name the installer of `version`?
fn signed_file_matches(trusted_comment: &str, version: &str) -> bool {
    trusted_comment
        .split('\t')
        .find_map(|f| f.strip_prefix("file:"))
        .is_some_and(|file| file.ends_with(&installer_suffix(version)))
}

/// The CN of an X.500 subject as Windows prints it: `CN=G ROX LTD, O=G ROX LTD, L=London, C=GB`.
///
/// ⚠ Exact component, never a substring of the whole subject. `O=G ROX LTD` on an attacker's own
/// certificate, or `CN=G ROX LTD Impersonations`, must not pass.
pub fn subject_cn(subject: &str) -> Option<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in subject.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                cur.push(c);
            }
            ',' if !quoted => parts.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    parts.push(cur);
    parts.iter().find_map(|p| {
        let v = p.trim().strip_prefix("CN=")?;
        Some(v.trim().trim_matches('"').to_string())
    })
}

/// What Windows says about a file's Authenticode signature.
#[derive(Debug, PartialEq, Eq)]
pub struct Authenticode {
    /// `Valid` | `NotSigned` | `HashMismatch` | `UnknownError` | …
    pub status: String,
    pub subject: String,
}

impl Authenticode {
    /// ⚠ BOTH: a valid chain AND the pinned publisher. Valid alone accepts anyone's certificate.
    pub fn trusted(&self) -> bool {
        self.status == "Valid" && subject_cn(&self.subject).as_deref() == Some(EXPECTED_PUBLISHER)
    }
}

/// Ask Windows (WinVerifyTrust, through `Get-AuthenticodeSignature`) about `path`.
///
/// ⚠ PowerShell rather than raw WinVerifyTrust FFI: it is the exact check the release pipeline
/// runs on the same file (`desktop-release.yml`), so CI and the till cannot disagree about what
/// "signed" means. The path travels in an environment variable, never in the script text.
#[cfg(windows)]
pub fn authenticode(path: &std::path::Path) -> Result<Authenticode, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let script = "$s = Get-AuthenticodeSignature -LiteralPath $env:LGR_VERIFY_PATH; \
                  [Console]::Out.WriteLine([string]$s.Status); \
                  [Console]::Out.WriteLine([string]$s.SignerCertificate.Subject)";
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .env("LGR_VERIFY_PATH", path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("authenticode_check_failed: {e}"))?;
    if !out.status.success() {
        return Err("authenticode_check_failed".into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    Ok(Authenticode {
        status: lines.next().unwrap_or_default().trim().to_string(),
        subject: lines.next().unwrap_or_default().trim().to_string(),
    })
}

#[cfg(not(windows))]
pub fn authenticode(_path: &std::path::Path) -> Result<Authenticode, String> {
    Err("updater_unsupported_platform".into())
}

/// Both checks on bytes already in hand. Shared by the install path and `--verify-update`, so the
/// release pipeline runs exactly what a till will.
pub fn verify_installer(
    bytes: &[u8],
    signature: &str,
    version: &str,
    scratch: &std::path::Path,
) -> Result<Authenticode, String> {
    let key = pubkey().ok_or("updater_not_configured")?;
    verify_minisign(bytes, signature, key, version)?;

    // Authenticode needs the bytes on disk. ⚠ The plugin installs from the SAME in-memory bytes
    // (it writes its own copy), so nothing can swap the file between this check and the run.
    let path = scratch.join(format!("lgr-desktop{}", installer_suffix(version)));
    std::fs::write(&path, bytes).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    let result = authenticode(&path);
    let _ = std::fs::remove_file(&path);
    let sig = result?;
    if !sig.trusted() {
        return Err(format!("authenticode_untrusted: status={} subject={}", sig.status, sig.subject));
    }
    Ok(sig)
}

/// Download `version` through the hub, verify it, and run its installer (FR-14.28).
///
/// On Windows a successful call does not return: the plugin starts the installer and exits this
/// process, and the installer restarts the app.
pub fn install(app: &tauri::AppHandle, server_url: &str, version: &str) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    let key = pubkey().ok_or("updater_not_configured")?;
    let target = platform().ok_or("updater_unsupported_platform")?;
    let running = app.package_info().version.to_string();

    let token = crate::enroll::mint_token(server_url).map_err(|e| e.to_string())?;
    let url = url::Url::parse(&format!(
        "{}/api/desktop/v1/update?platform={target}&current={running}",
        server_url.trim_end_matches('/'),
    ))
    .map_err(|e| e.to_string())?;

    let logger = app.clone();
    let updater = app
        .updater_builder()
        .pubkey(key)
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .header("Authorization", format!("Bearer {token}"))
        .map_err(|e| e.to_string())?
        // ⚠ Our rule, not the plugin's: one definition of "newer" (`update::is_upgrade`, which
        // mirrors the hub's), refusing equality, downgrades and unparseable versions.
        .version_comparator(|current, remote| update_is_upgrade(&current.to_string(), &remote.version.to_string()))
        .timeout(std::time::Duration::from_secs(300))
        .on_before_exit(move || {
            logger
                .state::<crate::AppState>()
                .logger
                .info("auto-update: installer started, exiting for it");
        })
        .build()
        .map_err(|e| e.to_string())?;

    let update = tauri::async_runtime::block_on(updater.check())
        .map_err(|e| format!("update_check_failed: {e}"))?
        .ok_or("no_update_offered")?;
    // ⚠ Install what was DECIDED on. If the hub moved on between the decision and now, the next
    // check decides again — with the till state and deferral count that go with it.
    if update.version != version {
        return Err(format!("offer_changed: decided {version}, hub now offers {}", update.version));
    }

    // The plugin verifies minisign here too; `verify_installer` repeats it with the version binding.
    let bytes = tauri::async_runtime::block_on(update.download(|_, _| {}, || {}))
        .map_err(|e| format!("download_failed: {e}"))?;
    let scratch = crate::paths::local_dir(app)?;
    let sig = verify_installer(&bytes, &update.signature, version, &scratch)?;
    app.state::<crate::AppState>()
        .logger
        .info(&format!("auto-update: {version} verified (minisign + Authenticode {})", sig.subject));

    update.install(bytes).map_err(|e| format!("install_failed: {e}"))
}

fn update_is_upgrade(current: &str, candidate: &str) -> bool {
    crate::update::is_upgrade(current, candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A THROWAWAY key, generated for these tests and used for nothing else. Its private half was
    // discarded. `SIG` signs `PAYLOAD` as the file `LGR Desktop_9.9.9_x64-setup.exe`.
    const PUB: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDc2MTM3MDkzNjhFMEY5NzAKUldSdytlQm9rM0FUZGtYbmd3OWFQUkhISjZnOFlmblZ5R3NBNnZzVlRSY1AwMktLaXI5c0ZNb2wK";
    const SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSdytlQm9rM0FUZG5QVVhLZHlZOVlHWTEzWjU5QXkzTFB3NWFmMFdBbEMrdG54U0l2cHdvSkxJUGFXdzNNVnJUaDBtVGdlRjNJQ1hwWWhKaEhCdXQxZHVvQm8vRjlnY2dNPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyMTc3MTg2CWZpbGU6TEdSIERlc2t0b3BfOS45LjlfeDY0LXNldHVwLmV4ZQpnT0NmdDZGWEhwdXhvSTQzZmFBZWVYVEFibUlTV3ZpWllEQjFQVmx1ZCtJbW9wc3UrVm03bFhzZFVha2pYbkEvS05qY0Q5TUJSNVhXM051d250akRDUT09Cg==";
    const PAYLOAD: &[u8] = b"lgr updater test payload";

    #[test]
    fn a_genuine_signature_for_the_announced_version_passes() {
        assert_eq!(verify_minisign(PAYLOAD, SIG, PUB, "9.9.9"), Ok(()));
    }

    #[test]
    fn one_changed_byte_is_refused() {
        let mut tampered = PAYLOAD.to_vec();
        tampered[0] ^= 1;
        assert_eq!(verify_minisign(&tampered, SIG, PUB, "9.9.9"), Err("minisign_invalid".into()));
    }

    #[test]
    fn a_genuine_older_installer_under_a_newer_version_number_is_refused() {
        // ⚠ The downgrade attack: a tampered manifest announcing 10.0.0 with a real, validly
        // signed installer of another version. minisign alone accepts it.
        assert_eq!(verify_minisign(PAYLOAD, SIG, PUB, "10.0.0"), Err("signed_for_another_version".into()));
        // …including a version that is a SUFFIX of the signed one.
        assert_eq!(verify_minisign(PAYLOAD, SIG, PUB, "9.9"), Err("signed_for_another_version".into()));
    }

    #[test]
    fn another_key_is_refused() {
        // A different (valid-shaped) public key: the signature must not verify.
        let other = base64::engine::general_purpose::STANDARD.encode(
            "untrusted comment: minisign public key: 0000000000000000\nRWQAAAAAAAAAAACU2HqoXOqzVRBmV+Ly1u9+qjXE5gBUn3cENQHlpMbAFs1CDT6KhH9x\n",
        );
        assert!(verify_minisign(PAYLOAD, SIG, &other, "9.9.9").is_err());
    }

    #[test]
    fn garbage_is_a_refusal_not_a_panic() {
        for bad in ["", "not base64!", "aGVsbG8="] {
            assert!(verify_minisign(PAYLOAD, bad, PUB, "9.9.9").is_err(), "sig {bad:?}");
            assert!(verify_minisign(PAYLOAD, SIG, bad, "9.9.9").is_err(), "key {bad:?}");
        }
    }

    #[test]
    fn the_publisher_is_matched_on_the_cn_exactly() {
        let ok = |s: &str| Authenticode { status: "Valid".into(), subject: s.into() }.trusted();
        assert!(ok("CN=G ROX LTD, O=G ROX LTD, L=London, S=London, C=GB"));
        assert!(ok("CN=\"G ROX LTD\", O=G ROX LTD, C=GB"));
        // ⚠ The impersonations a substring match would let through.
        assert!(!ok("CN=G ROX LTD Impersonations, O=Evil, C=GB"));
        assert!(!ok("CN=Evil Ltd, O=G ROX LTD, C=GB"));
        assert!(!ok("CN=Evil, OU=CN=G ROX LTD"));
        assert!(!ok(""));
    }

    #[test]
    fn the_right_publisher_with_a_broken_chain_is_refused() {
        for status in ["NotSigned", "HashMismatch", "NotTrusted", "UnknownError", ""] {
            let a = Authenticode { status: status.into(), subject: "CN=G ROX LTD, C=GB".into() };
            assert!(!a.trusted(), "{status}");
        }
    }

    #[test]
    fn a_quoted_cn_may_contain_a_comma() {
        assert_eq!(subject_cn("CN=\"Acme, Inc\", O=Acme").as_deref(), Some("Acme, Inc"));
    }

    #[test]
    fn no_key_means_nothing_is_installed() {
        // While `updater.pub` is empty, `verify_installer` refuses before looking at anything.
        if pubkey().is_none() {
            let r = verify_installer(PAYLOAD, SIG, "9.9.9", &std::env::temp_dir());
            assert_eq!(r, Err("updater_not_configured".into()));
        }
    }
}
