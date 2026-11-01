import { isRemovalReversalNote, noteSaysNoDelivery } from 'config/movement-notes'
import { mongoose } from 'db/connection'
import { Contact, Invoice, Org, Product, StockMovement } from 'db/models'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'
import { createAuditEntry } from './audit-log.service.js'
import { getNextDraftInvoiceNumber, getNextInvoiceNumber } from './invoice-numbering.service.js'

/**
 * The supplier's bill for goods already received (FR-22.31 / #168, FR-22 D-2).
 *
 * Goods often arrive before the supplier's invoice: staff book a receipt (often "with product
 * update") and start selling. Days later the invoice comes, and it is entered as a bill. A bill
 * receives its own goods when it is received (`createInvoiceStockMovement`), so a bill typed in
 * for goods a receipt already booked put them in stock a second time (FR-22 B-4) — and, in an org
 * that keeps journals, booked the inventory twice as well.
 *
 * So the bill is made FROM the receipt, and remembers it:
 *
 *   - `stockSource { marker: 'movement:<id>[,<id>…]', docNumber, movementIds, detectedBy: 'manual' }`
 *     on the bill. Present ⇒ the bill moves no stock, on any path (`movesNoStock` in
 *     `invoicing.service.ts`: receive, issue, void, Files rollback).
 *   - `invoiceId` on each receipt — the CLAIM. A receipt is billed once and whole (D-2): the claim
 *     is a compare-and-set on that field, so two bills cannot take the same receipt, and the
 *     product ledger then names the bill next to the receipt (`product-ledger.service.ts`).
 *
 * One bill may cover several receipts, all from ONE supplier (D-2). Voiding or deleting the bill
 * releases the claims — the receipt can be billed again — and moves nothing either way (§5.3).
 * A receipt a live bill claims cannot be rolled back under it (§5.4, `doc-delete.service.ts`).
 *
 * A receipt that names no supplier is billed too (FR-22.31a): a completed receipt can no longer be
 * edited, so it would otherwise stay unbillable for ever. The bill's supplier is written onto it in
 * the claim's own compare-and-set, and only there, so two bills racing for it cannot overwrite each
 * other. The bill remembers which receipts it named (`stockSource.supplierGivenTo`), and releasing
 * the claim takes the supplier off again: a wrong choice must stay correctable, or the receipt would
 * be refused every other supplier from then on. The supplier feeds no journal entry (a receipt's
 * valuation entry carries no contact); the ledgers and reports read it, and name it from then on.
 *
 * A bill typed by hand for goods a receipt already booked is what this module exists to prevent, so
 * receiving an unlinked bill is refused while such a receipt stands unclaimed (FR-22.31c,
 * `receiptsOverlapping`). The refusal is a question: `acknowledgeOverlap` answers it.
 *
 * Prices (D-2): the bill keeps the supplier's prices as typed and the form shows the difference
 * to the receipt's cost per line. Receiving the bill moves the product's `purchasePrice` to the
 * billed price — for FUTURE receipts — and never re-costs what was received: StockLevel.avgCost
 * and the cost layers are left alone. The journals need nothing either: the receipt posted the
 * inventory, the bill posts the payable, and a price difference stays in purchases (FR-22, "D-2,
 * the journals question, verified").
 *
 * ⚠ A plain `POST`/`PUT /invoices` can never set `stockSource`: the routes strip it. This module
 * is the only writer of a `movement:` link.
 */

export class ReceiptBillError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ReceiptBillError'
  }
}

/** The marker prefix of a bill made from goods receipts. */
export const MOVEMENT_MARKER = 'movement:'
/** Invoice statuses that no longer hold a claim on their receipts. */
const RELEASED = ['voided', 'cancelled']
/** Quantities are compared at this precision — the form's number fields carry floats. */
const EPS = 1e-6
/**
 * How far from a bill's issue date, either way, a goods receipt can still be the delivery that bill
 * is for (FR-22.31c). Goods usually come first, days ahead of the invoice; a bill can also come
 * first, when it is paid in advance. Two months each way covers the slowest supplier invoicing at
 * the end of the following month. A wider window only finds an older delivery of the same article,
 * which is what a supplier who delivers often has anyway.
 */
export const RECEIPT_OVERLAP_WINDOW_DAYS = 60
const DAY_MS = 24 * 60 * 60 * 1000
/**
 * Receipts read per bill, newest first, before they are judged. The question only needs one, and
 * a bill sharing articles with more than this many deliveries in the window has met it long before
 * the last. An older match past the cap goes unasked; the cost of asking is a read on every bill.
 */
const OVERLAP_SCAN_LIMIT = 200
/** Receipts one refusal names: a person reads them. */
const OVERLAP_REPORT_LIMIT = 20

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
/** The `+(x).toFixed(2)` rounding of the document forms (`document-payload.ts`). */
function round2(v: number): number {
  return +num(v).toFixed(2)
}
function idOf(v: any): string {
  return v === undefined || v === null ? '' : String(v._id ?? v)
}
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}
/** A well-formed id — anything else would throw a CastError (a 500) instead of a 404. */
function isId(v: unknown): boolean {
  return typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v) && mongoose.Types.ObjectId.isValid(v)
}

/** Is `invoice` a bill made from goods receipts? */
export function isReceiptLinked(invoice: any): boolean {
  const src = invoice?.stockSource
  return !!src?.marker && String(src.marker).startsWith(MOVEMENT_MARKER)
}

/** The receipts a receipt-linked bill names, as ids. */
export function linkedMovementIds(invoice: any): string[] {
  return isReceiptLinked(invoice) ? (invoice.stockSource.movementIds || []).map(idOf) : []
}

// ── Who holds a receipt ─────────────────────────────────────────────────────────────────────

export interface ReceiptBillingState {
  /** The receipt may be billed now. */
  billable: boolean
  /** It may, once someone says whose goods they were: the receipt names no supplier. */
  needsSupplier?: boolean
  /** Why not, when it may not be. */
  reason?: 'not_a_receipt' | 'receipt_not_completed' | 'receipt_rolled_back' | 'receipt_is_reversal' | 'receipt_not_a_delivery' | 'receipt_already_billed' | 'receipt_not_billable'
  /** The live document that holds it (its bill, or the bill whose own receipt it is). */
  invoice?: { id: string; number: string; status: string; type: string; direction: string }
}

