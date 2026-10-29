//! Setup (FR-20.17, FR-20.18, issue #350): what a master asks for once, on its console, before it
//! serves a shop.
//!
//! The console (`ingress::Console`) opens with the one-time token and serves these steps itself;
//! they never reach the API, and no other ingress reaches the console. In order:
//! 1. **The link level** (`POST link`): Air-gapped, or registered with lgrai.app at Control or Full
//!    with the code an org admin minted on the Servers page (`register.rs`, what `lgr-server
//!    register` does).
//! 2. **The org.** Air-gapped: the page registers it through the API, stamped `console`, which makes
//!    its first admin ACTIVE (the setup token proves more than an emailed link would, and an
//!    Air-gapped master has no mail). Linked: the org's admin moves it here from lgrai.app (P3-6a),
//!    and its people come with it.
//! 3. **LAN access and the backup destination** (`POST settings`). Applied by starting again in
//!    this process (`Supervisor::request_reload`): the LAN ingress opens as it does at a start.
//! 4. **The first till** (optional): the page signs the first admin in and mints a pairing code
//!    through the API, which now names the LAN.
//! 5. **Finish** (`POST finish`): `BACKUP_SYS_ADMINS` becomes the owners of the orgs homed here, and
//!    `state/setup-complete` is written. The supervisor starts again without a console, so
//!    registering an org is off (`front-guard.ts`) and the tunnel carries traffic (FR-20.18).
//!
//! What setup chose is kept in `state/setup.json` and read as settings UNDER `config/api.env`
//! (`config::operator_env`): an operator's own line there always wins, and setup never edits that
//! file. `lgr-server setup reset` reopens setup with a new token.

use crate::ingress::{text, Body};
use crate::supervisor::Supervisor;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{HeaderValue, CONTENT_TYPE};
use hyper::{Method, Request, Response, StatusCode};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// The page of steps, served on the console only.
pub const APP: &str = "/__lgr/setup/app";
const API: &str = "/__lgr/setup/api/";
const PAGE: &str = include_str!("setup_page.html");

/// Paths the console answers itself, as setup.
pub fn is_setup_path(path: &str) -> bool {
    path == APP || path.starts_with(API)
}

/// What the steps need from the running supervisor.
pub struct Host {
    pub data: PathBuf,
    pub sup: Arc<Supervisor>,
    /// The console's own port: the LAN ingress must not want it.
    pub console_port: u16,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Choices {
    /// `airgapped`, `control` or `full`; none until the first step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lan: Option<Lan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup: Option<Backup>,
    /// FR-20.18: who may restore here (`BACKUP_SYS_ADMINS`), set at the finish.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sys_admins: Vec<String>,
    /// When LAN access and the backup were last chosen (seconds since the epoch): a round of the
    /// supervisor that started later runs with them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lan {
    pub on: bool,
    #[serde(default = "default_lan_port")]
    pub port: u16,
}

fn default_lan_port() -> u16 {
    4443
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    /// A folder for a copy of every backup (a USB drive), or none: the copy in the data folder only.
    #[serde(default)]
    pub local_path: Option<String>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Whether the round that started at `round_started` runs with the settings chosen at `settings_at`.
/// ⚠ Never earlier than the choice: the restart that applies them begins half a second AFTER it.
pub fn applied(settings_at: Option<u64>, round_started: u64) -> bool {
    settings_at.is_some_and(|at| round_started >= at)
}

pub fn choices_file(data: &Path) -> PathBuf {
    data.join("state").join("setup.json")
}

/// What setup chose so far. A file that cannot be read counts as nothing chosen, loudly: refusing to
/// start over it would take the shop's server down for a setting, and an operator line in
/// `config/api.env` overrides anything here anyway.
pub fn load(data: &Path) -> Choices {
    let file = choices_file(data);
    match std::fs::read_to_string(&file) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            tracing::error!(file = %file.display(), error = %e, "what setup chose cannot be read: starting as if nothing was chosen");
            Choices::default()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Choices::default(),
        Err(e) => {
            tracing::error!(file = %file.display(), error = %e, "what setup chose cannot be read: starting as if nothing was chosen");
            Choices::default()
        }
    }
}

pub fn save(data: &Path, choices: &Choices) -> anyhow::Result<()> {
    let text = serde_json::to_string_pretty(choices)?;
    crate::config::write_durable(&choices_file(data), text.as_bytes(), 0o640)
}

/// The settings setup's choices make, for `config::operator_env` to put UNDER `config/api.env`.
pub fn env(choices: &Choices) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    if let Some(lan) = &choices.lan {
        env.insert("LAN_INGRESS".to_string(), if lan.on { "on" } else { "off" }.to_string());
        if lan.on {
            env.insert("LAN_PORT".to_string(), lan.port.to_string());
        }
    }
    if let Some(path) = choices.backup.as_ref().and_then(|b| b.local_path.as_deref()).filter(|p| !p.trim().is_empty()) {
        env.insert("BACKUP_LOCAL_PATH".to_string(), path.trim().to_string());
    }
    if !choices.sys_admins.is_empty() {
        env.insert("BACKUP_SYS_ADMINS".to_string(), choices.sys_admins.join(","));
    }
    env
}

