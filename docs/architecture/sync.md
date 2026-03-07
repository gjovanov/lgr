# Sync Engine

## Overview

The sync engine (`packages/sync`) enables bidirectional data synchronization between LGR desktop instances over LAN and between cloud (MongoDB) and desktop (SQLite).

## Change Tracking

### SQLite Triggers

Every table gets INSERT/UPDATE/DELETE triggers that log changes to the `_changes` table:

```sql
CREATE TABLE _changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
  data TEXT,        -- JSON: full row for INSERT/UPDATE
  old_data TEXT,    -- JSON: previous values for UPDATE/DELETE
  timestamp TEXT,   -- ISO 8601 with microseconds
  device_id TEXT,
  synced INTEGER DEFAULT 0
);
```

237 triggers (3 per 79 tables) are installed via `installTriggers(db)`. Triggers are guarded by `WHEN (SELECT COUNT(*) FROM _device_info) > 0` so no tracking occurs until the device is initialized.

### Device Identity

```sql
CREATE TABLE _device_info (
  device_id TEXT PRIMARY KEY,
  device_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Each desktop instance has a unique device ID (UUID) set on first launch.

## Sync Protocol

### Message Types

| Message | Direction | Purpose |
|---------|-----------|---------|
| `handshake` | A → B | Exchange device IDs, last known seq, org ID |
| `handshake_ack` | B → A | Confirm identity, send B's last seq |
| `changes` | Both | Batch of change entries with `batchSeq` and `isLast` flag |
| `changes_ack` | Both | Confirm receipt with `lastProcessedSeq` |
| `conflict` | B → A | Report detected conflict |
| `conflict_resolution` | A → B | Resolution decision |
| `sync_complete` | Both | Final stats |
| `error` | Both | Error with optional code |

### Flow

```
Machine A (initiator)              Machine B (responder)
─────────────────────              ─────────────────────
                    ── handshake ──►
                    ◄── handshake_ack ──
                    ── changes (batch) ──►
                                        Apply + detect conflicts
                    ◄── changes_ack ──
                    ◄── changes (B's pending) ──
  Apply changes
                    ── changes_ack ──►
                    ── sync_complete ──►
                    ◄── sync_complete ──
```

### Batching

Changes are sent in batches of 500 (`BATCH_SIZE`). The last batch has `isLast: true`.

## Conflict Resolution

### Strategies

| Strategy | Tables | Behavior |
|----------|--------|----------|
| **Field-level LWW** | Default (all others) | Per-field last-write-wins using timestamps |
| **Additive** | `stock_levels`, `accounts`, `leave_balances` | `base + localDelta + remoteDelta` |
| **State Machine** | `invoices`, `journal_entries`, `stock_movements`, `payroll_runs`, `production_orders`, `leave_requests`, `business_trips`, `deals` | Take furthest status in ordered state list |

### Additive Merge Example

```
Initial stock: 100
Machine A: receipt +20 → local stock 120
Machine B: dispatch -10 → local stock 90
After sync: 100 + (120-100) + (90-100) = 110
```

### Conflict Logging

All conflicts are logged to `_conflict_log` for audit/review:

```sql
CREATE TABLE _conflict_log (
  id TEXT PRIMARY KEY,
  table_name TEXT, row_id TEXT,
  local_data TEXT, remote_data TEXT,
  resolution TEXT, resolved_data TEXT,
  created_at TEXT, resolved_at TEXT
);
```

## Transport

### WebSocket Server

Each desktop instance runs a WebSocket sync server (configurable port). Peers connect via `ws://<ip>:<port>/sync`.

### LAN Discovery

UDP broadcast on port 41234. Each instance periodically broadcasts:

```json
{
  "type": "lgr-sync-announce",
  "deviceId": "...",
  "deviceName": "Warehouse PC",
  "orgId": "...",
  "syncPort": 4090
}
```

Only peers with the same `orgId` are accepted. Stale peers (no broadcast for 3 intervals) are pruned.

### Trigger Bypass

During sync apply, triggers are temporarily removed via `withTriggersDisabled()` to prevent change-loop amplification. Remote changes are recorded directly in `_changes` with `synced = 1`.

## MongoDB ↔ SQLite Migration

### Cloud → Desktop

`migrateMongoToSQLite(mongoRepos, sqliteRepos, orgId)`:

1. Fetch all records per table in FK dependency order
2. Generate new UUIDs for each record
3. Remap all FK fields using the `IdMapper`
4. Insert into SQLite
5. Persist `_id_map` table for future reverse migration

### Desktop → Cloud

`migrateSQLiteToMongo(sqliteRepos, mongoRepos, orgId, db)`:

1. Load existing `_id_map` to restore original MongoDB ObjectIds
2. For new records without mappings, generate 24-char hex IDs
3. Remap FKs in reverse and insert into MongoDB

## Scheduler

`SyncScheduler` orchestrates:
- LAN discovery (continuous)
- Periodic sync with all known peers (default: every 30 seconds)
- Manual sync via `syncWithAddress()`
