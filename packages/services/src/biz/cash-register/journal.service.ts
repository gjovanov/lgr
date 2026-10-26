/**
 * FR-21.12 — the cash-register journal: every cash-register sale and storno, one row shape.
 *
 * What it lists:
 * - every `cash_sale` and `cash_storno` document — the till's (`register.origin: 'pos'`), the back
 *   office's and the PlusMinus imports';
 * - every POS row that has no document yet (until R2's copy, and anything written by an older
 *   release after it). A POS row a document copied is read from the document (`_id` is shared).
 *
 * The same journal is mounted at `/pos/orders` and `/invoicing/cash-sales` (D-10). Filters, sort and
 * paging run across both stores: each side is queried sorted and capped at what the page needs,
 * and the two are merged.
 */
import { Contact, Invoice, POSSession, POSTransaction, StockMovement, User, Warehouse } from 'db/models'
import { isDateOnly, localDayEnd, localDayStart, BULGARIAN_TIME_ZONE } from '../local-day.js'
import { keptByMethod, posRowSign } from './counting.js'
import { REGISTER_TYPES } from './pos-union.js'
import { invoicedCashSaleIds, invoicingByCashSale } from '../cash-sale-invoice.service.js'

export type JournalKind = 'sale' | 'storno'
export type JournalOrigin = 'pos' | 'backoffice' | 'import'
export type JournalStatus = 'completed' | 'stornoed' | 'voided'
export type JournalStock = 'moved' | 'error' | 'none'

export interface JournalQuery {
  orgId: string
  search?: string
  kind?: JournalKind
  origin?: JournalOrigin
  status?: JournalStatus
  fiscalState?: string
  sessionId?: string
  warehouseId?: string
  cashierId?: string
  contactId?: string
  paymentMethod?: string
  /**
   * #171: sales an invoice was issued for (`yes`), or not (`no`). Only a cash sale held as a
   * document can be invoiced, so `yes` lists no POS row; neither lists a storno.
   */
  invoiced?: 'yes' | 'no'
  /** Calendar dates (`YYYY-MM-DD`) in `timeZone`. */
  dateFrom?: string
  dateTo?: string
  timeZone?: string
  page?: number
  size?: number
  sortBy?: 'date' | 'number' | 'total'
  sortOrder?: 'asc' | 'desc'
}

export interface JournalPayment {
  method: string
  /** What was kept. */
  amount: number
  /** What was handed over, when it differs. */
  tendered?: number
}

export interface JournalRow {
  id: string
  /** Which store the row was read from — `pos` only until R2's copy. */
  store: 'invoice' | 'pos'
  number: string
  kind: JournalKind
  origin: JournalOrigin
  status: JournalStatus
  /** The moment of the sale; an imported day carries only its date. */
  date: string
  /** An imported day's documents have no time of day. */
  hasTime: boolean
  currency: string
  subtotal: number
  discountTotal: number
  taxTotal: number
  total: number
  payments: JournalPayment[]
  paymentLabel: string
  contactId?: string
  contactName?: string
  /** For the invoicing journal's "send by email" (FR-10), prefilled like the invoice list's. */
  contactEmail?: string
  sessionId?: string
  sessionNumber?: string
  warehouseId?: string
  warehouseName?: string
  cashierId?: string
  cashierName?: string
  fiscal: {
    isFiscal: boolean
    state?: string
    unp?: string
    receiptNumber?: string
    deviceNumber?: string
    printedAt?: string
  }
  stock: JournalStock
  reference?: string
  /** On a storno: the sale it reverses. */
  relatedId?: string
  /** On a sale: the stornos that reverse it. */
  stornoedBy?: string[]
  /** #171: on a cash sale held as a document, the invoices issued for it and how far it is invoiced. */
  invoices?: Array<{ id: string; number: string; status: string }>
  invoicingState?: 'none' | 'partial' | 'full'
}

export interface JournalPage {
  rows: JournalRow[]
  total: number
  page: number
  size: number
  totalPages: number
}

