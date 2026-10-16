//! FR-14.28 — the step `update.rs` stops short of: download an update, prove it is ours, run it.
//!
//! ⚠ **An updater that accepts an artifact it should not is remote code execution on every till
//! in the fleet.** So nothing here runs an installer until BOTH of these pass, each against an
//! anchor compiled into this binary — never one the hub, the manifest or a setting supplies:
//!
//!   1. **minisign**, against `updater.pub`. The plugin checks it while downloading; it is checked
//!      again here, together with the version binding below, because the plugin's own version
//!      binding cannot be used (see `signed_file_matches`).
//!   2. **The platform's own signature**, against roomler's identity:
//!      - Windows: Authenticode — a valid chain to a root the OS trusts AND the publisher CN
//!        exactly `G ROX LTD`;
//!      - macOS: Developer ID — `codesign --verify --deep --strict`, Team ID exactly `4TG7586MY5`,
//!        AND Gatekeeper's verdict `source=Notarized Developer ID`.
//!
//!   A leaked minisign key alone therefore installs nothing.
//!
//! ⚠ Every check fails closed. An empty `updater.pub` is `updater_not_configured`; an unreadable
//! signature is a refusal, not a skipped check.
//!
//! ⚠ Covered: Windows per-user (NSIS) and macOS where the user can write the app's folder. The
//! MSI is per-machine and never self-installs; a macOS app the user cannot write would make the
//! plugin ask for an admin password, which the shell never does (`update::detect_install_kind_here`);
//! Linux deb/rpm would need elevation too. The hub offers no manifest for Linux.

use base64::Engine;
use tauri::Manager;

/// The updater's public key, from the file the release pipeline signs against.
///
/// ⚠ `include_str!`, so it is fixed at COMPILE time. A key read at runtime — from settings, the
/// environment or the hub — would be a key an attacker could replace.
const UPDATER_PUBKEY: &str = include_str!("../updater.pub");

/// The Authenticode publisher every LGR Desktop Windows installer is signed by (FR-14.3, roomler's
/// Azure Trusted Signing profile). Compared against the certificate subject's CN, exactly.
// ⚠ Each platform's helpers are compiled — and unit-tested — on EVERY platform, so a parsing bug in
// the macOS checks shows up in Windows/Linux CI too; only the OS that calls them uses them.
#[cfg_attr(not(windows), allow(dead_code))]
pub const EXPECTED_PUBLISHER: &str = "G ROX LTD";

/// roomler's Apple Developer Team ID: `Developer ID Application: G ROX EOOD (4TG7586MY5)`, as the
/// release logs show it signing every `.app`. ⚠ The Team ID, never the organisation name: anyone
/// can call their company "G ROX EOOD", but Apple issues a Team ID to exactly one account.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const EXPECTED_TEAM_ID: &str = "4TG7586MY5";

/// The pinned key, or `None` while none has been generated (FR-14.28's one-time setup).
pub fn pubkey() -> Option<&'static str> {
    let k = UPDATER_PUBKEY.trim();
    (!k.is_empty()).then_some(k)
}

/// The Tauri `<target>-<arch>` this build can self-install on, as the hub's `/update` names it.
pub fn platform() -> Option<&'static str> {
    if cfg!(all(windows, target_arch = "x86_64")) {
        Some("windows-x86_64")
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("darwin-aarch64")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some("darwin-x86_64")
    } else {
        None
    }
}

/// How the release names the update file of `version` for `platform`. The hub's
/// `UPDATER_INSTALLERS` matches the same suffixes, and the release pipeline produces them.
///
/// ⚠ The version sits between `_` and `_`, so `0.1.6` can never match a file of `10.1.6` or `0.1.60`.
pub fn artifact_suffix(platform: &str, version: &str) -> Option<String> {
    match platform {
        "windows-x86_64" => Some(format!("_{version}_x64-setup.exe")),
        "darwin-aarch64" => Some(format!("_{version}_aarch64.app.tar.gz")),
        "darwin-x86_64" => Some(format!("_{version}_x64.app.tar.gz")),
        _ => None,
    }
}