/**
 * Whether a movement can be billed, and if not, who holds it.
 *
 * A `receipt` that names no supplier is not always a delivery, and linking a real bill to one means
 * the bill moves no stock, so the real delivery is never booked. Its notes are all that tells them
 * apart (`config/movement-notes`): the mirror of a removed document (goods put back), and a
 * correction, a reconcile delta or a day's aggregate. A receipt that names a supplier was given one
 * by someone, and is billable whatever its notes say.
 *
 * `invoices` maps the ids its `invoiceId` may point at to those invoices (lean). A movement whose
 * `invoiceId` names:
 *   - no document at all — a claim left by a crash between delete and release — is free, provided
 *     it names a supplier: a claim always has one, so a movement without one was never claimed.
 *     It is what a rolled-back till sale leaves behind, its reversal pointing at a sale that is gone;
 *   - a live document — billed (a receipt linked to a bill, or the bill's own receipt);
 *   - a voided document that LISTS it (a claim the void did not release) — free;
 *   - a voided document that does not list it — that document booked it and its void reversed
 *     it, so it is no receipt of its own any more.
 */
export function billingStateOf(movement: any, invoices: Map<string, any>): ReceiptBillingState {
  if (movement.type !== 'receipt') return { billable: false, reason: 'not_a_receipt' }
  if (movement.status !== 'completed') return { billable: false, reason: 'receipt_not_completed' }
  // Rolled back with its document: it stays completed, and the goods have left again.
  if (movement.reversedBy) return { billable: false, reason: 'receipt_rolled_back' }
  if (isRemovalReversalNote(movement.notes)) return { billable: false, reason: 'receipt_is_reversal' }
  if (!movement.contactId && noteSaysNoDelivery(movement.notes)) return { billable: false, reason: 'receipt_not_a_delivery' }
  const free: ReceiptBillingState = movement.contactId ? { billable: true } : { billable: true, needsSupplier: true }
  const invId = idOf(movement.invoiceId)
  if (!invId) return free
  const inv = invoices.get(invId)
  if (!inv) return movement.contactId ? free : { billable: false, reason: 'receipt_not_billable' }
  const ref = { id: invId, number: inv.invoiceNumber, status: inv.status, type: inv.type, direction: inv.direction }
  if (!RELEASED.includes(inv.status)) return { billable: false, reason: 'receipt_already_billed', invoice: ref }
  if (linkedMovementIds(inv).includes(idOf(movement._id))) return free
  return { billable: false, reason: 'receipt_not_billable', invoice: ref }
}

/** The invoices a set of movements point at, by id. */
async function invoicesOf(orgId: string, movements: any[]): Promise<Map<string, any>> {
  const ids = [...new Set(movements.map(m => idOf(m.invoiceId)).filter(Boolean))]
  if (!ids.length) return new Map()
  const rows: any[] = await Invoice.find(
    { orgId, _id: { $in: ids } } as any,
    { invoiceNumber: 1, status: 1, type: 1, direction: 1, stockSource: 1, contactId: 1 },
  ).lean().exec()
  return new Map(rows.map(r => [idOf(r._id), r]))
}

/**
 * A void writes the bill first and gives its receipts back after, so a crash between the two leaves a
 * voided bill still listing a receipt that still names the supplier it wrote, and a completed receipt
 * cannot be edited: every other supplier would be refused it for ever. The next touch of such a receipt
 * finishes the release, the rule FR-23 follows too. True when one was finished.
 */
async function finishReleases(orgId: string, movements: any[], invoices: Map<string, any>, userId?: string): Promise<boolean> {
  const unfinished = new Map<string, any>()
  for (const m of movements) {
    const bill = invoices.get(idOf(m.invoiceId))
    if (bill && RELEASED.includes(bill.status) && linkedMovementIds(bill).includes(idOf(m._id))) unfinished.set(idOf(bill._id), bill)
  }
  for (const bill of unfinished.values()) await releaseReceiptLinks(orgId, bill, userId)
  return unfinished.size > 0
}

/**
 * The movement as it stands, and its state, once a release left unfinished is done. For a page that
 * only reads, so a write it cannot make (another node is the org's home) leaves it reading as it was.
 */
async function settledBillingState(orgId: string, movement: any, userId?: string): Promise<{ current: any; state: ReceiptBillingState }> {
  const invoices = await invoicesOf(orgId, [movement])
  let finished = false
  try {
    finished = await finishReleases(orgId, [movement], invoices, userId)
  } catch (e: any) {
    logger.warn({ orgId, movement: idOf(movement._id), err: e?.message }, 'receipt-bill: an unfinished release could not be finished here')
  }
  if (!finished) return { current: movement, state: billingStateOf(movement, invoices) }
  const current: any = (await StockMovement.findOne({ orgId, _id: movement._id } as any).lean().exec()) ?? movement
  return { current, state: billingStateOf(current, await invoicesOf(orgId, [current])) }
}

/** The billing state of one movement (the receipt page's „Входяща фактура" and its bill link). */
export async function receiptBillingState(orgId: string, movement: any, userId?: string): Promise<ReceiptBillingState> {
  return (await settledBillingState(orgId, movement, userId)).state
}

/** Per movement id: the live invoice that holds it (the receipts list's „Фактурирана" marker). */
export async function billingByMovement(orgId: string, movements: any[]): Promise<Map<string, ReceiptBillingState>> {
  const invoices = await invoicesOf(orgId, movements)
  return new Map(movements.map(m => [idOf(m._id ?? m.id), billingStateOf(m, invoices)]))
}

const REFUSAL: Record<string, { status: number; message: (m: any, s: ReceiptBillingState) => string }> = {
  not_a_receipt: { status: 422, message: m => `${m.movementNumber} is not a goods receipt` },
  receipt_not_completed: { status: 422, message: m => `${m.movementNumber} is not booked yet — confirm it first` },
  receipt_rolled_back: { status: 422, message: m => `${m.movementNumber} was rolled back with its document — the goods left again` },
  receipt_is_reversal: { status: 422, message: m => `${m.movementNumber} puts back the goods of a removed document — no supplier billed it` },
  receipt_not_a_delivery: { status: 422, message: m => `${m.movementNumber} is a correction or a day's aggregate — no one supplier's bill pays for it` },
  receipt_already_billed: { status: 409, message: (m, s) => `${m.movementNumber} is already billed by ${s.invoice?.number}` },
  receipt_not_billable: {
    status: 409,
    message: (m, s) => (s.invoice
      ? `${m.movementNumber} was booked by ${s.invoice.number}, which is voided — it is no receipt of its own`
      : `${m.movementNumber} reverses a document that is gone — it is no receipt of its own`),
  },
}

