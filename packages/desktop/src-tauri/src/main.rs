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

mod bridge;
mod diagnostics;
mod discovery;
mod enroll;
mod framing;
mod identity;
mod keystore;
mod presence;
mod repoint;
mod proxy;
mod logs;
mod paths;
mod settings;
mod status;
mod trust;
mod update;
mod install;
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

/// Set before the process restarts into an update or a re-point: the same desktop coming straight
/// back, which an ephemeral desktop must never unregister for (`should_unregister`).
pub(crate) static RESTARTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Everything the shell knows about itself at runtime.
pub struct AppState {
    logger: logs::Logger,
    /// FR-14.26 — the native fiscal bridge: what holds the till's serial ports, and the state
    /// C08's Quit, C13's deferral and C09's Overview all read.
    ///
    /// ⚠ This replaced a `bridge_busy: Arc<Mutex<bool>>` placeholder that C08 put here so the
    /// quit path would not have to be reopened. It was not: the field changed type, the wait
    /// stayed where it was.
    bridge: Arc<bridge::BridgeState>,
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
    /// Have the presence socket and the fiscal bridges been started for this process?
    ///
    /// ⚠ The latch exists because both are started from TWO places: `setup` (a till that was
    /// already registered when it launched) and the end of a successful enrollment (a till that
    /// was not). Without it, re-enrolling a running desktop would spawn a second presence thread
    /// and a second bridge thread per device — and two threads on one serial port is the one thing
    /// the fiscal protocol cannot survive.
    ///
    /// ⚠ It is NOT cleared on revocation. A revoked desktop's threads stop on their own
    /// (`bridge::halt`, and the presence loop sees `revoked`), and re-enrolling after that needs a
    /// restart — which is the honest outcome, because `halt()` is deliberately one-way.
    started: Arc<std::sync::atomic::AtomicBool>,
    /// The stop flag of the presence run currently in flight.
    ///
    /// ⚠ **Per-run, not the process-wide `stop`.** Re-pointing a running desktop at another
    /// server has to end THAT run and start a new one; reusing the shutdown flag would mean
    /// setting it false again, and the old thread can read it after the reset - two presence
    /// threads, which is what the `started` latch exists to prevent. `quit` sets this as well.
    presence_stop: Arc<Mutex<Option<Arc<std::sync::atomic::AtomicBool>>>>,
    /// FR-20.82 — the org moved and this desktop has not followed (yet), for the Overview.
    org_moved: Arc<Mutex<Option<status::OrgMoved>>>,
    /// FR-14.28 — how many times the pending update has been put off for a busy till.
    deferrals: Arc<update::Deferrals>,
    /// FR-14.14 — the PKCE verifier for an OAuth flow currently in the system browser.
    ///
    /// ⚠ **In memory only, and taken once.** It is the half of the credential that makes the
    /// `lgr://login` code redeemable; writing it anywhere would hand a thief of that scheme the
    /// pair. `None` means no flow is in progress, which is what makes an unsolicited `lgr://login`
    /// something to ignore rather than act on.
    oauth_verifier: Arc<Mutex<Option<String>>>,
    /// FR-20.39 (P2-4b): a master's "Sign in with LGR" in flight: its state and the shell's verifier.
    /// Memory only, like `oauth_verifier`.
    idp_flow: Arc<Mutex<Option<(String, String)>>>,
    /// FR-20.32 — the loopback proxy `lgr-web` reaches a paired master through (`proxy.rs`).
    /// `None` until a master's window is opened, and for lgrai.app, which the window loads directly.
    proxy: Arc<Mutex<Option<proxy::Running>>>,
}

impl AppState {
    fn new(logger: logs::Logger) -> Self {
        Self {
            logger,
            bridge: Arc::new(bridge::BridgeState::default()),
            pending_view: Arc::new(Mutex::new(None)),
            pending_deep_link: Arc::new(Mutex::new(None)),
            link: Arc::new(presence::LinkState::default()),
            retrying: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            started: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            presence_stop: Arc::new(Mutex::new(None)),
            org_moved: Arc::new(Mutex::new(None)),
            deferrals: Arc::new(update::Deferrals::default()),
            oauth_verifier: Arc::new(Mutex::new(None)),
            idp_flow: Arc::new(Mutex::new(None)),
            proxy: Arc::new(Mutex::new(None)),
        }
    }
}

/// The window's way to `server_url` (FR-20.32): for a paired master, the loopback proxy's origin
/// and its boot URL for `path`, starting the proxy if it is not running. `None` for any other
/// server, which the window loads directly.
///
/// ⚠ The port is the installation's (`settings.proxyPort`). A new port is a new origin, and the
/// window's per-origin storage, the SPAs' sessions included, would start over at every launch.
pub(crate) fn proxy_route(app: &AppHandle, server_url: &str, path: &str) -> Result<Option<(String, String)>, String> {
    let Some(tls) = trust::pinned_tls(server_url)? else {
        stop_proxy(app);
        return Ok(None);
    };
    let master = url::Url::parse(server_url).map_err(|e| e.to_string())?;
    let st = app.state::<AppState>();
    let mut slot = st.proxy.lock().map_err(|_| "the proxy's state is poisoned".to_string())?;
    if slot.as_ref().is_some_and(|r| r.master != master.origin().ascii_serialization()) {
        if let Some(old) = slot.take() {
            old.stop();
        }
    }
    if slot.is_none() {
        let mut cfg = settings::load(app);
        let server = server_url.to_string();
        let log_app = app.clone();
        let up = proxy::Upstream {
            origin: master.clone(),
            tls: Arc::new(tls),
            token: Arc::new(move || enroll::mint_token(&server).map_err(|e| e.to_string())),
        };
        let log = Arc::new(move |m: &str| log_app.state::<AppState>().logger.info(m));
        let running = proxy::start(up, cfg.proxy_port, log)?;
        if running.port != cfg.proxy_port {
            if cfg.proxy_port != 0 {
                st.logger.warn(&format!(
                    "proxy: port {} is taken; the window moves to {} and its sessions start over",
                    cfg.proxy_port, running.port
                ));
            }
            cfg.proxy_port = running.port;
            let _ = settings::save(app, &cfg);
        }
        st.logger.info(&format!("proxy: {} -> {}", running.origin(), running.master));
        *slot = Some(running);
    }
    let running = slot.as_ref().expect("started just above");
    Ok(Some((running.origin(), running.boot_url(path))))
}

