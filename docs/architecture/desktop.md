# Desktop App Architecture

## Stack

| Layer | Technology |
|-------|-----------|
| Shell | Tauri 2 (Rust) |
| Backend | Bun + Elysia.js (sidecar process) |
| Database | SQLite via `bun:sqlite` (WAL mode) |
| Frontend | Vue 3 + Vuetify 3 + Pinia |
| Sync | WebSocket + UDP broadcast |
| Archive | rusqlite backup + zstd compression |

## Process Model

```
┌──────────────────────────────────┐
│  Tauri Main Process (Rust)       │
│  - Window management             │
│  - System tray (show/quit)       │
│  - Archive scheduler (daily 02:00)│
│  - Auto-updater                   │
│                                   │
│  Spawns ─────────────────────┐   │
│                               │   │
│  ┌────────────────────────┐  │   │
│  │ Bun Sidecar Process    │  │   │
│  │ desktop-api/src/index.ts│  │   │
│  │ Port 4080 (localhost)   │  │   │
│  └────────────────────────┘  │   │
│                               │   │
│  WebView ◄── HTTP ──► Sidecar │   │
└──────────────────────────────────┘
```

## Tauri Commands

Exposed to frontend via `@tauri-apps/api/core`:

| Command | Purpose |
|---------|---------|
| `start_api` | Start the Bun sidecar |
| `stop_api` | Stop the sidecar |
| `api_status` | Check if API is ready |
| `get_db_path` | Get SQLite file path |
| `create_archive` | Create compressed backup |
| `restore_archive` | Restore from backup |
| `list_archives` | List available backups |
| `delete_archive` | Delete a backup file |
| `cleanup_old_archives` | Remove old backups |
| `get_archive_stats` | Archive count/size stats |

## Desktop API

Single Elysia.js process serving all 38+ controllers from 7 domain modules:

- Imports controllers directly from domain API packages (no code duplication)
- `DesktopAuthService` issues AND verifies JWTs locally
- First-run creates default org (`my-company`) + admin user
- Settings persisted to `settings.json` alongside the database

### Endpoints

```
/api/auth/login          Desktop login
/api/auth/logout         Desktop logout
/api/auth/me             Current user
/api/settings            Desktop settings CRUD
/api/org/:orgId/...      All domain controllers
```

## Desktop UI

Unified Vue 3 SPA combining all 7 module views:

- Sidebar with collapsible module groups (Accounting, Invoicing, etc.)
- Local login page (no Portal redirect)
- Vite aliases redirect each domain's `app.store.ts` to the desktop version
- 46 views imported from domain UI packages

## Archive System

### Rust Side
- `rusqlite::backup::Backup` for consistent SQLite snapshots during writes
- `zstd` compression (level 3) → `.db.zst` files
- Integrity verification on restore (SQLite magic bytes + `PRAGMA integrity_check`)
- Atomic restore: temp file → verify → swap (with rollback on failure)

### Scheduler
- Daily at 02:00 local time
- 30-day retention (configurable)
- Runs in Tauri's async runtime

## Data Storage

```
~/.local/share/com.lgr.desktop/
├── lgr.db              Main SQLite database
├── lgr.db-wal          WAL journal
├── settings.json       Desktop settings
└── archives/
    ├── 2026-03-07_020000_daily.db.zst
    └── 2026-03-06_143000_manual.db.zst
```

## Development

```bash
bun run dev:desktop      # API (4080) + UI (4081)
bun run dev:desktop-api  # API only
bun run dev:desktop-ui   # UI only (Vite, proxies to API)
bun run tauri:dev        # Full Tauri app (requires Rust toolchain)
bun run tauri:build      # Production build
```
