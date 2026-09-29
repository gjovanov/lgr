// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! LGR Desktop — the shell.
//!
//! ⚠ There is **no sidecar, no Bun runtime and no local database** (FR-14.1). What used to be
//! here spawned a compiled `desktop-api` over SQLite, supervised it, and ran a nightly archive
//! scheduler over its data file. Local mode is gone (FR-14.34), so all of that went with it
//! rather than being left to rot:
//!
//!  - `sidecar.rs` started the sidecar **without `JWT_SECRET`**, so it signed local tokens with
//!    the committed `'lgr-dev-secret'`, and first run created `admin` / `admin123`, logged it in
//!    plain text and pre-filled it on the login form;
//!  - `archive.rs` archived a database that no longer exists;
//!  - ten `invoke` commands were registered and **not one was called by any frontend code**.
//!
//! What the shell will own instead is the server-mode client: Overview + Open LGR (FR-14.13),
//! registration and the desktop key (FR-14.20), and the native fiscal bridge (FR-14.26). Those
//! are separate chunks; this file is deliberately the minimum that still builds and runs.

use std::io::Write;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

/// Write a crash/error message to a log file next to the executable.
/// This is critical on Windows where `windows_subsystem = "windows"` hides all console output.
fn log_to_file(msg: &str) {
    if let Ok(exe_path) = std::env::current_exe() {
        let log_path = exe_path.parent().unwrap_or(std::path::Path::new(".")).join("lgr-desktop.log");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
            let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
            let _ = writeln!(f, "[{}] {}", timestamp, msg);
        }
    }
}

fn main() {
    log_to_file("Starting LGR Desktop...");

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            log_to_file("Setup started");

            // Build tray menu
            let show = MenuItem::with_id(app, "show", "Show LGR", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            // Create tray icon
            TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("LGR Desktop")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    // ⚠ FR-14.6 has Quit wait for an in-flight fiscal command. There is no
                    // bridge to wait for yet (FR-14.26), so this exits directly — the await
                    // point belongs in the chunk that introduces the thing to await.
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            log_to_file("Tray icon created");
            log_to_file("Setup complete");
            Ok(())
        })
        .on_window_event(|window, event| {
            // Minimize to tray on close instead of quitting
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!());

    match result {
        Ok(()) => log_to_file("Application exited normally"),
        Err(e) => {
            let msg = format!("Application failed to start: {}", e);
            log_to_file(&msg);
            // Also try a message box on Windows so the user sees the error
            #[cfg(target_os = "windows")]
            {
                use std::ffi::CString;
                let text = CString::new(msg.as_str()).unwrap_or_default();
                let title = CString::new("LGR Desktop Error").unwrap_or_default();
                unsafe {
                    extern "system" {
                        fn MessageBoxA(hwnd: *mut std::ffi::c_void, text: *const i8, caption: *const i8, utype: u32) -> i32;
                    }
                    MessageBoxA(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10);
                }
            }
        }
    }
}
