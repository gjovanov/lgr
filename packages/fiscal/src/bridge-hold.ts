import { FiscalDevice } from 'db/models'
import { POD_ID, livePresence } from 'services/biz/fiscal-presence.service'
import { logger } from 'services/logger'
import { getPrinter, isDeviceConnected, lostHereAt, printerRegistered } from './fiscal-device.service.js'
import type { IFiscalPrinter } from './types.js'

/**
 * #869 (the owner's ruling, 2026-11-19): a request that reaches a fiscal device whose bridge has JUST dropped waits for
 * it to register again, up to `BRIDGE_HOLD_MS`, instead of being refused or saving a sale without its receipt.
 *
 * Since desktop-v0.1.14 a bridge that drops tries again 1 to 2 s later, so a till that restarts, a network that blinks or
 * a server that restarts leaves a gap of a few seconds. A sale in that gap was refused ("the fiscal printer is not
 * connected"), or, when it already held the printer, failed at its first command and was saved without its receipt.
 *
 * The rules:
 *  - only for a device whose bridge was LOST within `BRIDGE_LOST_RECENT_MS`: one away longer is gone, and a request for
 *    it answers at once, as it always did. A deliberate stop (a revocation, a takeover) is no loss;
 *  - only before anything of the request has been sent to the device: in the routing layer, before the handler runs or
 *    the request is forwarded (`holdForBridge`, `fiscal-route.ts`); for a document in print, at the start of its
 *    operation (`printerForOperation`). ⚠ A command already handed to a socket that then dropped may have reached the
 *    device, and it is never sent again: a second fiscal receipt is the one failure this must never cause;
 *  - a read (GET) never waits: a status poll says what is true now;
 *  - the wait ends as soon as the device is held again, here or by another process. Held elsewhere, the routing layer
 *    forwards the request there (FR-24.50); a document already in print cannot follow it, and fails as it always did.
 */

/** How long a request waits for a bridge that has just dropped. */
export const BRIDGE_HOLD_MS = 5_000

/** "Just": a bridge lost longer ago than this is gone, and nothing waits for it. */
export const BRIDGE_LOST_RECENT_MS = 60_000

/** How often a wait looks for the device held by another process. A registration here wakes it at once. */
const POLL_MS = 250

export interface BridgeTarget {
  orgId: string
  deviceId: string
  deviceNumber: string
  /** `FiscalDevice.bridgeLostAt`, when the caller has already read one; otherwise the hold reads the row. */
  lostAt?: Date | number | null
}

export type BridgeWait = 'here' | 'elsewhere' | 'timeout'

/** Whether a bridge lost at `at` was lost within `BRIDGE_LOST_RECENT_MS`. (Either way of a few seconds of skew between pods.) */
export function justLost(at: Date | number | null | undefined, now = Date.now()): boolean {
  if (at === null || at === undefined) return false
  const t = typeof at === 'number' ? at : new Date(at).getTime()
  return Number.isFinite(t) && Math.abs(now - t) <= BRIDGE_LOST_RECENT_MS
}

/**
 * Held by another process right now: a live presence row that is neither this process's (one being registered here is
 * waited for, not "elsewhere") nor one an earlier run of it left at its own address (lgr#555).
 */
async function heldElsewhere(t: BridgeTarget, self: string | null): Promise<boolean> {
  const row = await livePresence({ orgId: t.orgId, deviceNumber: t.deviceNumber })
  return !!row && row.podId !== POD_ID && !(!!self && row.podAddr === self)
}

/** When the device's bridge was last lost anywhere, as the device row says. */
async function storedLostAt(t: BridgeTarget): Promise<Date | null> {
  const d: any = await FiscalDevice.findOne({ _id: t.deviceId, orgId: t.orgId }, { bridgeLostAt: 1 }).lean().exec()
  return d?.bridgeLostAt ?? null
}

/**
 * Wait up to `holdMs` for the device to be held again: 'here' (a printer is registered in this process), 'elsewhere'
 * (another process holds it) or 'timeout'. Never throws: a presence read that fails only stops it looking elsewhere.
 */