/// Stop the loopback proxy, if one runs: the desktop left its master, or its pin changed.
pub(crate) fn stop_proxy(app: &AppHandle) {
    if let Some(running) = app.state::<AppState>().proxy.lock().ok().and_then(|mut s| s.take()) {
        running.stop();
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
    // ⚠ What this desktop trusts is enrollment's to change, never the page's (FR-20.29): a pin is
    // written only after a pairing has checked the CA against its fingerprint. The proxy's port and
    // the window's server are the shell's own bookkeeping (FR-20.32): a page holding a copy read
    // before they changed would otherwise move the window to a new origin and lose its sessions.
    let on_disk = settings::load(&app);
    s.master = on_disk.master;
    s.proxy_port = on_disk.proxy_port;
    s.web_server = on_disk.web_server;
    // FR-20.82: a re-point's epoch is the shell's to raise; the page must not lower it.
    s.home_epoch = on_disk.home_epoch;
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
///
/// ⚠ **`async`, and that is a bug fix, not a style choice.** Tauri runs a SYNCHRONOUS command on
/// the main thread, and `WebviewWindowBuilder::build()` needs the event loop — which is the thread
/// it is being called from. So this deadlocked: the `lgr-web` window appeared as a half-created
/// `about:blank`, the promise never settled, and **every later `invoke` hung too**, because the
/// main thread never came back. The app was frozen by its own primary button.
///
/// Nothing caught it because the two paths anybody had exercised — the tray item and
/// `openLgrOnLaunch` — do not run inside a command handler. C15's CDP walk is what found it: it is
/// the first thing to press the button the way a user does.
///
/// `spawn_blocking` rather than a bare `async fn` body: everything below is blocking (a 5 s probe,
/// then window construction), and blocking inside an async task would occupy a runtime worker
/// instead of the main thread — better, but still wrong. From a blocking thread, `build()`
/// dispatches to the event loop and waits for it, which is the supported direction.
#[tauri::command]
async fn open_lgr(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_lgr_blocking(&app))
        .await
        .map_err(|e| format!("open_lgr could not run: {e}"))?
}

fn open_lgr_blocking(app: &AppHandle) -> Result<(), String> {
    let s = settings::load(app);
    // The assignment's `startPath` arrives with C06/C07; `/` is the documented fallback and
    // `web::target_url` re-validates whichever it gets.
    let start_path = assigned_start_path(app);

    // ⚠ Never for a master (FR-20.32): a browser cannot trust its CA, and the proxy's launch
    // secret belongs in the window's own cookie jar. In a browser's, every other server on
    // 127.0.0.1 would be sent it (cookies ignore ports).
    let master = trust::pin_for(&s.server_url).is_some();
    if s.open_in_system_browser && master {
        app.state::<AppState>()
            .logger
            .info("open_lgr: a master opens in its own window, never the system browser");
    }
    if s.open_in_system_browser && !master {
        let target = web::target_url(&s.server_url, start_path.as_deref())
            .ok_or_else(|| "the configured server address is not usable".to_string())?;
        app.state::<AppState>()
            .logger
            .info(&format!("open_lgr: system-browser url={target}"));
        return open_in_os(app, &target);
    }

    web::open(app, &s.server_url, start_path.as_deref())
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
///
/// ⚠ `async`, for the same reason as `open_lgr`: a print dialog is a modal the EVENT LOOP has to
/// drive, and a synchronous command occupies the thread that would drive it. Off the main thread,
/// the dialog opens and this resolves when it closes.
#[tauri::command]
async fn print_lgr(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(w) = app.get_webview_window(web::WEB_LABEL) else {
            return Err("lgr_web_not_open".into());
        };
        // C15 asserts on this line: a print dialog is not observable from CDP.
        app.state::<AppState>().logger.info("lgr-web: print-requested");
        w.print().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("print_lgr could not run: {e}"))?
}

/// Ask the hub what it is offering (FR-14.28).
///
/// ⚠ Answers honestly on every axis: whether a newer version EXISTS, whether this build is
/// REFUSED, and whether this machine may install anything at all. A per-machine install reports
/// `managed` and is never offered an Install button that cannot work.
#[tauri::command]
fn check_for_updates(app: AppHandle) -> Result<update::CheckResult, String> {
    run_update_check(&app)
}

/// The check itself, shared by the Overview's button and the background loop.
fn run_update_check(app: &AppHandle) -> Result<update::CheckResult, String> {
    let s = settings::load(app);
    let running = app.package_info().version.to_string();
    let kind = update::detect_install_kind_here();

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
    let state = app.state::<AppState>();
    // FR-14.28 — the bridge is what knows whether the till is in use: a command in flight, or one
    // within `BUSY_WINDOW_SECS`. See `BridgeState::till_state` for why it never reports
    // `MidReceipt`.
    let till = state.bridge.till_state();

    match update::try_install(&app, &running, &version, till, &state.deferrals)? {
        update::UpdateAction::Install => Ok("installing".into()),
        update::UpdateAction::Defer => Ok("deferred".into()),
    }
}

/// FR-14.28 — the background half of the updater, governed by the `autoUpdate` setting.
///
/// ⚠ One thread for the life of the process, started whatever the setting says, and the setting
/// re-read on every tick (`update::auto_check_due`). Starting it only when the switch was on at
/// launch would make turning it ON need a restart, and turning it OFF would not stop a loop that
/// was already running.
///
/// ⚠ It goes through exactly the path the Install button does — `try_install`, with the till
/// state and the shared deferral counter — so automatic installs carry every rule in `update.rs`:
/// no downgrade, never mid-receipt, never self-installing a per-machine install.
fn start_auto_update(app: &AppHandle) {
    let handle = app.clone();
    let stop = app.state::<AppState>().stop.clone();
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let mut last: Option<std::time::Instant> = None;
        let mut deferred = false;
        let mut logged_enabled: Option<bool> = None;
        while !stop.load(std::sync::atomic::Ordering::SeqCst) {
            let enabled = settings::load(&handle).auto_update;
            if logged_enabled != Some(enabled) {
                logged_enabled = Some(enabled);
                handle
                    .state::<AppState>()
                    .logger
                    .info(&format!("auto-update: {}", if enabled { "on" } else { "off" }));
            }
            let due = update::auto_check_due(
                enabled,
                started.elapsed().as_secs(),
                last.map(|t| t.elapsed().as_secs()),
                deferred,
            );
            // ⚠ An unregistered desktop has no token to fetch the manifest with; asking anyway
            // would log a refusal every four hours on a machine that is simply not set up yet.
            if due && stored_registered() {
                last = Some(std::time::Instant::now());
                deferred = auto_update_once(&handle);
            }
            // Short ticks so Quit is not held up and a changed setting is seen within seconds.
            std::thread::sleep(std::time::Duration::from_secs(15));
        }
    });
}

/// One automatic check, and the install attempt if it found something. Returns whether the
/// attempt was deferred for a busy till, which brings the next check forward.
fn auto_update_once(app: &AppHandle) -> bool {
    let st = app.state::<AppState>();
    let check = match run_update_check(app) {
        Ok(c) => c,
        Err(e) => {
            // ⚠ A failed check is not a failed app — a till offline for the afternoon still sells.
            st.logger.warn(&format!("auto-update: check failed: {e}"));
            return false;
        }
    };
    let Some(version) = check.available else { return false };
    if check.managed {
        // Already logged by the check (`kind=per_machine`). Whoever manages the machine installs it.
        return false;
    }

    let running = app.package_info().version.to_string();
    match update::try_install(app, &running, &version, st.bridge.till_state(), &st.deferrals) {
        Ok(update::UpdateAction::Defer) => {
            st.logger.info(&format!(
                "auto-update: {version} deferred, the till is in use ({}/{})",
                st.deferrals.count(),
                update::MAX_DEFERRALS
            ));
            true
        }
        Ok(update::UpdateAction::Install) => {
            st.logger.info(&format!("auto-update: installing {version}"));
            false
        }
        Err(e) => {
            st.logger.warn(&format!("auto-update: {version} not installed: {e}"));
            false
        }
    }
}

