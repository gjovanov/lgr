import { mongoose } from 'db/connection'
import { Invoice, Org, Product, StockMovement } from 'db/models'
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
  /** Why not, when it may not be. */
  reason?: 'not_a_receipt' | 'receipt_not_completed' | 'receipt_without_supplier' | 'receipt_already_billed' | 'receipt_not_billable'
  /** The live document that holds it (its bill, or the bill whose own receipt it is). */
  invoice?: { id: string; number: string; status: string; type: string; direction: string }
}

/**
 * Whether a movement can be billed, and if not, who holds it.
 *
 * `invoices` maps the ids its `invoiceId` may point at to those invoices (lean). A movement whose
 * `invoiceId` names:
 *   - no document at all — a claim left by a crash between delete and release — is free;
 *   - a live document — billed (a receipt linked to a bill, or the bill's own receipt);
 *   - a voided document that LISTS it (a claim the void did not release) — free;
 *   - a voided document that does not list it — that document booked it and its void reversed
 *     it, so it is no receipt of its own any more.
 */
export function billingStateOf(movement: any, invoices: Map<string, any>): ReceiptBillingState {
  if (movement.type !== 'receipt') return { billable: false, reason: 'not_a_receipt' }
  if (movement.status !== 'completed') return { billable: false, reason: 'receipt_not_completed' }
  if (!movement.contactId) return { billable: false, reason: 'receipt_without_supplier' }
  const invId = idOf(movement.invoiceId)
  if (!invId) return { billable: true }
  const inv = invoices.get(invId)
  if (!inv) return { billable: true }
  const ref = { id: invId, number: inv.invoiceNumber, status: inv.status, type: inv.type, direction: inv.direction }
  if (!RELEASED.includes(inv.status)) return { billable: false, reason: 'receipt_already_billed', invoice: ref }
  if (linkedMovementIds(inv).includes(idOf(movement._id))) return { billable: true }
  return { billable: false, reason: 'receipt_not_billable', invoice: ref }
}

/** The invoices a set of movements point at, by id. */
async function invoicesOf(orgId: string, movements: any[]): Promise<Map<string, any>> {
  const ids = [...new Set(movements.map(m => idOf(m.invoiceId)).filter(Boolean))]
  if (!ids.length) return new Map()
  const rows: any[] = await Invoice.find(
    { orgId, _id: { $in: ids } } as any,
    { invoiceNumber: 1, status: 1, type: 1, direction: 1, stockSource: 1 },
  ).lean().exec()
  return new Map(rows.map(r => [idOf(r._id), r]))
}

/** The billing state of one movement (the receipt page's „Входяща фактура" and its bill link). */
export async function receiptBillingState(orgId: string, movement: any): Promise<ReceiptBillingState> {
  return billingStateOf(movement, await invoicesOf(orgId, [movement]))
}

/** Per movement id: the live invoice that holds it (the receipts list's „Фактурирана" marker). */
export async function billingByMovement(orgId: string, movements: any[]): Promise<Map<string, ReceiptBillingState>> {
  const invoices = await invoicesOf(orgId, movements)
  return new Map(movements.map(m => [idOf(m._id ?? m.id), billingStateOf(m, invoices)]))
}

const REFUSAL: Record<string, { status: number; message: (m: any, s: ReceiptBillingState) => string }> = {
  not_a_receipt: { status: 422, message: m => `${m.movementNumber} is not a goods receipt` },
  receipt_not_completed: { status: 422, message: m => `${m.movementNumber} is not booked yet — confirm it first` },
  receipt_without_supplier: { status: 422, message: m => `${m.movementNumber} names no supplier` },
  receipt_already_billed: { status: 409, message: (m, s) => `${m.movementNumber} is already billed by ${s.invoice?.number}` },
  receipt_not_billable: { status: 409, message: (m, s) => `${m.movementNumber} was booked by ${s.invoice?.number}, which is voided — it is no receipt of its own` },
}

