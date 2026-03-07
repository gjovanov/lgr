import type { Database } from 'bun:sqlite'
import { serialize, deserialize, type SyncMessage } from '../protocol/messages.js'
import { createHandshake, processHandshakeAck } from '../protocol/handshake.js'
import { generateChangeBatches, processChangesAck, createChangesAck } from '../protocol/delta-stream.js'
import { ConflictResolver } from '../conflict/resolver.js'
import { logConflict } from '../conflict/conflict-log.js'
import { getSyncState, upsertSyncState, insertRemoteChange } from '../change-tracker/change-log.js'
import { withTriggersDisabled } from '../change-tracker/triggers.js'
import { applyChange } from './apply-change.js'

export interface SyncClientOptions {
  db: Database
  orgId: string
  peerAddress: string
  onProgress?: (stats: { sent: number; received: number; conflicts: number }) => void
  onComplete?: (stats: { sent: number; received: number; conflicts: number }) => void
  onError?: (error: Error) => void
}

/**
 * Connect to a peer sync server and perform bidirectional sync.
 */
export async function syncWithPeer(options: SyncClientOptions): Promise<{
  sent: number
  received: number
  conflicts: number
}> {
  const { db, orgId, peerAddress, onProgress, onComplete, onError } = options
  const resolver = new ConflictResolver()

  return new Promise((resolve, reject) => {
    const stats = { sent: 0, received: 0, conflicts: 0 }
    let peerDeviceId = ''

    const ws = new WebSocket(`${peerAddress}/sync`)

    ws.onopen = () => {
      // Initiate handshake
      const handshake = createHandshake(db, orgId)
      ws.send(serialize(handshake))
    }

    ws.onmessage = (event) => {
      const msg = deserialize(event.data as string)

      switch (msg.type) {
        case 'handshake_ack': {
          peerDeviceId = msg.deviceId
          const { peerLastSeq } = processHandshakeAck(db, msg)

          // Send our changes to the peer
          for (const batch of generateChangeBatches(db, msg.deviceId)) {
            ws.send(serialize(batch))
            stats.sent += batch.changes.length
          }
          break
        }

        case 'changes': {
          withTriggersDisabled(db, () => {
            for (const change of msg.changes) {
              try {
                const applied = applyChange(db, change, resolver)
                stats.received++
                if (applied.hadConflict) {
                  stats.conflicts++
                  logConflict(db, {
                    id: crypto.randomUUID(),
                    tableName: change.tableName,
                    rowId: change.rowId,
                    localData: applied.localData ?? {},
                    remoteData: change.data ?? {},
                    resolution: applied.resolution,
                    resolvedData: applied.resolvedData,
                  })
                }
                insertRemoteChange(db, change)
              } catch (err) {
                console.error(`[sync-client] Failed to apply change:`, err)
              }
            }
          })

          // Update sync state
          const syncState = getSyncState(db, peerDeviceId)
          upsertSyncState(db, {
            peerDeviceId,
            lastReceivedSeq: msg.batchSeq,
            lastSentSeq: syncState?.lastSentSeq ?? 0,
            lastSyncAt: new Date().toISOString(),
            peerName: null,
            peerAddress,
          })

          ws.send(serialize(createChangesAck(msg.batchSeq)))
          onProgress?.(stats)

          if (msg.isLast) {
            ws.send(serialize({
              type: 'sync_complete',
              changesApplied: stats.received,
              conflictsResolved: stats.conflicts,
            }))
            ws.close()
            onComplete?.(stats)
            resolve(stats)
          }
          break
        }

        case 'changes_ack': {
          processChangesAck(db, peerDeviceId, msg)
          break
        }

        case 'error': {
          const err = new Error(msg.message)
          onError?.(err)
          ws.close()
          reject(err)
          break
        }
      }
    }

    ws.onerror = (event) => {
      const err = new Error('WebSocket connection error')
      onError?.(err)
      reject(err)
    }

    ws.onclose = () => {
      // If we haven't resolved yet, resolve with current stats
    }
  })
}
