import { randomUUID } from 'crypto'
import { mongoose } from 'db/connection'
import { Invoice, Contact, StockMovement } from 'db/models'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'
import { createAuditEntry } from './audit-log.service.js'
import { getNextInvoiceNumber, getNextDraftInvoiceNumber } from './invoice-numbering.service.js'
import { LEASE_MS, assertSameRequest, isDuplicateKey, takeLease, waitForCompletion } from './hot-path-key.js'
import { CASH_SALE_REF_ID } from './sale-counting.js'
import { upsertAmountInWords } from 'config/amount-in-words'

const { Types } = mongoose

/**
 * „Фактура към касова продажба" — an invoice issued for a cash sale (#171, #203).
 *
 * A customer buys at the counter and asks for a фактура. The cash sale already moved the stock
 * and took the money, so the invoice is the tax document for that same sale:
 *
 *   - it moves no stock: it carries `stockSource`, which `createInvoiceStockMovement` and
 *     `reverseInvoiceStockMovement` honour on every path (issue, void, Files rollback);
 *   - it is born paid, with one payment row (`origin: 'cash_register'`) mirroring how the cash
 *     sale was paid, and it emits no `payment.recorded`;
 *   - it posts no journal entry (`/send` emits no `invoice.posted` for it, and the handler skips
 *     it besides);
 *   - every report counts the sale once, on the cash sale (`sale-counting.ts`).
 *
 * ⚠ Only the invoice stores the link (`cashSaleRef`, `lines[].cashSaleLineId`). An issued sale is
 * never written to (FR-20.51), so "which invoices does this cash sale have" is a query on the
 * `{orgId, 'cashSaleRef.cashSaleId'}` index, and the claim on the sale's quantities below locks
 * nothing on the sale either.
 *
 * Quantities: a cash sale that names a customer is invoiced WHOLE, once. One without a customer
 * (an imported till day, a walk-in sale) may be invoiced in parts, by several invoices, but never
 * beyond what was sold: each line's quantity is a budget shared by every live invoice of the sale
 * (drafts included, so a second click cannot invoice the same goods twice).
 *
 * Corrections are ordinary documents. A credit or debit note against such an invoice behaves like
 * any other note — it moves the stock back and counts negative — because no other correction for a
 * cash sale exists before FR-21's storno. Voiding the invoice releases its quantities.
 */

export class CashSaleInvoiceError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'CashSaleInvoiceError'
  }
}

/** The number a conversion holds between its insert and its real number (as keyed cash sales do). */
const PENDING_NUMBER = '~pending:'
/** Invoice statuses that no longer claim any of the cash sale's quantities. */
const RELEASED = ['voided', 'cancelled']
/** `payments[].method` enum of the Invoice model. */
const PAYMENT_METHODS = ['cash', 'bank_transfer', 'card', 'cash_on_delivery', 'other']
/** The payment origin that marks money taken by the cash sale. */
export const CASH_REGISTER_ORIGIN = 'cash_register'

const EPS = 1e-9

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
/** The `+(x).toFixed(2)` rounding the document forms use (`document-payload.ts`). */
function round2(v: number): number {
  return +num(v).toFixed(2)
}
function idOf(v: any): string {
  return v === undefined || v === null ? '' : String(v._id ?? v)
}
function isoDay(d: Date | string | undefined | null): string {
  if (!d) return ''
  const dt = new Date(d)
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10)
}

// ── Pure parts (unit-tested) ─────────────────────────────────────────────────────────────────

export interface SourceLine {
  _id: unknown
  productId?: unknown
  description?: string
  quantity: number
  unit?: string
  unitPrice: number
  discount?: number
  taxRate?: number
  warehouseId?: unknown
  priceExplanation?: unknown[]
  sourceText?: string
}

/**
 * One invoice line for `quantity` of a cash-sale line, priced exactly as the sale was.
 *
 * The amounts are recomputed the way a sales invoice computes them (`document-payload.ts`,
 * discount-aware) instead of being copied: an imported till day stores `lineTotal` NET (FR-21
 * B-5), while every invoice line is gross. `orderRef` is never carried over — an invoice for a
 * cash sale must not consume a reservation, whose goods would then count as dispatched twice.
 */
export function invoiceLineFrom(src: SourceLine, quantity: number): Record<string, any> {
  const unitPrice = num(src.unitPrice)
  const discount = num(src.discount)
  const taxRate = num(src.taxRate)
  const net = quantity * unitPrice
  const taxable = net - net * (discount / 100)
  const taxAmount = taxable * (taxRate / 100)
  return {
    productId: src.productId || undefined,
    description: src.description || '',
    quantity,
    unit: src.unit || 'pcs',
    unitPrice,
    discount,
    taxRate,
    taxAmount: round2(taxAmount),
    lineTotal: round2(taxable + taxAmount),
    warehouseId: src.warehouseId || undefined,
    priceExplanation: Array.isArray(src.priceExplanation) && src.priceExplanation.length ? src.priceExplanation : undefined,
    sourceText: src.sourceText || undefined,
    cashSaleLineId: src._id,
  }
}

