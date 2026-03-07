// ── Change Tracker ──
export type { ChangeEntry, SyncState, DeviceInfo, ConflictEntry, IdMapEntry, TableMeta } from './change-tracker/types.js'
export { TABLE_REGISTRY, getParentTables, getChildTables, getTrackableTables, getTableByRepoKey } from './change-tracker/table-registry.js'
export { installTriggers, removeTriggers, withTriggersDisabled, generateTriggerSQL } from './change-tracker/triggers.js'
export {
  getPendingChanges, getChangesAfterSeq, markSynced, getLatestSeq,
  insertRemoteChange, getDeviceInfo, setDeviceInfo,
  getSyncState, upsertSyncState, getAllPeers,
} from './change-tracker/change-log.js'

// ── Protocol ──
export type { SyncMessage, HandshakeMessage, HandshakeAckMessage, ChangesMessage, ChangesAckMessage, ConflictMessage, ConflictResolutionMessage, SyncCompleteMessage, SyncErrorMessage } from './protocol/messages.js'
export { serialize, deserialize, PROTOCOL_VERSION, BATCH_SIZE } from './protocol/messages.js'
export { createHandshake, processHandshake, processHandshakeAck } from './protocol/handshake.js'
export { generateChangeBatches, processChangesAck, createChangesAck } from './protocol/delta-stream.js'

// ── Conflict Resolution ──
export type { ResolvedConflict, ConflictStrategy } from './conflict/resolver.js'
export { ConflictResolver } from './conflict/resolver.js'
export { LWWStrategy, FieldLevelLWWStrategy } from './conflict/lww.js'
export { AdditiveStrategy } from './conflict/additive.js'
export { StateMachineStrategy, INVOICE_STATUS_ORDER, JOURNAL_STATUS_ORDER, MOVEMENT_STATUS_ORDER, PAYROLL_STATUS_ORDER, PRODUCTION_STATUS_ORDER, LEAVE_STATUS_ORDER, TRIP_STATUS_ORDER, DEAL_STATUS_ORDER } from './conflict/state-machine.js'
export { logConflict, getPendingConflicts, getConflicts, resolveConflict } from './conflict/conflict-log.js'

// ── Transport ──
export { createSyncServer, type SyncServerOptions } from './transport/ws-server.js'
export { syncWithPeer, type SyncClientOptions } from './transport/ws-client.js'
export { applyChange, type ApplyResult } from './transport/apply-change.js'
export { LANDiscovery, type Peer, type LANDiscoveryOptions } from './transport/lan-discovery.js'

// ── Migration ──
export { IdMapper } from './migration/id-mapper.js'
export { migrateMongoToSQLite, type MigrationResult, type MigrationOptions } from './migration/mongo-to-sqlite.js'
export { migrateSQLiteToMongo } from './migration/sqlite-to-mongo.js'

// ── Scheduler ──
export { SyncScheduler, type SyncSchedulerOptions } from './scheduler/sync-scheduler.js'