/// The marker setup's last step writes. Its existence is what closes the console.
pub fn complete(data: &Path) -> anyhow::Result<()> {
    let marker = data.join("state").join("setup-complete");
    crate::config::write_durable(&marker, serde_json::json!({ "completedAt": now_secs() }).to_string().as_bytes(), 0o644)
}

// ── The steps ───────────────────────────────────────────────────────────────────────────────────

fn json(status: StatusCode, value: serde_json::Value) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::from(value.to_string())).map_err(|never| match never {}).boxed());
    *r.status_mut() = status;
    r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
    r
}

fn refuse(status: StatusCode, code: &str, message: &str) -> Response<Body> {
    json(status, serde_json::json!({ "code": code, "message": message }))
}

pub async fn handle(host: Arc<Host>, req: Request<Incoming>) -> Response<Body> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    if method == Method::GET && path == APP {
        let mut r = text(StatusCode::OK, PAGE);
        r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
        r.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
        // The page is setup's own: nothing framed, nothing fetched from elsewhere.
        r.headers_mut().insert("x-frame-options", HeaderValue::from_static("DENY"));
        r.headers_mut().insert(
            "content-security-policy",
            HeaderValue::from_static("default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'"),
        );
        return r;
    }
    let step = path.strip_prefix(API).unwrap_or("");
    if method == Method::GET && step == "state" {
        return json(StatusCode::OK, state(&host).await);
    }
    if method != Method::POST {
        return refuse(StatusCode::NOT_FOUND, "not_found", "Not found.");
    }
    if crate::front::setup_complete(&host.data) {
        return refuse(StatusCode::CONFLICT, "setup_complete", "Setup is complete.");
    }
    let body = match Limited::new(req.into_body(), 16 * 1024).collect().await {
        Ok(b) => b.to_bytes(),
        Err(_) => return refuse(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "The request is too large."),
    };
    match step {
        "link" => link(&host, &body).await,
        "settings" => settings(&host, &body).await,
        "finish" => finish(&host).await,
        _ => refuse(StatusCode::NOT_FOUND, "not_found", "Not found."),
    }
}

/// Everything the page draws from: what was chosen and whether this round runs with it, the
/// registration, what the API says is homed here, and whether the LAN is open.
async fn state(host: &Host) -> serde_json::Value {
    let status = host.sup.status();
    let facts = api_facts(&host.sup).await;
    let choices = load(&host.data);
    let round_started = now_secs().saturating_sub(status["uptimeSecs"].as_u64().unwrap_or(0));
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "machine": crate::front::hostname(),
        "applied": applied(choices.settings_at, round_started),
        "choices": choices,
        "registration": status["registration"],
        "api": match &facts {
            Some(f) => serde_json::json!({ "ready": true, "orgs": f["orgs"], "desktops": f["desktops"] }),
            None => serde_json::json!({ "ready": false }),
        },
        "lan": status["front"]["lan"],
        "complete": crate::front::setup_complete(&host.data),
    })
}

