/**
 * FR-21.12 — the cash-register journal: every cash-register sale and storno, one row shape.
 *
 * What it lists: every `cash_sale` and `cash_storno` document — the till's
 * (`register.origin: 'pos'`), the back office's and the PlusMinus imports' — and the receipt of
 * every payment on an invoice (`payment_receipt`, FR-23): number, УНП, amount and the invoice it paid.
 *
 * Until R4 it also listed the POS rows no document had copied yet. Since R3 every row has its
 * document and `postransactions` is frozen, so the journal reads the documents only (FR-21.27);
 * the server refuses it until that holds (`freeze-check.ts`, FR-21.28). A row's `store` is
 * always `'invoice'` now; the field stays for the UI that still branches on it.
 *
 * The same journal is mounted at `/pos/orders` and `/invoicing/cash-sales` (D-10).
 */
import { Contact, Invoice, POSSession, StockMovement, User, Warehouse } from 'db/models'
import { localDayWindow, BULGARIAN_TIME_ZONE } from '../local-day.js'
import { PAYMENT_RECEIPT, TILL_DOCUMENT_TYPES } from './pos-union.js'
import { invoicedCashSaleIds, invoicingByCashSale } from '../cash-sale-invoice.service.js'

export type JournalKind = 'sale' | 'storno' | 'payment'
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
  /** Which store the row was read from: always `invoice` since R4 (`pos` until the copy). */
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
  /**
   * #171: on a cash sale held as a document, the invoices issued for it and how far it is invoiced.
   * FR-23: on a payment's receipt, the invoice it paid.
   */
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
  return localDayWindow(q.dateFrom, q.dateTo, q.timeZone || BULGARIAN_TIME_ZONE)
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

const KIND_TYPE: Record<JournalKind, string> = { sale: 'cash_sale', storno: 'cash_storno', payment: PAYMENT_RECEIPT }
const kindOf = (doc: any): JournalKind => (doc.type === 'cash_storno' ? 'storno' : doc.type === PAYMENT_RECEIPT ? 'payment' : 'sale')

function documentMatch(q: JournalQuery, invoiced: any[] | null): Record<string, any> | null {
  const and: Record<string, any>[] = [{ orgId: oid(q.orgId) }, { type: { $in: TILL_DOCUMENT_TYPES } }]
  if (q.kind) and.push({ type: KIND_TYPE[q.kind] })
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

// ── Rows ────────────────────────────────────────────────────────────────────

function documentStatus(doc: any): JournalStatus {
  if (doc.status === 'voided') return 'voided'
  if (doc.register?.stornoState === 'full') return 'stornoed'
  return 'completed'
}

/** The methods as words, not as keys: "cash on delivery". The journal's page shows them translated. */
function label(payments: JournalPayment[]): string {
  return [...new Set(payments.map(p => p.method.replace(/_/g, ' ')))].join(' + ')
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
    kind: kindOf(doc),
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
    ...(doc.type === PAYMENT_RECEIPT
      ? { invoices: [{ id: String(reg.paidInvoiceId), number: reg.paidInvoiceNumber || '', status: 'paid' }], invoicingState: 'full' as const }
      : {}),
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

/** One page of the journal, sorted and paged by the database. */
export async function listJournal(q: JournalQuery): Promise<JournalPage> {
  const page = Math.max(0, Number(q.page) || 0)
  // The grid's "All" is `size=0`: as many as one page may hold.
  const requested = q.size === undefined ? 25 : Number(q.size)
  const size = !Number.isFinite(requested) || requested <= 0 ? 500 : Math.min(500, Math.floor(requested))
  const dir = q.sortOrder === 'asc' ? 1 : -1
  const by = q.sortBy || 'date'

  const invoiced = q.invoiced === 'yes' || q.invoiced === 'no' ? await invoicedCashSaleIds(q.orgId) : null
  const docMatch = documentMatch(q, invoiced)
  const docSort: Record<string, 1 | -1> = by === 'number' ? { invoiceNumber: dir, _id: dir } : by === 'total' ? { total: dir, _id: dir } : { issueDate: dir, createdAt: dir, _id: dir }

  const [docs, total] = await Promise.all([
    docMatch ? Invoice.find(docMatch).sort(docSort).skip(page * size).limit(size).lean().exec() : Promise.resolve([]),
    docMatch ? Invoice.countDocuments(docMatch).exec() : Promise.resolve(0),
  ])

  const movedIds = new Set(
    (await StockMovement.distinct('invoiceId', { orgId: oid(q.orgId), invoiceId: { $in: (docs as any[]).map(d => d._id) } }).exec())
      .map(String),
  )
  const rows = (docs as any[]).map(d => fromDocument(d, movedIds))
  await hydrate(q.orgId, rows)
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
  const doc: any = await Invoice.findOne({ _id: oid(id), orgId: oid(orgId), type: { $in: TILL_DOCUMENT_TYPES } }).lean().exec()
  if (!doc) return null

  const moved = new Set((await StockMovement.distinct('invoiceId', { orgId: oid(orgId), invoiceId: doc._id }).exec()).map(String))
  const journalRow = fromDocument(doc, moved)
  const lines: JournalLine[] = (doc.lines || []).map((l: any) => ({
    ...(l.productId ? { productId: String(l.productId) } : {}),
    description: l.description, quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice,
    discount: l.discount || 0, taxRate: l.taxRate || 0, taxAmount: round2(l.taxAmount), lineTotal: round2(l.lineTotal),
    ...(l.warehouseId ? { warehouseId: String(l.warehouseId) } : {}),
    unmatched: !l.productId,
  }))

  // The storno chain: the sale a storno reverses, and the stornos of a sale.
  const relatedIds = [journalRow.relatedId, ...(journalRow.stornoedBy || [])].filter(Boolean) as string[]
  const relatedDocs: any[] = relatedIds.length
    ? await Invoice.find({ _id: { $in: relatedIds.map(oid) }, orgId: oid(orgId), type: { $in: TILL_DOCUMENT_TYPES } }).lean().exec()
    : []
  const related = relatedDocs.map(d => fromDocument(d, new Set()))

  const movementFilter = { orgId: oid(orgId), $or: [{ invoiceId: doc._id }, ...(doc.register?.movementId ? [{ _id: doc.register.movementId }] : [])] }
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
