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
mod logs;
mod paths;
mod settings;
mod status;
mod validate;

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
}

impl AppState {
    fn new(logger: logs::Logger) -> Self {
        Self {
            logger,
            bridge_busy: Arc::new(Mutex::new(false)),
            pending_view: Arc::new(Mutex::new(None)),
            pending_deep_link: Arc::new(Mutex::new(None)),
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

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

fn build_status(app: &AppHandle) -> status::Status {
    let s = settings::load(app);
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
        // FR-14.18's registration lands in a later chunk; until then this is the honest answer
        // rather than an invented one.
        registration: status::Registration {
            state: "not_registered".into(),
            desktop_id: None,
            org_slug: None,
        },
        bridge: status::Bridge { supported: false, devices: vec![] },
        autostart: s.autostart,
        open_lgr_on_launch: s.open_lgr_on_launch,
        log_path,
    }
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
        Some(validate::DeepLink::Login { .. }) => {
            // FR-14.14 redeems this in `lgr-web`; until that chunk exists, record and show the app.
            st.logger.info("deep link: login code received");
            store(raw);
            show_main(app, None);
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

            handle.state::<AppState>().logger.info("setup complete");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // ⚠ Closing HIDES the shell and DESTROYS `lgr-web` (FR-14.6). A hidden window
                // holding a signed-in cloud session is how a till shows the previous shift's user.
                let app = window.app_handle();
                if let Some(web) = app.get_webview_window("lgr-web") {
                    let _ = web.destroy();
                }
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
    let open_lgr = MenuItem::with_id(app, "open-lgr", "Open LGR", true, None::<&str>)?;
    let overview = MenuItem::with_id(app, "overview", "Overview", true, None::<&str>)?;
    // ⚠ Disabled until FR-14.28 ships the updater. A menu item that silently does nothing is
    // worse than one that is visibly not ready yet.
    let updates = MenuItem::with_id(app, "check-updates", "Check for updates", false, None::<&str>)?;
    let open_logs = MenuItem::with_id(app, "open-logs", "Open logs folder", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_lgr, &overview, &updates, &open_logs, &quit_item])?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("LGR Desktop")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            // Open LGR is FR-14.13's window; until that chunk, route to the Overview that hosts
            // the button rather than pretending to open something.
            "open-lgr" | "overview" => show_main(app, Some("overview")),
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