const IMPORT_TAG = 'cash-register-import'
const SALES_ANALYSIS = /^salesAnalysis:/
const oid = (v: unknown) => new Invoice.base.Types.ObjectId(String(v))
const isOid = (v: unknown) => typeof v === 'string' && Invoice.base.Types.ObjectId.isValid(v)
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Where a document came from, for documents written before `register.origin` existed. */
export function originOf(doc: any): JournalOrigin {
  if (doc.register?.origin) return doc.register.origin
  if ((doc.tags || []).includes(IMPORT_TAG) || SALES_ANALYSIS.test(doc.reference || '')) return 'import'
  return 'backoffice'
}

function windowOf(q: JournalQuery): { $gte?: Date; $lte?: Date } | null {
  const tz = q.timeZone || BULGARIAN_TIME_ZONE
  const w: { $gte?: Date; $lte?: Date } = {}
  if (q.dateFrom && isDateOnly(q.dateFrom)) w.$gte = localDayStart(q.dateFrom, tz)
  if (q.dateTo && isDateOnly(q.dateTo)) w.$lte = localDayEnd(q.dateTo, tz)
  return Object.keys(w).length ? w : null
}

/**
 * A receipt's state. A till sale rung before the receipt became a recorded step carries none:
 * its receipt number says whether it printed. Without that, "Printed" would leave out the
 * whole older history, and "None" would claim it.
 */
function fiscalStateOf(state: string | undefined, receiptNumber: string | undefined): string {
  return state || (receiptNumber ? 'printed' : 'none')
}

function fiscalStateMatch(state: string, stateField: string, receiptField: string): Record<string, any> {
  if (state !== 'printed' && state !== 'none') return { [stateField]: state }
  return { $or: [
    { [stateField]: state },
    { [stateField]: { $exists: false }, [receiptField]: state === 'printed' ? { $nin: [null, ''] } : { $in: [null, ''] } },
  ] }
}

// ── The document side ───────────────────────────────────────────────────────

function documentMatch(q: JournalQuery, invoiced: any[] | null): Record<string, any> | null {
  const and: Record<string, any>[] = [{ orgId: oid(q.orgId) }, { type: { $in: REGISTER_TYPES } }]
  if (q.kind) and.push({ type: q.kind === 'storno' ? 'cash_storno' : 'cash_sale' })
  if (invoiced) and.push({ type: 'cash_sale', _id: q.invoiced === 'yes' ? { $in: invoiced } : { $nin: invoiced } })
  if (q.origin === 'pos') and.push({ 'register.origin': 'pos' })
  if (q.origin === 'import') {
    and.push({ $or: [
      { 'register.origin': 'import' },
      { 'register.origin': { $exists: false }, $or: [{ tags: IMPORT_TAG }, { reference: { $regex: SALES_ANALYSIS } }] },
    ] })
  }
  if (q.origin === 'backoffice') {
    and.push({ $or: [
      { 'register.origin': 'backoffice' },
      { 'register.origin': { $exists: false }, tags: { $ne: IMPORT_TAG }, reference: { $not: SALES_ANALYSIS } },
    ] })
  }
  if (q.status === 'completed') and.push({ status: 'paid', 'register.stornoState': { $ne: 'full' } })
  if (q.status === 'stornoed') and.push({ 'register.stornoState': 'full' })
  if (q.status === 'voided') and.push({ status: 'voided' })
  if (q.fiscalState) and.push(fiscalStateMatch(q.fiscalState, 'register.fiscal.state', 'register.fiscalReceiptNumber'))
  if (q.sessionId) {
    if (!isOid(q.sessionId)) return null
    and.push({ 'register.sessionId': oid(q.sessionId) })
  }
  if (q.cashierId) {
    if (!isOid(q.cashierId)) return null
    and.push({ $or: [{ 'register.cashierId': oid(q.cashierId) }, { 'register.cashierId': { $exists: false }, createdBy: oid(q.cashierId) }] })
  }
  if (q.warehouseId) {
    if (!isOid(q.warehouseId)) return null
    and.push({ $or: [{ 'register.warehouseId': oid(q.warehouseId) }, { 'lines.warehouseId': oid(q.warehouseId) }] })
  }
  if (q.contactId) {
    if (!isOid(q.contactId)) return null
    and.push({ contactId: oid(q.contactId) })
  }
  if (q.paymentMethod) {
    const m = q.paymentMethod
    and.push({ $or: [
      { 'payments.method': m },
      { 'payments.0': { $exists: false }, paymentMethod: m },
      // A cash sale recorded with no payment row and no method was paid in cash at the till.
      ...(m === 'cash' ? [{ 'payments.0': { $exists: false }, paymentMethod: { $in: [null, ''] } }] : []),
    ] })
  }
  if (q.search) {
    const re = { $regex: escapeRegex(q.search.trim()), $options: 'i' }
    and.push({ $or: [{ invoiceNumber: re }, { 'register.unp': re }, { reference: re }] })
  }
  const w = windowOf(q)
  if (w) and.push({ issueDate: w })
  return { $and: and }
}