/// Check `data` against `signature` (the `.sig` file's base64) with the pinned `pubkey`, and that
/// the signature was made for a file whose name ends with `expected_suffix` (which carries the
/// version — `artifact_suffix`).
///
/// ⚠ **The version binding is ours, not the plugin's.** Its `requireSignedVersion` reads a
/// `version:` field from the trusted comment, and the Tauri CLI the release pipeline pins (2.10.1)
/// writes none — its `signer sign` records `timestamp:` and `file:`. Without SOME binding, a
/// tampered manifest could pair "version 9.9.9" with an OLDER genuine installer and its genuine
/// signature, and every till would downgrade to a build with known bugs. The file name carries the
/// version, and the trusted comment is covered by minisign's global signature, so it serves.
pub fn verify_minisign(data: &[u8], signature: &str, pubkey: &str, expected_suffix: &str) -> Result<(), String> {
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
    if !signed_file_matches(sig.trusted_comment(), expected_suffix) {
        return Err("signed_for_another_version".into());
    }
    Ok(())
}

/// Does the trusted comment's `file:` end with `suffix`?
fn signed_file_matches(trusted_comment: &str, suffix: &str) -> bool {
    trusted_comment
        .split('\t')
        .find_map(|f| f.strip_prefix("file:"))
        .is_some_and(|file| file.ends_with(suffix))
}

// ── Windows: Authenticode ────────────────────────────────────────────────────────────────────

/// The CN of an X.500 subject as Windows prints it: `CN=G ROX LTD, O=G ROX LTD, L=London, C=GB`.
///
/// ⚠ Exact component, never a substring of the whole subject. `O=G ROX LTD` on an attacker's own
/// certificate, or `CN=G ROX LTD Impersonations`, must not pass.
#[cfg_attr(not(windows), allow(dead_code))]
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
#[cfg_attr(not(windows), allow(dead_code))]
pub struct Authenticode {
    /// `Valid` | `NotSigned` | `HashMismatch` | `UnknownError` | …
    pub status: String,
    pub subject: String,
}

#[cfg_attr(not(windows), allow(dead_code))]
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
///
/// ⚠ **`PSModulePath` is removed for the child.** Started from a PowerShell 7 session (the release
/// pipeline's `pwsh`, or an IT script on a till), this process inherits PS7's module path, and
/// Windows PowerShell 5.1 then tries to load PS7's `Microsoft.PowerShell.Security` and fails:
/// "the module could not be loaded". That is a NON-terminating error, so the script used to exit 0
/// with empty output — 0.1.6's release read `status= subject=`. (PS7 itself scrubs the variable
/// when IT starts `powershell.exe`, which is why running the same command from pwsh by hand
/// works.) Without the variable, 5.1 builds its own default.
///
/// ⚠ And no result is ever silent again: `$ErrorActionPreference = 'Stop'` turns any failure into
/// a non-zero exit, an empty status is an error, and both carry PowerShell's own message.
#[cfg(windows)]
pub fn authenticode(path: &std::path::Path) -> Result<Authenticode, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let script = "$ErrorActionPreference = 'Stop'; \
                  $s = Get-AuthenticodeSignature -LiteralPath $env:LGR_VERIFY_PATH; \
                  [Console]::Out.WriteLine([string]$s.Status); \
                  [Console]::Out.WriteLine([string]$s.SignerCertificate.Subject)";
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .env("LGR_VERIFY_PATH", path)
        .env_remove("PSModulePath")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("authenticode_check_failed: {e}"))?;
    let stderr = || {
        let s = String::from_utf8_lossy(&out.stderr);
        let first = s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("no message");
        first.chars().take(300).collect::<String>()
    };
    if !out.status.success() {
        return Err(format!("authenticode_check_failed: {}", stderr()));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let status = lines.next().unwrap_or_default().trim().to_string();
    let subject = lines.next().unwrap_or_default().trim().to_string();
    if status.is_empty() {
        return Err(format!("authenticode_check_failed: no status ({})", stderr()));
    }
    Ok(Authenticode { status, subject })
}

// ── macOS: Developer ID + notarisation ───────────────────────────────────────────────────────

/// The `TeamIdentifier=` line of `codesign -dv --verbose=2` (which codesign prints to STDERR).
///
/// ⚠ A whole line, compared exactly by the caller. `TeamIdentifier=not set` is what an ad-hoc
/// signed app prints, and must read as "not 4TG7586MY5", not as a parse error to skip past.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn codesign_team_id(codesign_dv_output: &str) -> Option<&str> {
    codesign_dv_output.lines().find_map(|l| l.trim().strip_prefix("TeamIdentifier="))
}