/// Put the paired master's pin (`settings.master`) into `trust.rs`'s registry (FR-20.31).
///
/// ⚠ Checked, not trusted: a pin whose certificate is not the one its fingerprint names, or one on a
/// name a pin may not apply to, is refused and said so. That desktop then cannot reach its master
/// until it is paired again, which is the failure to want: it trusts nothing it was not paired with.
fn restore_master_pin(app: &AppHandle) {
    let Some(m) = settings::load(app).master else { return };
    let logger = &app.state::<AppState>().logger;
    let restored = trust::MasterPin::new(&m.ca_pem, &m.fingerprint)
        .and_then(|pin| match (&m.next_ca_pem, &m.next_fingerprint) {
            (Some(pem), Some(fp)) => pin.with_next(pem, fp),
            _ => Ok(pin),
        })
        .map(|pin| trust::set_pin(&m.origin, Some(pin)));
    match restored {
        Ok(true) => {
            logger.info(&format!("trusting {} by its pinned CA {}", m.origin, m.fingerprint));
        }
        _ => logger.error(&format!("the pin for {} in the settings proves nothing: pair this desktop again", m.origin)),
    }
}

/// FR-20.30 — follow the LAN CA rotations a paired master announces: shortly after the start, then
/// hourly. A week's notice gives every till that is switched on in it 168 chances.
fn follow_ca_rotations(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(30));
        loop {
            follow_ca_rotation(&app);
            std::thread::sleep(std::time::Duration::from_secs(3600));
        }
    });
}

/// Ask the paired master about its CA, through the pinned TLS, and do what `trust::follow` decides:
/// learn an announced next CA (trusted beside the current one), or, once the switch took effect,
/// keep only the new one. The settings, the pin in force and the window's proxy all follow.
fn follow_ca_rotation(app: &AppHandle) {
    let cfg = settings::load(app);
    let Some(master) = cfg.master.clone() else { return };
    let Some(pin) = trust::pin_for(&cfg.server_url) else { return };
    let logger = &app.state::<AppState>().logger;
    let said = match trust::ca_announcement(&cfg.server_url) {
        Ok(s) => s,
        // Quiet: an unreachable master is presence's to report, and one from before P1-4 has no
        // `/__lgr/ca.json` to answer with (a desktop is often updated before its master).
        Err(_) => return,
    };
    let mut current = pin;
    // A promotion and the next announcement can arrive in one answer: follow until nothing changes.
    for _ in 0..2 {
        let next = match trust::follow(&current, &said) {
            trust::Follow::Nothing => break,
            trust::Follow::Unknown => {
                logger.warn("ca rotation: the master names a CA this desktop knows nothing of; nothing changed");
                break;
            }
            trust::Follow::Learn(pin, switch_at) => {
                logger.info(&format!(
                    "ca rotation: {} announced its next CA {}; trusted beside the current one{}",
                    master.origin,
                    pin.next.as_ref().map(|(_, fp)| fp.as_str()).unwrap_or("?"),
                    switch_at.map(|t| format!(", the switch is due at {t}")).unwrap_or_default(),
                ));
                let mut next_cfg = settings::load(app);
                if let Some(m) = next_cfg.master.as_mut() {
                    m.next_ca_pem = pin.next.as_ref().map(|(pem, _)| pem.clone());
                    m.next_fingerprint = pin.next.as_ref().map(|(_, fp)| fp.clone());
                    m.next_switch_at = switch_at;
                }
                let _ = settings::save(app, &next_cfg);
                pin
            }
            trust::Follow::Promote(pin) => {
                logger.warn(&format!("ca rotation: {} moved to its new CA {}; the old one is trusted no more", master.origin, pin.fingerprint));
                let mut next_cfg = settings::load(app);
                if let Some(m) = next_cfg.master.as_mut() {
                    m.ca_pem = pin.ca_pem.clone();
                    m.fingerprint = pin.fingerprint.clone();
                    m.next_ca_pem = None;
                    m.next_fingerprint = None;
                    m.next_switch_at = None;
                }
                let _ = settings::save(app, &next_cfg);
                pin
            }
        };
        trust::set_pin(&cfg.server_url, Some(next.clone()));
        if let (Ok(Some(tls)), Ok(slot)) = (trust::pinned_tls(&cfg.server_url), app.state::<AppState>().proxy.lock()) {
            if let Some(running) = slot.as_ref() {
                running.retrust(Arc::new(tls));
            }
        }
        current = next;
    }
}

/// The pin a status reports: the six words a person can compare with the master's Desktops page.
fn status_pin(server_url: &str, master: Option<&settings::MasterSetting>) -> Option<status::ServerPin> {
    let fingerprint = match master {
        // Without an app, the settings are all there is; checked the way `restore_master_pin` checks.
        Some(m) => trust::MasterPin::new(&m.ca_pem, &m.fingerprint).ok().map(|p| p.fingerprint)?,
        // With one, what is in force.
        None => trust::pin_for(server_url)?.fingerprint,
    };
    Some(status::ServerPin {
        words: trust::fingerprint_words(&fingerprint).unwrap_or_default().into_iter().map(String::from).collect(),
        fingerprint,
    })
}

/// Does this machine hold a live registration — the credential presence and the manifest need?
fn stored_registered() -> bool {
    keystore::secure_dir()
        .map(|d| {
            let s = keystore::load(&d);
            !s.desktop_id.is_empty() && !s.revoked && keystore::key_storage(&d) != keystore::KeyStorage::None
        })
        .unwrap_or(false)
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

/// The LGR Servers on this network (FR-20.28), as their DNS-SD adverts describe them: the
/// onboarding's "on this network" list. ⚠ Unverified: a chosen server is probed and pinned as a
/// typed one is. Off the main thread: it listens for three seconds.
#[tauri::command]
async fn discover_servers() -> Result<Vec<discovery::Found>, String> {
    tauri::async_runtime::spawn_blocking(|| discovery::browse(std::time::Duration::from_secs(3)))
        .await
        .map_err(|e| format!("discovery could not run: {e}"))
}

/// What the server at `server_url` is, before pairing with it (FR-20.28, FR-20.29): a name the OS
/// store vouches for (lgrai.app), a plain LAN server, or an LGR Server whose CA's six words a person
/// compares with its Desktops page. Off the main thread, like `open_lgr`: a master that does not
/// answer takes the probe's whole timeout.
#[tauri::command]
async fn probe_server(server_url: String) -> Result<trust::ServerKind, String> {
    let server = validate::normalize_server_url(&server_url).ok_or("invalid_server_url")?;
    tauri::async_runtime::spawn_blocking(move || trust::probe(&server))
        .await
        .map_err(|e| format!("probe could not run: {e}"))?
}

/// Exchange a registration code for this desktop's identity (FR-14.19), and, for a master, pin the
/// CA its fingerprint names (FR-20.29).
///
/// ⚠ Off the main thread (see `open_lgr`). Pairing with a master is a probe, the exchange and a
/// token, each with its own timeout, and the setup screen must not freeze for all three.
#[tauri::command]
async fn enroll_desktop(app: AppHandle, req: EnrollRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || enroll_desktop_blocking(&app, req))
        .await
        .map_err(|e| format!("enroll could not run: {e}"))?
}

