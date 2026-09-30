//! `--status-json` (FR-14.5): what the shell is, in one machine-readable line.
//!
//! ⚠ **This is a contract, not a convenience.** C15's Playwright harness and C17's guest drivers
//! read it *instead of scraping screens*, and FR-14.39's fleet check reads it through
//! `roomler exec`. So it carries `schemaVersion`: a consumer can then tell "the shape changed"
//! from "the field is missing", and a lane that starts failing says which.
//!
//! ⚠ It must contain **no credential**. It is printed to a terminal, captured into CI logs and
//! pasted into issues. `registered` says *whether* there is a key, never what it is.

use serde::Serialize;

/// Bumped only when a field is removed or changes meaning. Adding a field is not a bump.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub schema_version: u32,
    pub app_version: String,
    pub os: OsInfo,
    pub server_url: String,
    pub desktop_name: String,
    /// FR-14.18 — whether this machine holds a desktop credential. Never the credential.
    pub registration: Registration,
    /// FR-14.26 — the native fiscal bridge. `supported: false` until C18 ships it.
    pub bridge: Bridge,
    pub autostart: bool,
    pub open_lgr_on_launch: bool,
    pub log_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsInfo {
    pub platform: String,
    pub arch: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    /// `not_registered` | `registered` | `revoked`.
    pub state: String,
    pub desktop_id: Option<String>,
    pub org_slug: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bridge {
    pub supported: bool,
    pub devices: Vec<String>,
}

impl OsInfo {
    pub fn current() -> Self {
        Self {
            platform: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Status {
        Status {
            schema_version: SCHEMA_VERSION,
            app_version: "0.2.0".into(),
            os: OsInfo::current(),
            server_url: "https://lgrai.app".into(),
            desktop_name: "TILL-1".into(),
            registration: Registration { state: "not_registered".into(), desktop_id: None, org_slug: None },
            bridge: Bridge { supported: false, devices: vec![] },
            autostart: false,
            open_lgr_on_launch: false,
            log_path: "C:/x/lgr-desktop.log".into(),
        }
    }

    #[test]
    fn serialises_as_camel_case_json_with_a_schema_version() {
        // The harnesses parse this; the key names are the contract.
        let v: serde_json::Value = serde_json::from_str(&serde_json::to_string(&sample()).unwrap()).unwrap();
        assert_eq!(v["schemaVersion"], 1);
        for key in [
            "appVersion", "os", "serverUrl", "desktopName", "registration", "bridge",
            "autostart", "openLgrOnLaunch", "logPath",
        ] {
            assert!(!v[key].is_null(), "missing {key} in {v}");
        }
        assert!(!v["os"]["platform"].is_null());
        assert_eq!(v["registration"]["state"], "not_registered");
        assert_eq!(v["bridge"]["supported"], false);
    }

    #[test]
    fn carries_no_credential() {
        // ⚠ Structural guard. This output lands in CI logs and pasted issues.
        let json = serde_json::to_string(&sample()).unwrap().to_ascii_lowercase();
        for forbidden in ["token", "secret", "password", "assertion", "privatekey", "publickey"] {
            assert!(!json.contains(forbidden), "status must not carry {forbidden}");
        }
    }

    #[test]
    fn is_one_line_so_a_shell_can_capture_it() {
        // `roomler exec` splits argv on spaces and captures stdout; multi-line output is awkward
        // for every consumer and buys nothing.
        assert!(!serde_json::to_string(&sample()).unwrap().contains('\n'));
    }
}