/** Document totals of invoice lines, components rounded first (as `computeTotals` does). */
export function invoiceTotalsOf(lines: Array<{ quantity: number; unitPrice: number; discount?: number; taxRate?: number }>): {
  subtotal: number; discountTotal: number; taxTotal: number; total: number
} {
  let subtotal = 0
  let discountTotal = 0
  let taxTotal = 0
  for (const l of lines) {
    const net = num(l.quantity) * num(l.unitPrice)
    const disc = net * (num(l.discount) / 100)
    subtotal += net
    discountTotal += disc
    taxTotal += (net - disc) * (num(l.taxRate) / 100)
  }
  const s = round2(subtotal)
  const d = round2(discountTotal)
  const t = round2(taxTotal)
  return { subtotal: s, discountTotal: d, taxTotal: t, total: round2(s - d + t) }
}

/** A claim on a cash sale's quantities: one live invoice of it. */
export interface Claim {
  id: string
  lines: Map<string, number>
}

/** Quantity per cash-sale line across a set of claims. */
export function claimedByLine(claims: Claim[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of claims) for (const [k, q] of c.lines) out.set(k, (out.get(k) || 0) + q)
  return out
}

/**
 * Does claim `ownId` fit? Claims are taken in `_id` order and the earlier ones win, so two
 * requests racing for the last units agree on which of them gets them — the later one gives way,
 * and nobody needs a lock on the cash sale. An earlier claim that does not fit itself is giving
 * way too, so it takes nothing. Returns the lines of `ownId` that do not fit (empty = fits).
 */
export function overClaimed(sold: Map<string, number>, claims: Claim[], ownId: string): Array<{ lineId: string; remaining: number; requested: number }> {
  const ordered = [...claims].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const used = new Map<string, number>()
  const misfits = (c: Claim) => {
    const over: Array<{ lineId: string; remaining: number; requested: number }> = []
    for (const [lineId, q] of c.lines) {
      const remaining = Math.max(0, (sold.get(lineId) || 0) - (used.get(lineId) || 0))
      if (q > remaining + EPS) over.push({ lineId, remaining, requested: q })
    }
    return over
  }
  for (const c of ordered) {
    const over = misfits(c)
    if (c.id === ownId) return over
    if (over.length) continue
    for (const [k, q] of c.lines) used.set(k, (used.get(k) || 0) + q)
  }
  return []
}

/**
 * The invoice's payment rows: the money the cash sale took for this part of the sale.
 *
 * A cash sale is paid by one method (its `paymentMethod`, or `payments[]` when it has them), and
 * the invoice's `amountPaid` is its own total. Split tender (a till sale, after FR-21) is shared
 * pro rata, to the cent, the remainder going to the largest part.
 */
export function mirroredPayments(
  cs: { invoiceNumber?: string; paymentMethod?: string; payments?: Array<{ method?: string; amount?: number }> },
  total: number,
  date: Date,
): Array<{ date: Date; amount: number; method: string; origin: string; reference?: string }> {
  const method = (m: unknown) => (PAYMENT_METHODS.includes(String(m)) ? String(m) : 'other')
  const tenders = (cs.payments || []).filter(p => num(p?.amount) > 0)
  const byMethod = new Map<string, number>()
  for (const p of tenders) byMethod.set(method(p.method), (byMethod.get(method(p.method)) || 0) + num(p.amount))
  const row = (m: string, amount: number) => ({ date, amount, method: m, origin: CASH_REGISTER_ORIGIN, reference: cs.invoiceNumber })
  if (byMethod.size <= 1) {
    const only = byMethod.size ? [...byMethod.keys()][0] : method(cs.paymentMethod || 'cash')
    return [row(only, round2(total))]
  }
  const totalCents = Math.round(total * 100)
  const tendered = [...byMethod.values()].reduce((s, v) => s + v, 0)
  const parts = [...byMethod.entries()].map(([m, v]) => {
    const exact = (totalCents * v) / tendered
    return { m, cents: Math.floor(exact), frac: exact - Math.floor(exact) }
  })
  let rest = totalCents - parts.reduce((s, p) => s + p.cents, 0)
  for (const p of [...parts].sort((a, b) => b.frac - a.frac)) {
    if (rest <= 0) break
    p.cents += 1
    rest -= 1
  }
  return parts.filter(p => p.cents > 0).map(p => row(p.m, p.cents / 100))
}

/** The header `paymentMethod` of the invoice: the method of its largest payment. */
function mainMethod(payments: Array<{ method: string; amount: number }>): string {
  return [...payments].sort((a, b) => b.amount - a.amount)[0]?.method || 'cash'
}

// ── Reading the state of a cash sale ─────────────────────────────────────────────────────────

/** Is this the placeholder of a conversion still in flight (or one that crashed)? */
function isPending(doc: any): boolean {
  return String(doc?.invoiceNumber || '').startsWith(PENDING_NUMBER)
}
function leaseLapsed(doc: any, now = Date.now()): boolean {
  return !doc.leaseUntil || new Date(doc.leaseUntil).getTime() < now
}

