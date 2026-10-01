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
    /// FR-14.17 — `unknown` until something has tried to reach the server (C10).
    pub server_link: String,
    /// FR-14.20 — where the desktop key lives: `none` | `keystore` | `file` (C11).
    ///
    /// ⚠ WHERE, never WHAT. The Overview warns on `file` because that is the Linux fallback
    /// (C11), and this output is printed into CI logs and pasted into issues.
    pub key_storage: String,
    /// FR-14.21 — measured from the server's `serverTime` (C11). `None` = never measured.
    pub clock_skew_ms: Option<i64>,
    /// FR-14.28 — filled by C13.
    pub update: Update,
    /// FR-14.16 — the desktop's assignment (C06/C07).
    pub assignment: Assignment,
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
    /// ⚠ Identifiers only. The Overview renders the ASSIGNED devices (C06's `fiscalDeviceIds`);
    /// port, state and last command are things only the native bridge knows (C18). Turning this
    /// into a list of objects would change an existing field's meaning — the one case
    /// `SCHEMA_VERSION` is bumped for — and C15/C17 already parse it.
    pub devices: Vec<String>,
}

/// ⚠ The derived default is the right one and must stay so: no update known, none required.
/// A hand-written impl here would be two more lines that can drift from the field list.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub available: bool,
    /// Below `DESKTOP_MIN_VERSION`: the server will refuse this build (C13).
    pub required: bool,
    pub version: Option<String>,
}

/// Default = unassigned and unmanaged, i.e. **Open LGR** lands on the server's home page and
/// the Settings field stays editable.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Assignment {
    /// Where **Open LGR** lands, e.g. `/pos/` for a till. `None` = the server's home page.
    pub start_path: Option<String>,
    /// True when an administrator set it, which makes it read-only on the Settings screen.
    pub managed: bool,
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
            server_link: "unknown".into(),
            key_storage: "none".into(),
            clock_skew_ms: None,
            update: Update::default(),
            assignment: Assignment::default(),
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
            // C09's Overview reads these; later chunks fill them with real data.
            "serverLink", "keyStorage", "update", "assignment",
        ] {
            assert!(!v[key].is_null(), "missing {key} in {v}");
        }
        assert!(!v["os"]["platform"].is_null());
        assert_eq!(v["registration"]["state"], "not_registered");
        assert_eq!(v["bridge"]["supported"], false);
        assert_eq!(v["serverLink"], "unknown", "nothing has reached the server yet");
        assert_eq!(v["keyStorage"], "none", "an unregistered desktop stores no key");
        assert_eq!(v["update"]["required"], false);
        assert_eq!(v["assignment"]["managed"], false);
    }

    #[test]
    fn clock_skew_is_absent_rather_than_zero_when_unmeasured() {
        // ⚠ `0` would mean "measured, and the clock is right" — which is exactly the claim the
        // Overview must not make before anything has asked the server what time it is.
        let v: serde_json::Value = serde_json::from_str(&serde_json::to_string(&sample()).unwrap()).unwrap();
        assert!(v["clockSkewMs"].is_null());
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