/** Load `movementIds` and refuse unless every one may be billed, by one bill, from one supplier. */
async function loadBillableReceipts(orgId: string, movementIds: string[], userId: string): Promise<any[]> {
  const ids = [...new Set((movementIds || []).map(String).filter(Boolean))]
  if (!ids.length) throw new ReceiptBillError(422, 'no_receipts', 'Choose at least one goods receipt')
  if (!ids.every(isId)) throw new ReceiptBillError(404, 'receipt_not_found', 'Goods receipt not found')
  const read = async () => {
    const rows: any[] = await StockMovement.find({ orgId, _id: { $in: ids } } as any).lean().exec()
    if (rows.length !== ids.length) throw new ReceiptBillError(404, 'receipt_not_found', 'Goods receipt not found')
    // The order the user named them in is the order their lines take on the bill.
    const byId = new Map(rows.map(r => [idOf(r._id), r]))
    return ids.map(id => byId.get(id))
  }
  let movements = await read()
  let invoices = await invoicesOf(orgId, movements)
  if (await finishReleases(orgId, movements, invoices, userId)) {
    movements = await read()
    invoices = await invoicesOf(orgId, movements)
  }
  for (const m of movements) {
    const state = billingStateOf(m, invoices)
    if (state.billable) continue
    const refusal = REFUSAL[state.reason!]
    throw new ReceiptBillError(refusal.status, state.reason!, refusal.message(m, state), {
      movementId: idOf(m._id), movementNumber: m.movementNumber,
      ...(state.invoice ? { invoiceId: state.invoice.id, invoiceNumber: state.invoice.number } : {}),
    })
  }
  // A receipt that names no supplier takes the bill's, so only the ones that name one can clash.
  const suppliers = new Set(movements.map(m => idOf(m.contactId)).filter(Boolean))
  if (suppliers.size > 1) {
    throw new ReceiptBillError(422, 'mixed_suppliers', 'One bill covers the receipts of one supplier — these name different suppliers')
  }
  return movements
}

/**
 * A contact that may be named on a receipt: an active supplier (or `both`) of this org. Another
 * org's contact reads as one that does not exist.
 */
async function assertSupplier(orgId: string, contactId: string): Promise<void> {
  const known = isId(contactId) && await Contact.exists({
    orgId, _id: contactId, type: { $in: ['supplier', 'both'] }, isActive: { $ne: false },
  } as any).exec()
  if (!known) throw new ReceiptBillError(422, 'supplier_not_found', 'Choose a supplier of this organization')
}

interface SettledSupplier {
  supplierId: string
  /** The receipts that name none, and take this one with their claim. */
  unnamed: any[]
}

/**
 * The supplier of a bill for these receipts: the one they name, or `chosen`. `chosen` must not
 * contradict a receipt, and is needed the moment one of them names nobody.
 *
 * `check` proves `chosen` even when no receipt takes it: `from-receipt` makes the bill out to it.
 * A link keeps the bill's own contact, which is proved only when a receipt is about to take it.
 */
async function settleSupplier(orgId: string, movements: any[], chosen: string | undefined, check: boolean): Promise<SettledSupplier> {
  const named = idOf(movements.find(m => m.contactId)?.contactId)
  if (chosen && named && idOf(chosen) !== named) {
    throw new ReceiptBillError(422, 'supplier_mismatch', 'The receipts are from another supplier')
  }
  const unnamed = movements.filter(m => !m.contactId)
  if (unnamed.length && !chosen) {
    const first = unnamed[0]
    throw new ReceiptBillError(422, 'receipt_without_supplier', `${first.movementNumber} names no supplier — choose it`, {
      movementId: idOf(first._id), movementNumber: first.movementNumber,
    })
  }
  if (chosen && (check || unnamed.length)) await assertSupplier(orgId, idOf(chosen))
  return { supplierId: named || idOf(chosen), unnamed }
}

// ── The bill's lines ────────────────────────────────────────────────────────────────────────

interface ProductInfo { name: string; unit?: string; taxRate?: number; trackInventory?: boolean }

async function productsOf(orgId: string, ids: string[]): Promise<Map<string, ProductInfo>> {
  if (!ids.length) return new Map()
  const rows: any[] = await Product.find(
    { orgId, _id: { $in: [...new Set(ids)] } } as any,
    { name: 1, unit: 1, taxRate: 1, trackInventory: 1 },
  ).lean().exec()
  return new Map(rows.map(r => [idOf(r._id), r]))
}

/**
 * One bill line per received line, at the cost it was received at — the purchase bill's own
 * arithmetic (`document-payload.ts`, no discount): the tax and the line total are rounded per
 * line, as the form rounds them, so the form re-saves the same figures.
 */
export function billLinesFrom(movements: any[], products: Map<string, ProductInfo>, defaultVatRate: number): any[] {
  const lines: any[] = []
  for (const m of movements) {
    for (const l of m.lines || []) {
      const quantity = num(l.quantity)
      // A price-only разписка line moves nothing and bills nothing.
      if (!(quantity > 0)) continue
      const p = products.get(idOf(l.productId))
      const unitPrice = num(l.unitCost)
      const taxRate = p?.taxRate ?? defaultVatRate
      const net = quantity * unitPrice
      lines.push({
        productId: l.productId,
        // The model requires a description; an article that no longer exists keeps its line.
        description: p?.name || String(l.productId),
        quantity,
        unit: p?.unit || 'pcs',
        unitPrice,
        discount: 0,
        taxRate,
        taxAmount: round2(net * taxRate / 100),
        lineTotal: round2(net * (1 + taxRate / 100)),
        warehouseId: m.toWarehouseId || undefined,
      })
    }
  }
  return lines
}

/** The bill's totals from its lines, as `computeTotals` makes them (components rounded first). */
export function billTotalsOf(lines: any[]): { subtotal: number; taxTotal: number; total: number } {
  let subtotal = 0
  let tax = 0
  for (const l of lines) {
    const net = num(l.quantity) * num(l.unitPrice)
    subtotal += net
    tax += net * num(l.taxRate) / 100
  }
  return { subtotal: round2(subtotal), taxTotal: round2(tax), total: round2(round2(subtotal) + round2(tax)) }
}

