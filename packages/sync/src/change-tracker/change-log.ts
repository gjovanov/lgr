import type { Database } from 'bun:sqlite'
import type { ChangeEntry, DeviceInfo, SyncState } from './types.js'

/**
 * Read pending (unsynced) changes from the _changes table.
 */
export function getPendingChanges(db: Database, afterSeq: number = 0, limit: number = 1000): ChangeEntry[] {
  const stmt = db.prepare(`
    SELECT seq, table_name, row_id, operation, data, old_data, timestamp, device_id, synced
    FROM _changes
    WHERE synced = 0 AND seq > ?
    ORDER BY seq ASC
    LIMIT ?
  `)
  const rows = stmt.all(afterSeq, limit) as any[]
  return rows.map(mapChangeRow)
}

/**
 * Get changes after a given sequence number (for a specific peer).
 */
export function getChangesAfterSeq(db: Database, afterSeq: number, limit: number = 1000): ChangeEntry[] {
  const stmt = db.prepare(`
    SELECT seq, table_name, row_id, operation, data, old_data, timestamp, device_id, synced
    FROM _changes
    WHERE seq > ?
    ORDER BY seq ASC
    LIMIT ?
  `)
  const rows = stmt.all(afterSeq, limit) as any[]
  return rows.map(mapChangeRow)
}

/**
 * Mark changes as synced up to a given sequence number.
 */
export function markSynced(db: Database, upToSeq: number): void {
  db.prepare('UPDATE _changes SET synced = 1 WHERE seq <= ? AND synced = 0').run(upToSeq)
}

/**
 * Get the latest sequence number in the changes log.
 */
export function getLatestSeq(db: Database): number {
  const row = db.prepare('SELECT MAX(seq) as max_seq FROM _changes').get() as any
  return row?.max_seq ?? 0
}

/**
 * Insert a change entry received from a remote peer.
 * This bypasses triggers (the change was already tracked on the source).
 */
export function insertRemoteChange(db: Database, change: Omit<ChangeEntry, 'seq' | 'synced'>): void {
  db.prepare(`
    INSERT INTO _changes (table_name, row_id, operation, data, old_data, timestamp, device_id, synced)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    change.tableName,
    change.rowId,
    change.operation,
    change.data ? JSON.stringify(change.data) : null,
    change.oldData ? JSON.stringify(change.oldData) : null,
    change.timestamp,
    change.deviceId,
  )
}

// ── Device Info ──

export function getDeviceInfo(db: Database): DeviceInfo | null {
  const row = db.prepare('SELECT device_id, device_name, created_at FROM _device_info LIMIT 1').get() as any
  if (!row) return null
  return {
    deviceId: row.device_id,
    deviceName: row.device_name,
    createdAt: row.created_at,
  }
}

export function setDeviceInfo(db: Database, deviceId: string, deviceName: string): void {
  db.prepare(`
    INSERT OR REPLACE INTO _device_info (device_id, device_name, created_at)
    VALUES (?, ?, datetime('now'))
  `).run(deviceId, deviceName)
}

// ── Sync State ──

export function getSyncState(db: Database, peerDeviceId: string): SyncState | null {
  const row = db.prepare('SELECT * FROM _sync_state WHERE peer_device_id = ?').get(peerDeviceId) as any
  if (!row) return null
  return {
    peerDeviceId: row.peer_device_id,
    lastReceivedSeq: row.last_received_seq,
    lastSentSeq: row.last_sent_seq,
    lastSyncAt: row.last_sync_at,
    peerName: row.peer_name,
    peerAddress: row.peer_address,
  }
}

export function upsertSyncState(db: Database, state: SyncState): void {
  db.prepare(`
    INSERT INTO _sync_state (peer_device_id, last_received_seq, last_sent_seq, last_sync_at, peer_name, peer_address)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(peer_device_id) DO UPDATE SET
      last_received_seq = excluded.last_received_seq,
      last_sent_seq = excluded.last_sent_seq,
      last_sync_at = excluded.last_sync_at,
      peer_name = excluded.peer_name,
      peer_address = excluded.peer_address
  `).run(
    state.peerDeviceId,
    state.lastReceivedSeq,
    state.lastSentSeq,
    state.lastSyncAt,
    state.peerName,
    state.peerAddress,
  )
}

export function getAllPeers(db: Database): SyncState[] {
  const rows = db.prepare('SELECT * FROM _sync_state').all() as any[]
  return rows.map(row => ({
    peerDeviceId: row.peer_device_id,
    lastReceivedSeq: row.last_received_seq,
    lastSentSeq: row.last_sent_seq,
    lastSyncAt: row.last_sync_at,
    peerName: row.peer_name,
    peerAddress: row.peer_address,
  }))
}

// ── Helpers ──

function mapChangeRow(row: any): ChangeEntry {
  return {
    seq: row.seq,
    tableName: row.table_name,
    rowId: row.row_id,
    operation: row.operation,
    data: row.data ? JSON.parse(row.data) : null,
    oldData: row.old_data ? JSON.parse(row.old_data) : null,
    timestamp: row.timestamp,
    deviceId: row.device_id,
    synced: row.synced,
  }
}
