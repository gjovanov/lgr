export interface ChangeEntry {
  seq: number
  tableName: string
  rowId: string
  operation: 'INSERT' | 'UPDATE' | 'DELETE'
  data: Record<string, unknown> | null
  oldData: Record<string, unknown> | null
  timestamp: string
  deviceId: string
  synced: number
}

export interface SyncState {
  peerDeviceId: string
  lastReceivedSeq: number
  lastSentSeq: number
  lastSyncAt: string | null
  peerName: string | null
  peerAddress: string | null
}

export interface DeviceInfo {
  deviceId: string
  deviceName: string
  createdAt: string
}

export interface ConflictEntry {
  id: string
  tableName: string
  rowId: string
  localData: Record<string, unknown>
  remoteData: Record<string, unknown>
  resolution: 'local_wins' | 'remote_wins' | 'merged' | 'pending'
  resolvedData: Record<string, unknown> | null
  createdAt: string
  resolvedAt: string | null
}

export interface IdMapEntry {
  sqliteId: string
  mongoId: string
  tableName: string
}

export interface TableMeta {
  name: string
  repoKey: string
  columns: string[]
  isChild: boolean
  parentTable?: string
  parentFk?: string
}