function stockSourceFor(movements: any[], unnamed: any[]): Record<string, any> {
  return {
    marker: `${MOVEMENT_MARKER}${movements.map(m => idOf(m._id)).join(',')}`,
    docNumber: movements.map(m => m.movementNumber).join(', '),
    movementIds: movements.map(m => m._id),
    ...(unnamed.length ? { supplierGivenTo: unnamed.map(m => m._id) } : {}),
    detectedBy: 'manual',
    linkedAt: new Date(),
  }
}

function statusEntry(status: string, fromStatus: string | undefined, userId: string, reason: string) {
  return { status, ...(fromStatus ? { fromStatus } : {}), changedAt: new Date(), changedBy: userId, reason }
}

/**
 * Give claims back: only the ones `billId` still holds, never another bill's. `givenTo` are the
 * receipts that bill named: they go back to naming nobody, as they were before it.
 */
async function releaseClaims(orgId: string, billId: unknown, ids: unknown[], givenTo: unknown[]): Promise<number> {
  const given = new Set(givenTo.map(idOf))
  const named = ids.filter(id => given.has(idOf(id)))
  const others = ids.filter(id => !given.has(idOf(id)))
  let released = 0
  if (named.length) {
    released += (await StockMovement.updateMany({ orgId, _id: { $in: named }, invoiceId: billId } as any, { $unset: { invoiceId: 1, contactId: 1 } }).exec()).modifiedCount
  }
  if (others.length) {
    released += (await StockMovement.updateMany({ orgId, _id: { $in: others }, invoiceId: billId } as any, { $unset: { invoiceId: 1 } }).exec()).modifiedCount
  }
  return released
}

/**
 * Claim the receipts for `billId`: one compare-and-set per receipt on the `invoiceId` it was read
 * with, in `_id` order (so two requests for overlapping sets meet on the same first receipt, and
 * one of them takes none). A receipt that names no supplier takes `supplierId` in the same update,
 * guarded on still naming none: of two bills naming different suppliers, one writes its supplier
 * and the other loses the claim. On a lost race it gives back what it took and throws 409.
 */
async function claimReceipts(orgId: string, billId: unknown, movements: any[], supplierId: string): Promise<void> {
  const claimed: any[] = []
  const sorted = [...movements].sort((a, b) => idOf(a._id).localeCompare(idOf(b._id)))
  for (const m of sorted) {
    const unnamed = !m.contactId
    const res = await StockMovement.updateOne(
      { _id: m._id, orgId, type: 'receipt', status: 'completed', invoiceId: m.invoiceId ?? null, ...(unnamed ? { contactId: null } : {}) } as any,
      { $set: { invoiceId: billId, ...(unnamed ? { contactId: supplierId } : {}) } },
    ).exec()
    if (res.modifiedCount === 1) {
      claimed.push(m)
      continue
    }
    await releaseClaims(orgId, billId, claimed.map(c => c._id), claimed.filter(c => !c.contactId).map(c => c._id))
    throw new ReceiptBillError(409, 'receipt_already_billed', `${m.movementNumber} was billed by another document just now`, {
      movementId: idOf(m._id), movementNumber: m.movementNumber,
    })
  }
}

/** One audit entry per receipt that took (or gave back) a supplier. Nothing else records it. */
function auditSupplier(orgId: string, userId: string, billId: string, movements: any[], change: { oldValue: string | null; newValue: string | null }): void {
  for (const m of movements) {
    createAuditEntry({
      orgId, userId, action: 'update', module: 'warehouse', entityType: 'stock_movement',
      entityId: idOf(m._id), entityName: m.movementNumber, correlationId: billId,
      changes: [{ field: 'contactId', ...change }],
    })
  }
}

/**
 * Give the receipts a bill claims back. Only the claims it still holds: never another bill's.
 * A supplier this bill wrote goes with its claim: a receipt the wrong supplier was chosen for has
 * no other way back, because a completed receipt cannot be edited.
 */
export async function releaseReceiptLinks(orgId: string, bill: any, userId?: string): Promise<number> {
  const ids = linkedMovementIds(bill)
  if (!ids.length) return 0
  const billId = idOf(bill._id ?? bill.id)
  const givenTo: unknown[] = bill.stockSource?.supplierGivenTo || []
  const held: any[] = givenTo.length
    ? await StockMovement.find({ orgId, _id: { $in: givenTo }, invoiceId: billId } as any, { movementNumber: 1 }).lean().exec()
    : []
  const released = await releaseClaims(orgId, billId, ids, givenTo)
  if (released) {
    logger.info({ orgId, billId, released }, 'receipt-bill: receipts released by their bill')
    if (userId) auditSupplier(orgId, userId, billId, held, { oldValue: idOf(bill.contactId), newValue: null })
  }
  return released
}

// ── Making the bill ─────────────────────────────────────────────────────────────────────────

export interface BillFromReceiptsInput {
  movementIds: string[]
  /** The supplier, for receipts that name none. It must not contradict one that does. */
  contactId?: string
  /** The currency of the form this bill is made from: a bill in another than the org's is refused. */
  currency?: string
  /** The supplier's own invoice number, when the user already typed it. */
  reference?: string
  issueDate?: string
  dueDate?: string
  notes?: string
  paymentMethod?: string
}

interface Actor { id: string }

async function orgDefaults(orgId: string): Promise<{ currency: string; vat: number }> {
  const org: any = await Org.findById(orgId, { settings: 1, baseCurrency: 1 }).lean().exec()
  return {
    currency: org?.settings?.baseCurrency || org?.baseCurrency || 'EUR',
    vat: num(org?.settings?.taxConfig?.defaultVatRate),
  }
}

/**
 * A delivery's lines carry its costs in the org's currency, and nothing converts them. A bill in
 * another currency keeping those numbers would owe them in the wrong money, so it is not linked.
 */
function refuseForeignBill(currency: string | undefined, baseCurrency: string, number?: string): void {
  if (!currency || currency === baseCurrency) return
  throw new ReceiptBillError(422, 'bill_foreign_currency', `${number || 'A bill'} in ${currency} cannot take a delivery's costs, which are in ${baseCurrency}`, { currency, baseCurrency })
}