/** The live invoices of a cash sale, in `_id` order. A crashed conversion's placeholder is skipped. */
async function liveInvoicesOf(orgId: string, cashSaleId: string): Promise<any[]> {
  const docs: any[] = await Invoice.find(
    { orgId, type: 'invoice', [CASH_SALE_REF_ID]: new Types.ObjectId(cashSaleId), status: { $nin: RELEASED } } as any,
    { invoiceNumber: 1, status: 1, contactId: 1, total: 1, issueDate: 1, leaseUntil: 1, completedAt: 1, 'lines.cashSaleLineId': 1, 'lines.quantity': 1 },
  ).sort({ _id: 1 }).lean().exec()
  const now = Date.now()
  return docs.filter(d => !(isPending(d) && leaseLapsed(d, now)))
}

function claimOf(doc: any): Claim {
  const lines = new Map<string, number>()
  for (const l of doc.lines || []) {
    const k = idOf(l.cashSaleLineId)
    if (!k) continue
    lines.set(k, (lines.get(k) || 0) + num(l.quantity))
  }
  return { id: idOf(doc._id), lines }
}

/** Sold quantity per invoiceable line of the cash sale (lines that sold nothing invoice nothing). */
function soldByLine(cs: any): Map<string, number> {
  const out = new Map<string, number>()
  for (const l of cs.lines || []) if (num(l.quantity) > 0) out.set(idOf(l._id), num(l.quantity))
  return out
}

export interface CashSaleInvoicingState {
  cashSale: {
    id: string; number: string; issueDate: Date; status: string; contactId: string | null
    currency: string; total: number; paymentMethod: string
  }
  /** Invoiced whole only — the sale names a customer. */
  wholeOnly: boolean
  lines: Array<{
    lineId: string; productId: string | null; description: string; unit: string
    quantity: number; invoiced: number; remaining: number
    unitPrice: number; discount: number; taxRate: number
  }>
  invoices: Array<{ id: string; number: string; status: string; contactId: string | null; total: number; issueDate: Date }>
  /** `none` · `partial` · `full`. */
  state: 'none' | 'partial' | 'full'
  /** Whether a new invoice can be issued for it now, and why not. */
  canInvoice: boolean
  reason?: string
  /** The totals of an invoice for everything that remains (the dialog's preview). */
  remainingTotals: { subtotal: number; discountTotal: number; taxTotal: number; total: number }
}

function stateOf(cs: any, invoices: any[]): Pick<CashSaleInvoicingState, 'lines' | 'state' | 'remainingTotals'> {
  const used = claimedByLine(invoices.map(claimOf))
  const lines = (cs.lines || []).map((l: any) => {
    const quantity = num(l.quantity)
    const invoiced = used.get(idOf(l._id)) || 0
    return {
      lineId: idOf(l._id),
      productId: l.productId ? idOf(l.productId) : null,
      description: l.description || '',
      unit: l.unit || 'pcs',
      quantity,
      invoiced,
      remaining: quantity > 0 ? Math.max(0, quantity - invoiced) : 0,
      unitPrice: num(l.unitPrice),
      discount: num(l.discount),
      taxRate: num(l.taxRate),
    }
  })
  const invoiceable = lines.filter((l: any) => l.quantity > 0)
  const anyInvoiced = invoiceable.some((l: any) => l.invoiced > EPS)
  const allInvoiced = invoiceable.length > 0 && invoiceable.every((l: any) => l.remaining <= EPS)
  const state = allInvoiced ? 'full' : anyInvoiced ? 'partial' : 'none'
  const rest = invoiceable.filter((l: any) => l.remaining > EPS).map((l: any) => ({ ...l, quantity: l.remaining }))
  return { lines, state, remainingTotals: invoiceTotalsOf(rest) }
}

/** Why a cash sale cannot take an invoice (null = it can). */
function refusal(cs: any): { statusCode: number; code: string; message: string } | null {
  if (!cs || cs.type !== 'cash_sale') return { statusCode: 422, code: 'not_a_cash_sale', message: 'Only a cash sale can be invoiced this way' }
  if (cs.status !== 'paid') {
    return { statusCode: 422, code: 'cash_sale_not_paid', message: `Cash sale ${cs.invoiceNumber} is ${cs.status} — only a paid cash sale can be invoiced` }
  }
  return null
}