export async function awaitBridge(t: BridgeTarget, opts: { holdMs?: number; self?: string | null } = {}): Promise<BridgeWait> {
  const deadline = Date.now() + (opts.holdMs ?? BRIDGE_HOLD_MS)
  let lookElsewhere = true
  for (;;) {
    if (isDeviceConnected(t.deviceId)) return 'here'
    if (lookElsewhere) {
      try {
        if (await heldElsewhere(t, opts.self ?? null)) return 'elsewhere'
      } catch (e: any) {
        lookElsewhere = false
        logger.warn({ deviceNumber: t.deviceNumber, error: e?.message }, 'Fiscal bridge wait: cannot read who holds the device; waiting here only')
      }
    }
    const left = deadline - Date.now()
    if (left <= 0) return 'timeout'
    if (await printerRegistered(t.deviceId, Math.min(POLL_MS, left))) return 'here'
  }
}

/**
 * The routing layer's half (`fiscal-route.ts`): before a request that may print runs here or is forwarded, wait for its
 * device when that device's bridge has just dropped. What the wait came to, or null when nothing waited: the device is
 * held (here or elsewhere), was not lost recently, or could not be read (which never fails the request).
 */
export async function holdForBridge(t: BridgeTarget, opts: { self?: string | null; holdMs?: number } = {}): Promise<BridgeWait | null> {
  if (isDeviceConnected(t.deviceId)) return null
  try {
    // This process's own stamp first: it is written the moment the socket closes, before the row is.
    const lost = justLost(lostHereAt(t.deviceId)) || justLost(t.lostAt ?? (await storedLostAt(t)))
    if (!lost || (await heldElsewhere(t, opts.self ?? null))) return null
  } catch (e: any) {
    logger.warn({ deviceNumber: t.deviceNumber, error: e?.message }, 'Fiscal bridge hold: could not read the device; not waiting')
    return null
  }
  const started = Date.now()
  const outcome = await awaitBridge(t, opts)
  logger.info({ deviceId: t.deviceId, deviceNumber: t.deviceNumber, outcome, waitedMs: Date.now() - started }, 'Fiscal request waited for its bridge (#869)')
  return outcome
}

/**
 * The print's half: the printer a fiscal operation runs on, chosen at its OUTERMOST start, before anything of it is sent
 * (`tillPrinter`'s `operation`).
 *
 * `held` is the printer the request was handed. It stays while the device's registry still holds it. A newer one (the
 * bridge dropped and came back while the document waited for the device's turn) takes its place at once: nothing of
 * this operation went through the old one. None at all, with the bridge lost HERE within `BRIDGE_LOST_RECENT_MS`: wait
 * for one, up to `BRIDGE_HOLD_MS`. Otherwise `held` stays, and its first command fails as it always did.
 *
 * ⚠ Never mid-operation. Inside one, a command may already have gone through the old socket and reached the device, and
 * the device holds this document's receipt under the old driver's sequence numbers.
 */
export async function printerForOperation(held: IFiscalPrinter, t: BridgeTarget, opts: { self?: string | null; holdMs?: number } = {}): Promise<IFiscalPrinter> {
  if (isDeviceConnected(t.deviceId)) {
    const current = getPrinter(t.deviceId)
    if (current !== held) {
      logger.info({ deviceId: t.deviceId, deviceNumber: t.deviceNumber }, 'Fiscal bridge came back while this document waited: it prints on the new one (#869)')
    }
    return current
  }
  if (!justLost(lostHereAt(t.deviceId))) return held
  const started = Date.now()
  const outcome = await awaitBridge(t, opts)
  logger.info({ deviceId: t.deviceId, deviceNumber: t.deviceNumber, outcome, waitedMs: Date.now() - started }, 'Fiscal document waited for its bridge (#869)')
  return outcome === 'here' && isDeviceConnected(t.deviceId) ? getPrinter(t.deviceId) : held
}
