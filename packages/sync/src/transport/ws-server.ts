import type { Database } from 'bun:sqlite'
import type { ServerWebSocket } from 'bun'
import { serialize, deserialize, type SyncMessage } from '../protocol/messages.js'
import { createHandshake, processHandshake, processHandshakeAck } from '../protocol/handshake.js'
import { generateChangeBatches, processChangesAck, createChangesAck } from '../protocol/delta-stream.js'
import { ConflictResolver } from '../conflict/resolver.js'
import { logConflict } from '../conflict/conflict-log.js'
import { getLatestSeq, getSyncState, upsertSyncState, insertRemoteChange } from '../change-tracker/change-log.js'
import { withTriggersDisabled } from '../change-tracker/triggers.js'
import { applyChange } from './apply-change.js'

export interface SyncServerOptions {
  db: Database
  orgId: string
  port: number
  onSyncComplete?: (peerId: string, stats: { sent: number; received: number; conflicts: number }) => void
}

interface PeerData {
  deviceId: string
  deviceName: string
}

/**
 * Create a WebSocket sync server that other LGR desktop instances can connect to.
 */
export function createSyncServer(options: SyncServerOptions) {
  const { db, orgId, port, onSyncComplete } = options
  const resolver = new ConflictResolver()

  const server = Bun.serve({
    port,
    hostname: '0.0.0.0',
    fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === '/sync') {
        const upgraded = server.upgrade(req, { data: { deviceId: '', deviceName: '' } as PeerData })
        if (!upgraded) {
          return new Response('WebSocket upgrade failed', { status: 400 })
        }
        return undefined
      }
      return new Response('LGR Sync Server', { status: 200 })
    },
    websocket: {
      open(ws: ServerWebSocket<PeerData>) {
        // Client connects — wait for handshake
      },

      message(ws: ServerWebSocket<PeerData>, rawMessage: string | Buffer) {
        const msg = deserialize(typeof rawMessage === 'string' ? rawMessage : rawMessage.toString())
        handleMessage(db, orgId, ws, msg, resolver, onSyncComplete)
      },

      close(ws: ServerWebSocket<PeerData>) {
        // Peer disconnected
      },
    },
  })

  return {
    server,
    stop() {
      server.stop()
    },
  }
}

function handleMessage(
  db: Database,
  orgId: string,
  ws: ServerWebSocket<PeerData>,
  msg: SyncMessage,
  resolver: ConflictResolver,
  onSyncComplete?: SyncServerOptions['onSyncComplete'],
) {
  switch (msg.type) {
    case 'handshake': {
      if (msg.orgId !== orgId) {
        ws.send(serialize({ type: 'error', message: 'Org ID mismatch', code: 'ORG_MISMATCH' }))
        ws.close()
        return
      }
      ws.data.deviceId = msg.deviceId
      ws.data.deviceName = msg.deviceName

      const ack = processHandshake(db, msg)
      ws.send(serialize(ack))

      // Send our pending changes to the peer
      const syncState = getSyncState(db, msg.deviceId)
      let sentCount = 0
      for (const batch of generateChangeBatches(db, msg.deviceId)) {
        ws.send(serialize(batch))
        sentCount += batch.changes.length
      }
      break
    }

    case 'changes': {
      let conflictCount = 0
      withTriggersDisabled(db, () => {
        for (const change of msg.changes) {
          try {
            const applied = applyChange(db, change, resolver)
            if (applied.hadConflict) {
              conflictCount++
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
            console.error(`[sync] Failed to apply change ${change.tableName}/${change.rowId}:`, err)
          }
        }
      })

      // Update sync state
      const syncState = getSyncState(db, ws.data.deviceId)
      upsertSyncState(db, {
        peerDeviceId: ws.data.deviceId,
        lastReceivedSeq: msg.batchSeq,
        lastSentSeq: syncState?.lastSentSeq ?? 0,
        lastSyncAt: new Date().toISOString(),
        peerName: ws.data.deviceName,
        peerAddress: null,
      })

      ws.send(serialize(createChangesAck(msg.batchSeq)))
      break
    }

    case 'changes_ack': {
      processChangesAck(db, ws.data.deviceId, msg)
      break
    }

    case 'sync_complete': {
      onSyncComplete?.(ws.data.deviceId, {
        sent: msg.changesApplied,
        received: 0,
        conflicts: msg.conflictsResolved,
      })
      break
    }
  }
}
