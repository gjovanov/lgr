use std::path::PathBuf;
use serde::Serialize;
use tauri::AppHandle;
use tauri::Manager;

#[derive(Serialize, Clone)]
pub struct ArchiveInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub created_at: String,
    pub is_compressed: bool,
}

/// Create a compressed archive of the SQLite database.
/// Uses SQLite's online backup API for a consistent snapshot, then compresses with zstd.
#[tauri::command]
pub fn create_archive(
    app: AppHandle,
    name: Option<String>,
) -> Result<ArchiveInfo, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let db_path = data_dir.join("lgr.db");

    let archive_dir = data_dir.join("archives");
    std::fs::create_dir_all(&archive_dir)
        .map_err(|e| format!("Failed to create archive dir: {}", e))?;

    let timestamp = chrono::Local::now().format("%Y-%m-%d_%H%M%S").to_string();
    let label = name.unwrap_or_else(|| "manual".to_string());
    let backup_filename = format!("{}_{}.db", timestamp, label);
    let backup_path = archive_dir.join(&backup_filename);

    // SQLite online backup (consistent snapshot even during writes)
    {
        let src_conn = rusqlite::Connection::open(&db_path)
            .map_err(|e| format!("Failed to open source DB: {}", e))?;
        let mut dst_conn = rusqlite::Connection::open(&backup_path)
            .map_err(|e| format!("Failed to create backup DB: {}", e))?;
        let backup = rusqlite::backup::Backup::new(&src_conn, &mut dst_conn)
            .map_err(|e| format!("Failed to init backup: {}", e))?;
        backup
            .run_to_completion(100, std::time::Duration::from_millis(50), None)
            .map_err(|e| format!("Backup failed: {}", e))?;
    }

    // Compress with zstd (level 3 = good balance of speed/compression)
    let compressed_filename = format!("{}.zst", backup_filename);
    let compressed_path = archive_dir.join(&compressed_filename);

    let input = std::fs::read(&backup_path)
        .map_err(|e| format!("Failed to read backup: {}", e))?;
    let compressed = zstd::encode_all(input.as_slice(), 3)
        .map_err(|e| format!("Compression failed: {}", e))?;
    std::fs::write(&compressed_path, &compressed)
        .map_err(|e| format!("Failed to write compressed archive: {}", e))?;

    // Remove uncompressed backup
    std::fs::remove_file(&backup_path).ok();

    let metadata = std::fs::metadata(&compressed_path)
        .map_err(|e| format!("Failed to read archive metadata: {}", e))?;

    Ok(ArchiveInfo {
        path: compressed_path.to_string_lossy().to_string(),
        name: compressed_filename,
        size: metadata.len(),
        created_at: timestamp,
        is_compressed: true,
    })
}

/// Restore the database from a compressed archive.
/// Stops the API sidecar, replaces the DB file, then restarts.
#[tauri::command]
pub fn restore_archive(
    app: AppHandle,
    archive_path: String,
) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let db_path = data_dir.join("lgr.db");

    let archive = PathBuf::from(&archive_path);
    if !archive.exists() {
        return Err(format!("Archive not found: {}", archive_path));
    }

    // Decompress zstd
    let compressed = std::fs::read(&archive)
        .map_err(|e| format!("Failed to read archive: {}", e))?;
    let decompressed = zstd::decode_all(compressed.as_slice())
        .map_err(|e| format!("Decompression failed: {}", e))?;

    // Verify it's a valid SQLite database (check magic bytes)
    if decompressed.len() < 16 || &decompressed[0..16] != b"SQLite format 3\0" {
        return Err("Invalid archive: not a SQLite database".to_string());
    }

    // Write decompressed DB to a temp file first
    let temp_path = db_path.with_extension("db.restoring");
    std::fs::write(&temp_path, &decompressed)
        .map_err(|e| format!("Failed to write temp DB: {}", e))?;

    // Verify the restored DB is usable
    {
        let conn = rusqlite::Connection::open(&temp_path)
            .map_err(|e| format!("Restored DB is corrupt: {}", e))?;
        conn.execute_batch("PRAGMA integrity_check")
            .map_err(|e| format!("Restored DB integrity check failed: {}", e))?;
    }

    // Swap: backup current DB, move temp to main
    let old_backup = db_path.with_extension("db.pre-restore");
    if db_path.exists() {
        std::fs::rename(&db_path, &old_backup)
            .map_err(|e| format!("Failed to backup current DB: {}", e))?;
    }

    std::fs::rename(&temp_path, &db_path)
        .map_err(|e| {
            // Try to restore the old DB
            if old_backup.exists() {
                std::fs::rename(&old_backup, &db_path).ok();
            }
            format!("Failed to install restored DB: {}", e)
        })?;

    // Remove old backup
    std::fs::remove_file(&old_backup).ok();

    // Also remove WAL/SHM files from old DB
    let wal_path = db_path.with_extension("db-wal");
    let shm_path = db_path.with_extension("db-shm");
    std::fs::remove_file(&wal_path).ok();
    std::fs::remove_file(&shm_path).ok();

    Ok(())
}