/** A purchase bill is due a month after it is issued, as the bill form proposes. */
function plusOneMonth(d: Date): Date {
  const out = new Date(d)
  out.setMonth(out.getMonth() + 1)
  return out
}

/**
 * A DRAFT bill for `movementIds`: the supplier, the receipts' lines, quantities, warehouses and
 * unit costs, linked to the receipts. The user adds the supplier's invoice number and receives it.
 */
export async function createBillFromReceipts(orgId: string, actor: Actor, input: BillFromReceiptsInput): Promise<any> {
  const movements = await loadBillableReceipts(orgId, input.movementIds, actor.id)
  const { supplierId, unnamed } = await settleSupplier(orgId, movements, input.contactId, true)
  const [defaults, products] = await Promise.all([
    orgDefaults(orgId),
    productsOf(orgId, movements.flatMap(m => (m.lines || []).map((l: any) => idOf(l.productId)))),
  ])
  refuseForeignBill(input.currency, defaults.currency)
  const lines = billLinesFrom(movements, products, defaults.vat)
  if (!lines.length) throw new ReceiptBillError(422, 'nothing_to_bill', 'The receipts carry no quantities to bill')
  const totals = billTotalsOf(lines)
  const issueDate = input.issueDate ? new Date(input.issueDate) : new Date(isoDay(new Date()))
  const numbers = movements.map(m => m.movementNumber).join(', ')

  let bill: any = null
  for (let attempt = 0; attempt < 3 && !bill; attempt++) {
    const invoiceNumber = (await getNextDraftInvoiceNumber(orgId, 'incoming', 'invoice'))
      || (await getNextInvoiceNumber(orgId, 'incoming', 'invoice'))
    try {
      bill = (await Invoice.create({
        orgId,
        invoiceNumber,
        type: 'invoice',
        direction: 'incoming',
        status: 'draft',
        statusHistory: [statusEntry('draft', undefined, actor.id, `from_receipt ${numbers}`)],
        numberHistory: [{ number: invoiceNumber, allocatedAt: new Date(), status: 'draft' }],
        contactId: supplierId,
        issueDate,
        dueDate: input.dueDate ? new Date(input.dueDate) : plusOneMonth(issueDate),
        currency: defaults.currency,
        exchangeRate: 1,
        ...(input.reference ? { reference: input.reference } : {}),
        ...(input.paymentMethod ? { paymentMethod: input.paymentMethod } : {}),
        notes: input.notes || '',
        lines,
        subtotal: totals.subtotal,
        discountTotal: 0,
        taxTotal: totals.taxTotal,
        total: totals.total,
        totalBase: totals.total,
        amountPaid: 0,
        amountDue: totals.total,
        billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
        stockSource: stockSourceFor(movements, unnamed),
        createdBy: actor.id,
      } as any)).toObject()
    } catch (e: any) {
      // The draft counter handed out a number some document already has: draw the next one.
      if (e?.code !== 11000 || !/invoiceNumber/.test(String(e?.message))) throw e
      logger.warn({ orgId, invoiceNumber, attempt }, 'receipt-bill: draft number already taken, retrying')
    }
  }
  if (!bill) throw new ReceiptBillError(409, 'number_unavailable', 'Could not allocate the bill number after 3 attempts')

  try {
    await claimReceipts(orgId, bill._id, movements, supplierId)
  } catch (e) {
    // Lost to a concurrent bill: this one never was.
    await Invoice.deleteOne({ _id: bill._id, orgId } as any).exec()
    throw e
  }

  const id = idOf(bill._id)
  createAuditEntry({
    orgId, userId: actor.id, action: 'create', module: 'invoicing', entityType: 'invoice', entityId: id,
    entityName: bill.invoiceNumber, changes: [{ field: 'receipts', oldValue: null, newValue: numbers }],
  })
  auditSupplier(orgId, actor.id, id, unnamed, { oldValue: null, newValue: supplierId })
  for (const m of movements) {
    createAuditEntry({
      orgId, userId: actor.id, action: 'billed', module: 'warehouse', entityType: 'stock_movement',
      entityId: idOf(m._id), entityName: m.movementNumber, correlationId: id,
      changes: [{ field: 'invoice', oldValue: null, newValue: bill.invoiceNumber }],
    })
  }
  logger.info({ orgId, bill: bill.invoiceNumber, receipts: numbers }, 'receipt-bill: bill made from goods receipts')
  return getRepos().invoices.findOne({ id, orgId } as any)
}

export interface LinkReceiptsOptions {
  /**
   * The user was told the bill's typed lines go. Without it a bill with lines stays refused, so a
   * client that does not know this stays as it was (FR-22.32a).
   */
  replaceLines?: boolean
  /** The supplier the user sees, when the bill may not have one saved. */
  contactId?: string
}

/**
 * FR-22.32 — „Свържи с доставка": put the receipts on a bill that already exists.
 *
 * A bill linked to receipts moves no stock at all, so a line typed before linking would silently
 * never be received. So the receipts' lines become the bill's, as on a bill made from the receipt:
 * on an empty draft outright, on a draft with lines only when asked to replace them. What the bill
 * says about itself stays: its number, reference, dates, payment method and notes.
 *
 * A bill written against a supplier order is the exception. Its lines carry the `orderRef` that
 * books the delivery onto the order, and replacing them would leave the order waiting for goods
 * that came. It stays refused, and the receipt-overlap question still offers „receive anyway".
 */