export async function getCashSaleInvoicing(orgId: string, cashSaleId: string): Promise<CashSaleInvoicingState> {
  const cs: any = await Invoice.findOne({ _id: cashSaleId, orgId } as any).lean().exec()
  if (!cs) throw new CashSaleInvoiceError(404, 'not_found', 'Cash sale not found')
  if (cs.type !== 'cash_sale') throw new CashSaleInvoiceError(422, 'not_a_cash_sale', 'Only a cash sale can be invoiced this way')
  const invoices = await liveInvoicesOf(orgId, cashSaleId)
  const { lines, state, remainingTotals } = stateOf(cs, invoices)
  const why = refusal(cs)
  const wholeOnly = !!cs.contactId
  let reason = why?.message
  if (!reason && state === 'full') reason = 'Every line of this cash sale is already invoiced'
  if (!reason && wholeOnly && invoices.length) reason = 'This cash sale names a customer, so it is invoiced once, in full'
  return {
    cashSale: {
      id: idOf(cs._id), number: cs.invoiceNumber, issueDate: cs.issueDate, status: cs.status,
      contactId: cs.contactId ? idOf(cs.contactId) : null, currency: cs.currency || 'EUR', total: num(cs.total),
      paymentMethod: cs.paymentMethod || (cs.payments?.[0]?.method ?? 'cash'),
    },
    wholeOnly,
    lines,
    invoices: invoices.filter(i => !isPending(i)).map(i => ({
      id: idOf(i._id), number: i.invoiceNumber, status: i.status,
      contactId: i.contactId ? idOf(i.contactId) : null, total: num(i.total), issueDate: i.issueDate,
    })),
    state,
    canInvoice: !reason,
    ...(reason ? { reason } : {}),
    remainingTotals,
  }
}

/**
 * The invoices of a page of cash sales, and how far each is invoiced — what the lists show.
 *
 * Takes ids, not the repository's documents: the DAL's entity mapper drops every nested `_id`
 * (`dal-mongo/src/entity-mapper.ts`), so the lines it returns cannot be matched to anything.
 */
export async function invoicingByCashSale(
  orgId: string,
  cashSaleIds: string[],
): Promise<Map<string, { invoices: Array<{ id: string; number: string; status: string }>; state: 'none' | 'partial' | 'full' }>> {
  const out = new Map<string, { invoices: Array<{ id: string; number: string; status: string }>; state: 'none' | 'partial' | 'full' }>()
  const ids = [...new Set(cashSaleIds.map(idOf).filter(Boolean))]
  if (!ids.length) return out
  const oids = ids.map(id => new Types.ObjectId(id))
  const docs: any[] = await Invoice.find(
    { orgId, type: 'invoice', [CASH_SALE_REF_ID]: { $in: oids }, status: { $nin: RELEASED } } as any,
    { invoiceNumber: 1, status: 1, cashSaleRef: 1, leaseUntil: 1, 'lines.cashSaleLineId': 1, 'lines.quantity': 1 },
  ).sort({ _id: 1 }).lean().exec()
  const byCs = new Map<string, any[]>()
  for (const d of docs) {
    if (isPending(d)) continue
    const k = idOf(d.cashSaleRef?.cashSaleId)
    if (!byCs.has(k)) byCs.set(k, [])
    byCs.get(k)!.push(d)
  }
  const withInvoices = [...byCs.keys()]
  const sales: any[] = withInvoices.length
    ? await Invoice.find({ orgId, _id: { $in: withInvoices.map(id => new Types.ObjectId(id)) } } as any, { 'lines._id': 1, 'lines.quantity': 1 }).lean().exec()
    : []
  const saleById = new Map(sales.map(s => [idOf(s._id), s]))
  for (const k of ids) {
    const invs = byCs.get(k) || []
    const cs = saleById.get(k)
    if (!invs.length || !cs) { out.set(k, { invoices: [], state: 'none' }); continue }
    const { state } = stateOf(cs, invs)
    out.set(k, { invoices: invs.map(i => ({ id: idOf(i._id), number: i.invoiceNumber, status: i.status })), state })
  }
  return out
}

/** Ids of the cash sales that have at least one live invoice — the cash sales list's filter. */
export async function invoicedCashSaleIds(orgId: string): Promise<any[]> {
  const ids = await Invoice.distinct(CASH_SALE_REF_ID, {
    orgId: new Types.ObjectId(orgId), type: 'invoice', status: { $nin: RELEASED },
    invoiceNumber: { $not: /^~pending:/ },
  } as any).exec()
  return (ids as unknown[]).map(id => new Types.ObjectId(String(id)))
}

/** The live invoices of a cash sale, for the guards that must not remove it from under them. */
export async function liveInvoiceNumbersFor(orgId: string, cashSaleId: string): Promise<string[]> {
  return (await liveInvoicesOf(orgId, cashSaleId)).filter(d => !isPending(d)).map(d => d.invoiceNumber)
}

// ── Issuing ──────────────────────────────────────────────────────────────────────────────────

export interface InvoiceForCashSaleInput {
  contactId: string
  /** `YYYY-MM-DD`; today when omitted. */
  issueDate?: string
  /** Which lines, how much. Omitted: everything that remains. */
  lines?: Array<{ lineId: string; quantity: number }>
  /** Issue now (the default) or keep a draft. */
  issue?: boolean
  /** Free notes. „Словом" is written into them here, as the document forms do on save. */
  notes?: string
  printNote?: string
  /** The language of „Словом" — the user's UI language, as the forms use. Default `bg`. */
  locale?: string
}

