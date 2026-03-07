// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod archive;
mod sidecar;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

fn main() {
    tauri::Builder::default()
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

            // Auto-start the API sidecar
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sidecar::start(&handle).await {
                    eprintln!("Failed to start API sidecar: {}", e);
                }
            });

            // Start the daily archive scheduler
            let archive_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                archive_scheduler(archive_handle).await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Minimize to tray on close instead of quitting
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