export async function linkReceiptsToBill(orgId: string, actor: Actor, billId: string, movementIds: string[], opts: LinkReceiptsOptions = {}): Promise<any> {
  if (!isId(billId)) throw new ReceiptBillError(404, 'not_found', 'Bill not found')
  const bill: any = await Invoice.findOne({ _id: billId, orgId } as any).lean().exec()
  if (!bill) throw new ReceiptBillError(404, 'not_found', 'Bill not found')
  if (bill.type !== 'invoice' || bill.direction !== 'incoming') {
    throw new ReceiptBillError(422, 'not_a_bill', 'Only a supplier bill can be linked to goods receipts')
  }
  if (bill.status !== 'draft') throw new ReceiptBillError(422, 'bill_not_draft', `${bill.invoiceNumber} is no longer a draft`)
  if (bill.stockSource?.marker) {
    throw new ReceiptBillError(409, 'bill_already_linked', `${bill.invoiceNumber} is already linked to ${bill.stockSource.docNumber}`)
  }
  const filled = filledLinesOf(bill)
  if (filled.length && !opts.replaceLines) {
    throw new ReceiptBillError(422, 'bill_not_empty', `${bill.invoiceNumber} already has lines — a bill linked to a delivery takes the delivery's lines`)
  }
  if (filled.length && (bill.orderId || filled.some((l: any) => Object.values(l.orderRef || {}).some(Boolean)))) {
    throw new ReceiptBillError(422, 'bill_on_order', `${bill.invoiceNumber} is written against a supplier order — its lines book the delivery onto that order`)
  }
  const defaults = await orgDefaults(orgId)
  refuseForeignBill(bill.currency, defaults.currency, bill.invoiceNumber)
  const movements = await loadBillableReceipts(orgId, movementIds, actor.id)
  if (opts.contactId && bill.contactId && idOf(opts.contactId) !== idOf(bill.contactId)) {
    throw new ReceiptBillError(422, 'supplier_mismatch', `${bill.invoiceNumber} names another supplier — save the bill first`)
  }
  const { supplierId, unnamed } = await settleSupplier(orgId, movements, idOf(bill.contactId) || opts.contactId, false)
  const products = await productsOf(orgId, movements.flatMap(m => (m.lines || []).map((l: any) => idOf(l.productId))))
  const lines = billLinesFrom(movements, products, defaults.vat)
  if (!lines.length) throw new ReceiptBillError(422, 'nothing_to_bill', 'The receipts carry no quantities to bill')
  const totals = billTotalsOf(lines)

  // Link first, guarded on the bill still being an unlinked draft, then claim. A lost claim
  // puts the bill back the way it was.
  const before: Record<string, any> = {
    lines: bill.lines || [],
    subtotal: num(bill.subtotal), discountTotal: num(bill.discountTotal), taxTotal: num(bill.taxTotal),
    total: num(bill.total), totalBase: num(bill.totalBase), amountDue: num(bill.amountDue),
  }
  const unsetOnUndo: Record<string, 1> = { stockSource: 1 }
  if (bill.contactId) before.contactId = bill.contactId
  else unsetOnUndo.contactId = 1
  const link = stockSourceFor(movements, unnamed)
  const linked = await Invoice.findOneAndUpdate(
    { _id: billId, orgId, status: 'draft', 'stockSource.marker': { $in: [null, ''] } } as any,
    {
      $set: {
        contactId: supplierId,
        lines,
        subtotal: totals.subtotal,
        discountTotal: 0,
        taxTotal: totals.taxTotal,
        total: totals.total,
        // In the org's currency, whatever a stale rate on the bill says.
        totalBase: totals.total,
        amountDue: round2(totals.total - num(bill.amountPaid)),
        stockSource: link,
      },
    },
    { new: true },
  ).lean().exec()
  if (!linked) throw new ReceiptBillError(409, 'bill_already_linked', `${bill.invoiceNumber} changed meanwhile — reload it`)
  try {
    await claimReceipts(orgId, bill._id, movements, supplierId)
  } catch (e) {
    // Only the draft this request linked: what was read before the link is older than anything another
    // request did since, and a bill received or linked meanwhile must not get those old lines back.
    await Invoice.updateOne({ _id: billId, orgId, status: 'draft', 'stockSource.marker': link.marker } as any, { $set: before, $unset: unsetOnUndo }).exec()
    throw e
  }

  const numbers = movements.map(m => m.movementNumber).join(', ')
  createAuditEntry({
    orgId, userId: actor.id, action: 'update', module: 'invoicing', entityType: 'invoice', entityId: billId,
    entityName: bill.invoiceNumber,
    changes: [
      { field: 'receipts', oldValue: null, newValue: numbers },
      // The bill no longer holds the supplier's figures, and this is the only record of them.
      ...(filled.length ? [
        { field: 'lines', oldValue: filled.map(auditedLine), newValue: lines.map(auditedLine) },
        { field: 'subtotal', oldValue: num(bill.subtotal), newValue: totals.subtotal },
        { field: 'taxTotal', oldValue: num(bill.taxTotal), newValue: totals.taxTotal },
        { field: 'total', oldValue: num(bill.total), newValue: totals.total },
      ] : []),
      ...(bill.contactId ? [] : [{ field: 'contactId', oldValue: null, newValue: supplierId }]),
    ],
  })
  auditSupplier(orgId, actor.id, billId, unnamed, { oldValue: null, newValue: supplierId })
  for (const m of movements) {
    createAuditEntry({
      orgId, userId: actor.id, action: 'billed', module: 'warehouse', entityType: 'stock_movement',
      entityId: idOf(m._id), entityName: m.movementNumber, correlationId: billId,
      changes: [{ field: 'invoice', oldValue: null, newValue: bill.invoiceNumber }],
    })
  }
  return getRepos().invoices.findOne({ id: billId, orgId } as any)
}

/** A bill line as the audit trail keeps it: the article, how many, at what price. */
function auditedLine(l: any) {
  return { productId: idOf(l.productId) || null, description: l.description, quantity: num(l.quantity), unitPrice: num(l.unitPrice) }
}

/** The lines of a bill that say something: the form keeps a blank one at the bottom. */
function filledLinesOf(bill: any): any[] {
  return (bill.lines || []).filter((l: any) => l.productId || String(l.description || '').trim())
}

// ── The receipts a supplier has not billed yet (FR-22.32's picker) ───────────────────────────

export interface BillableReceipt {
  id: string
  number: string
  date: Date
  warehouseId?: string
  lineCount: number
  total: number
  /** It names no supplier, and takes the bill's. */
  noSupplier?: boolean
  /** Its notes, when it names no supplier: all there is to tell whose goods they were. */
  notes?: string
}

/** What deciding on a receipt reads: `billingStateOf` and `asBillable`. */
const RECEIPT_FIELDS = { movementNumber: 1, date: 1, toWarehouseId: 1, lines: 1, totalAmount: 1, invoiceId: 1, type: 1, status: 1, contactId: 1, notes: 1, reversedBy: 1 }

function asBillable(m: any): BillableReceipt {
  return {
    id: idOf(m._id),
    number: m.movementNumber,
    date: m.date,
    warehouseId: m.toWarehouseId ? idOf(m.toWarehouseId) : undefined,
    lineCount: (m.lines || []).filter((l: any) => num(l.quantity) > 0).length,
    total: round2(num(m.totalAmount)),
    ...(m.contactId ? {} : { noSupplier: true, ...(m.notes ? { notes: m.notes } : {}) }),
  }
}

