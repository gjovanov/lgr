/**
 * FR-21.8 — every till row, from both stores, each once.
 *
 * Until R4 a till sale lives in one of two places:
 * - `postransactions`, where the POS has always written it;
 * - `invoices`, as a cash-register document with `register.origin: 'pos'` — every till sale from
 *   R2 on, and every row R2's migration copied.
 * A copy keeps the row's `_id`, so a row found in both is the same sale: it is read from the
 * document. The readers that still speak POS rows (SUPTO 18.1–18.5, the session journal entry,
 * `/trade/pos/transactions`) read through here, so they report every till sale exactly once
 * whichever store holds it, before the copy, after it, and after a rollback to R1.
 *
 * A till document's `issueDate` is the moment of the sale (the POS row's `createdAt`), so both
 * stores window on the same instant.
 */
import { Invoice, POSTransaction } from 'db/models'
import { toPosTransaction } from './mapping.js'

export const REGISTER_TYPES = ['cash_sale', 'cash_storno'] as const

export interface PosUnionFilter {
  orgId: string
  from?: Date
  to?: Date
  sessionId?: string
  ids?: string[]
}

const oid = (v: unknown) => new POSTransaction.base.Types.ObjectId(String(v))

/** The till rows matching the filter, oldest first. */
export async function loadPosRows(f: PosUnionFilter): Promise<any[]> {
  const org = oid(f.orgId)
  const posMatch: Record<string, any> = { orgId: org }
  const docMatch: Record<string, any> = { orgId: org, type: { $in: REGISTER_TYPES }, 'register.origin': 'pos' }
  if (f.from || f.to) {
    const window: Record<string, Date> = {}
    if (f.from) window.$gte = f.from
    if (f.to) window.$lte = f.to
    posMatch.createdAt = window
    docMatch.issueDate = window
  }
  if (f.sessionId) {
    posMatch.sessionId = oid(f.sessionId)
    docMatch['register.sessionId'] = oid(f.sessionId)
  }
  if (f.ids) {
    const ids = f.ids.map(oid)
    posMatch._id = { $in: ids }
    docMatch._id = { $in: ids }
  }

  const [rows, docs] = await Promise.all([
    POSTransaction.find(posMatch).lean().exec(),
    Invoice.find(docMatch).lean().exec(),
  ])
  const fromDocs = (docs as any[]).map(toPosTransaction)
  const copied = new Set(fromDocs.map(d => String(d._id)))
  return [...fromDocs, ...(rows as any[]).filter(r => !copied.has(String(r._id)))]
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map(asEntity)
}

/** One till row by id, from whichever store holds it (the document wins). */
export async function findPosRow(orgId: string, id: string): Promise<any | null> {
  if (!POSTransaction.base.Types.ObjectId.isValid(id)) return null
  const doc = await Invoice.findOne({
    _id: oid(id), orgId: oid(orgId), type: { $in: REGISTER_TYPES }, 'register.origin': 'pos',
  }).lean().exec()
  if (doc) return asEntity(toPosTransaction(doc))
  const row = await POSTransaction.findOne({ _id: oid(id), orgId: oid(orgId) }).lean().exec()
  return row ? asEntity(row) : null
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
  if (v instanceof POSTransaction.base.Types.ObjectId) return String(v)
  if (Array.isArray(v)) return v.map(stringifyIds)
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, any> = {}
    for (const [k, x] of Object.entries(v)) out[k] = stringifyIds(x)
    return out
  }
  return v
}