fn enroll_desktop_blocking(app: &AppHandle, req: EnrollRequest) -> Result<(), String> {
    // ⚠ Shape first, network second. A typo in the address or the code must say so immediately
    // rather than after a 20-second timeout against something that was never a server.
    let server = validate::normalize_server_url(&req.server_url).ok_or("invalid_server_url")?;
    // A one-time code (`XXXX-XXXX`), or an enrollment KEY (#328: an ephemeral desktop, FR-14.19).
    if !is_enrollment_code(&req.code) && !enroll::is_enrollment_key(&req.code) {
        return Err("invalid_code".into());
    }

    // FR-20.29 — a master is paired by its CA's fingerprint: the one its link carried, or the one
    // whose six words a person confirmed. `trust::confirm` fetches the CA itself; the page only ever
    // names the fingerprint.
    let pin = match req.fingerprint.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        None => None,
        Some(fp) => Some(trust::confirm(&server, fp).map_err(|e| {
            app.state::<AppState>().logger.warn(&format!("pairing refused: {e}"));
            e
        })?),
    };
    // The exchange runs under the trust it is pairing with. ⚠ Put back as it was if it fails, so a
    // mistyped code does not leave a till trusting a CA nothing was registered against.
    let previous = trust::pin_for(&server);
    trust::set_pin(&server, pin.clone());

    let version = app.package_info().version.to_string();
    let name = if req.name.trim().is_empty() { settings::hostname() } else { req.name.clone() };

    let stored = enroll::enroll(&server, &req.code, &name, &version).map_err(|e| {
        trust::set_pin(&server, previous.clone());
        app.state::<AppState>().logger.warn(&format!("enroll failed: {e}"));
        e.to_string()
    })?;

    // The address that worked is the one to keep — onboarding may have upgraded or trimmed what
    // was typed, and the stored settings must match what the registration was made against. And so
    // is its trust: the pin, or none for a server the OS store vouches for.
    let mut cfg = settings::load(app);
    let left = cfg.master.take();
    cfg.server_url = server.clone();
    cfg.desktop_name = name;
    cfg.master = pin.as_ref().map(|p| settings::MasterSetting {
        origin: server.clone(),
        ca_pem: p.ca_pem.clone(),
        fingerprint: p.fingerprint.clone(),
        next_ca_pem: None,
        next_fingerprint: None,
        next_switch_at: None,
    });
    let _ = settings::save(app, &cfg);
    // A master this desktop has left is trusted no more.
    if let Some(old) = left.filter(|old| pin.is_none() || old.origin != server) {
        trust::set_pin(&old.origin, None);
    }
    if let Some(p) = &pin {
        app.state::<AppState>()
            .logger
            .info(&format!("paired with {server}: its CA {} is pinned", p.fingerprint));
    }
    // FR-20.32 — a re-point. The window still shows the previous registration and a proxy, if one
    // runs, forwards with the previous pin: both go. The next Open LGR starts over, and clears the
    // window's storage when the server changed (`web::prepare_storage`).
    stop_proxy(app);
    web::close(app);

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
            // ⚠ A desktop can be re-enrolled - at a DIFFERENT server - without restarting, and
            // the `started` latch then made `start_registered_services` a no-op. Presence kept
            // talking to the previous server: the app worked (its window follows the new URL)
            // while the Overview said "unreachable" and the hub listed the new desktop as offline,
            // with nothing in the log. Observed against a till moved from a dev server to prod.
            if app.state::<AppState>().started.load(std::sync::atomic::Ordering::SeqCst) {
                restart_presence(app);
                // ⚠ The bridge cannot follow in-process. Only say so when there is actually a
                // device to move, so a desktop with none is not told to restart for nothing.
                if !app.state::<AppState>().bridge.report().is_empty() {
                    app.state::<AppState>().logger.warn(
                        "fiscal bridge still bound to the previous registration: restart LGR Desktop to move it",
                    );
                    let _ = app.emit_to("main", "shell:restart-required", "bridge");
                }
            }
            // ⚠ Now, not at the next launch. `setup` started neither the presence socket nor the
            // bridges, because at that point this machine was not registered — and a till that
            // enrolls and then cannot print until somebody thinks to restart it is a support call
            // with no symptom to go on.
            start_registered_services(app);
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
    /// FR-20.29 — the master's CA fingerprint, from its link or confirmed by its six words. Absent
    /// for lgrai.app, which the OS store vouches for.
    #[serde(default)]
    fingerprint: Option<String>,
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
                ephemeral: false,
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
            ephemeral: stored.ephemeral,
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
        bridge: status::Bridge {
            supported: true,
            devices: reg_status.devices,
            fiscal: app.state::<AppState>().bridge.report(),
        },
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
        server_pin: status_pin(&s.server_url, None),
        org_moved: app.state::<AppState>().org_moved.lock().ok().and_then(|m| m.clone()),
    }
}

