// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! LGR Desktop — the shell.
//!
//! ⚠ There is **no sidecar, no Bun runtime and no local database** (FR-14.1). Local mode was
//! retired in FR-14.34; `docs/architecture/desktop.md` records what went and why.
//!
//! What this file wires up (FR-14.5–14.7, 14.9, 14.10, 14.12):
//!  · one instance per OS user, with `--view=` routing and `--status-json`;
//!  · the tray, whose Quit waits for an in-flight fiscal command;
//!  · `lgr://` deep links, every parameter validated;
//!  · rotating, redacted logs and the diagnostics bundle;
//!  · a per-user autostart login item.
//!
//! Open LGR (`lgr-web`) is FR-14.13 and lands in its own chunk. The commands below are what the
//! shell's own Vue pages call; the remote origin gets **none** of them (see `capabilities/`).

mod diagnostics;
mod enroll;
mod identity;
mod keystore;
mod presence;
mod logs;
mod paths;
mod settings;
mod status;
mod update;
mod validate;
mod web;

use std::io::Write as _;
use std::sync::{Arc, Mutex};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;

/// Everything the shell knows about itself at runtime.
pub struct AppState {
    logger: logs::Logger,
    /// FR-14.6 — Quit must wait for an in-flight fiscal command.
    ///
    /// ⚠ The await point exists NOW, with nothing to await, because FR-14.26's bridge is a later
    /// chunk. Adding it later would mean reopening the quit path, and "quit interrupted a receipt"
    /// is the kind of bug that only shows up on a customer's till.
    bridge_busy: Arc<Mutex<bool>>,
    /// The view a `--view=` argument or a tray item asked for, read by the front end on start.
    pending_view: Arc<Mutex<Option<&'static str>>>,
    /// A deep link that arrived before the window was listening.
    pending_deep_link: Arc<Mutex<Option<String>>>,
    /// FR-14.17 / FR-14.21 — whether the server answers, shared by the presence socket and the
    /// unreachable page's retry loop so **Retry now** nudges whichever one is waiting.
    link: Arc<presence::LinkState>,
    /// One retry loop at a time: pressing Retry three times must nudge, not spawn.
    retrying: Arc<std::sync::atomic::AtomicBool>,
    /// Set on shutdown so the presence thread stops instead of reconnecting into a closing app.
    stop: Arc<std::sync::atomic::AtomicBool>,
    /// FR-14.28 — how many times the pending update has been put off for a busy till.
    deferrals: Arc<update::Deferrals>,
    /// FR-14.14 — the PKCE verifier for an OAuth flow currently in the system browser.
    ///
    /// ⚠ **In memory only, and taken once.** It is the half of the credential that makes the
    /// `lgr://login` code redeemable; writing it anywhere would hand a thief of that scheme the
    /// pair. `None` means no flow is in progress, which is what makes an unsolicited `lgr://login`
    /// something to ignore rather than act on.
    oauth_verifier: Arc<Mutex<Option<String>>>,
}

impl AppState {
    fn new(logger: logs::Logger) -> Self {
        Self {
            logger,
            bridge_busy: Arc::new(Mutex::new(false)),
            pending_view: Arc::new(Mutex::new(None)),
            pending_deep_link: Arc::new(Mutex::new(None)),
            link: Arc::new(presence::LinkState::default()),
            retrying: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            deferrals: Arc::new(update::Deferrals::default()),
            oauth_verifier: Arc::new(Mutex::new(None)),
        }
    }
}

// ── Commands the shell's OWN pages call ─────────────────────────────────────────────────────
//
// ⚠ Each is reachable only from a window listed in a capability. `lgr-web` is in none of them, so
// an `invoke` from the cloud app is refused (FR-14.9, AC 4).