interface Actor { id: string; firstName?: string; lastName?: string }

/** The billing address an invoice copies from a contact, the way the invoice form picks it. */
function billingAddressOf(contact: any): Record<string, string> {
  const list: any[] = contact?.addresses || []
  const a = list.find(x => x.type === 'billing' && x.isDefault) || list.find(x => x.type === 'billing') || list.find(x => x.isDefault) || list[0]
  if (!a) return { street: '-', city: '-', postalCode: '-', country: '-' }
  return { street: a.street || '-', city: a.city || '-', ...(a.state ? { state: a.state } : {}), postalCode: a.postalCode || '-', country: a.country || '-' }
}

/** What an invoice for `cs` carries besides its lines. */
function stockSourceFor(cs: any, movementIds: unknown[]): Record<string, any> {
  return {
    marker: `cash_sale:${cs.invoiceNumber}`,
    docNumber: cs.invoiceNumber,
    movementIds,
    detectedBy: 'cash_sale',
    linkedAt: new Date(),
  }
}

/** The fields an invoice for a cash sale takes when it is issued (here, and by `/send` for a draft). */
export async function issueFieldsFor(orgId: string, invoice: any): Promise<Record<string, any>> {
  const cs: any = await Invoice.findOne({ _id: invoice.cashSaleRef?.cashSaleId, orgId } as any)
    .select('invoiceNumber paymentMethod payments paidAt issueDate').lean().exec()
  const paidOn = new Date(cs?.paidAt || cs?.issueDate || invoice.issueDate || Date.now())
  const payments = mirroredPayments(cs || { paymentMethod: 'cash' }, num(invoice.total), paidOn)
  return {
    status: 'paid',
    payments,
    paymentMethod: mainMethod(payments),
    amountPaid: round2(num(invoice.total)),
    amountDue: 0,
    paidAt: paidOn,
  }
}

/** Resolve the quantities this request asks for, or refuse. */
function requestedQuantities(
  cs: any,
  state: Pick<CashSaleInvoicingState, 'lines'>,
  hasOtherInvoices: boolean,
  input: InvoiceForCashSaleInput,
): Map<string, number> {
  const byId = new Map(state.lines.map(l => [l.lineId, l]))
  const wanted = new Map<string, number>()
  if (!input.lines?.length) {
    for (const l of state.lines) if (l.remaining > EPS) wanted.set(l.lineId, l.remaining)
  } else {
    for (const r of input.lines) {
      const l = byId.get(String(r.lineId))
      if (!l || l.quantity <= 0) throw new CashSaleInvoiceError(422, 'unknown_line', `Line ${r.lineId} is not an invoiceable line of ${cs.invoiceNumber}`)
      const q = num(r.quantity)
      if (!(q > 0)) throw new CashSaleInvoiceError(422, 'invalid_quantity', `The quantity for „${l.description}" must be greater than 0`)
      wanted.set(l.lineId, (wanted.get(l.lineId) || 0) + q)
    }
  }
  if (!wanted.size) {
    throw new CashSaleInvoiceError(409, 'cash_sale_fully_invoiced', `Every line of ${cs.invoiceNumber} is already invoiced`)
  }
  for (const [lineId, q] of wanted) {
    const l = byId.get(lineId)!
    if (q > l.remaining + EPS) {
      throw new CashSaleInvoiceError(409, 'cash_sale_quantity_exceeded',
        `„${l.description}": ${q} requested, ${l.remaining} not yet invoiced`, { lineId, remaining: l.remaining })
    }
  }
  if (cs.contactId) {
    // A sale to a named customer is that customer's purchase: it is invoiced whole, once.
    const whole = !hasOtherInvoices && state.lines.every(l => l.quantity <= 0 || Math.abs((wanted.get(l.lineId) || 0) - l.quantity) <= EPS)
    if (!whole) {
      throw new CashSaleInvoiceError(422, 'cash_sale_whole_only',
        `${cs.invoiceNumber} names a customer, so it is invoiced once, with every line in full`)
    }
  }
  return wanted
}

/**
 * Build the invoice document (without its number) for `wanted` of cash sale `cs`.
 * Whole: the cash sale's own totals, to the cent — they are the receipt's figures.
 */