/// Start the presence socket (FR-14.21), if this machine is registered.
///
/// ⚠ A thread, not a task: the shell has no async runtime, and one socket that speaks every 30 s
/// does not justify adding one. An UNREGISTERED desktop starts nothing — there is no credential
/// to authenticate with, and a socket that could only ever be refused is noise in the server's
/// audit log.
fn start_presence(app: &AppHandle) {
    if !stored_registered() {
        app.state::<AppState>().logger.info("presence: not registered, socket not started");
        return;
    }

    let server_url = settings::load(app).server_url;
    let state = app.state::<AppState>();
    let link = state.link.clone();
    // ⚠ This run's OWN stop flag, published so `restart_presence` can end this run and only this
    // run. `quit` sets it too, which is why the process-wide flag is no longer read here.
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    if let Ok(mut slot) = state.presence_stop.lock() {
        *slot = Some(stop.clone());
    }
    let handle = app.clone();

    std::thread::spawn(move || {
        // Remembers the last reason LOGGED, so a long outage does not fill the log with copies.
        let mut last_reason: Option<&'static str> = None;
        // FR-20.28 — a master that stops answering may only have moved (DHCP).
        let mut unreachable_in_a_row = 0u32;
        presence::run(server_url, link, stop, move |event| match event {
            presence::Event::Authenticated => {
                last_reason = None;
                unreachable_in_a_row = 0;
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
                    // FR-14.21 — the ports this machine can see, so an admin picks "COM4" from a
                    // list on the Desktops page instead of typing it from memory.
                    let ports = bridge::visible_ports();
                    match enroll::report_self(&url, &version, &ports) {
                        Ok(None) => reporter.state::<AppState>().logger.info("presence: self reported"),
                        // #328: an admin's assignment since the last report. Open LGR lands there
                        // from now on; a window already open is left where its user is.
                        Ok(Some(path)) => reporter.state::<AppState>().logger.info(&format!(
                            "presence: self reported; the start path is now {}",
                            if path.is_empty() { "/ (none assigned)" } else { path.as_str() }
                        )),
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
                // ⚠ The bridge is stopped by `mark_revoked` (`bridge::halt`), not here: the same
                // revocation can be discovered inside `mint_token` on a thread that has no
                // `AppHandle`, so the teardown belongs with the thing that owns the order rather
                // than being repeated at each call site. This only clears what the Overview shows.
                handle.state::<AppState>().bridge.clear();
                if let Ok(dir) = keystore::secure_dir() {
                    let mut stored = keystore::load(&dir);
                    enroll::mark_revoked(&dir, &mut stored);
                }
                let _ = handle.emit_to("main", "shell:revoked", msg);
                // Bring the shell forward: a till whose registration just died must not keep
                // showing a cloud app it can no longer reach.
                show_main(&handle, Some("overview"));
            }
            presence::Event::Repoint { instruction, name } => {
                // FR-20.82: the network work (the master's CA) off the presence thread, whose loop
                // is about to read the refusal that follows and reconnect.
                let app = handle.clone();
                std::thread::spawn(move || follow_repoint(&app, &instruction, &name));
            }
            presence::Event::Moved { name } => {
                let st = handle.state::<AppState>();
                st.logger.warn(&format!("presence: the organisation moved to its own server ({name}); lgrai.app cannot say where it answers, so this desktop waits to be paired with it"));
                if let Ok(mut m) = st.org_moved.lock() {
                    *m = Some(status::OrgMoved { name, server: None, reason: None });
                }
                show_main(&handle, Some("overview"));
            }
            presence::Event::UpdateRequested => {
                // C13 acts on this; recorded now so the path is not invented later.
                handle.state::<AppState>().logger.info("presence: update requested by server");
                let _ = handle.emit_to("main", "shell:update-requested", ());
            }
            presence::Event::Disconnected(reason) => {
                // ⚠ **Say it.** This arm used to emit to the UI and log NOTHING, so a till that
                // could not reach its hub produced an empty log: the app ran, the Desktops page
                // said offline, and there was nothing to go on. The bridge's own disconnect has
                // always been logged (`bridge: ... disconnected`); presence was the silent one.
                //
                // ⚠ Consecutive identical reasons are suppressed. A server that is down for a
                // day would otherwise write ~1,400 identical lines and push everything else out
                // of a rotated log - but the FIRST one, and every CHANGE, is always recorded.
                let r = reason.as_str();
                if last_reason != Some(r) {
                    last_reason = Some(r);
                    let st = handle.state::<AppState>();
                    match reason {
                        presence::DisconnectReason::Refused => st.logger.warn(
                            "presence: the server refused this desktop's credential; retrying slowly",
                        ),
                        presence::DisconnectReason::Unreachable => st
                            .logger
                            .warn("presence: the server did not answer; retrying with backoff"),
                        // #328: the line the first field lane looked for and never found.
                        presence::DisconnectReason::Silent => st.logger.warn(
                            "presence: the server said nothing for 75 s; the link is dead, reconnecting",
                        ),
                        presence::DisconnectReason::Closed => {
                            st.logger.info("presence: socket closed, reconnecting")
                        }
                        // ⚠ Names the TILL as the thing to look at. Reported as `Refused` this
                        // read as a hub problem, and the hub was never contacted.
                        presence::DisconnectReason::NotConfigured => st.logger.warn(
                            "presence: this machine cannot mint a credential (not registered, or no key); re-enrol it",
                        ),
                    }
                }
                // ⚠ The STATE, not the literal `"unreachable"` this used to send for every
                // reason. `get_status` has always reported `signed_out` correctly and the
                // Overview translates it in all four locales, so the event was the one place
                // that disagreed with itself. Nothing listens to `shell:link` today, which is
                // exactly why it was wrong and nobody saw it.
                let link = handle.state::<AppState>().link.get().as_str();
                let _ = handle.emit_to("main", "shell:link", link);

                // FR-20.28 — a paired master that no longer answers where it was is looked for by
                // its CA, after three tries in a row (seconds, on presence's backoff).
                // A link that went silent counts too: a master that moved address goes quiet first.
                if matches!(reason, presence::DisconnectReason::Unreachable | presence::DisconnectReason::Silent) {
                    unreachable_in_a_row += 1;
                    if unreachable_in_a_row >= 3 {
                        maybe_refind_master(&handle);
                    }
                } else {
                    unreachable_in_a_row = 0;
                }
            }
        });
    });
}

/// Look for a paired master that stopped answering (`refind_master`): one search at a time, at most
/// every two minutes, so a master that is simply switched off is not hunted for in a loop.
fn maybe_refind_master(app: &AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static LAST: Mutex<Option<std::time::Instant>> = Mutex::new(None);
    static SEARCHING: AtomicBool = AtomicBool::new(false);
    if settings::load(app).master.is_none() {
        return;
    }
    {
        let mut last = LAST.lock().unwrap_or_else(|p| p.into_inner());
        if last.is_some_and(|t| t.elapsed() < std::time::Duration::from_secs(120)) {
            return;
        }
        *last = Some(std::time::Instant::now());
    }
    if SEARCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if !refind_master(&app) {
            app.state::<AppState>()
                .logger
                .info("presence: the master is not answering, and no address on this network proves to be it");
        }
        SEARCHING.store(false, Ordering::SeqCst);
    });
}

