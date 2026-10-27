import { OrgHome, Sequence, User } from 'db/models'

/**
 * FR-20.51, FR-20.81 (plan step P3-6d): the LEGAL series, whose numbers a customer or the tax
 * authority holds: sales documents (invoices and their notes), cash sales, and each fiscal device's
 * УНП. After a promotion they stay frozen until a person records the last numbers the lost master
 * issued (`OrgHome.seriesFrozen`): global must never give a second customer a number the site may
 * already have issued.
 */
export const LEGAL_SERIES: ReadonlySet<string> = new Set(['SALES_DOC', 'CASH_SALE'])
export const isLegalSeries = (prefix: string) => LEGAL_SERIES.has(prefix) || prefix.startsWith('UNP-')

export class SeriesFrozenError extends Error {
  readonly statusCode = 409
  readonly code = 'series_frozen'
  constructor(readonly orgId: string, readonly since?: Date) {
    super('Legal numbering waits until the last numbers issued at the site are recorded.')
    this.name = 'SeriesFrozenError'
  }
}

/** Since when the org's legal series are frozen, or null. Read fresh: a promotion freezes them at once. */
export async function seriesFrozenSince(orgId: string): Promise<Date | null> {
  const home: any = await OrgHome.findOne({ orgId }, { seriesFrozen: 1 }).lean().exec()
  return home?.seriesFrozen?.since ?? null
}

/** Throws while the org's legal series are frozen. */
export async function assertSeriesOpen(orgId: string): Promise<void> {
  const since = await seriesFrozenSince(orgId)
  if (since) throw new SeriesFrozenError(String(orgId), since)
}

/**
 * Atomic sequence number generator using MongoDB findOneAndUpdate with $inc.
 * Race-condition safe — multiple concurrent calls will never get the same number.
 *
 * Usage:
 *   const num = await getNextNumber(orgId, 'INV', 5)  // → "INV-2026-00001"
 *   const num = await getNextNumber(orgId, 'POS', 6)  // → "POS-2026-000001"
 */
export async function getNextNumber(
  orgId: string,
  prefix: string,
  padLength: number = 5,
  year?: number,
): Promise<string> {
  const yr = year ?? new Date().getFullYear()
  if (isLegalSeries(prefix)) await assertSeriesOpen(orgId)

  const doc = await Sequence.findOneAndUpdate(
    { orgId, prefix, year: yr },
    { $inc: { lastNumber: 1 } },
    { upsert: true, returnDocument: 'after' },
  ).exec()

  const seq = String(doc!.lastNumber).padStart(padLength, '0')
  return `${prefix}-${yr}-${seq}`
}

/**
 * Allocate the org's next 4-digit SUPTO operator code.
 *
 * The OPERATOR counter can lag behind reality: users imported or seeded before the counter
 * existed hold codes it never issued (the `regal` org had 0001 and 0002 in use with the
 * counter still at 0). A bare `$inc` then re-issues a code already taken and the insert dies
 * on the {operatorCode, orgId} unique index — so pull the counter past the highest code
 * actually held before incrementing. Idempotent, and the `$inc` keeps concurrent callers
 * on distinct numbers.
 */
export async function allocateOperatorCode(orgId: string): Promise<string> {
  const held = await User.find(
    { orgId, operatorCode: { $exists: true, $ne: null } },
    { operatorCode: 1 },
  ).lean().exec()
  const maxHeld = held.reduce((max, u: any) => Math.max(max, parseInt(u.operatorCode, 10) || 0), 0)
  await ensureSequenceAtLeast(orgId, 'OPERATOR', 0, maxHeld)

  const doc = await Sequence.findOneAndUpdate(
    { orgId, prefix: 'OPERATOR', year: 0 },
    { $inc: { lastNumber: 1 } },
    { upsert: true, returnDocument: 'after' },
  ).exec()
  return String(doc!.lastNumber).padStart(4, '0')
}

/**
 * Generate a SUPTO-compliant Unique Sale Number (УНП).
 *
 * Format per Appendix 29 of Ordinance Н-18:
 *   XXXXXXXX-ZZZZ-0000001
 *   ^^^^^^^^ ^^^^ ^^^^^^^
 *   │        │    └─ 7-digit sequential number, ONE counter per fiscal device (т. 9)
 *   │        └────── 4-digit operator code — names the operator, never splits the counter
 *   └─────────────── 8-character fiscal device number
 *
 * Uses atomic $inc — race-condition safe for concurrent POS terminals.
 *
 * ⚠ Until #156 the counter was per device AND operator (`UNP-<device>-<operator>`), so two
 * operators on one device issued the same numbers. Migration `0001-unp-per-device` seeds
 * `UNP-<device>` above everything issued. Two rules keep that safe while it rolls out:
 * - **A device with old counters but no new one has not been migrated.** Allocating would
 *   restart its numbers at 1 and re-issue legal numbers, so it refuses instead and says to run
 *   `bun run migrate`. A device with no history (a new device, a fresh database) starts at 1.
 * - **For one release the two keep each other up**, both directions (`$max`): before counting, the
 *   new counter is raised to the highest old one, and after, the old ones are raised to the new
 *   number. A rolled-back binary, which still counts per operator, then continues above every
 *   number the new one issued; and re-upgrading after it continues above what it issued.
 */
