import type { ChangeEntry, ConflictEntry } from '../change-tracker/types.js'

export type SyncMessage =
  | HandshakeMessage
  | HandshakeAckMessage
  | ChangesMessage
  | ChangesAckMessage
  | ConflictMessage
  | ConflictResolutionMessage
  | SyncCompleteMessage
  | SyncErrorMessage

export interface HandshakeMessage {
  type: 'handshake'
  deviceId: string
  deviceName: string
  lastSeq: number
  orgId: string
  protocolVersion: number
}

export interface HandshakeAckMessage {
  type: 'handshake_ack'
  deviceId: string
  deviceName: string
  lastSeq: number
}

export interface ChangesMessage {
  type: 'changes'
  changes: ChangeEntry[]
  batchSeq: number
  isLast: boolean
}

export interface ChangesAckMessage {
  type: 'changes_ack'
  lastProcessedSeq: number
}

export interface ConflictMessage {
  type: 'conflict'
  conflict: ConflictEntry
}

export interface ConflictResolutionMessage {
  type: 'conflict_resolution'
  conflictId: string
  resolution: 'local_wins' | 'remote_wins' | 'merged'
  data?: Record<string, unknown>
}

export interface SyncCompleteMessage {
  type: 'sync_complete'
  changesApplied: number
  conflictsResolved: number
}

export interface SyncErrorMessage {
  type: 'error'
  message: string
  code?: string
}

export const PROTOCOL_VERSION = 1
export const BATCH_SIZE = 500

export function serialize(msg: SyncMessage): string {
  return JSON.stringify(msg)
}

export function deserialize(data: string): SyncMessage {
  return JSON.parse(data) as SyncMessage
}