/// FR-20.28 — "a paired desktop finds its master by identity, not by address". A master that no
/// longer answers at its address is looked for on the network by the CA fingerprint this desktop
/// pinned; an address is used only once the pin itself proves it, and then everything follows: the
/// settings, the pin, the record of whose session the window holds, the proxy, presence.
///
/// ⚠ Proof is the pinned TLS, never the advert. Anyone on the LAN can claim a fingerprint; an
/// address whose certificate the pin does not name fails at the handshake and is skipped.
fn refind_master(app: &AppHandle) -> bool {
    let cfg = settings::load(app);
    let Some(master) = cfg.master.clone() else { return false };
    let old = cfg.server_url.clone();
    let Ok(pin) = trust::MasterPin::new(&master.ca_pem, &master.fingerprint) else { return false };
    if let Some(url) = discovery::locate(&pin, &old, std::time::Duration::from_secs(3)) {
        let mut next = settings::load(app);
        next.server_url = url.clone();
        next.master = Some(settings::MasterSetting { origin: url.clone(), ..master.clone() });
        // ⚠ The same master at a new address: its window's session is not another server's, and
        // must not be cleared as if it were (`web::prepare_storage`).
        if next.web_server == old {
            next.web_server = url.clone();
        }
        let _ = settings::save(app, &next);
        trust::set_pin(&old, None);
        if let (Ok(mut slot), Ok(target)) = (app.state::<AppState>().proxy.lock(), url::Url::parse(&url)) {
            if let Some(running) = slot.as_mut() {
                running.retarget(target);
            }
        }
        app.state::<AppState>().logger.warn(&format!(
            "the master moved from {old} to {url}: found on the network by its CA {}, proven by the pin",
            master.fingerprint
        ));
        restart_presence(app);
        // ⚠ The bridge cannot follow in-process (see `enroll_desktop_blocking`).
        if !app.state::<AppState>().bridge.report().is_empty() {
            app.state::<AppState>()
                .logger
                .warn("fiscal bridge still bound to the old address: restart LGR Desktop to move it");
            let _ = app.emit_to("main", "shell:restart-required", "bridge");
        }
        return true;
    }
    false
}

/// Open the till's fiscal devices and bridge them to the hub (FR-14.26).
///
/// ⚠ **One thread per device.** Commands on one serial port must be serialized, and a thread that
/// blocks on its socket until an exchange finishes gives that for free. Two devices are two
/// independent ports, so they are two threads — a long Z-report on one must not hold up a sale on
/// the other.
///
/// ⚠ **The assignment is fetched, not assumed.** `fiscalDeviceIds` from enrollment is only a list
/// of ids; the port, baud rate, device number and manufacturer come from the hub, so an admin
/// moving a printer from COM3 to COM4 reaches a running till on its next reconnect.
///
/// ⚠ An UNREGISTERED desktop starts nothing, for the same reason the presence socket does not:
/// there is no credential, and a bridge that could only ever be refused is noise in the audit log.
fn start_bridges(app: &AppHandle) {
    let registered = keystore::secure_dir()
        .map(|d| {
            let s = keystore::load(&d);
            !s.desktop_id.is_empty() && !s.revoked && keystore::key_storage(&d) != keystore::KeyStorage::None
        })
        .unwrap_or(false);
    if !registered {
        app.state::<AppState>().logger.info("bridge: not registered, no device opened");
        return;
    }

    let server_url = settings::load(app).server_url;
    let state = app.state::<AppState>();
    let bridge_state = state.bridge.clone();
    let stop = state.stop.clone();
    let handle = app.clone();

    // ⚠ The fetch is on its own thread: it is a network call, and `setup` must not block on the
    // hub being reachable. A till with no internet still has to show its Overview.
    std::thread::spawn(move || {
        let devices = match bridge::fetch_assignment(&server_url) {
            Ok(d) => d,
            Err(e) => {
                handle
                    .state::<AppState>()
                    .logger
                    .warn(&format!("bridge: could not read the device assignment: {e}"));
                return;
            }
        };

        if devices.is_empty() {
            handle.state::<AppState>().logger.info("bridge: no fiscal device assigned");
            return;
        }

        for device in devices {
            let url = server_url.clone();
            let st = bridge_state.clone();
            let stop = stop.clone();
            let h = handle.clone();
            let label = format!("{} ({})", device.name, device.device_number);
            // ⚠ The manufacturer is logged, not acted on: the DRIVER lives on the hub, and this
            // line is what tells a support call whether the device an operator described is the
            // one the till actually opened.
            h.state::<AppState>().logger.info(&format!(
                "bridge: opening {label} [{}] on {} at {} baud",
                device.manufacturer,
                device.port.clone().unwrap_or_else(|| "<no port>".into()),
                device.baud_rate,
            ));

            std::thread::spawn(move || {
                bridge::run(url, device, st, stop, move |event| match event {
                    bridge::Event::Registered(id) => h
                        .state::<AppState>()
                        .logger
                        .info(&format!("bridge: {label} registered with the hub (device {id})")),
                    bridge::Event::Refused { device_id, code } => {
                        // ⚠ `error`, not `warn`: this is the state where a till cannot print and
                        // only an admin can fix it, which is exactly what a support call needs to
                        // find in the log.
                        h.state::<AppState>()
                            .logger
                            .error(&format!("bridge: {label} refused ({code}); device {device_id} will not retry"));
                        let _ = h.emit_to("main", "shell:bridge-refused", code);
                    }
                    bridge::Event::Disconnected(id) => h
                        .state::<AppState>()
                        .logger
                        .warn(&format!("bridge: {label} disconnected (device {id}), retrying")),
                });
            });
        }
    });
}

/// Start everything a REGISTERED desktop runs: the presence socket and the fiscal bridges.
///
/// ⚠ Called from `setup` and from the end of a successful enrollment, which is the whole reason it
/// exists. Both `start_presence` and `start_bridges` return immediately when the machine is not
/// registered, so a till enrolled at 9 a.m. on a shell launched at 8 used to have **no presence
/// socket and no fiscal bridge until somebody restarted it** — and nothing in onboarding said so.
/// The till looked enrolled, the Desktops page showed it offline, and its printer never opened.
///
/// ⚠ Idempotent via the latch: enrolling twice must not put two threads on one serial port.
fn start_registered_services(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    if app.state::<AppState>().started.swap(true, Ordering::SeqCst) {
        return;
    }
    start_presence(app);
    // FR-14.26 — open the till's fiscal devices. After the presence socket on purpose: both need a
    // token, and the presence thread is what reports this machine's serial ports, so an admin can
    // see them before assigning one.
    start_bridges(app);
}

