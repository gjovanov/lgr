/**
 * FR-20.49 (plan step P1-10b) — Н-18 Прил. 29 т. 8: a sale may open only if the fiscal device was
 * reached within the last two hours.
 *
 * Two halves, because the rule is only as good as the time it reads:
 * - **`lastCommunicationAt` is kept honest.** It used to be written when a bridge registered and
 *   when it was probed, and never again, so a till printing all day would have read "not reached
 *   since 07:00" by 09:00. Now every command the device answers updates it (`getPrinter`'s counted
 *   view hands each answer to `noteAnswered`), at most once a minute per device.
 * - **The rule** (`maySaleOpen`), enforced only in SUPTO production mode (`SUPTO_MODE`). A device not
 *   reached within the window is ASKED before anything is refused: a status read that answers is
 *   the device reached, and the sale opens. Only a device that is stale and silent stops it.
 *
 * ⚠ Development mode, the default and what every deployment runs today, enforces nothing: a till
 * that cannot sell is a shop that cannot trade, and that trade-off is the SUPTO declaration's
 * (FR-20.50), not a default's.
 */
import { config } from 'config'
import { FiscalDevice } from 'db/models'
import { logger } from 'services/logger'
import { getPrinter, isDeviceConnected } from './fiscal-device.service.js'

/** Прил. 29 т. 8: two hours. */
export const REACH_WINDOW_MS = 2 * 60 * 60 * 1000

/** A burst of commands (a receipt is a dozen) is one write, not twelve. */
const WRITE_EVERY_MS = 60_000

/** How long a stale device is given to answer before the sale is refused. */
const ASK_TIMEOUT_MS = 5_000

/** Commands that do not reach the device itself: opening and closing the transport. */
const NOT_THE_DEVICE = new Set(['connect', 'disconnect'])

type Writer = (deviceId: string, at: Date) => Promise<unknown>
const writeToDb: Writer = (deviceId, at) =>
  FiscalDevice.updateOne({ _id: deviceId }, { $set: { lastCommunicationAt: at } }).exec()
let write: Writer = writeToDb
const lastWritten = new Map<string, number>()

/** Tests only: where `noteAnswered` writes, and a fresh throttle. `null` restores the database. */
export function setReachWriterForTests(w: Writer | null): void {
  write = w ?? writeToDb
  lastWritten.clear()
}

/** The device answered `method` with `result` (`tracked`'s callback). */
export function noteAnswered(deviceId: string, method: string, result: unknown, now = Date.now()): void {
  if (NOT_THE_DEVICE.has(method)) return
  // A status read that came back "not connected" is the device NOT answering.
  if (method === 'getStatus' && (result as { connected?: boolean } | undefined)?.connected === false) return
  if (now - (lastWritten.get(deviceId) ?? 0) < WRITE_EVERY_MS) return
  lastWritten.set(deviceId, now)
  write(deviceId, new Date(now)).catch((err: any) =>
    logger.warn({ deviceId, err: err?.message }, 'fiscal: could not record that the device answered'),
  )
}

/** Was the device reached within the window? Never reached is not. */
export function reachedWithin(at: Date | string | null | undefined, now = Date.now(), windowMs = REACH_WINDOW_MS): boolean {
  if (!at) return false
  const t = new Date(at).getTime()
  return Number.isFinite(t) && now - t <= windowMs
}

export type SaleVerdict =
  | { ok: true }
  | { ok: false; deviceName: string; lastCommunicationAt: Date | null }

/** Ask a connected device for its status, within `ms`. `true` when it answered. */
async function askNow(deviceId: string, ms: number): Promise<boolean> {
  if (!isDeviceConnected(deviceId)) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const status = await Promise.race([
      getPrinter(deviceId).getStatus(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms) }),
    ])
    return status?.connected !== false
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * May a fiscal sale open in `warehouseId`? Its devices are the workstation's (a warehouse's tills
 * print on its devices, the connected one first). A warehouse with no active device is not this
 * rule's to judge.
 */
export async function maySaleOpen(
  orgId: string,
  warehouseId: string,
  opts: { now?: number; askTimeoutMs?: number } = {},
): Promise<SaleVerdict> {
  if (config.supto.mode !== 'production') return { ok: true }
  const now = opts.now ?? Date.now()
  const devices = (await FiscalDevice.find({ orgId, warehouseId, isActive: true })
    .select('name lastCommunicationAt')
    .lean()
    .exec()) as Array<{ _id: unknown; name?: string; lastCommunicationAt?: Date }>
  if (!devices.length) return { ok: true }
  if (devices.some(d => reachedWithin(d.lastCommunicationAt, now))) return { ok: true }

  // Stale: ask before refusing. An answer is the device reached (and `noteAnswered` records it).
  for (const d of devices) {
    if (await askNow(String(d._id), opts.askTimeoutMs ?? ASK_TIMEOUT_MS)) return { ok: true }
  }
  const newest = devices.reduce<{ name: string; at: Date | null }>(
    (best, d) => {
      const at = d.lastCommunicationAt ? new Date(d.lastCommunicationAt) : null
      return at && (!best.at || at > best.at) ? { name: d.name ?? '', at } : best
    },
    { name: devices[0].name ?? '', at: null },
  )
  logger.warn({ orgId, warehouseId, lastCommunicationAt: newest.at }, 'fiscal: a sale was refused, no device reached in 2 hours (Прил. 29 т. 8)')
  return { ok: false, deviceName: newest.name, lastCommunicationAt: newest.at }
}
