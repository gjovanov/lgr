/**
 * Time Synchronization Service for SUPTO compliance.
 *
 * Appendix 29 requires:
 * - "Reliable astronomical time source"
 * - "Mandatory synchronization between workstations and fiscal devices"
 *
 * This service verifies the server's clock (`clock.ts`) and sets the fiscal devices' clocks from it.
 *
 * ⚠ FR-20.22 (plan step P1-10, AC 58): **no unverified clock reaches a fiscal device.** A device
 * writes the time it is given into its fiscal records, which cannot be corrected afterwards. So a
 * device is set automatically only when:
 * - the server's clock was verified within 24 h and was then off by no more than 2 minutes, and has
 *   not moved since (`clockTrusted`);
 * - and the device's own clock would move by no more than 2 minutes.
 *
 * Anything else sets nothing, and says why. A person confirms with the device's time sync
 * (`POST /fiscal/device/:id/sync-time` with `confirm: true`).
 *
 * Before: the check reported drift 0 whenever it could not reach its source, and the cycle then set
 * every device to `new Date()` whatever the check had said, a CRITICAL drift included.
 */

import { logger } from 'services/logger'
import { getActiveDeviceIds, getPrinter } from './fiscal-device.service.js'
import { clockTrusted, formatStep, MAX_STEP_MS, verifyClock, type ClockCheck } from './clock.js'

/** Check the server's clock and say how it stands. A check that reached nothing is *unknown*. */
export async function verifyServerTime(): Promise<ClockCheck> {
  const check = await verifyClock()
  if (check.state === 'unknown') {
    logger.warn({ reason: check.reason }, 'The server clock could not be verified: fiscal devices are not set from it until it is')
    return check
  }
  const at = { driftMs: check.driftMs, source: check.source, precisionMs: check.precisionMs }
  const drift = Math.abs(check.driftMs)
  if (drift > MAX_STEP_MS) {
    logger.error(at, `CRITICAL: the server clock is off by ${formatStep(check.driftMs)}: fiscal devices are not set from it`)
  } else if (drift > 30_000) {
    logger.error(at, 'Server clock drift exceeds 30 seconds — fiscal receipt timestamps may be inaccurate')
  } else if (drift > 2000) {
    logger.warn(at, 'Server clock drift exceeds 2 seconds — consider NTP synchronization')
  } else {
    logger.info(at, 'Server clock verified (within tolerance)')
  }
  return check
}

export interface DeviceSyncResult {
  /** The devices whose clocks were set. */
  set: string[]
  /** The devices left as they were, and why: each one waits for a person. */
  held: Array<{ deviceId: string; reason: string }>
}

/** Set every connected fiscal device's clock from the server's, where FR-20.22 allows it. */
export async function syncAllFiscalDevices(): Promise<DeviceSyncResult> {
  const result: DeviceSyncResult = { set: [], held: [] }
  const deviceIds = getActiveDeviceIds()
  if (deviceIds.length === 0) return result

  const trust = clockTrusted()
  if (!trust.ok) {
    for (const deviceId of deviceIds) result.held.push({ deviceId, reason: trust.reason })
    logger.warn({ reason: trust.reason, devices: deviceIds.length },
      'Nothing set in the fiscal devices: the server clock is not verified (FR-20.22). A person confirms with the device\'s time sync.')
    return result
  }

  for (const deviceId of deviceIds) {
    try {
      const printer = getPrinter(deviceId)
      const theirs = await printer.readDateTime()
      const now = new Date()
      const step = now.getTime() - theirs.getTime()
      if (Math.abs(step) > MAX_STEP_MS) {
        const reason = `the device's clock would move by ${formatStep(step)}: a step that large waits for a person`
        result.held.push({ deviceId, reason })
        logger.warn({ deviceId, stepMs: step }, `Fiscal device clock not set: ${reason}`)
        continue
      }
      await printer.syncDateTime(now)
      result.set.push(deviceId)
    } catch (e: any) {
      result.held.push({ deviceId, reason: `the device did not answer: ${e.message}` })
      logger.warn({ deviceId, error: e.message }, 'Failed to sync fiscal device time')
    }
  }

  logger.info({ set: result.set.length, held: result.held.length, total: deviceIds.length }, 'Fiscal device time sync completed')
  return result
}

/**
 * Run a full time verification and device sync cycle.
 * Call this on startup and periodically (e.g., every 6 hours).
 */
export async function runTimeSyncCycle(): Promise<void> {
  await verifyServerTime()
  await syncAllFiscalDevices()
}