function buildInvoiceDoc(orgId: string, cs: any, contact: any, actor: Actor, wanted: Map<string, number>, input: InvoiceForCashSaleInput, movementIds: unknown[]) {
  const srcById = new Map((cs.lines || []).map((l: any) => [idOf(l._id), l]))
  const lines = [...wanted.entries()].map(([lineId, q]) => invoiceLineFrom(srcById.get(lineId) as SourceLine, q))
  const whole = (cs.lines || []).every((l: any) => num(l.quantity) <= 0 || Math.abs((wanted.get(idOf(l._id)) || 0) - num(l.quantity)) <= EPS)
  const totals = whole
    ? { subtotal: round2(cs.subtotal), discountTotal: round2(cs.discountTotal), taxTotal: round2(cs.taxTotal), total: round2(cs.total) }
    : invoiceTotalsOf(lines)
  const issueDate = input.issueDate ? new Date(input.issueDate) : new Date(isoDay(new Date()))
  const exchangeRate = num(cs.exchangeRate) || 1
  const name = [actor.firstName, actor.lastName].filter(Boolean).join(' ').trim()
  return {
    orgId,
    type: 'invoice',
    direction: 'outgoing',
    contactId: contact._id,
    issueDate,
    dueDate: issueDate,
    taxEventDate: cs.issueDate,
    currency: cs.currency || 'EUR',
    exchangeRate,
    lines,
    ...totals,
    totalBase: round2(totals.total * exchangeRate),
    amountPaid: 0,
    amountDue: totals.total,
    billingAddress: billingAddressOf(contact),
    // Every outgoing document carries „Словом" (`useDocumentForm.buildPayload`); so does this one.
    notes: upsertAmountInWords(input.notes || '', totals.total, totals.subtotal, cs.currency || 'EUR', input.locale || 'bg'),
    printNote: input.printNote || undefined,
    preparedBy: name || cs.preparedBy || undefined,
    placeOfTransaction: cs.placeOfTransaction || undefined,
    paymentMethod: cs.paymentMethod || undefined,
    cashSaleRef: {
      cashSaleId: cs._id,
      number: cs.invoiceNumber,
      issueDate: cs.issueDate,
      ...(cs.contactId ? { contactId: cs.contactId } : {}),
    },
    stockSource: stockSourceFor(cs, movementIds),
  }
}

/** Number a conversion's placeholder: the issued SALES_DOC number, or a draft one. Null after 3 tries. */
async function numberIt(orgId: string, id: string, issue: boolean, fields: (n: string) => Record<string, any>): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const number = issue
      ? await getNextInvoiceNumber(orgId, 'outgoing', 'invoice')
      : (await getNextDraftInvoiceNumber(orgId, 'outgoing', 'invoice')) || (await getNextInvoiceNumber(orgId, 'outgoing', 'invoice'))
    try {
      const done = await Invoice.findOneAndUpdate(
        { _id: id, orgId, invoiceNumber: { $regex: `^${PENDING_NUMBER}` } } as any,
        { $set: fields(number), $unset: { leaseUntil: 1 } },
        { new: true },
      ).lean().exec()
      // No match: a resumed request numbered it first — either way it is done.
      return done || (await Invoice.findOne({ _id: id, orgId } as any).lean().exec())
    } catch (e: any) {
      if (e?.code !== 11000) throw e
      logger.warn({ orgId, id, number, attempt }, 'Invoice number already taken, retrying')
    }
  }
  return null
}

/**
 * Issue an invoice (or a draft) for cash sale `cashSaleId`.
 *
 * With an `Idempotency-Key`, a retry returns the invoice the first request made; a crashed
 * request's placeholder is resumed once its lease lapses (#155's pattern).
 */
