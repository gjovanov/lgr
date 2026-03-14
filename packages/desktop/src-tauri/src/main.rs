// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod archive;
mod sidecar;

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
        .invoke_handler(tauri::generate_handler![
            sidecar::start_api,
            sidecar::stop_api,
            sidecar::api_status,
            sidecar::get_db_path,
            archive::create_archive,
            archive::restore_archive,
            archive::list_archives,
            archive::delete_archive,
            archive::cleanup_old_archives,
            archive::get_archive_stats,
        ])
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
                    "quit" => {
                        // Stop the API sidecar before quitting
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            sidecar::shutdown(&handle).await;
                            handle.exit(0);
                        });
                    }
                    _ => {}
                })
                .build(app)?;

            log_to_file("Tray icon created");

            // Auto-start the API sidecar
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sidecar::start(&handle).await {
                    log_to_file(&format!("Failed to start API sidecar: {}", e));
                } else {
                    log_to_file("API sidecar started successfully");
                }
            });

            // Start the daily archive scheduler
            let archive_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                archive_scheduler(archive_handle).await;
            });

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

/// Background archive scheduler: creates daily auto-archives and cleans up old ones.
async fn archive_scheduler(app: tauri::AppHandle) {
    let retention_days = 30u32;

    loop {
        // Sleep until next 02:00
        let now = chrono::Local::now();
        let target_hour = 2;
        let next_run = if now.hour() < target_hour {
            now.date_naive()
                .and_hms_opt(target_hour, 0, 0)
                .unwrap()
        } else {
            (now.date_naive() + chrono::Duration::days(1))
                .and_hms_opt(target_hour, 0, 0)
                .unwrap()
        };
        let local_next = next_run
            .and_local_timezone(chrono::Local)
            .single()
            .unwrap_or_else(|| now + chrono::Duration::hours(1));
        let delay = (local_next - now).to_std().unwrap_or(std::time::Duration::from_secs(3600));

        tokio::time::sleep(delay).await;

        // Create daily archive
        match archive::create_archive(app.clone(), Some("daily".to_string())) {
            Ok(info) => {
                println!("[archive] Daily archive created: {} ({} bytes)", info.name, info.size);
            }
            Err(e) => {
                eprintln!("[archive] Daily archive failed: {}", e);
            }
        }

        // Cleanup old archives
        match archive::cleanup_old_archives(app.clone(), retention_days) {
            Ok(deleted) => {
                if deleted > 0 {
                    println!("[archive] Cleaned up {} old archives", deleted);
                }
            }
            Err(e) => {
                eprintln!("[archive] Cleanup failed: {}", e);
            }
        }
    }
}

use chrono::Timelike;
