/**
 * NTP Time Synchronization Service for SUPTO compliance.
 *
 * Appendix 29 requires:
 * - "Reliable astronomical time source"
 * - "Mandatory synchronization between workstations and fiscal devices"
 *
 * This service verifies server time against NTP and syncs fiscal device clocks.
 */

import { logger } from 'services/logger'
import { getActiveDeviceIds, getPrinter } from './fiscal-device.service.js'

/**
 * Check server time against NTP pool. Returns drift in milliseconds.
 * Uses Bun's built-in fetch to query a time API as NTP client.
 */
export async function checkServerTimeDrift(): Promise<{ driftMs: number; ntpTime: Date; serverTime: Date }> {
  const serverTime = new Date()

  try {
    // Use worldtimeapi.org as a reliable time source (HTTP-based, no UDP NTP needed)
    const response = await fetch('http://worldtimeapi.org/api/timezone/Etc/UTC', { signal: AbortSignal.timeout(5000) })
    const data = await response.json() as { datetime: string; unixtime: number }
    const ntpTime = new Date(data.unixtime * 1000)
    const driftMs = Math.abs(serverTime.getTime() - ntpTime.getTime())

    return { driftMs, ntpTime, serverTime }
  } catch (e: any) {
    logger.warn({ error: e.message }, 'NTP time check failed, falling back to server time')
    return { driftMs: 0, ntpTime: serverTime, serverTime }
  }
}

/**
 * Verify server time is within acceptable drift.
 * Logs warning if drift > 2 seconds, error if > 30 seconds.
 */
export async function verifyServerTime(): Promise<void> {
  const { driftMs, ntpTime, serverTime } = await checkServerTimeDrift()

  if (driftMs > 30000) {
    logger.error({ driftMs, ntpTime: ntpTime.toISOString(), serverTime: serverTime.toISOString() },
      'CRITICAL: Server time drift exceeds 30 seconds — fiscal receipt timestamps may be inaccurate')
  } else if (driftMs > 2000) {
    logger.warn({ driftMs, ntpTime: ntpTime.toISOString(), serverTime: serverTime.toISOString() },
      'Server time drift exceeds 2 seconds — consider NTP synchronization')
  } else {
    logger.info({ driftMs }, 'Server time verified (within tolerance)')
  }
}

/**
 * Synchronize all connected fiscal device clocks with server time.
 */
export async function syncAllFiscalDevices(): Promise<void> {
  const deviceIds = getActiveDeviceIds()
  if (deviceIds.length === 0) return

  const now = new Date()
  let synced = 0
  let failed = 0

  for (const deviceId of deviceIds) {
    try {
      const printer = getPrinter(deviceId)
      await printer.syncDateTime(now)
      synced++
    } catch (e: any) {
      logger.warn({ deviceId, error: e.message }, 'Failed to sync fiscal device time')
      failed++
    }
  }

  logger.info({ synced, failed, total: deviceIds.length }, 'Fiscal device time sync completed')
}

/**
 * Run a full time verification and device sync cycle.
 * Call this on startup and periodically (e.g., every 6 hours).
 */
export async function runTimeSyncCycle(): Promise<void> {
  await verifyServerTime()
  await syncAllFiscalDevices()
}