export async function createInvoiceForCashSale(
  orgId: string,
  actor: Actor,
  cashSaleId: string,
  input: InvoiceForCashSaleInput,
  opts: { key?: string; hash?: string } = {},
): Promise<any> {
  const { key, hash } = opts
  const r = getRepos()
  const issue = input.issue !== false
  const asRepo = (id: unknown) => r.invoices.findOne({ id: idOf(id), orgId } as any)

  // A retry: replay, wait, or resume what the first request left.
  let resumed: any = null
  if (key) {
    const existing: any = await Invoice.findOne({ orgId, clientKey: key } as any).lean().exec()
    if (existing) {
      assertSameRequest(existing.requestHash, hash!)
      if (existing.completedAt) return asRepo(existing._id)
      resumed = await takeLease(Invoice, orgId, existing._id)
      if (!resumed) {
        const { doc } = await waitForCompletion(Invoice, orgId, existing._id)
        if (doc?.completedAt) return asRepo(doc._id)
        throw new CashSaleInvoiceError(409, 'idempotency_in_progress', 'This invoice is still being created — retry with the same Idempotency-Key.')
      }
    }
  }

  const dropOwn = (doc: any) => Invoice.deleteOne({ _id: doc._id, orgId, invoiceNumber: { $regex: `^${PENDING_NUMBER}` } } as any).exec()
  const cs: any = await Invoice.findOne({ _id: cashSaleId, orgId } as any).lean().exec()
  const why = cs ? refusal(cs) : { statusCode: 404, code: 'not_found', message: 'Cash sale not found' }
  if (why) {
    if (resumed) await dropOwn(resumed)
    throw new CashSaleInvoiceError(why.statusCode, why.code, why.message)
  }

  let own: any = resumed
  if (!own) {
    // A conversion that crashed before it was numbered holds nothing once its lease lapses; its
    // placeholder never became a document, so it goes rather than lingering as a draft.
    await Invoice.deleteMany({
      orgId, [CASH_SALE_REF_ID]: cs._id, invoiceNumber: { $regex: `^${PENDING_NUMBER}` }, leaseUntil: { $lt: new Date() },
    } as any).exec()
    if (!input.contactId) throw new CashSaleInvoiceError(422, 'contact_required', 'Choose the customer the invoice is for')
    const contact: any = await Contact.findOne({ _id: input.contactId, orgId } as any).lean().exec()
    if (!contact || contact.isActive === false) throw new CashSaleInvoiceError(404, 'contact_not_found', 'Customer not found')
    if (contact.type === 'supplier') throw new CashSaleInvoiceError(422, 'contact_not_customer', 'The contact is a supplier only — choose a customer')
    if (input.issueDate && isoDay(input.issueDate) < isoDay(cs.issueDate)) {
      throw new CashSaleInvoiceError(422, 'issue_date_before_sale', `The invoice cannot be dated before the sale (${isoDay(cs.issueDate)})`)
    }

    const others = await liveInvoicesOf(orgId, cashSaleId)
    const wanted = requestedQuantities(cs, stateOf(cs, others), others.length > 0, input)
    const movementIds = (await StockMovement.find({ orgId, invoiceId: cs._id } as any, { _id: 1 }).lean().exec()).map((m: any) => m._id)
    const doc = buildInvoiceDoc(orgId, cs, contact, actor, wanted, input, movementIds)

    // Claim first, under a placeholder that is no legal number, then check the claim, then number.
    const placeholder = `${PENDING_NUMBER}${key || randomUUID()}`
    try {
      own = (await Invoice.create({
        ...doc,
        invoiceNumber: placeholder,
        status: 'draft',
        statusHistory: [{ status: 'draft', changedAt: new Date(), changedBy: actor.id, reason: `for_cash_sale ${cs.invoiceNumber}` }],
        leaseUntil: new Date(Date.now() + LEASE_MS),
        ...(key ? { clientKey: key, requestHash: hash } : {}),
        createdBy: actor.id,
      } as any)).toObject()
    } catch (e: any) {
      // The same key won a race to the insert: answer as that request does.
      if (key && isDuplicateKey(e)) return createInvoiceForCashSale(orgId, actor, cashSaleId, input, opts)
      throw e
    }
  }

  // Does this claim fit beside the earlier ones? A later claim that does not gives way.
  const claims = (await liveInvoicesOf(orgId, cashSaleId)).map(claimOf)
  if (!claims.some(c => c.id === idOf(own._id))) claims.push(claimOf(own))
  const over = overClaimed(soldByLine(cs), claims, idOf(own._id))
  const earlier = claims.filter(c => c.id < idOf(own._id))
  if (over.length || (cs.contactId && earlier.length)) {
    await dropOwn(own)
    if (cs.contactId && earlier.length) {
      throw new CashSaleInvoiceError(409, 'cash_sale_fully_invoiced', `${cs.invoiceNumber} is already invoiced`)
    }
    const line = (cs.lines || []).find((l: any) => idOf(l._id) === over[0].lineId)
    throw new CashSaleInvoiceError(409, 'cash_sale_quantity_exceeded',
      `„${line?.description || over[0].lineId}": ${over[0].requested} requested, ${over[0].remaining} not yet invoiced`,
      { lines: over })
  }

  const issuing = issue ? await issueFieldsFor(orgId, own) : null
  const now = new Date()
  const numbered = await numberIt(orgId, idOf(own._id), issue, (number) => ({
    invoiceNumber: number,
    numberHistory: [{ number, allocatedAt: now, status: issue ? 'paid' : 'draft' }],
    completedAt: now,
    ...(issuing
      ? {
          ...issuing,
          sentAt: now,
          statusHistory: [
            ...(own.statusHistory || []),
            { status: 'paid', fromStatus: 'draft', changedAt: now, changedBy: actor.id, reason: `issued for cash sale ${cs.invoiceNumber}` },
          ],
        }
      : {}),
  }))
  if (!numbered) {
    await dropOwn(own)
    throw new CashSaleInvoiceError(409, 'number_unavailable', 'Could not allocate the invoice number after 3 attempts')
  }

  const id = idOf(numbered._id)
  createAuditEntry({
    orgId, userId: actor.id, action: issue ? 'send' : 'create', module: 'invoicing', entityType: 'invoice',
    entityId: id, entityName: numbered.invoiceNumber, correlationId: idOf(cs._id),
    changes: [{ field: 'cashSale', oldValue: null, newValue: cs.invoiceNumber }],
  } as any)
  createAuditEntry({
    orgId, userId: actor.id, action: 'invoiced', module: 'invoicing', entityType: 'invoice',
    entityId: idOf(cs._id), entityName: cs.invoiceNumber, correlationId: id,
    changes: [{ field: 'invoice', oldValue: null, newValue: numbered.invoiceNumber }],
  } as any)
  logger.info({ orgId, cashSale: cs.invoiceNumber, invoice: numbered.invoiceNumber, issue }, 'Invoice issued for a cash sale')
  return asRepo(id)
}

// ── Editing ──────────────────────────────────────────────────────────────────────────────────

