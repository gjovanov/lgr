/**
 * "Have we already imported this?" — checked before anything is written, so a re-run of a
 * day folder is a no-op instead of a double-booking.
 *
 * Each target has its own natural key:
 *   invoices/bills   → the legacy document number, held in `reference` while the document
 *                      is a draft and baked into `invoiceNumber` (`<prefix>-<number>`) once
 *                      issued. The prefix is the org's CONFIGURED one, resolved from the
 *                      sequences registry — the CLI scripts' hardcoded /^INV-(\d{6,})$/ is
 *                      precisely the assumption not to repeat here.
 *   cash register    → `reference = salesAnalysis:<date>` (one CSR document per day).
 *   stock movements  → a marker inside `notes` (`stokrazp:<n>`, `sklrazp:<n>`, `sklisk:<n>`,
 *                      `corr:<n>`, `storeOperations:<date>`), because StockMovement has no
 *                      reference field. These are the same markers `check-doc-sequences`
 *                      verifies, so the UI and the audit script agree on what "imported"
 *                      means.
 */
import { Invoice, StockMovement } from 'db/models'
import { resolveDocPrefix } from '../invoice-numbering.service.js'
import { clean } from './detect.js'
import type { DuplicateHit } from './types.js'

/** Escape for embedding in a RegExp (display prefixes allow `-` and `_`). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * An invoice/bill carrying this legacy document number, if one exists.
 * Matches drafts (by `reference`) and issued documents (by `<configuredPrefix>-<number>`).
 */
export async function findDuplicateInvoice(
  orgId: string,
  reference: string,
  type: string,
  direction: string,
): Promise<DuplicateHit | null> {
  const ref = clean(reference)
  if (!ref) return null

  const or: any[] = [{ reference: ref }]
  const prefix = await resolveDocPrefix(orgId, type, direction, 'issued')
  if (prefix && /^\d+$/.test(ref)) {
    or.push({ invoiceNumber: `${prefix}-${ref}` })
    // Older imports may predate a prefix rename — also look for a bare `<anything>-<number>`
    // whose numeric tail is this document, restricted to the same type/direction below.
    or.push({ invoiceNumber: { $regex: `^${escapeRe(prefix)}-${ref}$` } })
  }

  const hit: any = await Invoice.findOne(
    { orgId, type, direction, status: { $nin: ['voided', 'cancelled'] }, $or: or } as any,
    { invoiceNumber: 1, status: 1, reference: 1 },
  ).lean()
  if (!hit) return null
  return {
    id: String(hit._id),
    number: hit.invoiceNumber,
    status: hit.status,
    reason: hit.status === 'draft' ? 'already imported as a draft' : 'already issued',
  }
}

/** The one cash-sale document for a day, keyed by `reference = salesAnalysis:<date>`. */
export async function findDuplicateCashSale(orgId: string, reference: string): Promise<DuplicateHit | null> {
  const ref = clean(reference)
  if (!ref) return null
  const hit: any = await Invoice.findOne(
    { orgId, type: 'cash_sale', reference: ref, status: { $nin: ['voided', 'cancelled'] } } as any,
    { invoiceNumber: 1, status: 1 },
  ).lean()
  return hit
    ? { id: String(hit._id), number: hit.invoiceNumber, status: hit.status, reason: `already imported (${ref})` }
    : null
}

/**
 * A stock movement whose notes carry this marker. Narrowed by a `$regex` on notes and then
 * confirmed with a plain `includes` — the marker is ASCII, so no Cyrillic ever reaches Mongo
 * as a pattern.
 */
export async function findDuplicateMovement(orgId: string, marker: string): Promise<DuplicateHit | null> {
  const m = clean(marker)
  if (!m) return null
  const candidates: any[] = await StockMovement.find(
    { orgId, notes: { $regex: escapeRe(m) }, status: { $ne: 'cancelled' } } as any,
    { movementNumber: 1, status: 1, notes: 1 },
  ).limit(20).lean()
  const hit = candidates.find(c => String(c.notes || '').includes(m))
  return hit
    ? { id: String(hit._id), number: hit.movementNumber, status: hit.status, reason: `already booked (${m})` }
    : null
}
