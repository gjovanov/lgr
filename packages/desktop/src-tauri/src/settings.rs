//! The shell's settings (FR-14.32), in non-roaming storage.
//!
//! ⚠ Settings only — **never a credential**. FR-14.20's desktop key belongs in the OS keystore and
//! `installationId` beside it; neither goes in this file. A settings file is the thing people copy
//! between machines when they clone a PC, which is precisely why it must be worthless to copy.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// The LGR server this desktop is registered against.
    pub server_url: String,
    /// What this machine calls itself until an admin renames it.
    pub desktop_name: String,
    /// FR-14.7 — a per-user login item.
    pub autostart: bool,
    /// FR-14.16 — after autostart, put the POS on screen with nobody touching it.
    pub open_lgr_on_launch: bool,
    /// FR-14.13 — open the cloud app in the system browser instead of `lgr-web`.
    pub open_in_system_browser: bool,
    /// FR-14.28 — check the hub in the background (at start, then every 4 h) and install what it
    /// offers, under every rule in `update.rs`. Off = only the Overview's Check / Install.
    ///
    /// ⚠ On by default, and a file written before this field existed loads as ON too (the
    /// struct's `#[serde(default)]`). A fleet that has to opt IN to updates is a fleet that stays
    /// below `DESKTOP_MIN_VERSION` until someone visits every till.
    pub auto_update: bool,
    /// FR-14.32 — an explicit proxy, when the system one is wrong.
    pub proxy: String,
    /// Empty = follow the OS locale (FR-14.33).
    pub locale: String,
    pub log_level: String,
    /// FR-20.29 — the master this desktop was paired with, and the CA it trusts for it (`trust.rs`).
    /// `None` for lgrai.app, which the OS store vouches for.
    ///
    /// ⚠ Written by enrollment only: `save_settings` keeps what is on disk whatever the page sends,
    /// so nothing but a pairing that checked the fingerprint changes what this desktop trusts. A CA
    /// certificate is public, which is why it may sit in a file that gets copied with a cloned PC.
    pub master: Option<MasterSetting>,
    /// FR-20.32 — the loopback proxy's port for a master's window, kept for the installation: the
    /// window's origin is `http://127.0.0.1:<port>`, so its storage survives a restart only while
    /// this does. `0` until a master's window first opens.
    pub proxy_port: u16,
    /// FR-20.32 — the server whose session `lgr-web`'s storage holds. A window opened for another
    /// server clears that storage first, so nothing of one server's session reaches the next. Empty
    /// means not yet recorded (every install before this field), which clears nothing.
    pub web_server: String,
}

/// A paired master: its origin and its pinned CA.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterSetting {
    pub origin: String,
    pub ca_pem: String,
    pub fingerprint: String,
    /// FR-20.30: the CA the master announced it will rotate to, learnt through the pinned TLS, and
    /// when the switch is due. Trusted beside `ca_pem` until then, and in its place after.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_ca_pem: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_switch_at: Option<i64>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server_url: "https://lgrai.app".into(),
            desktop_name: hostname(),
            autostart: false,
            open_lgr_on_launch: false,
            open_in_system_browser: false,
            auto_update: true,
            proxy: String::new(),
            locale: String::new(),
            log_level: "info".into(),
            master: None,
            proxy_port: 0,
            web_server: String::new(),
        }
    }
}

/// The machine's name, for the onboarding default. Best-effort: a desktop with no readable
/// hostname is not a desktop that should fail to start.
pub fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "LGR Desktop".into())
}

pub fn load(app: &AppHandle) -> Settings {
    let Ok(path) = paths::settings_file(app) else {
        return Settings::default();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return Settings::default();
    };
    // ⚠ A corrupt or half-written settings file must not stop the app. `#[serde(default)]` on the
    // struct means a file missing any field still loads, and a file that is not JSON at all falls
    // back to defaults rather than panicking on a till at 07:00.
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = paths::settings_file(app)?;
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_the_cloud_and_nothing_enabled() {
        let s = Settings::default();
        assert_eq!(s.server_url, "https://lgrai.app");
        assert!(!s.autostart);
        assert!(!s.open_lgr_on_launch);
        assert!(!s.open_in_system_browser);
        assert!(s.locale.is_empty(), "empty locale means follow the OS");
        // The one switch that defaults ON — see the field.
        assert!(s.auto_update);
    }

    #[test]
    fn a_file_from_before_the_toggle_keeps_updating() {
        // ⚠ Every settings.json in the field predates `autoUpdate`. Reading its absence as OFF
        // would silently stop updates on every installed desktop at once.
        let s: Settings = serde_json::from_str(r#"{"serverUrl":"https://x.example","autostart":true}"#).unwrap();
        assert!(s.auto_update);
        let off: Settings = serde_json::from_str(r#"{"autoUpdate":false}"#).unwrap();
        assert!(!off.auto_update);
    }

    #[test]
    fn a_partial_file_still_loads() {
        // The shape an older or hand-edited file has.
        let s: Settings = serde_json::from_str(r#"{"serverUrl":"https://x.example"}"#).unwrap();
        assert_eq!(s.server_url, "https://x.example");
        assert_eq!(s.log_level, "info", "missing fields take their default");
    }

    #[test]
    fn garbage_does_not_panic() {
        assert!(serde_json::from_str::<Settings>("not json").is_err());
        // `load` turns that into defaults; this asserts the conversion is the safe direction.
        let fallback: Settings = serde_json::from_str("not json").unwrap_or_default();
        assert_eq!(fallback.server_url, "https://lgrai.app");
    }

    #[test]
    fn a_file_from_before_pairing_has_no_master() {
        // Every settings.json in the field predates FR-20: it must read as lgrai.app's trust.
        let s: Settings = serde_json::from_str(r#"{"serverUrl":"https://lgrai.app"}"#).unwrap();
        assert_eq!(s.master, None);
        let paired: Settings = serde_json::from_str(
            r#"{"master":{"origin":"https://192.168.1.10:4443","caPem":"-----BEGIN CERTIFICATE-----","fingerprint":"sha256:x"}}"#,
        )
        .unwrap();
        assert_eq!(paired.master.unwrap().origin, "https://192.168.1.10:4443");
    }

    #[test]
    fn no_credential_field_exists() {
        // ⚠ Structural: if someone adds a token or key here, this fails and they have to justify
        // it. The file is what gets copied when a PC is cloned.
        let json = serde_json::to_string(&Settings::default()).unwrap().to_ascii_lowercase();
        for forbidden in ["token", "secret", "password", "privatekey", "installationid", "key\""] {
            assert!(!json.contains(forbidden), "settings must not carry {forbidden}: {json}");
        }
    }
}