/** Fields of an invoice for a cash sale that no edit may change: they are the cash sale's. */
const FIXED_FIELDS = [
  'cashSaleRef', 'stockSource', 'taxEventDate', 'currency', 'exchangeRate', 'payments', 'amountPaid', 'amountDue',
  'paymentMethod', 'subtotal', 'discountTotal', 'taxTotal', 'taxAmount', 'total', 'totalBase',
  'orderId', 'orderGroupId', 'internalOrderId',
]

/**
 * Check a `PUT` to an invoice issued for a cash sale and return what it may set.
 *
 * An issued one keeps its lines and dates: correcting it is a credit or debit note, or a void and
 * a new invoice. A draft may drop lines, or invoice less of one, when the sale names no customer;
 * the amounts are recomputed from the cash sale whatever the request sent. The customer and the
 * free text can always change. Mutates `body` (drops what is fixed); returns the server-built
 * lines and totals to set, or throws.
 */
export async function checkInvoiceForCashSaleEdit(orgId: string, existing: any, body: Record<string, any>): Promise<Record<string, any>> {
  for (const f of FIXED_FIELDS) delete body[f]
  const issued = existing.status !== 'draft'
  if (issued) {
    const datesChange = (body.issueDate !== undefined && isoDay(body.issueDate) !== isoDay(existing.issueDate))
      || (body.dueDate !== undefined && isoDay(body.dueDate) !== isoDay(existing.dueDate))
    if (datesChange || body.lines !== undefined) {
      if (body.lines !== undefined && sameLines(existing.lines, body.lines) && !datesChange) {
        delete body.lines
      } else {
        throw new CashSaleInvoiceError(422, 'invoice_for_cash_sale_issued',
          `${existing.invoiceNumber} is issued for cash sale ${existing.cashSaleRef?.number}: its lines and dates are the sale's. Correct it with a credit or debit note, or void it and issue a new one.`)
      }
    }
    return {}
  }
  if (body.lines === undefined) return {}

  const cs: any = await Invoice.findOne({ _id: existing.cashSaleRef?.cashSaleId, orgId } as any).lean().exec()
  if (!cs) throw new CashSaleInvoiceError(409, 'cash_sale_missing', 'The cash sale this invoice is for no longer exists')
  const others = (await liveInvoicesOf(orgId, idOf(cs._id))).filter(d => idOf(d._id) !== idOf(existing._id))
  const state = stateOf(cs, others)
  const srcById = new Map((cs.lines || []).map((l: any) => [idOf(l._id), l]))
  const wanted = new Map<string, number>()
  for (const l of body.lines as any[]) {
    const k = idOf(l.cashSaleLineId)
    const src: any = k ? srcById.get(k) : null
    if (!src) {
      throw new CashSaleInvoiceError(422, 'line_not_in_cash_sale',
        `An invoice for cash sale ${cs.invoiceNumber} carries only that sale's lines — „${l.description || l.productId || '?'}" is not one of them`)
    }
    const same = idOf(l.productId) === idOf(src.productId)
      && Math.abs(num(l.unitPrice) - num(src.unitPrice)) <= EPS
      && Math.abs(num(l.discount) - num(src.discount)) <= EPS
      && Math.abs(num(l.taxRate) - num(src.taxRate)) <= EPS
    if (!same) {
      throw new CashSaleInvoiceError(422, 'line_terms_fixed',
        `„${src.description}": the product, price, discount and VAT are those of cash sale ${cs.invoiceNumber}`)
    }
    const q = num(l.quantity)
    if (!(q > 0)) throw new CashSaleInvoiceError(422, 'invalid_quantity', `The quantity for „${src.description}" must be greater than 0`)
    wanted.set(k, (wanted.get(k) || 0) + q)
  }
  const input: InvoiceForCashSaleInput = { contactId: '', lines: [...wanted].map(([lineId, quantity]) => ({ lineId, quantity })) }
  requestedQuantities(cs, state, others.length > 0, input)
  const lines = [...wanted.entries()].map(([lineId, q]) => invoiceLineFrom(srcById.get(lineId) as SourceLine, q))
  const whole = (cs.lines || []).every((l: any) => num(l.quantity) <= 0 || Math.abs((wanted.get(idOf(l._id)) || 0) - num(l.quantity)) <= EPS)
  const totals = whole
    ? { subtotal: round2(cs.subtotal), discountTotal: round2(cs.discountTotal), taxTotal: round2(cs.taxTotal), total: round2(cs.total) }
    : invoiceTotalsOf(lines)
  delete body.lines
  return { lines, ...totals, totalBase: round2(totals.total * (num(existing.exchangeRate) || 1)), amountDue: totals.total }
}

/** Do two line arrays invoice the same cash-sale lines in the same quantities? (A form re-save.) */
function sameLines(a: any[] = [], b: any[] = []): boolean {
  const key = (ls: any[]) => ls.map(l => `${idOf(l.cashSaleLineId)}:${num(l.quantity)}`).sort().join('|')
  return key(a) === key(b)
}