// ── The POS side: rows no document has copied ───────────────────────────────

async function posMatch(q: JournalQuery): Promise<Record<string, any> | null> {
  // A POS row is always the till's, and never invoiced: only a document can be (#171).
  if (q.origin && q.origin !== 'pos') return null
  if (q.invoiced === 'yes') return null
  const and: Record<string, any>[] = [{ orgId: oid(q.orgId) }]
  if (q.invoiced === 'no') and.push({ type: { $in: ['sale', 'exchange'] } })
  if (q.kind === 'sale') and.push({ type: { $in: ['sale', 'exchange'] } })
  if (q.kind === 'storno') and.push({ type: { $in: ['storno', 'return'] } })
  // A sale is cancelled only by its storno; a storno is cancelled when its receipt failed.
  if (q.status === 'completed') and.push({ status: 'completed' })
  if (q.status === 'stornoed') and.push({ type: { $in: ['sale', 'exchange'] }, status: 'cancelled' })
  if (q.status === 'voided') and.push({ type: { $in: ['storno', 'return'] }, status: 'cancelled' })
  if (q.fiscalState) and.push(fiscalStateMatch(q.fiscalState, 'fiscal.state', 'fiscalReceiptNumber'))
  if (q.sessionId) {
    if (!isOid(q.sessionId)) return null
    and.push({ sessionId: oid(q.sessionId) })
  }
  if (q.cashierId) {
    if (!isOid(q.cashierId)) return null
    and.push({ createdBy: oid(q.cashierId) })
  }
  if (q.contactId) {
    if (!isOid(q.contactId)) return null
    and.push({ customerId: oid(q.contactId) })
  }
  if (q.warehouseId) {
    if (!isOid(q.warehouseId)) return null
    const sessions = await POSSession.find({ orgId: oid(q.orgId), warehouseId: oid(q.warehouseId) }, { _id: 1 }).lean().exec()
    and.push({ sessionId: { $in: sessions.map((s: any) => s._id) } })
  }
  if (q.paymentMethod) and.push({ 'payments.method': q.paymentMethod })
  if (q.search) {
    const re = { $regex: escapeRegex(q.search.trim()), $options: 'i' }
    and.push({ $or: [{ transactionNumber: re }, { unpNumber: re }] })
  }
  const w = windowOf(q)
  if (w) and.push({ createdAt: w })
  return { $and: and }
}

/** The POS rows matching, minus those a document already holds (a copy keeps the `_id`). */
function uncopied(match: Record<string, any>): any[] {
  return [
    { $match: match },
    { $lookup: { from: 'invoices', localField: '_id', foreignField: '_id', as: '_copy', pipeline: [{ $project: { _id: 1 } }] } },
    { $match: { _copy: { $size: 0 } } },
    { $project: { _copy: 0 } },
  ]
}

// ── Rows ────────────────────────────────────────────────────────────────────

function documentStatus(doc: any): JournalStatus {
  if (doc.status === 'voided') return 'voided'
  if (doc.register?.stornoState === 'full') return 'stornoed'
  return 'completed'
}

