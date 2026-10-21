import type { Migration } from '../types.js'

/**
 * One УНП counter per fiscal device (FR-20.45, #156).
 *
 * Наредба Н-18, Прил. 29 т. 9: the 7-digit part of a УНП (`XXXXXXXX-ZZZZ-NNNNNNN`) is kept per
 * FISCAL DEVICE and steps by 1 for every sale; `ZZZZ` only names the operator. LGR kept one
 * counter per device AND operator (`UNP-<device>-<operator>`), so two operators on one device
 * both issued …-0000001, …-0000002.
 *
 * This seeds the per-device counter `UNP-<device>` with the HIGHEST of:
 * - every per-operator counter of that device, and
 * - the highest suffix of any УНП actually issued on it (POS transactions, stornos included),
 * so the first number after it is above every number issued before it (AC 12). `$max` makes it
 * idempotent, and lets it run safely after the new code has already allocated some.
 *
 * Expand only: the per-operator counters stay. `generateUNP` raises them along with the new one
 * for a release, so a rolled-back binary that still reads them cannot re-issue a number.
 */

/** `UNP-<8-char device>-<4-digit operator>` — the old key. Never matches the new `UNP-<device>`. */
const LEGACY = /^UNP-([A-Za-z0-9]{8})-(\d{4})$/
/** `<8-char device>-<4-digit operator>-<7 digits>`. */
const ISSUED = /^([A-Za-z0-9]{8})-\d{4}-(\d{7})$/

export const unpPerDevice: Migration = {
  id: '0001-unp-per-device',
  description: 'One УНП counter per fiscal device (Н-18 Прил. 29 т. 9), seeded above every number issued',
  async up({ db, log, orgFilter }) {
    const sequences = db.collection('sequences')
    const floors = new Map<string, { orgId: unknown; device: string; floor: number }>()
    const raise = (orgId: unknown, device: string, n: number) => {
      const k = `${String(orgId)}|${device}`
      const cur = floors.get(k)
      if (!cur || n > cur.floor) floors.set(k, { orgId, device, floor: n })
    }

    for await (const s of sequences.find({ ...orgFilter, year: 0, prefix: { $regex: '^UNP-[A-Za-z0-9]{8}-\\d{4}$' } })) {
      const m = LEGACY.exec(String(s.prefix))
      if (m) raise(s.orgId, m[1], Number(s.lastNumber) || 0)
    }

    const issued = db.collection('postransactions').aggregate([
      { $match: { ...orgFilter, unpNumber: { $type: 'string' } } },
      { $project: { orgId: 1, unpNumber: 1 } },
    ])
    for await (const t of issued) {
      const m = ISSUED.exec(String(t.unpNumber))
      if (m) raise(t.orgId, m[1], Number(m[2]))
    }

    for (const { orgId, device, floor } of floors.values()) {
      await sequences.updateOne(
        { orgId, prefix: `UNP-${device}`, year: 0 },
        { $max: { lastNumber: floor } },
        { upsert: true },
      )
      log(`УНП counter for device ${device} seeded at ${floor}`, { orgId: String(orgId) })
    }
  },
}
