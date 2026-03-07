import type { Database } from 'bun:sqlite'
import type { HandshakeMessage, HandshakeAckMessage } from './messages.js'
import { PROTOCOL_VERSION } from './messages.js'
import { getDeviceInfo, getLatestSeq, getSyncState, upsertSyncState } from '../change-tracker/change-log.js'

/**
 * Create a handshake message to initiate sync with a peer.
 */
export function createHandshake(db: Database, orgId: string): HandshakeMessage {
  const device = getDeviceInfo(db)
  if (!device) throw new Error('Device not initialized. Call setDeviceInfo() first.')

  return {
    type: 'handshake',
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    lastSeq: getLatestSeq(db),
    orgId,
    protocolVersion: PROTOCOL_VERSION,
  }
}

/**
 * Process a received handshake and produce an ack.
 * Also updates the peer's sync state.
 */
export function processHandshake(db: Database, msg: HandshakeMessage): HandshakeAckMessage {
  const device = getDeviceInfo(db)
  if (!device) throw new Error('Device not initialized.')

  // Update our knowledge of this peer
  const existing = getSyncState(db, msg.deviceId)
  upsertSyncState(db, {
    peerDeviceId: msg.deviceId,
    lastReceivedSeq: existing?.lastReceivedSeq ?? 0,
    lastSentSeq: existing?.lastSentSeq ?? 0,
    lastSyncAt: new Date().toISOString(),
    peerName: msg.deviceName,
    peerAddress: null,
  })

  return {
    type: 'handshake_ack',
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    lastSeq: getLatestSeq(db),
  }
}

/**
 * Process a handshake ack from a peer.
 * Returns the peer's last known seq so we know what changes to send.
 */
export function processHandshakeAck(db: Database, msg: HandshakeAckMessage): { peerLastSeq: number } {
  const existing = getSyncState(db, msg.deviceId)
  upsertSyncState(db, {
    peerDeviceId: msg.deviceId,
    lastReceivedSeq: existing?.lastReceivedSeq ?? 0,
    lastSentSeq: existing?.lastSentSeq ?? 0,
    lastSyncAt: new Date().toISOString(),
    peerName: msg.deviceName,
    peerAddress: null,
  })

  return { peerLastSeq: existing?.lastSentSeq ?? 0 }
}