function posStatus(row: any): JournalStatus {
  if (row.status !== 'cancelled') return 'completed'
  return posRowSign({ type: row.type, status: 'completed' }) < 0 ? 'voided' : 'stornoed'
}

function label(payments: JournalPayment[]): string {
  return [...new Set(payments.map(p => p.method))].join(' + ')
}

function fromDocument(doc: any, moved: Set<string>): JournalRow {
  const reg = doc.register || {}
  const origin = originOf(doc)
  const payments: JournalPayment[] = (doc.payments || []).length
    ? doc.payments.map((p: any) => ({ method: p.method, amount: round2(p.amount), ...(p.tendered !== undefined ? { tendered: round2(p.tendered) } : {}) }))
    // A document recorded without payment rows: its header method, or cash at the till.
    : doc.status === 'paid' ? [{ method: doc.paymentMethod || 'cash', amount: round2(doc.total) }] : []
  const id = String(doc._id)
  return {
    id,
    store: 'invoice',
    number: doc.invoiceNumber,
    kind: doc.type === 'cash_storno' ? 'storno' : 'sale',
    origin,
    status: documentStatus(doc),
    date: new Date(doc.issueDate || doc.createdAt).toISOString(),
    hasTime: origin === 'pos',
    currency: doc.currency || 'EUR',
    subtotal: round2(doc.subtotal),
    discountTotal: round2(doc.discountTotal),
    taxTotal: round2(doc.taxTotal),
    total: round2(doc.total),
    payments,
    paymentLabel: label(payments),
    ...(doc.contactId ? { contactId: String(doc.contactId) } : {}),
    ...(reg.sessionId ? { sessionId: String(reg.sessionId) } : {}),
    ...(reg.warehouseId || doc.lines?.find((l: any) => l.warehouseId)?.warehouseId
      ? { warehouseId: String(reg.warehouseId || doc.lines.find((l: any) => l.warehouseId).warehouseId) }
      : {}),
    cashierId: String(reg.cashierId || doc.createdBy),
    fiscal: {
      isFiscal: !!reg.isFiscal,
      state: fiscalStateOf(reg.fiscal?.state, reg.fiscalReceiptNumber),
      ...(reg.unp ? { unp: reg.unp } : {}),
      ...(reg.fiscalReceiptNumber ? { receiptNumber: reg.fiscalReceiptNumber } : {}),
      ...(reg.fiscalDeviceNumber ? { deviceNumber: reg.fiscalDeviceNumber } : {}),
      ...(reg.printedAt ? { printedAt: new Date(reg.printedAt).toISOString() } : {}),
    },
    stock: reg.stockError ? 'error' : moved.has(id) || reg.movementId ? 'moved' : 'none',
    ...(doc.reference ? { reference: doc.reference } : {}),
    ...(doc.type === 'cash_storno' && (reg.storno?.originalId || doc.relatedInvoiceId)
      ? { relatedId: String(reg.storno?.originalId || doc.relatedInvoiceId) }
      : {}),
    ...(reg.stornoedBy?.length ? { stornoedBy: reg.stornoedBy.map(String) } : {}),
  }
}