/// What the API says through its control socket (`GET /setup`): the orgs homed here, their owners
/// and admins, and the desktops paired. `None` while the API is not answering.
async fn api_facts(sup: &Supervisor) -> Option<serde_json::Value> {
    let (socket, secret) = sup.api_control()?;
    match crate::control::call(&socket, &secret, "GET", "/setup", Duration::from_secs(5)).await {
        Ok((200, body)) => serde_json::from_str(&body).ok(),
        _ => None,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkAsk {
    level: String,
    code: Option<String>,
    /// lgrai.app unless the page names another global (a test one).
    server: Option<String>,
    name: Option<String>,
}

async fn link(host: &Host, body: &[u8]) -> Response<Body> {
    let Ok(ask) = serde_json::from_slice::<LinkAsk>(body) else {
        return refuse(StatusCode::BAD_REQUEST, "bad_request", "The request cannot be read.");
    };
    let registered = crate::register::current(&host.data);
    let mut choices = load(&host.data);
    match ask.level.as_str() {
        "airgapped" => {
            if registered.is_some() {
                return refuse(
                    StatusCode::CONFLICT,
                    "registered",
                    "This server is registered with lgrai.app, so it is not Air-gapped. Revoke it on the Servers page first, then run \"lgr-server setup reset\".",
                );
            }
            choices.link = Some("airgapped".into());
        }
        "control" | "full" => {
            if registered.is_none() {
                let Some(code) = ask.code.as_deref().map(str::trim).filter(|c| !c.is_empty()) else {
                    return refuse(StatusCode::UNPROCESSABLE_ENTITY, "code_required", "Enter the registration code from the Servers page on lgrai.app.");
                };
                let Some(registrar) = host.sup.registrar() else {
                    return refuse(StatusCode::SERVICE_UNAVAILABLE, "no_client", "This server cannot reach lgrai.app (see its log): it can be set up as Air-gapped.");
                };
                let name = ask.name.filter(|n| !n.trim().is_empty()).or_else(crate::front::hostname).unwrap_or_else(|| "lgr-server".into());
                let server = ask.server.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| crate::register::DEFAULT_SERVER.to_string());
                let r = crate::register::Ask { server, code: code.to_string(), link_level: ask.level.clone(), name };
                match crate::register::register(&registrar.data, &registrar.client, &r).await {
                    Ok(_) => registrar.wake.notify_waiters(),
                    // Global's refusal in its own words: a used code, an expired one, another org's server.
                    Err(e) => return refuse(StatusCode::UNPROCESSABLE_ENTITY, "registration_refused", &format!("{e:#}")),
                }
            }
            choices.link = Some(ask.level.clone());
        }
        _ => return refuse(StatusCode::BAD_REQUEST, "bad_level", "The link level is airgapped, control or full."),
    }
    if let Err(e) = save(&host.data, &choices) {
        return refuse(StatusCode::INTERNAL_SERVER_ERROR, "not_saved", &format!("{e:#}"));
    }
    tracing::info!(level = %ask.level, "setup: the link level is chosen");
    json(StatusCode::OK, serde_json::json!({ "choices": choices, "registration": crate::register::current(&host.data) }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsAsk {
    lan: Lan,
    backup: Backup,
}

async fn settings(host: &Host, body: &[u8]) -> Response<Body> {
    let Ok(ask) = serde_json::from_slice::<SettingsAsk>(body) else {
        return refuse(StatusCode::BAD_REQUEST, "bad_request", "The request cannot be read.");
    };
    let mut choices = load(&host.data);
    if choices.link.is_none() {
        return refuse(StatusCode::CONFLICT, "link_first", "Choose how this server links to lgrai.app first.");
    }
    if let Err(message) = lan_port_ok(&ask.lan, host.console_port) {
        return refuse(StatusCode::UNPROCESSABLE_ENTITY, "lan_port", &message);
    }
    let backup = match ask.backup.local_path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        None => Backup { local_path: None },
        Some(path) => match backup_folder_ok(Path::new(path), &host.data) {
            Ok(()) => Backup { local_path: Some(path.to_string()) },
            Err(message) => return refuse(StatusCode::UNPROCESSABLE_ENTITY, "backup_path", &message),
        },
    };
    choices.lan = Some(ask.lan);
    choices.backup = Some(backup);
    choices.settings_at = Some(now_secs());
    if let Err(e) = save(&host.data, &choices) {
        return refuse(StatusCode::INTERNAL_SERVER_ERROR, "not_saved", &format!("{e:#}"));
    }
    tracing::info!(lan = ?choices.lan, "setup: LAN access and the backup are chosen; starting again with them");
    reload_soon(host.sup.clone());
    json(StatusCode::ACCEPTED, serde_json::json!({ "applying": true, "choices": choices }))
}

async fn finish(host: &Host) -> Response<Body> {
    let mut choices = load(&host.data);
    if choices.link.is_none() {
        return refuse(StatusCode::CONFLICT, "link_first", "Choose how this server links to lgrai.app first.");
    }
    if choices.lan.is_none() || choices.backup.is_none() {
        return refuse(StatusCode::CONFLICT, "settings_first", "Choose LAN access and the backup first.");
    }
    let Some(facts) = api_facts(&host.sup).await else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, "api_down", "The server is starting. Try again in a moment.");
    };
    if facts["orgs"].as_array().is_none_or(|o| o.is_empty()) {
        let message = if choices.link.as_deref() == Some("airgapped") {
            "Create the organization this server runs first."
        } else {
            "No organization is on this server yet: move it here from the Servers page on lgrai.app first."
        };
        return refuse(StatusCode::CONFLICT, "org_first", message);
    }
    choices.sys_admins = sys_admins(&facts);
    if let Err(e) = save(&host.data, &choices).and_then(|_| complete(&host.data)) {
        return refuse(StatusCode::INTERNAL_SERVER_ERROR, "not_saved", &format!("{e:#}"));
    }
    tracing::info!(sys_admins = choices.sys_admins.len(), "setup is complete: starting again without a console");
    reload_soon(host.sup.clone());
    json(StatusCode::OK, serde_json::json!({ "complete": true, "choices": choices, "lan": host.sup.status()["front"]["lan"] }))
}

/// After the answer has gone out: a restart in place takes the console down with everything else.
fn reload_soon(sup: Arc<Supervisor>) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        sup.request_reload();
    });
}