export async function generateUNP(
  orgId: string,
  fiscalDeviceNumber: string,
  operatorCode: string,
): Promise<string> {
  if (fiscalDeviceNumber.length !== 8) {
    throw new Error(`Fiscal device number must be 8 characters, got: ${fiscalDeviceNumber}`)
  }
  if (operatorCode.length !== 4) {
    throw new Error(`Operator code must be 4 digits, got: ${operatorCode}`)
  }

  const prefix = `UNP-${fiscalDeviceNumber}`
  await assertSeriesOpen(orgId)
  const legacy = { orgId, year: 0, prefix: { $regex: `^${prefix}-\\d{4}$` } }

  // Upserting would create the counter at 1 — exactly the re-issue the migration prevents.
  const exists = await Sequence.exists({ orgId, prefix, year: 0 }).exec()
  if (!exists && await Sequence.exists(legacy).exec()) {
    throw new Error(
      `The УНП counter of fiscal device ${fiscalDeviceNumber} has not been migrated to one counter per device. ` +
      'Run `bun run migrate` (migration 0001-unp-per-device) before selling on it.',
    )
  }

  const highestLegacy = await Sequence.findOne(legacy, { lastNumber: 1 }).sort({ lastNumber: -1 }).lean().exec()
  if (highestLegacy) {
    await Sequence.updateOne({ orgId, prefix, year: 0 }, { $max: { lastNumber: highestLegacy.lastNumber } }).exec()
  }

  const doc = await Sequence.findOneAndUpdate(
    { orgId, prefix, year: 0 }, // year=0: УНП counters are not year-scoped per Appendix 29
    { $inc: { lastNumber: 1 } },
    { upsert: true, returnDocument: 'after' },
  ).exec()
  const n = doc!.lastNumber

  // Rollback safety (FR-20.45), for one release: the previous binary counts per operator.
  await Sequence.updateMany(legacy, { $max: { lastNumber: n } }).exec()

  if (n > 9999999) {
    throw new Error(`UNP sequence overflow for device ${fiscalDeviceNumber}: max 9,999,999`)
  }
  return `${fiscalDeviceNumber}-${operatorCode}-${String(n).padStart(7, '0')}`
}

/**
 * Get the current (last used) number without incrementing.
 * Useful for display or debugging.
 */
export async function getCurrentNumber(orgId: string, prefix: string, year?: number): Promise<number> {
  const yr = year ?? new Date().getFullYear()
  const doc = await Sequence.findOne({ orgId, prefix, year: yr }).exec()
  return doc?.lastNumber ?? 0
}

/**
 * Read the active display prefix for a logical key. When admin overrides the public-facing
 * prefix (e.g. "INV" → "INVOICE"), it lives on the year=0 sentinel doc so it applies across
 * all future years. Returns the override if present, otherwise the canonical key.
 */
export async function getDisplayPrefix(orgId: string, prefix: string): Promise<string> {
  const doc = await Sequence.findOne({ orgId, prefix, year: 0 }).lean().exec()
  return (doc as any)?.displayPrefix || prefix
}

/**
 * Set or clear the display-prefix override for a logical key. Org-global (year=0 sentinel).
 * Only affects future allocations; existing documents keep their stored numbers.
 */
export async function setDisplayPrefix(orgId: string, prefix: string, displayPrefix: string | null): Promise<void> {
  await Sequence.findOneAndUpdate(
    { orgId, prefix, year: 0 },
    displayPrefix ? { $set: { displayPrefix } } : { $unset: { displayPrefix: 1 } },
    { upsert: true, returnDocument: 'after' },
  ).exec()
}

/**
 * List every Sequence document for an org. Used by the configuration page so admins can
 * see counters + override prefixes side-by-side.
 */
export async function listSequencesForOrg(orgId: string): Promise<Array<{ prefix: string; year: number; lastNumber: number; displayPrefix?: string }>> {
  const docs = await Sequence.find({ orgId }).sort({ prefix: 1, year: -1 }).lean().exec()
  return docs.map(d => ({
    prefix: (d as any).prefix,
    year: (d as any).year,
    lastNumber: (d as any).lastNumber,
    displayPrefix: (d as any).displayPrefix,
  }))
}

/**
 * Ensure the sequence counter for (orgId, prefix, year) is at least `minValue`.
 * Idempotent and race-safe — the `$max` aggregation-pipeline update will only bump the counter,
 * never lower it. Use this before the first `$inc` when pre-existing documents (seeded rows,
 * rows created by a prior per-prefix algorithm, or rows that share the counter group like
 * INV/CRN/DBN all sharing SALES_DOC) may have numbers higher than the sequence has tracked.
 */
export async function ensureSequenceAtLeast(
  orgId: string,
  prefix: string,
  year: number,
  minValue: number,
): Promise<void> {
  if (minValue <= 0) return
  // Pipeline-form update lets us express "lastNumber = max(lastNumber, minValue)" atomically.
  await Sequence.updateOne(
    { orgId, prefix, year },
    [
      {
        $set: {
          lastNumber: { $max: [{ $ifNull: ['$lastNumber', 0] }, minValue] },
          orgId: { $ifNull: ['$orgId', orgId] },
          prefix: { $ifNull: ['$prefix', prefix] },
          year: { $ifNull: ['$year', year] },
        },
      },
    ],
    { upsert: true },
  ).exec()
}