/// Did `spctl --assess --type execute -vv` accept the app as NOTARISED?
///
/// ⚠ `accepted` alone is not enough: a Developer ID app that was never notarised is "accepted"
/// on a machine with Gatekeeper relaxed, with `source=Developer ID` — and refused on every
/// customer Mac. Only `source=Notarized Developer ID` is the real verdict (the release pipeline
/// greps for the same line).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn spctl_notarized(spctl_output: &str) -> bool {
    let accepted = spctl_output.lines().any(|l| l.trim_end().ends_with(": accepted"));
    let notarized = spctl_output.lines().any(|l| l.trim() == "source=Notarized Developer ID");
    accepted && notarized
}

/// What macOS says about an `.app`.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct DeveloperId {
    /// `codesign --verify --deep --strict` succeeded.
    pub signature_valid: bool,
    pub team_id: Option<String>,
    pub notarized: bool,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl DeveloperId {
    /// ⚠ ALL THREE. A valid signature by another team, or roomler's team without notarisation,
    /// is not something to put on a customer's machine.
    pub fn trusted(&self) -> bool {
        self.signature_valid && self.team_id.as_deref() == Some(EXPECTED_TEAM_ID) && self.notarized
    }
}

#[cfg(target_os = "macos")]
fn developer_id(app: &std::path::Path) -> Result<DeveloperId, String> {
    use std::process::Command;
    let run = |cmd: &str, args: &[&std::ffi::OsStr]| {
        Command::new(cmd).args(args).output().map_err(|e| format!("{cmd}_failed: {e}"))
    };
    let p = app.as_os_str();
    let verify = run("/usr/bin/codesign", &["--verify".as_ref(), "--deep".as_ref(), "--strict".as_ref(), p])?;
    let display = run("/usr/bin/codesign", &["-dv".as_ref(), "--verbose=2".as_ref(), p])?;
    let assess = run("/usr/sbin/spctl", &["--assess".as_ref(), "--type".as_ref(), "execute".as_ref(), "-vv".as_ref(), p])?;
    // codesign and spctl both report on STDERR.
    let dv = String::from_utf8_lossy(&display.stderr);
    let sp = format!("{}{}", String::from_utf8_lossy(&assess.stdout), String::from_utf8_lossy(&assess.stderr));
    Ok(DeveloperId {
        signature_valid: verify.status.success(),
        team_id: codesign_team_id(&dv).map(str::to_string),
        notarized: assess.status.success() && spctl_notarized(&sp),
    })
}

/// Unpack an update archive into `dir` and return the `.app` at its root.
///
/// ⚠ Only ever called AFTER minisign has accepted the bytes, so the archive is one the release
/// pipeline produced, not something a hub or a network path chose.
#[cfg(target_os = "macos")]
fn unpack_app(archive: &std::path::Path, dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let out = std::process::Command::new("/usr/bin/tar")
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(dir)
        .output()
        .map_err(|e| format!("tar_failed: {e}"))?;
    if !out.status.success() {
        return Err("update_archive_unreadable".into());
    }
    let apps: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "app"))
        .collect();
    match apps.as_slice() {
        [one] => Ok(one.clone()),
        _ => Err(format!("update_archive_unexpected: {} .app bundles at the root", apps.len())),
    }
}

// ── Both checks ──────────────────────────────────────────────────────────────────────────────

/// The platform signature check on bytes minisign has already accepted. Returns what was proven,
/// for the log.
fn platform_signature(bytes: &[u8], suffix: &str, scratch: &std::path::Path) -> Result<String, String> {
    // The check needs the bytes on disk. ⚠ The plugin installs from the SAME in-memory bytes (it
    // writes or unpacks its own copy), so nothing can swap the file between this check and the run.
    let path = scratch.join(format!("lgr-desktop-update{suffix}"));
    std::fs::write(&path, bytes).map_err(|e| format!("cannot write {}: {e}", path.display()))?;

    #[cfg(windows)]
    let result = {
        let r = authenticode(&path);
        let _ = std::fs::remove_file(&path);
        let sig = r?;
        if !sig.trusted() {
            return Err(format!("authenticode_untrusted: status={} subject={}", sig.status, sig.subject));
        }
        Ok(format!("Authenticode {}", sig.subject))
    };

    #[cfg(target_os = "macos")]
    let result = {
        let dir = scratch.join("lgr-desktop-update-unpacked");
        let _ = std::fs::remove_dir_all(&dir);
        let r = unpack_app(&path, &dir).and_then(|app| developer_id(&app));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&dir);
        let id = r?;
        if !id.trusted() {
            return Err(format!(
                "developer_id_untrusted: signature_valid={} team={:?} notarized={}",
                id.signature_valid, id.team_id, id.notarized
            ));
        }
        Ok(format!("Developer ID team {EXPECTED_TEAM_ID}, notarised"))
    };

    #[cfg(not(any(windows, target_os = "macos")))]
    let result = {
        let _ = std::fs::remove_file(&path);
        Err("updater_unsupported_platform".to_string())
    };

    result
}