/**
 * The receipts a bill of this supplier can take: the supplier's own, then the ones that name no
 * supplier (which take the bill's). Each group newest first, up to `limit`.
 */
export async function billableReceiptsOf(orgId: string, contactId: string, limit = 50): Promise<BillableReceipt[]> {
  if (!isId(contactId)) return []
  const unbilled = async (supplier: string | null) => {
    const rows: any[] = await StockMovement.find({ orgId, contactId: supplier, type: 'receipt', status: 'completed' } as any, RECEIPT_FIELDS)
      .sort({ date: -1, _id: -1 }).limit(limit * 3).lean().exec()
    const states = await billingByMovement(orgId, rows)
    return rows.filter(m => states.get(idOf(m._id))?.billable).slice(0, limit).map(asBillable)
  }
  return [...await unbilled(contactId), ...await unbilled(null)]
}

// ── Before a bill books its own goods (FR-22.31c) ────────────────────────────────────────────

export interface ReceiptOverlap {
  /** The bill's lines a link would replace. */
  typedLines: number
  receipts: BillableReceipt[]
}

/**
 * The unclaimed receipts a bill may be for, when receiving it would book its goods a second time.
 *
 * Only a draft supplier bill that will book stock: one linked to anything moves none, and a line
 * books only with a product that holds stock, a warehouse and a quantity. A receipt counts when it
 * put goods in stock (it names a warehouse), lies within `RECEIPT_OVERLAP_WINDOW_DAYS` of the
 * bill's issue date, nobody has claimed it (`billingStateOf`: a live bill's receipt, a voided
 * document's own and a reversal are out) and it shares a line with the bill:
 *
 *   - naming the bill's supplier, any stock-held article in common;
 *   - naming no supplier, an article in common at the same quantity on one line. Articles alone
 *     are no evidence there: a store whose receipts carry no supplier stocks the same articles
 *     every week, and would be asked about nearly every bill;
 *   - naming another supplier, never.
 */
export async function receiptsOverlapping(orgId: string, bill: any): Promise<ReceiptOverlap | null> {
  if (bill.type !== 'invoice' || bill.direction !== 'incoming' || bill.status !== 'draft' || bill.stockSource?.marker) return null
  const booking = (bill.lines || []).filter((l: any) => l.productId && l.warehouseId && num(l.quantity) > 0)
  if (!booking.length) return null
  const products = await productsOf(orgId, booking.map((l: any) => idOf(l.productId)))
  const quantities = new Map<string, number[]>()
  for (const l of booking) {
    const id = idOf(l.productId)
    const p = products.get(id)
    if (p && p.trackInventory !== false) quantities.set(id, [...(quantities.get(id) || []), num(l.quantity)])
  }
  if (!quantities.size) return null

  const at = new Date(bill.issueDate ?? Date.now()).getTime()
  const span = RECEIPT_OVERLAP_WINDOW_DAYS * DAY_MS
  const supplier = idOf(bill.contactId)
  const rows: any[] = await StockMovement.find(
    {
      orgId, type: 'receipt', status: 'completed',
      date: { $gte: new Date(at - span), $lte: new Date(at + span) },
      toWarehouseId: { $ne: null },
      'lines.productId': { $in: [...quantities.keys()] },
      contactId: supplier ? { $in: [supplier, null] } : null,
    } as any,
    RECEIPT_FIELDS,
  ).sort({ date: -1, _id: -1 }).limit(OVERLAP_SCAN_LIMIT).lean().exec()

  const shares = (m: any) => (m.lines || []).some((l: any) => {
    const billed = quantities.get(idOf(l.productId))
    const q = num(l.quantity)
    if (!billed || !(q > 0)) return false
    return !!m.contactId || billed.some(b => Math.abs(b - q) <= EPS)
  })
  const states = await billingByMovement(orgId, rows)
  const receipts = rows
    .filter(m => states.get(idOf(m._id))?.billable && shares(m))
    .sort((a, b) => Number(!a.contactId) - Number(!b.contactId))
    .slice(0, OVERLAP_REPORT_LIMIT)
    .map(asBillable)
  return receipts.length ? { typedLines: filledLinesOf(bill).length, receipts } : null
}

// ── What a linked bill may become ───────────────────────────────────────────────────────────

/** Received quantity per stock-tracked product over a bill's receipts. */
async function receivedByProduct(orgId: string, movementIds: string[]): Promise<{ qty: Map<string, number>; cost: Map<string, number[]>; numbers: string[] }> {
  const rows: any[] = await StockMovement.find(
    { orgId, _id: { $in: movementIds } } as any,
    { movementNumber: 1, lines: 1 },
  ).lean().exec()
  const qty = new Map<string, number>()
  const cost = new Map<string, number[]>()
  for (const m of rows) {
    for (const l of m.lines || []) {
      const id = idOf(l.productId)
      qty.set(id, (qty.get(id) || 0) + num(l.quantity))
      if (num(l.quantity) > 0) cost.set(id, [...(cost.get(id) || []), num(l.unitCost)])
    }
  }
  return { qty, cost, numbers: rows.map(r => r.movementNumber) }
}

/**
 * Check a `PUT` to a bill made from receipts (D-2: a receipt is billed once and whole).
 *
 * The bill moves no stock, so every stock-tracked quantity on it must be one its receipts
 * received: a line added for an article the receipts do not carry, or more of one than they
 * received, would be paid for and never be put in stock; less of one would leave received goods
 * that no bill can ever pay for (the receipt is claimed whole). Prices, units, tax rates, the
 * text and lines that hold no stock (a service, a fee, free text) stay free — the bill keeps the
 * supplier's prices as typed. Nor may the bill change supplier: the goods came from that one.
 */