#[tauri::command]
fn get_settings(app: AppHandle) -> settings::Settings {
    settings::load(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, incoming: settings::Settings) -> Result<settings::Settings, String> {
    let mut s = incoming;
    // ⚠ Normalised here, not trusted from the page. `http://` is upgraded except for loopback
    // (FR-14.11), and a server URL carrying a path would misdirect every path resolved against it.
    s.server_url = validate::normalize_server_url(&s.server_url)
        .ok_or_else(|| "That does not look like a server address.".to_string())?;
    settings::save(&app, &s)?;

    // Keep the OS login item in step with the setting, and report a failure rather than leaving
    // the two silently disagreeing (FR-14.7).
    let mgr = app.autolaunch();
    let result = if s.autostart { mgr.enable() } else { mgr.disable() };
    if let Err(e) = result {
        let verb = if s.autostart { "enable" } else { "disable" };
        app.state::<AppState>().logger.warn(&format!("autostart {verb} failed: {e}"));
    }
    Ok(s)
}

#[tauri::command]
fn get_status(app: AppHandle) -> status::Status {
    build_status(&app)
}

#[tauri::command]
fn read_logs(app: AppHandle, max_lines: Option<usize>) -> Vec<String> {
    let st = app.state::<AppState>();
    let cap = max_lines.unwrap_or(2000).min(20_000);
    let mut lines: Vec<String> = Vec::new();
    // Newest file first; stop once we have enough.
    for path in st.logger.files() {
        if let Ok(text) = std::fs::read_to_string(&path) {
            for l in text.lines().rev() {
                lines.push(l.to_string());
                if lines.len() >= cap {
                    return lines;
                }
            }
        }
    }
    lines
}

#[tauri::command]
fn create_diagnostics_bundle(app: AppHandle) -> Result<String, String> {
    let s = build_status(&app);
    let st = app.state::<AppState>();
    match diagnostics::create_bundle(&app, &st.logger, &s) {
        Ok(path) => {
            st.logger.info(&format!("diagnostics bundle written: {}", path.display()));
            Ok(path.to_string_lossy().to_string())
        }
        Err(e) => {
            // ⚠ Logged as well as returned. This is the button someone presses BECAUSE something
            // is already wrong, so its own failure must leave a trace rather than only a toast.
            st.logger.error(&format!("diagnostics bundle failed: {e}"));
            Err(e)
        }
    }
}

/// The UI reports that it rendered (FR-14.10).
///
/// ⚠ Not test scaffolding. This line in the log — and so in the diagnostics bundle — is what
/// distinguishes "the app started but the page never rendered" from "the app never started".
/// Those are indistinguishable in a user's report of a blank window, and only one of them is a
/// content-security problem.
#[tauri::command]
fn shell_ready(app: AppHandle, route: Option<String>) {
    app.state::<AppState>()
        .logger
        .info(&format!("ui ready (route={})", route.unwrap_or_else(|| "/".into())));

    // FR-14.28 — this is the moment a start COUNTS as successful, and so the moment the running
    // version becomes `last_known_good`.
    //
    // ⚠ Deliberately here and not at `setup`. A build that panics while rendering, or whose
    // webview never loads, reaches `setup` perfectly well — treating that as a good start would
    // record a crash-looping version as the one to roll back TO.
    let running = app.package_info().version.to_string();
    let mut state = update::load_state(&app);
    if state.consecutive_failed_starts > 0 || state.last_known_good != running || !state.attempting.is_empty() {
        state.mark_started(&running);
        update::save_state(&app, &state);
    }
}

/// What view the front end should show on start (a `--view=` argument or a tray item).
#[tauri::command]
fn take_pending_view(app: AppHandle) -> Option<String> {
    let st = app.state::<AppState>();
    let taken = st.pending_view.lock().ok()?.take();
    // ⚠ Logged when it is HANDED OVER, not when it is parsed. C17's `desktop-walk` drives
    // `--view=<v>` and needs to tell "the view was refused" from "the view never reached the page"
    // — and a missing result is a FAIL in that harness, so the distinction decides whether a lane
    // failure is a bug or a typo.
    if let Some(v) = taken {
        st.logger.info(&format!("view requested: {v}"));
    }
    taken.map(|v| v.to_string())
}

/// A deep link that arrived before the page was listening (FR-14.12).
#[tauri::command]
fn take_pending_deep_link(app: AppHandle) -> Option<String> {
    let st = app.state::<AppState>();
    let mut guard = st.pending_deep_link.lock().ok()?;
    guard.take()
}

/// Resolve a path inside the registered server origin — the only way a page may build a URL.
///
/// ⚠ The page never constructs the target itself. Both of FR-14.12's checks happen here: the path
/// shape, then the **resolved origin**.
#[tauri::command]
fn resolve_server_url(app: AppHandle, path: String) -> Option<String> {
    let s = settings::load(&app);
    validate::resolve_in_origin(&s.server_url, &path)
}

/// Open the log folder in the OS file manager.
#[tauri::command]
fn open_log_folder(app: AppHandle) -> Result<(), String> {
    let dir = paths::log_dir(&app)?;
    open_in_os(&app, &dir.to_string_lossy())
}

/// **Open LGR** (FR-14.13) — the `lgr-web` window lands in C10.
///
/// ⚠ Takes NO url. The page asks for "the app"; the origin comes from settings and the path from
/// the assignment, both re-validated here (FR-14.12). A command that accepted a URL would be one
/// a compromised page could point anywhere, which is the whole reason `resolve_server_url` exists.
#[tauri::command]
fn open_lgr(app: AppHandle) -> Result<(), String> {
    let s = settings::load(&app);
    // The assignment's `startPath` arrives with C06/C07; `/` is the documented fallback and
    // `web::target_url` re-validates whichever it gets.
    let start_path = assigned_start_path(&app);

    if s.open_in_system_browser {
        let target = web::target_url(&s.server_url, start_path.as_deref())
            .ok_or_else(|| "the configured server address is not usable".to_string())?;
        app.state::<AppState>()
            .logger
            .info(&format!("open_lgr: system-browser url={target}"));
        return open_in_os(&app, &target);
    }

    web::open(&app, &s.server_url, start_path.as_deref())
}

/// The desktop's assigned start page (FR-14.16), as stored at enrollment.
///
/// ⚠ Still re-validated downstream by `web::target_url`. The value came from the server, but it
/// reaches a navigation, and `//evil.example` is a path-shaped string that is not a path.
fn assigned_start_path(_app: &AppHandle) -> Option<String> {
    let dir = keystore::secure_dir().ok()?;
    let stored = keystore::load(&dir);
    (!stored.start_path.is_empty()).then_some(stored.start_path)
}

/// Send the cloud app to the OS print dialog (FR-14.15).
///
/// ⚠ The PAGE's own `window.print()` behaves differently in WebView2, WKWebView and WebKitGTK
/// and is exercised per platform (C15, C17) — it is not something this process can make
/// uniform. What this command guarantees is a route to the dialog that does not depend on the
/// page: the tray and a shortcut can reach it even when the page's button does nothing.
#[tauri::command]
fn print_lgr(app: AppHandle) -> Result<(), String> {
    let Some(w) = app.get_webview_window(web::WEB_LABEL) else {
        return Err("lgr_web_not_open".into());
    };
    // C15 asserts on this line: a print dialog is not observable from CDP.
    app.state::<AppState>().logger.info("lgr-web: print-requested");
    w.print().map_err(|e| e.to_string())
}

/// Ask the hub what it is offering (FR-14.28).
///
/// ⚠ Answers honestly on every axis: whether a newer version EXISTS, whether this build is
/// REFUSED, and whether this machine may install anything at all. A per-machine install reports
/// `managed` and is never offered an Install button that cannot work.
#[tauri::command]
fn check_for_updates(app: AppHandle) -> Result<update::CheckResult, String> {
    let s = settings::load(&app);
    let running = app.package_info().version.to_string();
    let kind = update::detect_install_kind(
        &std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
    );

    let (offered, min_version) = enroll::fetch_manifest(&s.server_url).map_err(|e| e.to_string())?;

    let available = offered.filter(|v| update::is_upgrade(&running, v));
    let required = min_version
        .as_deref()
        .map(|m| !update::meets_minimum(&running, m))
        .unwrap_or(false);

    app.state::<AppState>().logger.info(&format!(
        "update check: running={running} offered={available:?} required={required} kind={}",
        kind.as_str()
    ));

    Ok(update::CheckResult {
        available,
        required,
        install_kind: kind.as_str(),
        managed: !kind.may_self_install(),
    })
}

/// Install a version the hub offered, if now is a safe moment (FR-14.28).
#[tauri::command]
fn install_update(app: AppHandle, version: String) -> Result<String, String> {
    let running = app.package_info().version.to_string();
    // ⚠ C18 supplies the real till state. Until the native bridge exists there is no fiscal
    // command to be mid-way through, so `Idle` is the truthful answer rather than a placeholder.
    let till = update::TillState::Idle;

    let state = app.state::<AppState>();
    match update::try_install(&app, &running, &version, till, &state.deferrals)? {
        update::UpdateAction::Install => Ok("installing".into()),
        update::UpdateAction::Defer => Ok("deferred".into()),
    }
}

/// Replace this desktop's keypair (FR-14.32). C11 implements it.
///
/// ⚠ Refuses rather than pretending. A Settings button that reported success while rotating
/// nothing would leave an operator believing a compromised key had been replaced.
#[tauri::command]
fn rotate_desktop_key(app: AppHandle) -> Result<(), String> {
    let s = settings::load(&app);
    let version = app.package_info().version.to_string();
    enroll::rotate_key(&s.server_url, &version).map_err(|e| e.to_string())
}

/// Exchange a registration code for this desktop's identity (FR-14.19).
#[tauri::command]
fn enroll_desktop(app: AppHandle, req: EnrollRequest) -> Result<(), String> {
    // ⚠ Shape first, network second. A typo in the address or the code must say so immediately
    // rather than after a 20-second timeout against something that was never a server.
    let server = validate::normalize_server_url(&req.server_url).ok_or("invalid_server_url")?;
    if !is_enrollment_code(&req.code) {
        return Err("invalid_code".into());
    }

    let version = app.package_info().version.to_string();
    let name = if req.name.trim().is_empty() { settings::hostname() } else { req.name.clone() };

    let stored = enroll::enroll(&server, &req.code, &name, &version).map_err(|e| {
        app.state::<AppState>().logger.warn(&format!("enroll failed: {e}"));
        e.to_string()
    })?;

    // The address that worked is the one to keep — onboarding may have upgraded or trimmed what
    // was typed, and the stored settings must match what the registration was made against.
    let mut cfg = settings::load(&app);
    cfg.server_url = server;
    cfg.desktop_name = name;
    let _ = settings::save(&app, &cfg);

    app.state::<AppState>()
        .logger
        .info(&format!("enrolled desktop={} org={}", stored.desktop_id, stored.org_name));

    // ⚠ Prove the stored key actually works before telling anyone this machine is registered.
    // Enrollment only proves the server accepted a PUBLIC key; minting a token is the first
    // thing that exercises the private half out of the OS keystore, and it is also where the
    // clock offset is learned. Finding out at the first sale instead would be a till that is
    // "registered" and cannot authenticate.
    match enroll::mint_token(&cfg.server_url) {
        Ok(_) => {
            app.state::<AppState>().logger.info("enrollment verified: token minted");
            Ok(())
        }
        Err(e) => {
            app.state::<AppState>()
                .logger
                .error(&format!("enrolled but cannot mint a token: {e}"));
            Err(format!("enrolled_but_token_failed:{e}"))
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollRequest {
    server_url: String,
    #[allow(dead_code)]
    name: String,
    code: String,
}

/// `XXXX-XXXX`, as minted on the Desktops page (C06).
fn is_enrollment_code(code: &str) -> bool {
    let bytes = code.as_bytes();
    bytes.len() == 9
        && bytes[4] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, c)| i == 4 || c.is_ascii_uppercase() || c.is_ascii_digit())
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

/// What this machine's non-roaming storage says about its registration (FR-14.18, FR-14.20).
///
/// ⚠ The KEY is what decides `registered`, not the record. A `registration.json` copied from
/// another PC carries ids but no usable credential, and reporting it as registered would be the
/// Overview vouching for a machine that cannot mint a token (AC 10).
/// ⚠ A struct rather than a tuple: this grew to six fields, and `reg_status.5` at the call site
/// is how `key_storage` and `clock_skew` eventually get swapped by somebody adding a seventh.
struct RegistrationSnapshot {
    registration: status::Registration,
    key_storage: keystore::KeyStorage,
    devices: Vec<String>,
    clock_skew_ms: Option<i64>,
    assignment: status::Assignment,
    /// FR-14.29 — the hub refused this build the last time it was asked.
    update_required: bool,
}

impl Default for RegistrationSnapshot {
    fn default() -> Self {
        Self {
            registration: status::Registration {
                state: "not_registered".into(),
                desktop_id: None,
                org_slug: None,
            },
            key_storage: keystore::KeyStorage::None,
            devices: vec![],
            clock_skew_ms: None,
            assignment: status::Assignment::default(),
            update_required: false,
        }
    }
}

fn registration_status() -> RegistrationSnapshot {
    let Ok(dir) = keystore::secure_dir() else {
        return RegistrationSnapshot::default();
    };
    let stored = keystore::load(&dir);
    let storage = keystore::key_storage(&dir);

    let state = if stored.revoked {
        "revoked"
    } else if !stored.desktop_id.is_empty() && storage != keystore::KeyStorage::None {
        "registered"
    } else {
        "not_registered"
    };

    let assignment = status::Assignment {
        start_path: (!stored.start_path.is_empty()).then(|| stored.start_path.clone()),
        // An assigned start path is one an administrator set, which is what makes the Settings
        // field read-only (FR-14.32).
        managed: !stored.start_path.is_empty(),
    };
    // ⚠ The Overview reports how far the MACHINE is out, which is the opposite sign of the
    // offset applied to `iat`. `skew_ms()` owns that inversion so it exists in one place.
    let offset = identity::ClockOffset { millis: stored.clock_offset_ms };
    let skew = (stored.clock_offset_ms != 0).then(|| offset.skew_ms());

    RegistrationSnapshot {
        registration: status::Registration {
            state: state.into(),
            desktop_id: (!stored.desktop_id.is_empty()).then(|| stored.desktop_id.clone()),
            org_slug: (!stored.org_name.is_empty()).then(|| stored.org_name.clone()),
        },
        key_storage: storage,
        devices: stored.fiscal_device_ids.clone(),
        clock_skew_ms: skew,
        assignment,
        update_required: stored.update_required,
    }
}

fn build_status(app: &AppHandle) -> status::Status {
    let s = settings::load(app);
    let reg_status = registration_status();
    let log_path = app
        .state::<AppState>()
        .logger
        .path()
        .to_string_lossy()
        .to_string();
    status::Status {
        schema_version: status::SCHEMA_VERSION,
        app_version: app.package_info().version.to_string(),
        os: status::OsInfo::current(),
        server_url: s.server_url.clone(),
        desktop_name: s.desktop_name.clone(),
        registration: reg_status.registration,
        bridge: status::Bridge { supported: false, devices: reg_status.devices },
        autostart: s.autostart,
        open_lgr_on_launch: s.open_lgr_on_launch,
        log_path,
        // ⚠ An unmeasured clock stays `None` rather than becoming a skew of zero — the Overview
        // renders these as states a person reads out on a support call, and a flattering default
        // is a lie there. `unknown` likewise is not `connected`.
        server_link: app.state::<AppState>().link.get().as_str().into(),
        key_storage: reg_status.key_storage.as_str().into(),
        clock_skew_ms: reg_status.clock_skew_ms,
        // FR-14.29 — `required` is the hub's 426 as last seen, so the Overview's banner survives
        // a restart. `available` stays false until a manifest has actually offered something:
        // "an update exists" and "this build is refused" are different sentences, and the banner
        // that matters is the second.
        update: status::Update {
            available: false,
            required: reg_status.update_required,
            version: None,
        },
        assignment: reg_status.assignment,
    }
}

/// Start the presence socket (FR-14.21), if this machine is registered.
///
/// ⚠ A thread, not a task: the shell has no async runtime, and one socket that speaks every 30 s
/// does not justify adding one. An UNREGISTERED desktop starts nothing — there is no credential
/// to authenticate with, and a socket that could only ever be refused is noise in the server's
/// audit log.
fn start_presence(app: &AppHandle) {
    let stored_registered = keystore::secure_dir()
        .map(|d| {
            let s = keystore::load(&d);
            !s.desktop_id.is_empty() && !s.revoked && keystore::key_storage(&d) != keystore::KeyStorage::None
        })
        .unwrap_or(false);
    if !stored_registered {
        app.state::<AppState>().logger.info("presence: not registered, socket not started");
        return;
    }

    let server_url = settings::load(app).server_url;
    let state = app.state::<AppState>();
    let link = state.link.clone();
    let stop = state.stop.clone();
    let handle = app.clone();

    std::thread::spawn(move || {
        presence::run(server_url, link, stop, move |event| match event {
            presence::Event::Authenticated => {
                handle.state::<AppState>().logger.info("presence: authenticated");
                let _ = handle.emit_to("main", "shell:link", "connected");

                // FR-14.21 — report version, OS and ports once the socket is up.
                //
                // ⚠ Here rather than at startup, and only on a FRESH authentication: it needs a
                // token, and a desktop that cannot authenticate has nothing to report to. ⚠ And
                // on its own thread — the presence loop is about to block on `read()`, and a
                // slow PUT would delay the first heartbeat.
                let reporter = handle.clone();
                std::thread::spawn(move || {
                    let url = settings::load(&reporter).server_url;
                    let version = reporter.package_info().version.to_string();
                    // Serial ports arrive with C18's bridge; an empty list is the honest answer
                    // from a shell that cannot enumerate them yet.
                    match enroll::report_self(&url, &version, &[]) {
                        Ok(()) => reporter.state::<AppState>().logger.info("presence: self reported"),
                        Err(e) => reporter
                            .state::<AppState>()
                            .logger
                            .warn(&format!("presence: self report failed: {e}")),
                    }
                });
            }
            presence::Event::Revoked(msg) => {
                // FR-14.22, in the order the chunk sets out: say so, stop the bridge, delete the
                // key. `mark_revoked` does the last two; this is the "say so".
                handle
                    .state::<AppState>()
                    .logger
                    .error(&format!("presence: this desktop was revoked: {msg}"));
                if let Ok(dir) = keystore::secure_dir() {
                    let mut stored = keystore::load(&dir);
                    enroll::mark_revoked(&dir, &mut stored);
                }
                let _ = handle.emit_to("main", "shell:revoked", msg);
                // Bring the shell forward: a till whose registration just died must not keep
                // showing a cloud app it can no longer reach.
                show_main(&handle, Some("overview"));
            }
            presence::Event::UpdateRequested => {
                // C13 acts on this; recorded now so the path is not invented later.
                handle.state::<AppState>().logger.info("presence: update requested by server");
                let _ = handle.emit_to("main", "shell:update-requested", ());
            }
            presence::Event::Disconnected => {
                let _ = handle.emit_to("main", "shell:link", "unreachable");
            }
        });
    });
}

/// Show and focus the main window, optionally routing it to a view first.
fn show_main(app: &AppHandle, view: Option<&'static str>) {
    if let Some(v) = view {
        if let Ok(mut pending) = app.state::<AppState>().pending_view.lock() {
            *pending = Some(v);
        }
        let _ = app.emit_to("main", "shell:view", v);
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Open a path with the OS default handler.
///
/// ⚠ `tauri-plugin-opener`, not `ShellExt::shell().open()` — the latter is deprecated and clippy
/// under `-D warnings` (which `ci.yml` runs) refuses it. That is the right outcome: opening a path
/// is exactly the operation worth keeping on a maintained, scoped API.
fn open_in_os(_app: &AppHandle, target: &str) -> Result<(), String> {
    tauri_plugin_opener::open_path(target, None::<&str>).map_err(|e| e.to_string())
}

/// Handle a `lgr://` URL (FR-14.12).
fn handle_deep_link(app: &AppHandle, raw: &str) {
    let st = app.state::<AppState>();
    let store = |link: &str| {
        if let Ok(mut p) = st.pending_deep_link.lock() {
            *p = Some(link.to_string());
        }
    };
    match validate::parse_deep_link(raw) {
        // ⚠ Enroll PRE-FILLS and asks. It never registers silently — the front end shows the
        // confirmation, which is why this only stores and routes.
        Some(validate::DeepLink::Enroll { .. }) => {
            st.logger.info("deep link: enroll (awaiting confirmation)");
            store(raw);
            show_main(app, Some("onboarding"));
        }
        Some(validate::DeepLink::Open { path }) => {
            st.logger.info(&format!("deep link: open {path}"));
            store(raw);
            show_main(app, Some("overview"));
        }
        Some(validate::DeepLink::Login { code }) => {
            // FR-14.14 — the system browser finished an OAuth handshake and sent the one-time
            // code back. ⚠ NOT stored as a pending deep link: this one is acted on immediately
            // and in Rust, because redeeming it needs the verifier, which never leaves this
            // process until it goes into `lgr-web`'s URL fragment. Parking it for the front end
            // would mean handing the code to a page that cannot complete it.
            //
            // ⚠ The CODE is not logged. It is half a credential for the next 60 seconds.
            st.logger.info("deep link: login code received");
            web::finish_desktop_oauth(app, &code);
        }
        None => {
            // ⚠ Refused, and said so. A deep link is attacker-controlled input: `lgr://` is
            // registered with the OS, so any process or page on this machine can send one.
            st.logger.warn("deep link refused: not a link this app understands");
        }
    }
}

/// Wait for the fiscal bridge to go idle, then exit (FR-14.6).
fn quit(app: &AppHandle) {
    let st = app.state::<AppState>();
    // ⚠ Bounded. "Wait for the bridge" must never become "never quit": a stuck bridge would
    // otherwise leave a window nobody can close.
    for _ in 0..100 {
        let busy = st.bridge_busy.lock().map(|b| *b).unwrap_or(false);
        if !busy {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    st.logger.info("quitting");
    app.exit(0);
}

fn main() {
    // ── `--status-json` answers before any window exists ───────────────────────────────────
    //
    // ⚠ Handled before the Tauri builder, so it works on a machine where the app cannot start a
    // window at all — which is exactly when a harness most needs an answer. It prints what is on
    // disk and needs no IPC to do it.
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--status-json") {
        print_status_without_app();
        return;
    }

    let requested_view = args
        .iter()
        .find_map(|a| a.strip_prefix("--view="))
        .and_then(validate::parse_view);

    let result = tauri::Builder::default()
        // ⚠ Registered FIRST, as the plugin requires: a second launch must reach the running
        // instance rather than start a rival that would fight it for the till's serial port.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let view = argv
                .iter()
                .find_map(|a| a.strip_prefix("--view="))
                .and_then(validate::parse_view);
            app.state::<AppState>().logger.info("second instance: focusing the running one");
            show_main(app, view);
            // A deep link delivered to the second instance belongs to the first.
            if let Some(link) = argv.iter().find(|a| a.starts_with("lgr://")) {
                handle_deep_link(app, link);
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        // FR-14.15 — the Save-as dialog for `lgr-web`'s downloads. ⚠ Used from Rust only, in
        // `web::save_as`; it is deliberately NOT in any capability, so neither the shell's
        // pages nor the cloud app can open a file picker through it.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        // ⚠ Per-user, and the installer registers nothing machine-wide. Autostart on a shared PC
        // would otherwise start the app for every user who signs in (FR-14.7, trap 13).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            shell_ready,
            get_settings,
            save_settings,
            get_status,
            read_logs,
            create_diagnostics_bundle,
            open_log_folder,
            take_pending_view,
            take_pending_deep_link,
            resolve_server_url,
            open_lgr,
            print_lgr,
            check_for_updates,
            install_update,
            rotate_desktop_key,
            enroll_desktop,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let log_dir = paths::log_dir(&handle).unwrap_or_else(|_| std::env::temp_dir());
            let logger = logs::Logger::new(log_dir);
            logger.info(&format!(
                "LGR Desktop {} starting on {} {}",
                app.package_info().version,
                std::env::consts::OS,
                std::env::consts::ARCH
            ));
            let st = AppState::new(logger);
            if let Some(v) = requested_view {
                if let Ok(mut pending) = st.pending_view.lock() {
                    *pending = Some(v);
                }
            }
            app.manage(st);

            build_tray(&handle)?;

            // A deep link that launched the app (Windows and Linux deliver it as an argument).
            if let Some(link) = std::env::args().find(|a| a.starts_with("lgr://")) {
                handle_deep_link(&handle, &link);
            }
            // …and any that arrive while it runs (how macOS always delivers them).
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let h = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle_deep_link(&h, url.as_str());
                    }
                });
            }

            // FR-14.16 / AC 8 — after autostart, the POS is on screen without anyone touching
            // it. ⚠ Only when the setting is on AND no `--view=` or deep link already decided
            // where this launch should land: a person who opened Settings from the tray must
            // not have the cloud app thrown over the top of it.
            if settings::load(&handle).open_lgr_on_launch && requested_view.is_none() {
                if let Err(e) = open_lgr(handle.clone()) {
                    // Not fatal. A till with no network still has to finish starting, and the
                    // Overview is what tells its operator why the screen is empty.
                    handle
                        .state::<AppState>()
                        .logger
                        .error(&format!("open_lgr on launch: {e}"));
                }
            }

            // FR-14.28 — crash-loop detection.
            //
            // ⚠ Counted at SETUP and cleared at `shell_ready`. A start that reaches here and then
            // dies before the UI renders is exactly the failure this catches, so the increment
            // has to happen before the thing that might not survive. Three in a row and the
            // last known good version is reported as the one to go back to.
            {
                let mut st = update::load_state(&handle);
                if let Some(revert_to) = st.mark_failed_start() {
                    handle.state::<AppState>().logger.error(&format!(
                        "crash loop detected ({} failed starts); last known good is {revert_to}",
                        st.consecutive_failed_starts
                    ));
                }
                update::save_state(&handle, &st);
            }

            start_presence(&handle);

            handle.state::<AppState>().logger.info("setup complete");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // ⚠ This fires for EVERY window, and the two must be handled differently.
                //
                // `main` hides and keeps running in the tray (FR-14.6), taking `lgr-web` with
                // it — a hidden window holding a signed-in cloud session is how a till shows
                // the previous shift's user.
                //
                // `lgr-web` closing is just the person closing the app window: let it be
                // DESTROYED, which is Tauri's default. Hiding it and preventing the close —
                // which is what this handler did to every window — left exactly the signed-in
                // hidden webview the rule above exists to prevent, and it could never be
                // reopened because `web::open` would find it and merely focus it.
                let app = window.app_handle();
                if window.label() == web::WEB_LABEL {
                    app.state::<AppState>().logger.info("lgr-web: closed");
                    return;
                }
                web::close(app);
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!());

    if let Err(e) = result {
        let msg = format!("Application failed to start: {e}");
        eprintln!("{msg}");
        fallback_log(&msg);
        #[cfg(target_os = "windows")]
        windows_message_box(&msg);
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    // FR-14.6 — five items, in this order.
    // ⚠ `_item`, because the command below is also called `open_lgr` and a local binding would
    // shadow it inside the menu-event closure.
    let open_lgr_item = MenuItem::with_id(app, "open-lgr", "Open LGR", true, None::<&str>)?;
    let overview = MenuItem::with_id(app, "overview", "Overview", true, None::<&str>)?;
    // ⚠ Disabled until FR-14.28 ships the updater. A menu item that silently does nothing is
    // worse than one that is visibly not ready yet.
    let updates = MenuItem::with_id(app, "check-updates", "Check for updates", false, None::<&str>)?;
    let open_logs = MenuItem::with_id(app, "open-logs", "Open logs folder", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_lgr_item, &overview, &updates, &open_logs, &quit_item])?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("LGR Desktop")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            // FR-14.13 — the tray's Open LGR opens the window directly. It is the item a till
            // operator uses, and routing it through the Overview would mean two clicks to get
            // back to the screen they were just looking at.
            "open-lgr" => {
                if let Err(e) = open_lgr(app.clone()) {
                    app.state::<AppState>().logger.error(&format!("open_lgr: {e}"));
                    show_main(app, Some("overview"));
                }
            }
            "overview" => show_main(app, Some("overview")),
            "open-logs" => {
                if let Ok(dir) = paths::log_dir(app) {
                    let _ = open_in_os(app, &dir.to_string_lossy());
                }
            }
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left click opens the Overview (FR-14.6).
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                show_main(tray.app_handle(), Some("overview"));
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

/// `--status-json` without a Tauri app: read the settings file from the same non-roaming location
/// the app uses and print what can be known.
///
/// ⚠ It must not construct an `AppHandle`, because the point is to answer on a machine where the
/// app will not start.
fn print_status_without_app() {
    let dir = local_data_dir_without_app();
    let s: settings::Settings = dir
        .as_ref()
        .and_then(|d| std::fs::read_to_string(d.join("settings.json")).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let log_path = dir
        .as_ref()
        .map(|d| d.join("logs").join("lgr-desktop.log").to_string_lossy().to_string())
        .unwrap_or_default();
    let st = status::Status {
        schema_version: status::SCHEMA_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: status::OsInfo::current(),
        server_url: s.server_url,
        desktop_name: s.desktop_name,
        registration: status::Registration {
            state: "not_registered".into(),
            desktop_id: None,
            org_slug: None,
        },
        bridge: status::Bridge { supported: false, devices: vec![] },
        autostart: s.autostart,
        open_lgr_on_launch: s.open_lgr_on_launch,
        log_path,
        // ⚠ `--status-json` runs on a machine where the app will not start, so it can only
        // report what a settings file knows. Everything registration-shaped stays at its
        // "not measured" value rather than being guessed from the file.
        server_link: "unknown".into(),
        key_storage: "none".into(),
        clock_skew_ms: None,
        update: status::Update::default(),
        assignment: status::Assignment::default(),
    };
    // One line, so every consumer can capture it (see `status`).
    println!("{}", serde_json::to_string(&st).unwrap_or_else(|_| "{}".into()));
}

/// The same non-roaming directory `paths::local_dir` resolves, without an app handle.
fn local_data_dir_without_app() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("LOCALAPPDATA").map(|p| std::path::PathBuf::from(p).join("com.lgr.desktop"))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(|h| std::path::PathBuf::from(h).join("Library/Application Support/com.lgr.desktop"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share"))
            })
            .map(|p| p.join("com.lgr.desktop"))
    }
}

/// Last-resort log when the app could not start, so `windows_subsystem = "windows"` hiding stderr
/// does not turn a startup failure into silence.
fn fallback_log(msg: &str) {
    if let Some(dir) = local_data_dir_without_app() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("startup-error.log"))
        {
            let _ = writeln!(f, "[{}] {msg}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
        }
    }
}

#[cfg(target_os = "windows")]
fn windows_message_box(msg: &str) {
    use std::ffi::CString;
    let text = CString::new(msg).unwrap_or_default();
    let title = CString::new("LGR Desktop Error").unwrap_or_default();
    unsafe {
        extern "system" {
            fn MessageBoxA(
                hwnd: *mut std::ffi::c_void,
                text: *const i8,
                caption: *const i8,
                utype: u32,
            ) -> i32;
        }
        MessageBoxA(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10);
    }
}