/// Both checks on bytes already in hand, for THIS build's platform. Shared by the install path
/// and `--verify-update`, so the release pipeline runs exactly what a till will.
pub fn verify_installer(
    bytes: &[u8],
    signature: &str,
    version: &str,
    scratch: &std::path::Path,
) -> Result<String, String> {
    let key = pubkey().ok_or("updater_not_configured")?;
    let platform = platform().ok_or("updater_unsupported_platform")?;
    let suffix = artifact_suffix(platform, version).ok_or("updater_unsupported_platform")?;
    verify_minisign(bytes, signature, key, &suffix)?;
    platform_signature(bytes, &suffix, scratch)
}

/// Download `version` through the hub, verify it, and install it (FR-14.28).
///
/// On Windows a successful call does not return: the plugin starts the installer and exits this
/// process, and the installer restarts the app. On macOS the plugin swaps the `.app` in place and
/// returns; this then restarts into the new version.
pub fn install(app: &tauri::AppHandle, server_url: &str, version: &str) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    let key = pubkey().ok_or("updater_not_configured")?;
    let target = platform().ok_or("updater_unsupported_platform")?;
    let running = app.package_info().version.to_string();

    // ⚠ Re-checked HERE, right before the plugin runs, not only in `try_install`. On macOS the
    // plugin's answer to a folder it cannot write is an administrator password prompt — the one
    // thing the shell never does — so this must hold at the moment of installing.
    if !crate::update::detect_install_kind_here().may_self_install() {
        return Err("managed".into());
    }

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
    let proven = verify_installer(&bytes, &update.signature, version, &scratch)?;
    app.state::<crate::AppState>()
        .logger
        .info(&format!("auto-update: {version} verified (minisign + {proven})"));

    update.install(bytes).map_err(|e| format!("install_failed: {e}"))?;

    // Only reached where the plugin does not exit for us (macOS). The new bundle is in place; the
    // running process is still the old one until it restarts.
    app.state::<crate::AppState>()
        .logger
        .info(&format!("auto-update: {version} installed, restarting into it"));
    app.restart()
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

    fn win(v: &str) -> String {
        artifact_suffix("windows-x86_64", v).unwrap()
    }

    #[test]
    fn a_genuine_signature_for_the_announced_version_passes() {
        assert_eq!(verify_minisign(PAYLOAD, SIG, PUB, &win("9.9.9")), Ok(()));
    }

    #[test]
    fn one_changed_byte_is_refused() {
        let mut tampered = PAYLOAD.to_vec();
        tampered[0] ^= 1;
        assert_eq!(verify_minisign(&tampered, SIG, PUB, &win("9.9.9")), Err("minisign_invalid".into()));
    }

    #[test]
    fn a_genuine_older_installer_under_a_newer_version_number_is_refused() {
        // ⚠ The downgrade attack: a tampered manifest announcing 10.0.0 with a real, validly
        // signed installer of another version. minisign alone accepts it.
        assert_eq!(verify_minisign(PAYLOAD, SIG, PUB, &win("10.0.0")), Err("signed_for_another_version".into()));
        // …including a version that is a SUFFIX of the signed one.
        assert_eq!(verify_minisign(PAYLOAD, SIG, PUB, &win("9.9")), Err("signed_for_another_version".into()));
    }

    #[test]
    fn a_file_for_another_platform_is_refused() {
        // The Windows installer's genuine signature, offered to a Mac.
        let mac = artifact_suffix("darwin-aarch64", "9.9.9").unwrap();
        assert_eq!(verify_minisign(PAYLOAD, SIG, PUB, &mac), Err("signed_for_another_version".into()));
    }

    #[test]
    fn every_platform_names_its_artifact_with_the_version_between_separators() {
        assert_eq!(artifact_suffix("windows-x86_64", "0.1.6").as_deref(), Some("_0.1.6_x64-setup.exe"));
        assert_eq!(artifact_suffix("darwin-aarch64", "0.1.6").as_deref(), Some("_0.1.6_aarch64.app.tar.gz"));
        assert_eq!(artifact_suffix("darwin-x86_64", "0.1.6").as_deref(), Some("_0.1.6_x64.app.tar.gz"));
        assert_eq!(artifact_suffix("linux-x86_64", "0.1.6"), None);
        // ⚠ `0.1.6` must not match the file of 10.1.6.
        assert!("LGR Desktop_10.1.6_x64-setup.exe".ends_with(&win("10.1.6")));
        assert!(!"LGR Desktop_10.1.6_x64-setup.exe".ends_with(&win("0.1.6")));
    }

    #[test]
    fn another_key_is_refused() {
        // A different (valid-shaped) public key: the signature must not verify.
        let other = base64::engine::general_purpose::STANDARD.encode(
            "untrusted comment: minisign public key: 0000000000000000\nRWQAAAAAAAAAAACU2HqoXOqzVRBmV+Ly1u9+qjXE5gBUn3cENQHlpMbAFs1CDT6KhH9x\n",
        );
        assert!(verify_minisign(PAYLOAD, SIG, &other, &win("9.9.9")).is_err());
    }

    #[test]
    fn garbage_is_a_refusal_not_a_panic() {
        for bad in ["", "not base64!", "aGVsbG8="] {
            assert!(verify_minisign(PAYLOAD, bad, PUB, &win("9.9.9")).is_err(), "sig {bad:?}");
            assert!(verify_minisign(PAYLOAD, SIG, bad, &win("9.9.9")).is_err(), "key {bad:?}");
        }
    }

    #[test]
    fn the_publisher_is_matched_on_the_cn_exactly() {
        let ok = |s: &str| Authenticode { status: "Valid".into(), subject: s.into() }.trusted();
        assert!(ok("CN=G ROX LTD, O=G ROX LTD, L=Pazardzhik, C=BG"));
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

    // What `codesign -dv --verbose=2` prints for a release `.app` (abridged).
    const CODESIGN_DV: &str = "Executable=/tmp/x/LGR Desktop.app/Contents/MacOS/lgr-desktop
Identifier=com.lgr.desktop
Format=app bundle with Mach-O thin (arm64)
Authority=Developer ID Application: G ROX EOOD (4TG7586MY5)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=16 Oct 2026 at 21:00:00
TeamIdentifier=4TG7586MY5
Runtime Version=14.0.0
";

    #[test]
    fn the_team_id_is_read_from_its_own_line() {
        assert_eq!(codesign_team_id(CODESIGN_DV), Some("4TG7586MY5"));
        // Ad-hoc signed: "not set" is a value, and it is not roomler's.
        assert_eq!(codesign_team_id("TeamIdentifier=not set\n"), Some("not set"));
        assert_eq!(codesign_team_id("Authority=Developer ID Application: X (4TG7586MY5)\n"), None);
    }

    #[test]
    fn notarisation_needs_the_notarized_source_not_just_accepted() {
        let notarized = "/tmp/x/LGR Desktop.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: G ROX EOOD (4TG7586MY5)\n";
        let signed_only = "/tmp/x/LGR Desktop.app: accepted\nsource=Developer ID\norigin=Developer ID Application: G ROX EOOD (4TG7586MY5)\n";
        let rejected = "/tmp/x/LGR Desktop.app: rejected\nsource=Notarized Developer ID\n";
        assert!(spctl_notarized(notarized));
        assert!(!spctl_notarized(signed_only), "a signed-but-not-notarised app is refused on customer Macs");
        assert!(!spctl_notarized(rejected));
        assert!(!spctl_notarized(""));
    }

    #[test]
    fn a_mac_app_needs_all_three() {
        let ok = DeveloperId { signature_valid: true, team_id: Some(EXPECTED_TEAM_ID.into()), notarized: true };
        assert!(ok.trusted());
        assert!(!DeveloperId { signature_valid: false, ..ok_clone(&ok) }.trusted());
        assert!(!DeveloperId { team_id: Some("ABCDE12345".into()), ..ok_clone(&ok) }.trusted());
        assert!(!DeveloperId { team_id: None, ..ok_clone(&ok) }.trusted());
        assert!(!DeveloperId { notarized: false, ..ok_clone(&ok) }.trusted());
    }

    fn ok_clone(d: &DeveloperId) -> DeveloperId {
        DeveloperId { signature_valid: d.signature_valid, team_id: d.team_id.clone(), notarized: d.notarized }
    }
}