/// List all archives in the archive directory.
#[tauri::command]
pub fn list_archives(app: AppHandle) -> Result<Vec<ArchiveInfo>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let archive_dir = data_dir.join("archives");

    if !archive_dir.exists() {
        return Ok(vec![]);
    }

    let mut archives: Vec<ArchiveInfo> = Vec::new();

    let entries = std::fs::read_dir(&archive_dir)
        .map_err(|e| format!("Failed to read archive dir: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();

        // Only list .db.zst files (compressed archives)
        if !name.ends_with(".db.zst") {
            continue;
        }

        let metadata = entry.metadata().map_err(|e| format!("Metadata error: {}", e))?;

        // Extract timestamp from filename: YYYY-MM-DD_HHMMSS_label.db.zst
        let created_at = name
            .split('_')
            .take(2)
            .collect::<Vec<_>>()
            .join("_");

        archives.push(ArchiveInfo {
            path: path.to_string_lossy().to_string(),
            name,
            size: metadata.len(),
            created_at,
            is_compressed: true,
        });
    }

    // Sort by created_at descending (newest first)
    archives.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    Ok(archives)
}

/// Delete a specific archive file.
#[tauri::command]
pub fn delete_archive(archive_path: String) -> Result<(), String> {
    let path = PathBuf::from(&archive_path);
    if !path.exists() {
        return Err(format!("Archive not found: {}", archive_path));
    }
    if !path.to_string_lossy().ends_with(".db.zst") {
        return Err("Can only delete .db.zst archive files".to_string());
    }
    std::fs::remove_file(&path)
        .map_err(|e| format!("Failed to delete archive: {}", e))?;
    Ok(())
}

/// Delete archives older than the specified number of days.
#[tauri::command]
pub fn cleanup_old_archives(app: AppHandle, retention_days: u32) -> Result<u32, String> {
    let archives = list_archives(app)?;
    let cutoff = chrono::Local::now() - chrono::Duration::days(retention_days as i64);
    let cutoff_str = cutoff.format("%Y-%m-%d_%H%M%S").to_string();

    let mut deleted = 0u32;
    for archive in &archives {
        if archive.created_at < cutoff_str {
            std::fs::remove_file(&archive.path).ok();
            deleted += 1;
        }
    }

    Ok(deleted)
}

/// Get the size of the archive directory.
#[tauri::command]
pub fn get_archive_stats(app: AppHandle) -> Result<ArchiveStats, String> {
    let archives = list_archives(app)?;
    let total_size: u64 = archives.iter().map(|a| a.size).sum();
    Ok(ArchiveStats {
        count: archives.len() as u32,
        total_size,
        oldest: archives.last().map(|a| a.created_at.clone()),
        newest: archives.first().map(|a| a.created_at.clone()),
    })
}

#[derive(Serialize)]
pub struct ArchiveStats {
    pub count: u32,
    pub total_size: u64,
    pub oldest: Option<String>,
    pub newest: Option<String>,
}