/// FR-20.18: `BACKUP_SYS_ADMINS` is the first admin, so a restore works. Per org homed here, its
/// owner, or its first active admin when the owner is gone. Never someone not active.
pub fn sys_admins(facts: &serde_json::Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for org in facts["orgs"].as_array().into_iter().flatten() {
        let owner = org["owner"].as_object().filter(|o| o.get("active").and_then(|a| a.as_bool()) == Some(true)).and_then(|o| o.get("email")).and_then(|e| e.as_str());
        let admin = org["admins"].as_array().into_iter().flatten().find(|a| a["active"].as_bool() == Some(true)).and_then(|a| a["email"].as_str());
        if let Some(email) = owner.or(admin).map(|e| e.trim().to_ascii_lowercase()).filter(|e| !e.is_empty()) {
            if !out.contains(&email) {
                out.push(email);
            }
        }
    }
    out
}

fn lan_port_ok(lan: &Lan, console_port: u16) -> Result<(), String> {
    if !lan.on {
        return Ok(());
    }
    if lan.port < 1024 {
        return Err(format!("Port {} needs administrator rights, which the server does not run with: choose 1024 or above (4443 by default).", lan.port));
    }
    if lan.port == console_port {
        return Err(format!("Port {} is the setup console's own.", lan.port));
    }
    Ok(())
}

/// A folder the backup can copy to: an existing folder, the service may write in it, and not the
/// disk the database is on (#355: a copy beside the data dies with it, so the API refuses it).
pub fn backup_folder_ok(path: &Path, data: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Name the folder by its full path.".into());
    }
    if !path.is_dir() {
        return Err(format!("{} is not a folder on this server (is the drive plugged in?).", path.display()));
    }
    if same_disk(path, data) {
        return Err(format!("{} is on the same disk as the database: a copy there is lost with it. Choose a USB drive or another disk.", path.display()));
    }
    writable(path)
}

/// Whether the service can write in `folder`: a file made and removed again.
fn writable(folder: &Path) -> Result<(), String> {
    let probe = folder.join(format!(".lgr-setup-{}", crate::front::random_token()));
    match std::fs::write(&probe, b"lgr") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(e) => Err(format!("The server cannot write in {} ({e}): give its service account write access, or choose another folder.", folder.display())),
    }
}

#[cfg(unix)]
fn same_disk(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev(),
        _ => false,
    }
}

