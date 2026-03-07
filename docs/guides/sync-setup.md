# Multi-Machine Sync Setup

## Overview

LGR desktop instances can sync data over LAN using WebSocket connections. Changes are tracked automatically via SQLite triggers and exchanged between peers.

## Setup

### 1. Initialize Device Identity

Each machine needs a unique device ID (done automatically on first launch):

```typescript
import { setDeviceInfo } from 'sync'
setDeviceInfo(db, crypto.randomUUID(), 'Warehouse PC')
```

### 2. Install Change Triggers

```typescript
import { installTriggers } from 'sync'
installTriggers(db)
```

### 3. Start Sync Server

```typescript
import { createSyncServer } from 'sync'

const server = createSyncServer({
  db,
  orgId: 'your-org-id',
  port: 4090,
  onSyncComplete: (peerId, stats) => {
    console.log(`Synced with ${peerId}: sent=${stats.sent}, received=${stats.received}`)
  },
})
```

### 4. Enable LAN Discovery

```typescript
import { SyncScheduler } from 'sync'

const scheduler = new SyncScheduler({
  db,
  orgId: 'your-org-id',
  syncPort: 4090,
  syncIntervalMs: 30_000,
  onPeerFound: (peer) => console.log(`Found peer: ${peer.name}`),
})
await scheduler.start()
```

## Manual Peer Connection

If UDP broadcast is blocked, connect to peers manually:

```typescript
const stats = await scheduler.syncWithAddress('ws://192.168.1.50:4090')
```

Or configure manual peers in Settings:

```json
{
  "sync": {
    "manualPeers": [
      { "name": "Office PC", "address": "192.168.1.50", "port": 4090 }
    ]
  }
}
```

## Conflict Resolution

### Automatic (Default)

| Data Type | Strategy |
|-----------|----------|
| Most fields | Last-Write-Wins per field |
| Stock quantities | Additive merge (sum deltas) |
| Account balances | Additive merge |
| Invoice/order status | State machine (furthest state wins) |

### Manual Review

Set `conflictResolution: 'manual'` in settings. Conflicts are logged to `_conflict_log` and can be reviewed in the app.

## Network Requirements

- LAN: UDP port 41234 (discovery) + TCP port 4090 (sync WebSocket)
- Both machines must be on the same network and same organization