export async function checkLinkedBillEdit(orgId: string, existing: any, body: { contactId?: string; lines?: any[] }): Promise<void> {
  if (!isReceiptLinked(existing)) return
  if (body.contactId !== undefined && body.contactId && idOf(body.contactId) !== idOf(existing.contactId)) {
    throw new ReceiptBillError(422, 'supplier_mismatch', `${existing.invoiceNumber} pays for goods received from its supplier on ${existing.stockSource.docNumber} — it cannot change supplier`)
  }
  if (!Array.isArray(body.lines)) return
  const { qty: received, numbers } = await receivedByProduct(orgId, linkedMovementIds(existing))
  const billedIds = body.lines.map(l => idOf(l.productId)).filter(Boolean)
  const products = await productsOf(orgId, [...billedIds, ...received.keys()])
  const tracked = (id: string) => products.get(id)?.trackInventory !== false
  const billed = new Map<string, number>()
  for (const l of body.lines) {
    const id = idOf(l.productId)
    if (!id || !tracked(id)) continue
    billed.set(id, (billed.get(id) || 0) + num(l.quantity))
  }
  const mismatches: Array<{ productId: string; name: string; received: number; billed: number }> = []
  for (const id of new Set([...billed.keys(), ...[...received.keys()].filter(tracked)])) {
    const r = received.get(id) || 0
    const b = billed.get(id) || 0
    if (Math.abs(r - b) > EPS) mismatches.push({ productId: id, name: products.get(id)?.name || id, received: r, billed: b })
  }
  if (!mismatches.length) return
  const first = mismatches[0]
  throw new ReceiptBillError(422, 'receipt_quantity_mismatch',
    `${existing.invoiceNumber} pays for ${numbers.join(', ')} whole: „${first.name}" was received ${first.received} and is billed ${first.billed}`
    + (mismatches.length > 1 ? ` (+${mismatches.length - 1} more)` : '')
    + '. A bill made from a delivery bills what was received; a difference with the supplier is settled by their credit or debit note.',
    { lines: mismatches })
}

// ── Receiving it ────────────────────────────────────────────────────────────────────────────

/**
 * D-2: receiving a bill made from receipts moves each article's `purchasePrice` to the billed
 * price, for the receipts still to come. Nothing already received is re-costed.
 *
 * Only where the purchase price is still one the receipts were booked at (compare-and-set): a
 * price someone set since — a later receipt with product update, an edit in Products — is newer
 * than this bill and stays. An article billed at two different prices on one bill is left alone
 * too: there is no one price to carry forward.
 */
export async function applyLinkedBillPrices(orgId: string, bill: any, userId: string): Promise<string[]> {
  if (!isReceiptLinked(bill)) return []
  // A linked bill's currency can still be edited, and a product's prices are in the org's.
  if (bill.currency && bill.currency !== (await orgDefaults(orgId)).currency) return []
  const { cost } = await receivedByProduct(orgId, linkedMovementIds(bill))
  const billedPrice = new Map<string, number | null>()
  for (const l of bill.lines || []) {
    const id = idOf(l.productId)
    if (!id) continue
    const p = round4(num(l.unitPrice))
    const seen = billedPrice.get(id)
    billedPrice.set(id, seen === undefined || seen === p ? p : null)
  }
  const updated: string[] = []
  for (const [id, price] of billedPrice) {
    const receivedAt = [...new Set((cost.get(id) || []).map(round4))]
    if (price === null || !(price > 0) || !receivedAt.length) continue
    if (receivedAt.length === 1 && receivedAt[0] === price) continue
    const res = await Product.updateOne(
      { orgId, _id: id, purchasePrice: { $in: receivedAt.filter(c => c !== price) } } as any,
      { $set: { purchasePrice: price } },
    ).exec()
    if (res.modifiedCount === 1) {
      updated.push(id)
      createAuditEntry({
        orgId, userId, action: 'update', module: 'warehouse', entityType: 'product', entityId: id,
        correlationId: idOf(bill._id ?? bill.id),
        changes: [{ field: 'purchasePrice', oldValue: receivedAt.join(' / '), newValue: price }],
      })
    }
  }
  if (updated.length) logger.info({ orgId, bill: bill.invoiceNumber, products: updated.length }, 'receipt-bill: purchase prices moved to the billed prices')
  return updated
}

function round4(v: number): number {
  return +num(v).toFixed(4)
}

// ── Reading the link ────────────────────────────────────────────────────────────────────────

export interface LinkedReceipt {
  id: string
  number: string
  date: Date
  status: string
  /** This bill still holds it (a voided bill has given it back). */
  held: boolean
  lines: Array<{ productId: string; quantity: number; unitCost: number }>
}

/** The receipts a bill was made from, for its form: links, and the costs its prices compare to. */
export async function linkedReceiptsOf(orgId: string, bill: any): Promise<LinkedReceipt[]> {
  const ids = linkedMovementIds(bill)
  if (!ids.length) return []
  const rows: any[] = await StockMovement.find(
    { orgId, _id: { $in: ids } } as any,
    { movementNumber: 1, date: 1, status: 1, lines: 1, invoiceId: 1 },
  ).lean().exec()
  const billId = idOf(bill._id ?? bill.id)
  const byId = new Map(rows.map(r => [idOf(r._id), r]))
  return ids.filter(id => byId.has(id)).map(id => {
    const m = byId.get(id)
    return {
      id,
      number: m.movementNumber,
      date: m.date,
      status: m.status,
      held: idOf(m.invoiceId) === billId,
      lines: (m.lines || []).map((l: any) => ({ productId: idOf(l.productId), quantity: num(l.quantity), unitCost: num(l.unitCost) })),
    }
  })
}

export interface ReceiptBillingForPage {
  billable: boolean
  /** It may be billed, and the page asks for the supplier first. */
  needsSupplier?: boolean
  /** Why it may not, when nothing else on the page says so: a held receipt names its bill. */
  notBillable?: { code: NonNullable<ReceiptBillingState['reason']>; number?: string }
  bill?: ReceiptBillingState['invoice']
  /** A release finished just now: the receipt as it now stands, in place of what the page read. */
  contactId?: unknown
  invoiceId?: unknown
}

/** For the movement page: the document that holds the receipt, and whether it may be billed. */
export async function receiptBillingFor(orgId: string, movement: any, userId?: string): Promise<ReceiptBillingForPage> {
  const { current, state } = await settledBillingState(orgId, movement, userId)
  const held = !!state.invoice && !RELEASED.includes(state.invoice.status)
  return {
    ...(current === movement ? {} : { contactId: current.contactId ?? null, invoiceId: current.invoiceId ?? null }),
    billable: state.billable,
    ...(state.needsSupplier ? { needsSupplier: true } : {}),
    ...(state.reason && !held ? { notBillable: { code: state.reason, ...(state.invoice ? { number: state.invoice.number } : {}) } } : {}),
    ...(held ? { bill: state.invoice } : {}),
  }
}
