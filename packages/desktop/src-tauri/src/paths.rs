//! Where the shell keeps its files (FR-14.20, §1.2 #5).
//!
//! ⚠ **Non-roaming, on purpose.** The prototype put profiles in `app_data_dir()`, which on Windows
//! is **Roaming** AppData. On a domain with roaming profiles that means every PC the user signs
//! into inherits the same files — and once FR-14.20's desktop key and `installationId` live here,
//! that would give every one of those machines the same identity, so revoking one would revoke a
//! machine nobody touched.
//!
//! `app_local_data_dir()` is the local, per-machine directory. Nothing credential-bearing may be
//! written anywhere else.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// The per-machine data directory, created if missing.
pub fn local_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("no local data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Where rotating logs go. The OS log directory, not beside the executable.
///
/// ⚠ The prototype wrote `lgr-desktop.log` next to the `.exe`, which under `%ProgramFiles%` is not
/// writable by a standard user — so on exactly the machines the per-machine MSI targets (FR-14.4),
/// the crash log nobody could read was the one explaining why.
pub fn log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("no log dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// `settings.json`, in the non-roaming directory.
pub fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(local_dir(app)?.join("settings.json"))
}