/// The drive each path is on. A path without one (a UNC share) is never "the same disk": the API
/// decides when it backs up.
#[cfg(not(unix))]
fn same_disk(a: &Path, b: &Path) -> bool {
    let prefix = |p: &Path| match p.components().next() {
        Some(std::path::Component::Prefix(x)) => Some(x.as_os_str().to_string_lossy().to_ascii_lowercase()),
        _ => None,
    };
    matches!((prefix(a), prefix(b)), (Some(x), Some(y)) if x == y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_chosen_sets_nothing() {
        assert!(env(&Choices::default()).is_empty());
    }

    #[test]
    fn the_choices_become_the_settings_an_operator_would_write() {
        let c = Choices {
            link: Some("airgapped".into()),
            lan: Some(Lan { on: true, port: 4443 }),
            backup: Some(Backup { local_path: Some(" /media/usb ".into()) }),
            sys_admins: vec!["owner@shop.example".into(), "second@shop.example".into()],
            settings_at: None,
        };
        let e = env(&c);
        assert_eq!(e["LAN_INGRESS"], "on");
        assert_eq!(e["LAN_PORT"], "4443");
        assert_eq!(e["BACKUP_LOCAL_PATH"], "/media/usb");
        assert_eq!(e["BACKUP_SYS_ADMINS"], "owner@shop.example,second@shop.example");
        // LAN off says off (an operator line that turned it on is still theirs to win), and no port.
        let off = env(&Choices { lan: Some(Lan { on: false, port: 4443 }), backup: Some(Backup { local_path: None }), ..c });
        assert_eq!(off["LAN_INGRESS"], "off");
        assert!(!off.contains_key("LAN_PORT") && !off.contains_key("BACKUP_LOCAL_PATH"));
    }

    #[test]
    fn the_choices_survive_a_round_trip_and_a_bad_file_counts_as_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()), Choices::default());
        let c = Choices { link: Some("full".into()), lan: Some(Lan { on: true, port: 5443 }), backup: None, sys_admins: vec![], settings_at: Some(1_761_700_000) };
        save(dir.path(), &c).unwrap();
        assert_eq!(load(dir.path()), c);
        std::fs::write(choices_file(dir.path()), "{ not json").unwrap();
        assert_eq!(load(dir.path()), Choices::default());
    }

    #[test]
    fn the_first_admin_is_each_orgs_active_owner_or_else_an_active_admin() {
        let facts = serde_json::json!({ "orgs": [
            { "slug": "a", "owner": { "email": "Owner@Shop.example", "active": true }, "admins": [{ "email": "x@shop.example", "active": true }] },
            { "slug": "b", "owner": { "email": "gone@shop.example", "active": false }, "admins": [
                { "email": "pending@shop.example", "active": false }, { "email": "admin@shop.example", "active": true }
            ] },
            { "slug": "c", "owner": null, "admins": [{ "email": "owner@shop.example", "active": true }] },
            { "slug": "d", "owner": null, "admins": [] }
        ] });
        assert_eq!(sys_admins(&facts), vec!["owner@shop.example", "admin@shop.example"]);
        assert!(sys_admins(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn the_lan_port_must_be_one_the_service_may_open() {
        assert!(lan_port_ok(&Lan { on: true, port: 4443 }, 4480).is_ok());
        assert!(lan_port_ok(&Lan { on: false, port: 80 }, 4480).is_ok(), "off: the port is not used");
        assert!(lan_port_ok(&Lan { on: true, port: 443 }, 4480).unwrap_err().contains("1024"));
        assert!(lan_port_ok(&Lan { on: true, port: 4480 }, 4480).unwrap_err().contains("console"));
    }

    #[test]
    fn a_backup_folder_must_exist_be_writable_and_not_be_the_databases_disk() {
        let data = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        assert!(backup_folder_ok(Path::new("relative/folder"), data.path()).unwrap_err().contains("full path"));
        let missing = elsewhere.path().join("not-there");
        assert!(backup_folder_ok(&missing, data.path()).unwrap_err().contains("not a folder"));
        // Two temporary folders are on one disk: exactly the copy #355 refuses.
        assert!(backup_folder_ok(elsewhere.path(), data.path()).unwrap_err().contains("same disk"));
        // Writable is proven by writing, and the proof leaves nothing behind.
        writable(elsewhere.path()).unwrap();
        assert!(std::fs::read_dir(elsewhere.path()).unwrap().next().is_none(), "the probe left nothing behind");
        assert!(writable(&missing).unwrap_err().contains("cannot write"));
    }

    #[test]
    fn settings_count_as_applied_only_by_a_round_that_started_after_them() {
        assert!(!applied(None, 2_000), "nothing chosen: nothing to apply");
        assert!(!applied(Some(1_000), 900), "the round that was running when they were chosen");
        assert!(applied(Some(1_000), 1_000));
        assert!(applied(Some(1_000), 1_001));
    }

    #[test]
    fn the_console_answers_setups_paths_itself_and_forwards_the_rest() {
        assert!(is_setup_path("/__lgr/setup/app"));
        assert!(is_setup_path("/__lgr/setup/api/state"));
        assert!(!is_setup_path("/__lgr/setup"), "the token page is the console's session step");
        assert!(!is_setup_path("/__lgr/setup/session"));
        assert!(!is_setup_path("/api/auth/register"));
    }
}