/// End the presence run in flight and start a new one against the CURRENT settings.
///
/// ⚠ **Presence only, and bridges deliberately NOT.** `bridge::halt()` is one-way by design
/// ("a resettable flag is one mis-ordered call away from a revoked till printing again"), and
/// restarting a bridge means handing a serial port from one thread to another - two threads on one
/// port is the single thing the fiscal protocol cannot survive. So a re-pointed till keeps its old
/// bridge until it restarts, and `enroll_desktop` says so out loud rather than pretending.
///
/// ⚠ Presence has no port and no such hazard: the old run is told to stop, nudged awake out of
/// its backoff sleep so it exits in milliseconds rather than up to a minute, and a new one starts.
fn restart_presence(app: &AppHandle) {
    let st = app.state::<AppState>();
    if let Ok(mut slot) = st.presence_stop.lock() {
        if let Some(flag) = slot.take() {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    // Wake whichever sleep the old run is in, so it observes the flag now.
    st.link.nudge();
    st.logger.info("presence: restarting against the current server");
    start_presence(app);
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
        Some(validate::DeepLink::Login { code, state }) => {
            // FR-14.14 — the system browser finished an OAuth handshake and sent the one-time
            // code back. ⚠ NOT stored as a pending deep link: this one is acted on immediately
            // and in Rust, because redeeming it needs the verifier, which never leaves this
            // process until it goes into `lgr-web`'s URL fragment. Parking it for the front end
            // would mean handing the code to a page that cannot complete it.
            //
            // ⚠ The CODE is not logged. It is half a credential for the next 60 seconds.
            st.logger.info("deep link: login code received");
            // FR-20.39: a master's "Sign in with LGR" this shell started carries its state.
            if let Some(state) = state.as_deref() {
                if web::finish_master_idp(app, &code, state) {
                    return;
                }
            }
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
/// FR-20.82 — follow a re-point: believe it (`repoint::verify`), check the master's CA against its
/// pin (`trust::confirm`), keep the new server and pin, and restart into them. The desktop keeps
/// its id and its key: its registry row moved with the org, so it mints its tokens at the master as
/// it did here. ⚠ A restart, not an in-place switch: the bridges hold the till's ports and cannot
/// follow in-process, and a move needs every till closed anyway (its preflight).
///
/// Not followed, it says why on the Overview, and follows the instruction lgrai.app sends again on
/// the next connection (a master switched off for the night is reached in the morning).
fn follow_repoint(app: &AppHandle, instruction: &str, name: &str) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static FOLLOWING: AtomicBool = AtomicBool::new(false);
    if FOLLOWING.swap(true, Ordering::SeqCst) {
        return;
    }
    let st = app.state::<AppState>();
    let said = |server: Option<String>, reason: &str| {
        if let Ok(mut m) = st.org_moved.lock() {
            *m = Some(status::OrgMoved { name: name.to_string(), server, reason: Some(reason.to_string()) });
        }
    };
    let outcome = (|| -> Result<repoint::Repoint, (Option<String>, String)> {
        let dir = keystore::secure_dir().map_err(|_| (None, "no_secure_storage".to_string()))?;
        let stored = keystore::load(&dir);
        let cfg = settings::load(app);
        // The corrected clock, as every assertion this desktop makes.
        let now = identity::ClockOffset { millis: stored.clock_offset_ms }.now_sec(chrono::Utc::now().timestamp_millis());
        let r = repoint::verify(instruction, &stored.desktop_id, &stored.org_id, cfg.home_epoch, now).map_err(|e| (None, e.to_string()))?;
        let mut cfg = cfg;
        // FR-20.80 (P3-6c): back to lgrai.app. No pin: the machine's store vouches for the cloud, and
        // `verify` took the instruction only for the cloud built into this binary.
        let Some(fingerprint) = r.fingerprint.clone() else {
            let left = cfg.master.take();
            cfg.server_url = r.server.clone();
            cfg.home_epoch = r.epoch;
            settings::save(app, &cfg).map_err(|e| (Some(r.server.clone()), format!("settings_not_saved: {e}")))?;
            if let Some(old) = left {
                trust::set_pin(&old.origin, None);
            }
            return Ok(r);
        };
        let pin = trust::confirm(&r.server, &fingerprint).map_err(|e| (Some(r.server.clone()), e))?;
        let left = cfg.master.take();
        cfg.server_url = r.server.clone();
        cfg.master = Some(settings::MasterSetting {
            origin: r.server.clone(),
            ca_pem: pin.ca_pem.clone(),
            fingerprint: pin.fingerprint.clone(),
            next_ca_pem: None,
            next_fingerprint: None,
            next_switch_at: None,
        });
        cfg.home_epoch = r.epoch;
        settings::save(app, &cfg).map_err(|e| (Some(r.server.clone()), format!("settings_not_saved: {e}")))?;
        trust::set_pin(&r.server, Some(pin));
        if let Some(old) = left.filter(|old| old.origin != r.server) {
            trust::set_pin(&old.origin, None);
        }
        Ok(r)
    })();
    match outcome {
        Ok(r) => {
            match &r.fingerprint {
                Some(fp) => st.logger.info(&format!(
                    "re-pointed: the organisation now lives on {name} at {} (its CA {fp} is pinned, epoch {}); restarting to follow it",
                    r.server, r.epoch
                )),
                None => st.logger.info(&format!(
                    "re-pointed: the organisation lives on {} again (epoch {}); the server's pin is dropped; restarting to follow it",
                    r.server, r.epoch
                )),
            }
            prepare_exit(app);
            RESTARTING.store(true, std::sync::atomic::Ordering::SeqCst);
            app.restart();
        }
        Err((server, reason)) => {
            st.logger.warn(&format!("re-point to {name} not followed: {reason}; tried again on the next connection"));
            said(server, &reason);
            FOLLOWING.store(false, Ordering::SeqCst);
        }
    }
}

/// What quitting and restarting share: the bridge given its 10 s to finish a fiscal command, and
/// every thread told to stop, so the next process finds the serial ports free.
fn prepare_exit(app: &AppHandle) {
    let st = app.state::<AppState>();
    // ⚠ Bounded. "Wait for the bridge" must never become "never quit": a stuck bridge would
    // otherwise leave a window nobody can close.
    for _ in 0..100 {
        if !st.bridge.is_busy() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if st.bridge.is_busy() {
        // ⚠ Said out loud. A receipt cut short by a quit is a fiscal problem somebody has to
        // reconcile against the device's own journal, and the log is where they will look.
        st.logger.warn("quitting while a fiscal command is still in flight: the 10 s wait expired");
    }
    // Let go of the serial ports before the process goes away, so the next thing to open them
    // (another till, a Chrome tab, the app restarting) is not refused by a port we still hold.
    st.stop.store(true, std::sync::atomic::Ordering::SeqCst);
    // ⚠ The presence run reads its own flag now, not this one, so shutdown has to set both or a
    // closing app would keep reconnecting.
    if let Ok(slot) = st.presence_stop.lock() {
        if let Some(flag) = slot.as_ref() {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    };
}

fn quit(app: &AppHandle) {
    prepare_exit(app);
    app.state::<AppState>().logger.info("quitting");
    app.exit(0);
}

/// FR-14.19, #328 — an ephemeral desktop removes its own row on a clean shutdown: a Quit, or the OS
/// ending the session (tao turns `WM_ENDSESSION` into the loop's end, and so `RunEvent::Exit`,
/// before the process goes). A machine that cannot reach its hub in time leaves the row to the
/// hub's reaper.
fn leave_if_ephemeral(app: &AppHandle) {
    let Some(st) = app.try_state::<AppState>() else { return };
    let Ok(dir) = keystore::secure_dir() else { return };
    let stored = keystore::load(&dir);
    let registered = !stored.desktop_id.is_empty() && !stored.revoked;
    let started = st.started.load(std::sync::atomic::Ordering::SeqCst);
    if !should_unregister(stored.ephemeral, registered, started, RESTARTING.load(std::sync::atomic::Ordering::SeqCst)) {
        return;
    }
    let server = settings::load(app).server_url;
    match enroll::unregister_self(&server, std::time::Duration::from_secs(2)) {
        Ok(()) => st.logger.info("ephemeral: unregistered from the hub on a clean shutdown"),
        Err(e) => st
            .logger
            .warn(&format!("ephemeral: could not unregister ({e}); the hub's reaper removes the row")),
    }
}

/// Whether this exit is an ephemeral desktop leaving. Pure, so the whole rule is one table test.
///
/// ⚠ Never on a RESTART (an update, a re-point): the same desktop comes straight back, and roomler
/// learned that an unregister there turns an update into a re-enrollment (FR-51,
/// `should_self_unenroll`). ⚠ And only from a process that started this registration's services:
/// a second instance, told to hand over to the first and exit, must not take the first one's row
/// with it.
fn should_unregister(ephemeral: bool, registered: bool, started: bool, restarting: bool) -> bool {
    ephemeral && registered && started && !restarting
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
    // FR-14.28 — the release pipeline's proof that what it is about to publish is installable:
    // the key compiled into THIS binary accepts the `.sig`, for this version, and the installer
    // carries roomler's Authenticode publisher. Same function the till runs before installing.
    if let Some(i) = args.iter().position(|a| a == "--verify-update") {
        std::process::exit(verify_update_cli(&args[i + 1..]));
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
        // FR-14.28 — driven from `install.rs` only. ⚠ No `updater:*` permission in any
        // capability, so no page — the shell's own or the cloud app — can start a download.
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            discover_servers,
            probe_server,
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

            // FR-20.31 — before anything below talks to the server.
            restore_master_pin(&handle);
            // FR-20.30 — a rotation the master announces is taken up within the hour.
            follow_ca_rotations(&handle);

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
                // Direct, not threaded: `setup` runs before the event loop starts (see the tray
                // handler), and this is the path that has always worked.
                if let Err(e) = open_lgr_blocking(&handle) {
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

            start_registered_services(&handle);
            start_auto_update(&handle);

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
        .build(tauri::generate_context!())
        .map(|app| {
            app.run(|handle, event| {
                if let tauri::RunEvent::Exit = event {
                    leave_if_ephemeral(handle);
                }
            })
        });

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
                // ⚠ On a thread, for the same reason the command is `async`: this callback runs ON
                // the event loop, and `WebviewWindowBuilder::build()` needs the event loop to make
                // the window — so building here would wait for a thread that is waiting for us.
                //
                // ⚠ The `setup` call below is the one exception and stays direct: it runs BEFORE
                // the event loop exists, where there is nothing to dispatch to and a spawned
                // thread would block instead.
                let app = app.clone();
                std::thread::spawn(move || {
                    if let Err(e) = open_lgr_blocking(&app) {
                        app.state::<AppState>().logger.error(&format!("open_lgr: {e}"));
                        show_main(&app, Some("overview"));
                    }
                });
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

/// `--verify-update <installer> <installer.sig> <version>` — prints one JSON line, exits 0 only
/// when a till would install this file.
///
/// ⚠ No `AppHandle`, like `--status-json`: it runs on a CI runner where no window can open.
fn verify_update_cli(rest: &[String]) -> i32 {
    let print = |ok: bool, detail: serde_json::Value| {
        // ⚠ `writeln!`, not `println!`: the release build is a GUI-subsystem program, and a caller
        // that does not wait for it (PowerShell's `& exe`) closes the pipe — `println!` then
        // PANICS, which is how 0.1.6's first release run died. A lost answer must still leave the
        // exit code meaning what it says, and the caller requires the JSON verdict anyway.
        use std::io::Write;
        let line = serde_json::json!({ "ok": ok, "keyPinned": install::pubkey().is_some(), "detail": detail });
        let _ = writeln!(std::io::stdout(), "{line}");
        if ok { 0 } else { 1 }
    };
    let [installer, sig, version] = rest else {
        return print(false, "usage: --verify-update <installer> <installer.sig> <version>".into());
    };
    let bytes = match std::fs::read(installer) {
        Ok(b) => b,
        Err(e) => return print(false, format!("cannot read {installer}: {e}").into()),
    };
    let signature = match std::fs::read_to_string(sig) {
        Ok(s) => s,
        Err(e) => return print(false, format!("cannot read {sig}: {e}").into()),
    };
    match install::verify_installer(&bytes, &signature, version, &std::env::temp_dir()) {
        Ok(proven) => print(true, serde_json::json!({ "platform": install::platform(), "verified": proven })),
        Err(e) => print(false, e.into()),
    }
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
    // ⚠ The registration IS knowable here, and reporting it as `not_registered` was a lie this
    // path used to tell. `registration_status()` takes no `AppHandle` — it reads the non-roaming
    // identity directory, which is resolved from environment variables alone — so the only thing
    // the missing app costs is the LIVE state: the server link, which nothing has probed, and the
    // update check, which needs a network call.
    //
    // It mattered because `--status-json` is the interface C15's harness and C17's guest drivers
    // read INSTEAD of scraping screens. A lane's `register` check would have read `not_registered`
    // from a till that had just enrolled successfully, and the obvious conclusion — "enrollment is
    // broken" — would have been wrong.
    let reg = registration_status();
    let server_pin = status_pin(&s.server_url, s.master.as_ref());
    let st = status::Status {
        schema_version: status::SCHEMA_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: status::OsInfo::current(),
        server_url: s.server_url,
        desktop_name: s.desktop_name,
        registration: reg.registration,
        // ⚠ `fiscal` is empty and `devices` is not: the ASSIGNMENT is on disk, while per-device
        // port and state exist only inside a running bridge. An empty `fiscal` from this path
        // therefore means "not running", which is exactly what it should mean.
        bridge: status::Bridge { supported: true, devices: reg.devices, fiscal: vec![] },
        autostart: s.autostart,
        open_lgr_on_launch: s.open_lgr_on_launch,
        log_path,
        // ⚠ These two stay at "not measured", because they genuinely are: nothing has probed the
        // server and nothing has asked the hub for a manifest.
        server_link: "unknown".into(),
        update: status::Update { required: reg.update_required, ..status::Update::default() },
        key_storage: reg.key_storage.as_str().into(),
        clock_skew_ms: reg.clock_skew_ms,
        assignment: reg.assignment,
        server_pin,
        org_moved: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// FR-14.19, #328 — the whole rule, as roomler tests `should_self_unenroll`.
    #[test]
    fn an_ephemeral_desktop_leaves_only_on_a_real_shutdown() {
        // (ephemeral, registered, started, restarting) → unregister?
        let cases = [
            ((true, true, true, false), true),
            ((false, true, true, false), false), // a permanent till never removes itself
            ((true, false, true, false), false), // nothing registered to remove
            ((true, true, false, false), false), // a second instance handing over to the first
            ((true, true, true, true), false),   // restarting into an update or a re-point
        ];
        for ((ephemeral, registered, started, restarting), leaves) in cases {
            assert_eq!(
                should_unregister(ephemeral, registered, started, restarting),
                leaves,
                "ephemeral={ephemeral} registered={registered} started={started} restarting={restarting}"
            );
        }
    }
}
