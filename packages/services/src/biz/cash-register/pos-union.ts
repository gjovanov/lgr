/**
 * FR-21.8 / FR-21.27 — every till row, read from the cash-register documents.
 *
 * Until R4 a till sale could live in `postransactions` or in `invoices` (a cash-register document
 * with `register.origin: 'pos'`), and this read both, each sale once. Since R3 every POS row has
 * its document (migrations 0008/0009, a copy keeping the row's `_id`) and the model is frozen, so
 * from R4 on the documents are the only store a reader asks. The readers that still speak POS rows
 * (SUPTO 18.1–18.5, the session journal entry, the session's list) read through here, as the rows
 * they were written against (`mapping.ts#toPosTransaction`).
 *
 * ⚠ The server refuses the cash-register routes until it may read this way
 * (`freeze-check.ts`, FR-21.28): a POS row with no document would otherwise be read by nobody.
 *
 * A till document's `issueDate` is the moment of the sale (the POS row's `createdAt`).
 */
import { Invoice } from 'db/models'
import { toPosTransaction } from './mapping.js'

export const REGISTER_TYPES = ['cash_sale', 'cash_storno'] as const

/**
 * FR-23 — the fiscal receipt of a payment on an invoice or a debit note. A document of the register,
 * and NOT one of `REGISTER_TYPES`: those are the sales, and a receipt is the money of a sale its
 * invoice already counts. A reader that names its types never sees one, so the worst it can do is
 * miss money, where it shows (a drawer short at the close).
 *
 * ⚠ A reader with no `type` in its filter sees it as one more paid document, and counts the money
 * twice with nothing to show for it: `NOT_PAYMENT_RECEIPT` (`sale-counting.ts`) is how each says so.
 * The previous image has none of those, which is why FR-23 §3 says what a rollback needs.
 */
export const PAYMENT_RECEIPT = 'payment_receipt'

/** Every document of a register: what the journal lists, and what a session's own figures read. */
export const TILL_DOCUMENT_TYPES = [...REGISTER_TYPES, PAYMENT_RECEIPT] as const

export interface PosUnionFilter {
  orgId: string
  from?: Date
  to?: Date
  sessionId?: string
  ids?: string[]
  /**
   * The receipts of payments on invoices too (FR-23): the session's own figures and the SUPTO tables
   * ask for them. Left out by default: the session journal entry and sales history read through
   * here, and the invoice posted that money.
   */
  withReceipts?: boolean
}

const ObjectId = Invoice.base.Types.ObjectId
const oid = (v: unknown) => new ObjectId(String(v))

/** The till rows matching the filter, oldest first. */
export async function loadPosRows(f: PosUnionFilter): Promise<any[]> {
  const match: Record<string, any> = { orgId: oid(f.orgId), type: { $in: f.withReceipts ? TILL_DOCUMENT_TYPES : REGISTER_TYPES }, 'register.origin': 'pos' }
  if (f.from || f.to) {
    const window: Record<string, Date> = {}
    if (f.from) window.$gte = f.from
    if (f.to) window.$lte = f.to
    match.issueDate = window
  }
  // A malformed session id names no session: an empty page, never a BSONError (500).
  if (f.sessionId && !ObjectId.isValid(f.sessionId)) return []
  if (f.sessionId) match['register.sessionId'] = oid(f.sessionId)
  if (f.ids) match._id = { $in: f.ids.map(oid) }

  const docs: any[] = await Invoice.find(match).lean().exec()
  return docs
    .map(toPosTransaction)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map(asEntity)
}

/** One till row by id. */
export async function findPosRow(orgId: string, id: string): Promise<any | null> {
  if (!ObjectId.isValid(id)) return null
  const doc = await Invoice.findOne({
    _id: oid(id), orgId: oid(orgId), type: { $in: REGISTER_TYPES }, 'register.origin': 'pos',
  }).lean().exec()
  return doc ? asEntity(toPosTransaction(doc)) : null
}

/**
 * A row as the DAL hands it out, which is what these readers were written against: every id a
 * string, and `id` beside `_id`. (SUPTO 18.1 prints `customerId` into a cell as it is.)
 */
export function asEntity<T extends Record<string, any>>(row: T): T & { id: string } {
  const out = stringifyIds(row) as any
  out.id = String(row._id)
  return out
}

function stringifyIds(v: any): any {
  if (v === null || v === undefined) return v
  if (v instanceof Date) return v
  if (v instanceof ObjectId) return String(v)
  if (Array.isArray(v)) return v.map(stringifyIds)
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, any> = {}
    for (const [k, x] of Object.entries(v)) out[k] = stringifyIds(x)
    return out
  }
  return v
}