/** Load `movementIds` and refuse unless every one may be billed, by one bill, from one supplier. */
async function loadBillableReceipts(orgId: string, movementIds: string[]): Promise<any[]> {
  const ids = [...new Set((movementIds || []).map(String).filter(Boolean))]
  if (!ids.length) throw new ReceiptBillError(422, 'no_receipts', 'Choose at least one goods receipt')
  if (!ids.every(isId)) throw new ReceiptBillError(404, 'receipt_not_found', 'Goods receipt not found')
  const rows: any[] = await StockMovement.find({ orgId, _id: { $in: ids } } as any).lean().exec()
  if (rows.length !== ids.length) throw new ReceiptBillError(404, 'receipt_not_found', 'Goods receipt not found')
  // The order the user named them in is the order their lines take on the bill.
  const byId = new Map(rows.map(r => [idOf(r._id), r]))
  const movements = ids.map(id => byId.get(id))
  const invoices = await invoicesOf(orgId, movements)
  for (const m of movements) {
    const state = billingStateOf(m, invoices)
    if (state.billable) continue
    const refusal = REFUSAL[state.reason!]
    throw new ReceiptBillError(refusal.status, state.reason!, refusal.message(m, state), {
      movementId: idOf(m._id), movementNumber: m.movementNumber,
      ...(state.invoice ? { invoiceId: state.invoice.id, invoiceNumber: state.invoice.number } : {}),
    })
  }
  const suppliers = new Set(movements.map(m => idOf(m.contactId)))
  if (suppliers.size > 1) {
    throw new ReceiptBillError(422, 'mixed_suppliers', 'One bill covers the receipts of one supplier — these name different suppliers')
  }
  return movements
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

function stockSourceFor(movements: any[]): Record<string, any> {
  return {
    marker: `${MOVEMENT_MARKER}${movements.map(m => idOf(m._id)).join(',')}`,
    docNumber: movements.map(m => m.movementNumber).join(', '),
    movementIds: movements.map(m => m._id),
    detectedBy: 'manual',
    linkedAt: new Date(),
  }
}

function statusEntry(status: string, fromStatus: string | undefined, userId: string, reason: string) {
  return { status, ...(fromStatus ? { fromStatus } : {}), changedAt: new Date(), changedBy: userId, reason }
}

/**
 * Claim the receipts for `billId`: one compare-and-set per receipt on the `invoiceId` it was read
 * with, in `_id` order (so two requests for overlapping sets meet on the same first receipt, and
 * one of them takes none). Returns the ids it claimed; on a lost race it gives them back and
 * throws 409.
 */
async function claimReceipts(orgId: string, billId: unknown, movements: any[]): Promise<void> {
  const claimed: unknown[] = []
  const sorted = [...movements].sort((a, b) => idOf(a._id).localeCompare(idOf(b._id)))
  for (const m of sorted) {
    const res = await StockMovement.updateOne(
      { _id: m._id, orgId, type: 'receipt', status: 'completed', invoiceId: m.invoiceId ?? null } as any,
      { $set: { invoiceId: billId } },
    ).exec()
    if (res.modifiedCount === 1) {
      claimed.push(m._id)
      continue
    }
    if (claimed.length) {
      await StockMovement.updateMany({ orgId, _id: { $in: claimed }, invoiceId: billId } as any, { $unset: { invoiceId: 1 } }).exec()
    }
    throw new ReceiptBillError(409, 'receipt_already_billed', `${m.movementNumber} was billed by another document just now`, {
      movementId: idOf(m._id), movementNumber: m.movementNumber,
    })
  }
}

/** Give the receipts a bill claims back. Only the claims it still holds: never another bill's. */
export async function releaseReceiptLinks(orgId: string, bill: any): Promise<number> {
  const ids = linkedMovementIds(bill)
  if (!ids.length) return 0
  const res = await StockMovement.updateMany(
    { orgId, _id: { $in: ids }, invoiceId: idOf(bill._id ?? bill.id) } as any,
    { $unset: { invoiceId: 1 } },
  ).exec()
  if (res.modifiedCount) {
    logger.info({ orgId, billId: idOf(bill._id ?? bill.id), released: res.modifiedCount }, 'receipt-bill: receipts released by their bill')
  }
  return res.modifiedCount
}

// ── Making the bill ─────────────────────────────────────────────────────────────────────────

export interface BillFromReceiptsInput {
  movementIds: string[]
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
  const movements = await loadBillableReceipts(orgId, input.movementIds)
  const [defaults, products] = await Promise.all([
    orgDefaults(orgId),
    productsOf(orgId, movements.flatMap(m => (m.lines || []).map((l: any) => idOf(l.productId)))),
  ])
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
        contactId: movements[0].contactId,
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
        stockSource: stockSourceFor(movements),
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
    await claimReceipts(orgId, bill._id, movements)
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

/**
 * FR-22.32 — „Свържи с доставка": put the receipts on a bill that already exists.
 *
 * Only an EMPTY draft bill: a bill linked to receipts moves no stock at all, so a line the user
 * had typed before linking would silently never be received. The receipts' lines become the
 * bill's lines, as on a bill made from the receipt.
 */
export async function linkReceiptsToBill(orgId: string, actor: Actor, billId: string, movementIds: string[]): Promise<any> {
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
  const filled = (bill.lines || []).filter((l: any) => l.productId || String(l.description || '').trim())
  if (filled.length) {
    throw new ReceiptBillError(422, 'bill_not_empty', `${bill.invoiceNumber} already has lines — a bill linked to a delivery takes the delivery's lines`)
  }
  const movements = await loadBillableReceipts(orgId, movementIds)
  if (bill.contactId && idOf(bill.contactId) !== idOf(movements[0].contactId)) {
    throw new ReceiptBillError(422, 'supplier_mismatch', 'The receipts are from another supplier than the bill')
  }
  const [defaults, products] = await Promise.all([
    orgDefaults(orgId),
    productsOf(orgId, movements.flatMap(m => (m.lines || []).map((l: any) => idOf(l.productId)))),
  ])
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
  const linked = await Invoice.findOneAndUpdate(
    { _id: billId, orgId, status: 'draft', 'stockSource.marker': { $in: [null, ''] } } as any,
    {
      $set: {
        contactId: movements[0].contactId,
        lines,
        subtotal: totals.subtotal,
        discountTotal: 0,
        taxTotal: totals.taxTotal,
        total: totals.total,
        totalBase: round2(totals.total * (num(bill.exchangeRate) || 1)),
        amountDue: round2(totals.total - num(bill.amountPaid)),
        stockSource: stockSourceFor(movements),
      },
    },
    { new: true },
  ).lean().exec()
  if (!linked) throw new ReceiptBillError(409, 'bill_already_linked', `${bill.invoiceNumber} changed meanwhile — reload it`)
  try {
    await claimReceipts(orgId, bill._id, movements)
  } catch (e) {
    await Invoice.updateOne({ _id: billId, orgId } as any, { $set: before, $unset: unsetOnUndo }).exec()
    throw e
  }

  const numbers = movements.map(m => m.movementNumber).join(', ')
  createAuditEntry({
    orgId, userId: actor.id, action: 'update', module: 'invoicing', entityType: 'invoice', entityId: billId,
    entityName: bill.invoiceNumber, changes: [{ field: 'receipts', oldValue: null, newValue: numbers }],
  })
  for (const m of movements) {
    createAuditEntry({
      orgId, userId: actor.id, action: 'billed', module: 'warehouse', entityType: 'stock_movement',
      entityId: idOf(m._id), entityName: m.movementNumber, correlationId: billId,
      changes: [{ field: 'invoice', oldValue: null, newValue: bill.invoiceNumber }],
    })
  }
  return getRepos().invoices.findOne({ id: billId, orgId } as any)
}

// ── The receipts a supplier has not billed yet (FR-22.32's picker) ───────────────────────────

export interface BillableReceipt {
  id: string
  number: string
  date: Date
  warehouseId?: string
  lineCount: number
  total: number
}

export async function billableReceiptsOf(orgId: string, contactId: string, limit = 50): Promise<BillableReceipt[]> {
  if (!isId(contactId)) return []
  const rows: any[] = await StockMovement.find(
    { orgId, contactId, type: 'receipt', status: 'completed' } as any,
    { movementNumber: 1, date: 1, toWarehouseId: 1, lines: 1, totalAmount: 1, invoiceId: 1, type: 1, status: 1, contactId: 1 },
  ).sort({ date: -1, _id: -1 }).limit(limit * 3).lean().exec()
  const states = await billingByMovement(orgId, rows)
  return rows
    .filter(m => states.get(idOf(m._id))?.billable)
    .slice(0, limit)
    .map(m => ({
      id: idOf(m._id),
      number: m.movementNumber,
      date: m.date,
      warehouseId: m.toWarehouseId ? idOf(m.toWarehouseId) : undefined,
      lineCount: (m.lines || []).filter((l: any) => num(l.quantity) > 0).length,
      total: round2(num(m.totalAmount)),
    }))
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

/** For the movement page: the document that holds the receipt, and whether it may be billed. */
export async function receiptBillingFor(orgId: string, movement: any): Promise<{ billable: boolean; bill?: ReceiptBillingState['invoice'] }> {
  const state = await receiptBillingState(orgId, movement)
  return { billable: state.billable, ...(state.invoice && !RELEASED.includes(state.invoice.status) ? { bill: state.invoice } : {}) }
}
