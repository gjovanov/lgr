import { randomUUID } from 'crypto'
import { disconnectDevice } from 'fiscal/fiscal-device.service'
import { claimPresence, heartbeatPresence, releasePresence } from 'services/biz/fiscal-presence.service'
import { logger } from 'services/logger'
import { podAddr } from '../tunnel/pod.js'

/**
 * FR-24.45: devices THIS pod opened itself over TCP (`kind: 'server'`). They hold a row like any
 * bridge, so a sibling pod does not open the same device and the device lists say who has it.
 *
 * (Moved out of `fiscal-bridge.ts` unchanged, which is over the FR-32.26 line budget: the bridge's
 * heartbeat and its graceful stop still drive these, through `heartbeatServerHolds` and
 * `releaseAllServerDevices`.)
 */
const serverHolds = new Map<string, { orgId: string; deviceNumber: string; deviceId: string; connId: string }>()

const holdKey = (orgId: string, deviceNumber: string) => `${orgId}:${deviceNumber}`

/** Claim a device the server is about to open. Null when it is free; the holder's label when not. */
export async function holdServerDevice(d: { orgId: string; deviceNumber: string; deviceId: string; label: string }): Promise<string | null> {
  const key = holdKey(d.orgId, d.deviceNumber)
  const connId = serverHolds.get(key)?.connId ?? randomUUID()
  const claim = await claimPresence(
    { orgId: d.orgId, deviceNumber: d.deviceNumber, deviceId: d.deviceId },
    { kind: 'server', label: d.label },
    { connId, podAddr: podAddr() },
  )
  if (!claim.ok) return claim.holder.label
  serverHolds.set(key, { orgId: d.orgId, deviceNumber: d.deviceNumber, deviceId: d.deviceId, connId })
  return null
}

/** Let go of a device the server opened. */
export async function releaseServerDevice(orgId: string, deviceNumber: string): Promise<void> {
  const key = holdKey(orgId, deviceNumber)
  const hold = serverHolds.get(key)
  if (!hold) return
  serverHolds.delete(key)
  await releasePresence({ orgId, deviceNumber }, hold.connId).catch(() => /* its row stops counting by itself within DEAD_MS */ undefined)
}

/** Let go of every device the server opened: the graceful stop (`closeAllBridges`). */
export async function releaseAllServerDevices(): Promise<void> {
  for (const hold of [...serverHolds.values()]) await releaseServerDevice(hold.orgId, hold.deviceNumber)
}

/** The heartbeat of the rows these devices hold. One that is no longer this pod's is closed here. */
export async function heartbeatServerHolds(): Promise<void> {
  if (!serverHolds.size) return
  const holds = [...serverHolds.values()]
  for (const lost of await heartbeatPresence(holds)) {
    const hold = holds.find(h => h.connId === lost.connId)
    if (!hold) continue
    serverHolds.delete(holdKey(hold.orgId, hold.deviceNumber))
    logger.warn({ deviceNumber: hold.deviceNumber, reason: lost.reason }, 'A server-opened fiscal device was taken by another holder')
    await disconnectDevice(hold.deviceId).catch(() => /* it logs its own failure; the device is another holder's now */ undefined)
  }
}
