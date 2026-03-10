use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

/// Holds the running sidecar process handle
struct SidecarState {
    child: Option<CommandChild>,
    ready: bool,
}

/// Initialize sidecar state (called once at setup)
fn ensure_state(app: &AppHandle) {
    if app.try_state::<Mutex<SidecarState>>().is_none() {
        app.manage(Mutex::new(SidecarState {
            child: None,
            ready: false,
        }));
    }
}

/// Start the Bun API sidecar process
pub async fn start(app: &AppHandle) -> Result<(), String> {
    ensure_state(app);

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    // Ensure data directory exists
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create data dir: {}", e))?;

    let db_path = data_dir.join("lgr.db");
    let db_path_str = db_path.to_string_lossy().to_string();

    // Resolve the API entry point relative to the app
    let api_script = if cfg!(debug_assertions) {
        // Development: resolve from CARGO_MANIFEST_DIR → repo root
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let repo_root = std::path::Path::new(manifest_dir)
            .parent() // packages/desktop
            .and_then(|p| p.parent()) // packages
            .and_then(|p| p.parent()) // repo root
            .unwrap_or_else(|| std::path::Path::new(manifest_dir));
        repo_root
            .join("packages/desktop-api/src/index.ts")
            .to_string_lossy()
            .to_string()
    } else {
        // Production: bundled alongside the app
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to get resource dir: {}", e))?;
        resource_dir
            .join("desktop-api/src/index.ts")
            .to_string_lossy()
            .to_string()
    };

    let shell = app.shell();
    let (mut rx, child) = shell
        .command("bun-sidecar")
        .args(&["run", &api_script])
        .env("LGR_MODE", "desktop")
        .env("LGR_DB_PATH", &db_path_str)
        .env("LGR_DESKTOP_PORT", "4080")
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    // Store the child handle
    {
        let state = app.state::<Mutex<SidecarState>>();
        let mut state = state.lock().unwrap();
        state.child = Some(child);
    }

    // Monitor sidecar output in background
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    // Detect when API is ready
                    if line_str.contains("LGR Desktop API running") {
                        let state = app_handle.state::<Mutex<SidecarState>>();
                        let mut state = state.lock().unwrap();
                        state.ready = true;
                        println!("[sidecar] API ready");
                    }
                    println!("[sidecar] {}", line_str);
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[sidecar] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(status) => {
                    println!("[sidecar] Process terminated: {:?}", status);
                    let state = app_handle.state::<Mutex<SidecarState>>();
                    let mut state = state.lock().unwrap();
                    state.child = None;
                    state.ready = false;
                    break;
                }
                _ => {}
            }
        }
    });

    // Wait for API to become ready (poll health check)
    for _ in 0..30 {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        let state = app.state::<Mutex<SidecarState>>();
        let state = state.lock().unwrap();
        if state.ready {
            return Ok(());
        }
    }

    Ok(()) // Start anyway even if not confirmed ready after 15s
}

/// Gracefully stop the sidecar
pub async fn shutdown(app: &AppHandle) {
    ensure_state(app);
    let state = app.state::<Mutex<SidecarState>>();
    let mut state = state.lock().unwrap();
    if let Some(child) = state.child.take() {
        let _ = child.kill();
        state.ready = false;
        println!("[sidecar] API stopped");
    }
}

// -- Tauri commands (callable from frontend) --

#[tauri::command]
pub async fn start_api(app: AppHandle) -> Result<String, String> {
    start(&app).await?;
    Ok("API started".to_string())
}

#[tauri::command]
pub async fn stop_api(app: AppHandle) -> Result<String, String> {
    shutdown(&app).await;
    Ok("API stopped".to_string())
}

#[tauri::command]
pub fn api_status(app: AppHandle) -> bool {
    ensure_state(&app);
    let state = app.state::<Mutex<SidecarState>>();
    let state = state.lock().unwrap();
    state.ready
}

#[tauri::command]
pub fn get_db_path(app: AppHandle) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    Ok(data_dir.join("lgr.db").to_string_lossy().to_string())
}