function fromPosRow(row: any, sessionById: Map<string, any>): JournalRow {
  const kept = keptByMethod(row)
  const tendered = new Map<string, number>()
  for (const p of row.payments || []) tendered.set(p.method, (tendered.get(p.method) || 0) + (Number(p.amount) || 0))
  const otherMethod = (row.payments || []).find((p: any) => p.method !== 'cash' && p.method !== 'card')?.method || 'other'
  const payments: JournalPayment[] = [
    ...(kept.cash ? [{ method: 'cash', amount: kept.cash, ...(round2(tendered.get('cash') || 0) !== kept.cash ? { tendered: round2(tendered.get('cash') || 0) } : {}) }] : []),
    ...(kept.card ? [{ method: 'card', amount: kept.card }] : []),
    ...(kept.other ? [{ method: otherMethod, amount: kept.other }] : []),
  ]
  const session = sessionById.get(String(row.sessionId))
  return {
    id: String(row._id),
    store: 'pos',
    number: row.transactionNumber,
    kind: posRowSign({ type: row.type, status: 'completed' }) < 0 ? 'storno' : 'sale',
    origin: 'pos',
    status: posStatus(row),
    date: new Date(row.createdAt).toISOString(),
    hasTime: true,
    currency: session?.currency || 'EUR',
    subtotal: round2(row.subtotal),
    discountTotal: round2(row.discountTotal),
    taxTotal: round2(row.taxTotal),
    total: round2(row.total),
    payments,
    paymentLabel: label(payments),
    ...(row.customerId ? { contactId: String(row.customerId) } : {}),
    ...(row.sessionId ? { sessionId: String(row.sessionId) } : {}),
    ...(session?.warehouseId ? { warehouseId: String(session.warehouseId) } : {}),
    cashierId: String(row.createdBy),
    fiscal: {
      isFiscal: !!row.isFiscal,
      state: fiscalStateOf(row.fiscal?.state, row.fiscalReceiptNumber),
      ...(row.unpNumber ? { unp: row.unpNumber } : {}),
      ...(row.fiscalReceiptNumber ? { receiptNumber: row.fiscalReceiptNumber } : {}),
      ...(row.fiscalDeviceNumber ? { deviceNumber: row.fiscalDeviceNumber } : {}),
      ...(row.printedAt ? { printedAt: new Date(row.printedAt).toISOString() } : {}),
    },
    stock: row.stockError ? 'error' : row.movementId ? 'moved' : 'none',
    ...(row.originalTransactionId ? { relatedId: String(row.originalTransactionId) } : {}),
  }
}

