# Archive & Backup Management

## Automatic Backups

By default, LGR creates a daily backup at 02:00 local time with 30-day retention.

### Configure via Settings API

```
PATCH /api/settings/archive
{
  "autoEnabled": true,
  "scheduleTime": "02:00",
  "retentionDays": 30,
  "directory": "~/LGR/archives"
}
```

## Manual Backup

### From the Desktop App (Tauri)

```typescript
const result = await invoke('create_archive', { name: 'before-update' })
// Returns: { path, name, size, created_at, is_compressed }
```

### Archive Format

Archives are `.db.zst` files — SQLite databases compressed with zstd (level 3).

Typical compression: 60-80% size reduction.

## Restore

### From the Desktop App

```typescript
// 1. Stop the API sidecar
await invoke('stop_api')

// 2. Restore
await invoke('restore_archive', {
  archivePath: '/path/to/2026-03-07_020000_daily.db.zst'
})

// 3. Restart the API
await invoke('start_api')
```

### Safety Features

- Decompressed archive is verified as valid SQLite (magic bytes check)
- `PRAGMA integrity_check` runs before swap
- Current DB is backed up as `.db.pre-restore` before replacement
- If swap fails, the original DB is restored automatically

## List & Manage Archives

```typescript
const archives = await invoke('list_archives')
// Returns: [{ path, name, size, created_at, is_compressed }, ...]

await invoke('delete_archive', { archivePath: '...' })

const stats = await invoke('get_archive_stats')
// Returns: { count, total_size, oldest, newest }

// Manual cleanup
const deleted = await invoke('cleanup_old_archives', { retentionDays: 30 })
```

## Storage Location

Archives are stored in `<app_data_dir>/archives/`:
- Linux: `~/.local/share/com.lgr.desktop/archives/`
- macOS: `~/Library/Application Support/com.lgr.desktop/archives/`
- Windows: `%APPDATA%/com.lgr.desktop/archives/`
