import type { Database } from 'bun:sqlite'
import type { ChangesMessage, ChangesAckMessage } from './messages.js'
import { BATCH_SIZE } from './messages.js'
import { getChangesAfterSeq, getSyncState, upsertSyncState } from '../change-tracker/change-log.js'

/**
 * Generate batches of changes to send to a peer.
 * Yields ChangesMessage objects that should be sent over WebSocket.
 */
export function* generateChangeBatches(db: Database, peerDeviceId: string): Generator<ChangesMessage> {
  const syncState = getSyncState(db, peerDeviceId)
  const afterSeq = syncState?.lastSentSeq ?? 0
  let currentSeq = afterSeq

  while (true) {
    const changes = getChangesAfterSeq(db, currentSeq, BATCH_SIZE)
    if (changes.length === 0) break

    const lastSeq = changes[changes.length - 1].seq
    const isLast = changes.length < BATCH_SIZE

    yield {
      type: 'changes',
      changes,
      batchSeq: lastSeq,
      isLast,
    }

    currentSeq = lastSeq
    if (isLast) break
  }
}

/**
 * Process an ack from a peer confirming they received our changes.
 * Updates the sync state with the last sent seq.
 */
export function processChangesAck(db: Database, peerDeviceId: string, ack: ChangesAckMessage): void {
  const syncState = getSyncState(db, peerDeviceId)
  if (syncState) {
    upsertSyncState(db, {
      ...syncState,
      lastSentSeq: ack.lastProcessedSeq,
      lastSyncAt: new Date().toISOString(),
    })
  }
}

/**
 * Create an ack message after processing received changes.
 */
export function createChangesAck(lastProcessedSeq: number): ChangesAckMessage {
  return {
    type: 'changes_ack',
    lastProcessedSeq,
  }
}
