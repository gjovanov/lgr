import { Sequence } from 'db/models'

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

  const doc = await Sequence.findOneAndUpdate(
    { orgId, prefix, year: yr },
    { $inc: { lastNumber: 1 } },
    { upsert: true, returnDocument: 'after' },
  ).exec()

  const seq = String(doc!.lastNumber).padStart(padLength, '0')
  return `${prefix}-${yr}-${seq}`
}

/**
 * Generate a SUPTO-compliant Unique Sale Number (УНП).
 *
 * Format per Appendix 29 of Ordinance Н-18:
 *   XXXXXXXX-ZZZZ-0000001
 *   ^^^^^^^^ ^^^^ ^^^^^^^
 *   │        │    └─ 7-digit sequential number (per fiscal device + operator)
 *   │        └────── 4-digit operator code
 *   └─────────────── 8-character fiscal device number
 *
 * Uses atomic $inc — race-condition safe for concurrent POS terminals.
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

  // Use a composite prefix to separate counters per device+operator
  const prefix = `UNP-${fiscalDeviceNumber}-${operatorCode}`

  const doc = await Sequence.findOneAndUpdate(
    { orgId, prefix, year: 0 }, // year=0: УНП counters are not year-scoped per Appendix 29
    { $inc: { lastNumber: 1 } },
    { upsert: true, returnDocument: 'after' },
  ).exec()

  const seq = String(doc!.lastNumber).padStart(7, '0')
  return `${fiscalDeviceNumber}-${operatorCode}-${seq}`
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