/** Names for the ids the rows carry, batched. */
async function hydrate(orgId: string, rows: JournalRow[]): Promise<void> {
  const ids = (k: keyof JournalRow) => [...new Set(rows.map(r => r[k]).filter(Boolean).map(String))].filter(isOid).map(oid)
  const [contacts, users, warehouses, sessions] = await Promise.all([
    Contact.find({ _id: { $in: ids('contactId') } }, { companyName: 1, firstName: 1, lastName: 1, email: 1 }).lean().exec(),
    User.find({ _id: { $in: ids('cashierId') } }, { firstName: 1, lastName: 1, username: 1 }).lean().exec(),
    Warehouse.find({ _id: { $in: ids('warehouseId') } }, { name: 1 }).lean().exec(),
    POSSession.find({ _id: { $in: ids('sessionId') }, orgId: oid(orgId) }, { sessionNumber: 1 }).lean().exec(),
  ])
  const name = (list: any[], f: (x: any) => string) => new Map(list.map((x: any) => [String(x._id), f(x)]))
  const contactName = name(contacts, c => c.companyName || `${c.firstName || ''} ${c.lastName || ''}`.trim())
  const contactEmail = name(contacts, c => c.email || '')
  const userName = name(users, u => `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.username || '')
  const warehouseName = name(warehouses, w => w.name || '')
  const sessionNumber = name(sessions, s => s.sessionNumber || '')
  for (const r of rows) {
    if (r.contactId) {
      r.contactName = contactName.get(r.contactId) || ''
      if (contactEmail.get(r.contactId)) r.contactEmail = contactEmail.get(r.contactId)
    }
    if (r.cashierId) r.cashierName = userName.get(r.cashierId) || ''
    if (r.warehouseId) r.warehouseName = warehouseName.get(r.warehouseId) || ''
    if (r.sessionId) r.sessionNumber = sessionNumber.get(r.sessionId) || ''
  }

  // #171: the invoices issued for a cash sale, read back from them (the link lives only on them).
  const cashSales = rows.filter(r => r.store === 'invoice' && r.kind === 'sale')
  if (cashSales.length) {
    const invoicing = await invoicingByCashSale(orgId, cashSales.map(r => r.id))
    for (const r of cashSales) {
      const inv = invoicing.get(r.id)
      r.invoices = inv?.invoices || []
      r.invoicingState = inv?.state || 'none'
    }
  }
}

// ── The page ────────────────────────────────────────────────────────────────

/** Rows of a page, each side asked for no more than the page needs. */
export async function listJournal(q: JournalQuery): Promise<JournalPage> {
  const page = Math.max(0, Number(q.page) || 0)
  // The grid's "All" is `size=0`: as many as one page may hold.
  const requested = q.size === undefined ? 25 : Number(q.size)
  const size = !Number.isFinite(requested) || requested <= 0 ? 500 : Math.min(500, Math.floor(requested))
  const need = (page + 1) * size
  const dir = q.sortOrder === 'asc' ? 1 : -1
  const by = q.sortBy || 'date'

  const invoiced = q.invoiced === 'yes' || q.invoiced === 'no' ? await invoicedCashSaleIds(q.orgId) : null
  const docMatch = documentMatch(q, invoiced)
  const pMatch = await posMatch(q)

  const docSort: Record<string, 1 | -1> = by === 'number' ? { invoiceNumber: dir } : by === 'total' ? { total: dir, _id: dir } : { issueDate: dir, createdAt: dir, _id: dir }
  const posSort: Record<string, 1 | -1> = by === 'number' ? { transactionNumber: dir } : by === 'total' ? { total: dir, _id: dir } : { createdAt: dir, _id: dir }

  const [docs, docCount, posRows, posCount] = await Promise.all([
    docMatch ? Invoice.find(docMatch).sort(docSort).limit(need).lean().exec() : Promise.resolve([]),
    docMatch ? Invoice.countDocuments(docMatch).exec() : Promise.resolve(0),
    pMatch ? POSTransaction.aggregate([...uncopied(pMatch), { $sort: posSort }, { $limit: need }]).exec() : Promise.resolve([]),
    pMatch ? POSTransaction.aggregate([...uncopied(pMatch), { $count: 'n' }]).exec().then(r => r[0]?.n || 0) : Promise.resolve(0),
  ])

  const movedIds = new Set(
    (await StockMovement.distinct('invoiceId', { orgId: oid(q.orgId), invoiceId: { $in: (docs as any[]).map(d => d._id) } }).exec())
      .map(String),
  )
  const sessionIds = [...new Set((posRows as any[]).map(r => String(r.sessionId)))].filter(isOid)
  const sessions = sessionIds.length
    ? await POSSession.find({ _id: { $in: sessionIds.map(oid) } }, { currency: 1, warehouseId: 1 }).lean().exec()
    : []
  const sessionById = new Map((sessions as any[]).map(s => [String(s._id), s]))

  const merged = [
    ...(docs as any[]).map(d => fromDocument(d, movedIds)),
    ...(posRows as any[]).map(r => fromPosRow(r, sessionById)),
  ]
  const key = (r: JournalRow) => (by === 'number' ? r.number : by === 'total' ? r.total : r.date)
  merged.sort((a, b) => {
    const x = key(a) as any
    const y = key(b) as any
    return (x === y ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : x < y ? -1 : 1) * dir
  })

  const rows = merged.slice(page * size, page * size + size)
  await hydrate(q.orgId, rows)
  const total = docCount + posCount
  return { rows, total, page, size, totalPages: Math.ceil(total / size) }
}

export interface JournalLine {
  productId?: string
  description: string
  quantity: number
  unit?: string
  unitPrice: number
  discount: number
  taxRate: number
  taxAmount: number
  /** Gross. */
  lineTotal: number
  warehouseId?: string
  /** A line no product matched (an imported free-text line): it counts, and moves no stock. */
  unmatched: boolean
}

export interface JournalDocument {
  row: JournalRow
  lines: JournalLine[]
  notes?: string
  /** The storno chain, both ways. */
  related: JournalRow[]
  movements: { id: string; number: string; type: string; status: string }[]
  session?: { id: string; number: string; status: string; journalEntryId?: string }
}

/** One journal entry in full: its lines, its storno chain, its stock and its session. */
export async function getJournalDocument(orgId: string, id: string): Promise<JournalDocument | null> {
  if (!isOid(id)) return null
  const doc: any = await Invoice.findOne({ _id: oid(id), orgId: oid(orgId), type: { $in: REGISTER_TYPES } }).lean().exec()
  const row: any = doc ? null : await POSTransaction.findOne({ _id: oid(id), orgId: oid(orgId) }).lean().exec()
  if (!doc && !row) return null

  let journalRow: JournalRow
  let lines: JournalLine[]
  if (doc) {
    const moved = new Set((await StockMovement.distinct('invoiceId', { orgId: oid(orgId), invoiceId: doc._id }).exec()).map(String))
    journalRow = fromDocument(doc, moved)
    lines = (doc.lines || []).map((l: any) => ({
      ...(l.productId ? { productId: String(l.productId) } : {}),
      description: l.description, quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice,
      discount: l.discount || 0, taxRate: l.taxRate || 0, taxAmount: round2(l.taxAmount), lineTotal: round2(l.lineTotal),
      ...(l.warehouseId ? { warehouseId: String(l.warehouseId) } : {}),
      unmatched: !l.productId,
    }))
  } else {
    const session: any = await POSSession.findOne({ _id: row.sessionId }, { currency: 1, warehouseId: 1 }).lean().exec()
    journalRow = fromPosRow(row, new Map(session ? [[String(session._id), session]] : []))
    lines = (row.lines || []).map((l: any) => ({
      productId: String(l.productId), description: l.name, quantity: l.quantity, unitPrice: l.unitPrice,
      discount: l.discount || 0, taxRate: l.taxRate || 0, taxAmount: round2(l.taxAmount),
      // A POS line keeps the net; the journal shows gross, like every document.
      lineTotal: round2((Number(l.lineTotal) || 0) + (Number(l.taxAmount) || 0)),
      ...(session?.warehouseId ? { warehouseId: String(session.warehouseId) } : {}),
      unmatched: false,
    }))
  }

  // The storno chain: the sale a storno reverses, and the stornos of a sale — in either store.
  const relatedIds = [journalRow.relatedId, ...(journalRow.stornoedBy || [])].filter(Boolean) as string[]
  const relatedDocs: any[] = relatedIds.length
    ? await Invoice.find({ _id: { $in: relatedIds.map(oid) }, orgId: oid(orgId), type: { $in: REGISTER_TYPES } }).lean().exec()
    : []
  const stornoRows: any[] = journalRow.kind === 'sale'
    ? await POSTransaction.find({ orgId: oid(orgId), originalTransactionId: oid(id) }).lean().exec()
    : []
  const relatedRows: any[] = journalRow.relatedId && !relatedDocs.some(d => String(d._id) === journalRow.relatedId)
    ? await POSTransaction.find({ _id: oid(journalRow.relatedId), orgId: oid(orgId) }).lean().exec()
    : []
  const related = [
    ...relatedDocs.map(d => fromDocument(d, new Set())),
    ...[...stornoRows, ...relatedRows]
      .filter(r => !relatedDocs.some(d => String(d._id) === String(r._id)))
      .map(r => fromPosRow(r, new Map())),
  ]

  const movementFilter = doc
    ? { orgId: oid(orgId), $or: [{ invoiceId: doc._id }, ...(doc.register?.movementId ? [{ _id: doc.register.movementId }] : [])] }
    : { orgId: oid(orgId), _id: row.movementId ?? null }
  const movements = (await StockMovement.find(movementFilter, { movementNumber: 1, type: 1, status: 1 }).lean().exec())
    .map((m: any) => ({ id: String(m._id), number: m.movementNumber, type: m.type, status: m.status }))

  let session: JournalDocument['session']
  if (journalRow.sessionId) {
    const s: any = await POSSession.findOne({ _id: oid(journalRow.sessionId), orgId: oid(orgId) }, { sessionNumber: 1, status: 1, journalEntryId: 1 }).lean().exec()
    if (s) session = { id: String(s._id), number: s.sessionNumber, status: s.status, ...(s.journalEntryId ? { journalEntryId: String(s.journalEntryId) } : {}) }
  }

  await hydrate(orgId, [journalRow, ...related])
  return { row: journalRow, lines, ...(doc?.notes ? { notes: doc.notes } : {}), related, movements, ...(session ? { session } : {}) }
}
