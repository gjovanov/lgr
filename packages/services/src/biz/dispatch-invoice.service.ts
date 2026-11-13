import { upsertAmountInWords, amountInWordsLocale } from 'config/amount-in-words'
import { isRemovalReversalNote, noteSaysNoDelivery } from 'config/movement-notes'
import { mongoose } from 'db/connection'
import { Contact, Invoice, StockMovement } from 'db/models'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'
import { createAuditEntry } from './audit-log.service.js'
import { invoiceTotalsOf, withLineAmounts } from './document-amounts.js'
import { getNextDraftInvoiceNumber, getNextInvoiceNumber } from './invoice-numbering.service.js'
import { unclaimedDraft } from './invoice-payment.js'
import { resolvePrice } from './pricing.service.js'
import { RECEIPT_OVERLAP_WINDOW_DAYS, invoicesOf, orgDefaults, productsOf, releaseClaims, type ProductInfo } from './receipt-bill.service.js'

/**
 * The customer's invoice for goods a stock note already delivered (FR-22.61 / #725): the sales twin of
 * `receipt-bill.service.ts` (FR-22.31).
 *
 * Goods often leave before their invoice: staff book a dispatch that names the customer (a stock note) and hand the
 * goods over. Later the invoice is entered. An invoice dispatches its own goods when it is issued
 * (`createInvoiceStockMovement`), so an invoice typed in for goods a note already delivered took them out of stock a
 * second time, and nothing said so until someone counted.
 *
 * So the invoice is made FROM the note, and remembers it:
 *
 *   - `stockSource { marker: 'dispatch:<id>[,<id>…]', docNumber, movementIds, detectedBy: 'manual' }` on the
 *     invoice. Present ⇒ the invoice moves no stock, on any path (`movesNoStock` in `invoicing.service.ts`: issue,
 *     void, Files rollback).
 *   - `invoiceId` on each note: the CLAIM. A note is invoiced once and whole: the claim is a compare-and-set on that
 *     field, so two invoices cannot take the same note, and the ledgers then name the invoice beside the note.
 *
 * One invoice may cover several notes, all of ONE customer. Voiding or deleting the invoice releases the claims (the
 * note can be invoiced again) and moves nothing either way.
 *
 * Where it differs from the purchase side, and why:
 *
 *   - **Prices.** A receipt carries what the goods cost, which is what its bill starts from. A stock note carries
 *     costs too, and an invoice charges a price: each line takes the price the engine resolves for this customer
 *     (`resolvePrice`, the one the invoice form proposes), with its trail. A cost never reaches an invoice.
 *   - **A typed invoice keeps its lines when it is linked**, where they already say what the notes delivered: the
 *     same quantity of every stock-held article. Its prices and discounts are the person's own work, and a note has
 *     none to replace them with. Only where they differ do the notes' lines take their place, and only when asked
 *     (`replaceLines`); lines that hold no stock (a service, a fee, free text) stay either way.
 *   - **The marker is its own** (`dispatch:`), so nothing written for a bill made from receipts
 *     (`isReceiptLinked`: its costs sent to the form, its purchase prices carried forward) ever runs on an invoice.
 *
 * A note that names no customer is invoiced too (FR-22.61a), as a receipt that names no supplier is billed: the
 * invoice's customer is written onto it in the claim's own compare-and-set, the invoice remembers which notes it
 * named (`stockSource.customerGivenTo`), and releasing the claim takes the customer off again.
 *
 * An invoice typed by hand for goods a note already delivered is what this module exists to prevent, so issuing an
 * unlinked invoice is refused while such a note stands unclaimed (FR-22.61b, `dispatchesOverlapping`). The refusal is
 * a question: linking answers it, and so does `acknowledgeOverlap`.
 *
 * ⚠ A plain `POST`/`PUT /invoices` can never set `stockSource`: the routes strip it. This module is the only writer
 * of a `dispatch:` link.
 */

export class DispatchInvoiceError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'DispatchInvoiceError'
  }
}

/** The marker prefix of an invoice made from stock notes. */
export const DISPATCH_MARKER = 'dispatch:'
/** Invoice statuses that no longer hold a claim on their notes. */
const RELEASED = ['voided', 'cancelled']
/** Quantities are compared at this precision: the form's number fields carry floats. */
const EPS = 1e-6
/**
 * How far from an invoice's issue date, either way, a stock note can still be the delivery that invoice is for: the
 * receipts' own window (FR-22.31c). Goods usually leave first; an invoice paid in advance comes first.
 */
export const DISPATCH_OVERLAP_WINDOW_DAYS = RECEIPT_OVERLAP_WINDOW_DAYS
const DAY_MS = 24 * 60 * 60 * 1000
/** Notes read per invoice, newest first, before they are judged. */
const OVERLAP_SCAN_LIMIT = 200
/** Notes one refusal names: a person reads them. */
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
/** A well-formed id: anything else would throw a CastError (a 500) instead of a 404. */
function isId(v: unknown): boolean {
  return typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v) && mongoose.Types.ObjectId.isValid(v)
}

/** Is `invoice` one made from stock notes? */
export function isDispatchLinked(invoice: any): boolean {
  const src = invoice?.stockSource
  return !!src?.marker && String(src.marker).startsWith(DISPATCH_MARKER)
}

/** The notes a note-linked invoice names, as ids. */
export function linkedDispatchIds(invoice: any): string[] {
  return isDispatchLinked(invoice) ? (invoice.stockSource.movementIds || []).map(idOf) : []
}

// ── Who holds a note ────────────────────────────────────────────────────────────────────────

export interface DispatchInvoicingState {
  /** The note may be invoiced now. */
  invoiceable: boolean
  /** It may, once someone says whose goods they were: the note names no customer. */
  needsCustomer?: boolean
  /** Why not, when it may not be. */
  reason?: 'not_a_dispatch' | 'dispatch_not_completed' | 'dispatch_rolled_back' | 'dispatch_is_reversal' | 'dispatch_not_a_delivery' | 'dispatch_already_invoiced' | 'dispatch_not_invoiceable'
  /** The live document that holds it (its invoice, or the sale whose own dispatch it is). */
  invoice?: { id: string; number: string; status: string; type: string; direction: string }
}

/**
 * Whether a movement can be invoiced, and if not, who holds it: `billingStateOf`, read from the other side.
 *
 * A `dispatch` is not always a delivery to a customer, and linking a real invoice to one means the invoice moves no
 * stock, so the real delivery is never booked. So none of these can be invoiced or overlap an invoice: a record of
 * goods another movement moved (`recordOnly`, FR-21.4), a note rolled back with its document, the mirror of a removed
 * document, and a dispatch naming no customer whose notes mark a correction or a reconcile delta
 * (`config/movement-notes`). A dispatch that names a customer was given one by someone, and is invoiceable whatever
 * its notes say.
 *
 * `invoices` maps the ids its `invoiceId` may point at to those invoices (lean). A movement whose `invoiceId` names:
 *   - no document at all (a claim left by a crash between delete and release) is free, provided it names a
 *     customer: a claim always has one, so a movement without one was never claimed;
 *   - a live document: invoiced (a note linked to an invoice, or the dispatch a sale booked for itself);
 *   - a voided document that LISTS it (a claim the void did not release): free;
 *   - a voided document that does not list it: that document booked it and its void reversed it, so it is no note
 *     of its own;
 *   - a purchase document, whatever its status: the dispatch is the mirror of a bill's receipt (a voided bill puts
 *     its goods back out). It is a reversal, and the bill is not named: a session that makes sales invoices need
 *     not read the purchases (FR-27.6).
 */
export function invoicingStateOf(movement: any, invoices: Map<string, any>): DispatchInvoicingState {
  if (movement.type !== 'dispatch') return { invoiceable: false, reason: 'not_a_dispatch' }
  if (movement.status !== 'completed') return { invoiceable: false, reason: 'dispatch_not_completed' }
  // Rolled back with its document: it stays completed, and the goods are back.
  if (movement.reversedBy) return { invoiceable: false, reason: 'dispatch_rolled_back' }
  if (isRemovalReversalNote(movement.notes)) return { invoiceable: false, reason: 'dispatch_is_reversal' }
  if (movement.recordOnly) return { invoiceable: false, reason: 'dispatch_not_a_delivery' }
  if (!movement.contactId && noteSaysNoDelivery(movement.notes)) return { invoiceable: false, reason: 'dispatch_not_a_delivery' }
  const free: DispatchInvoicingState = movement.contactId ? { invoiceable: true } : { invoiceable: true, needsCustomer: true }
  const invId = idOf(movement.invoiceId)
  if (!invId) return free
  const inv = invoices.get(invId)
  if (!inv) return movement.contactId ? free : { invoiceable: false, reason: 'dispatch_not_invoiceable' }
  if (inv.direction === 'incoming') return { invoiceable: false, reason: 'dispatch_is_reversal' }
  const ref = { id: invId, number: inv.invoiceNumber, status: inv.status, type: inv.type, direction: inv.direction }
  if (!RELEASED.includes(inv.status)) return { invoiceable: false, reason: 'dispatch_already_invoiced', invoice: ref }
  if (linkedDispatchIds(inv).includes(idOf(movement._id))) return free
  return { invoiceable: false, reason: 'dispatch_not_invoiceable', invoice: ref }
}

/**
 * A void writes the invoice first and gives its notes back after, so a crash between the two leaves a voided invoice
 * still listing a note it still holds. The next touch of such a note finishes the release, as the receipts' side
 * does. True when one was finished.
 */
async function finishReleases(orgId: string, movements: any[], invoices: Map<string, any>, userId?: string): Promise<boolean> {
  const unfinished = new Map<string, any>()
  for (const m of movements) {
    const holder = invoices.get(idOf(m.invoiceId))
    if (holder && RELEASED.includes(holder.status) && linkedDispatchIds(holder).includes(idOf(m._id))) unfinished.set(idOf(holder._id), holder)
  }
  for (const holder of unfinished.values()) await releaseDispatchLinks(orgId, holder, userId)
  return unfinished.size > 0
}

/**
 * The movement as it stands, and its state, once a release left unfinished is done. For a page that only reads, so a
 * write it cannot make (another node is the org's home) leaves it reading as it was.
 */
async function settledState(orgId: string, movement: any, userId?: string): Promise<{ current: any; state: DispatchInvoicingState }> {
  const invoices = await invoicesOf(orgId, [movement])
  let finished = false
  try {
    finished = await finishReleases(orgId, [movement], invoices, userId)
  } catch (e: any) {
    logger.warn({ orgId, movement: idOf(movement._id), err: e?.message }, 'dispatch-invoice: an unfinished release could not be finished here')
  }
  if (!finished) return { current: movement, state: invoicingStateOf(movement, invoices) }
  const current: any = (await StockMovement.findOne({ orgId, _id: movement._id } as any).lean().exec()) ?? movement
  return { current, state: invoicingStateOf(current, await invoicesOf(orgId, [current])) }
}

/** Per movement id: its state (the movements list's „Фактурирана" marker). */
export async function invoicingByMovement(orgId: string, movements: any[]): Promise<Map<string, DispatchInvoicingState>> {
  const invoices = await invoicesOf(orgId, movements)
  return new Map(movements.map(m => [idOf(m._id ?? m.id), invoicingStateOf(m, invoices)]))
}

const REFUSAL: Record<string, { status: number; message: (m: any, s: DispatchInvoicingState) => string }> = {
  not_a_dispatch: { status: 422, message: m => `${m.movementNumber} is not a dispatch` },
  dispatch_not_completed: { status: 422, message: m => `${m.movementNumber} is not booked yet: confirm it first` },
  dispatch_rolled_back: { status: 422, message: m => `${m.movementNumber} was rolled back with its document: the goods are back in stock` },
  dispatch_is_reversal: { status: 422, message: m => `${m.movementNumber} takes back the goods of a removed document: no customer received it` },
  dispatch_not_a_delivery: { status: 422, message: m => `${m.movementNumber} is a correction or a record of another movement: no customer's invoice is for it` },
  dispatch_already_invoiced: { status: 409, message: (m, s) => `${m.movementNumber} is already invoiced by ${s.invoice?.number}` },
  dispatch_not_invoiceable: {
    status: 409,
    message: (m, s) => (s.invoice
      ? `${m.movementNumber} was booked by ${s.invoice.number}, which is voided: it is no stock note of its own`
      : `${m.movementNumber} belongs to a document that is gone: it is no stock note of its own`),
  },
}

/** Load `movementIds` and refuse unless every one may be invoiced, by one invoice, to one customer. */
async function loadInvoiceableDispatches(orgId: string, movementIds: string[], userId: string): Promise<any[]> {
  const ids = [...new Set((movementIds || []).map(String).filter(Boolean))]
  if (!ids.length) throw new DispatchInvoiceError(422, 'no_dispatches', 'Choose at least one stock note')
  if (!ids.every(isId)) throw new DispatchInvoiceError(404, 'dispatch_not_found', 'Stock note not found')
  const read = async () => {
    const rows: any[] = await StockMovement.find({ orgId, _id: { $in: ids } } as any).lean().exec()
    if (rows.length !== ids.length) throw new DispatchInvoiceError(404, 'dispatch_not_found', 'Stock note not found')
    // The order the user named them in is the order their lines take on the invoice.
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
    const state = invoicingStateOf(m, invoices)
    if (state.invoiceable) continue
    const refusal = REFUSAL[state.reason!]
    throw new DispatchInvoiceError(refusal.status, state.reason!, refusal.message(m, state), {
      movementId: idOf(m._id), movementNumber: m.movementNumber,
      ...(state.invoice ? { invoiceId: state.invoice.id, invoiceNumber: state.invoice.number } : {}),
    })
  }
  // A note that names no customer takes the invoice's, so only the ones that name one can clash.
  const customers = new Set(movements.map(m => idOf(m.contactId)).filter(Boolean))
  if (customers.size > 1) {
    throw new DispatchInvoiceError(422, 'mixed_customers', 'One invoice covers the stock notes of one customer: these name different customers')
  }
  return movements
}

/**
 * A contact that may be named on a stock note: an active customer (or `both`) of this org. Another org's contact
 * reads as one that does not exist.
 */
async function assertCustomer(orgId: string, contactId: string): Promise<void> {
  const known = isId(contactId) && await Contact.exists({
    orgId, _id: contactId, type: { $in: ['customer', 'both'] }, isActive: { $ne: false },
  } as any).exec()
  if (!known) throw new DispatchInvoiceError(422, 'customer_not_found', 'Choose a customer of this organization')
}

interface SettledCustomer {
  customerId: string
  /** The notes that name none, and take this one with their claim. */
  unnamed: any[]
}

/**
 * The customer of an invoice for these notes: the one they name, or `chosen`. `chosen` must not contradict a note,
 * and is needed the moment one of them names nobody.
 *
 * `check` proves `chosen` even when no note takes it: `from-dispatch` makes the invoice out to it. A link keeps the
 * invoice's own contact, which is proved only when a note is about to take it.
 */
async function settleCustomer(orgId: string, movements: any[], chosen: string | undefined, check: boolean): Promise<SettledCustomer> {
  const named = idOf(movements.find(m => m.contactId)?.contactId)
  if (chosen && named && idOf(chosen) !== named) {
    throw new DispatchInvoiceError(422, 'customer_mismatch', 'The stock notes are another customer\'s')
  }
  const unnamed = movements.filter(m => !m.contactId)
  if (unnamed.length && !chosen) {
    const first = unnamed[0]
    throw new DispatchInvoiceError(422, 'dispatch_without_customer', `${first.movementNumber} names no customer: choose one`, {
      movementId: idOf(first._id), movementNumber: first.movementNumber,
    })
  }
  // A customer the notes already name needs no proving: one since deactivated still received them.
  if (chosen && idOf(chosen) !== named && (check || unnamed.length)) await assertCustomer(orgId, idOf(chosen))
  return { customerId: named || idOf(chosen), unnamed }
}

// ── The invoice's lines ─────────────────────────────────────────────────────────────────────

/**
 * One invoice line per dispatched line, at the price the engine resolves for this customer and quantity: what the
 * invoice form proposes when the article is picked, with its trail. Never the note's unit cost. The VAT and the line
 * total are rounded per line, as the form rounds them (`withLineAmounts`), so the form re-saves the same figures.
 */
async function invoiceLinesFrom(orgId: string, movements: any[], products: Map<string, ProductInfo>, customerId: string, defaultVatRate: number): Promise<any[]> {
  const lines: any[] = []
  for (const m of movements) {
    for (const l of m.lines || []) {
      const quantity = num(l.quantity)
      // A line with no quantity moved nothing and invoices nothing.
      if (!(quantity > 0)) continue
      const id = idOf(l.productId)
      const p = products.get(id)
      let unitPrice = 0
      let steps: unknown[] = []
      try {
        const resolved = await resolvePrice(orgId, id, customerId || undefined, quantity)
        unitPrice = num(resolved.finalPrice)
        steps = resolved.steps || []
      } catch {
        // An article that no longer exists keeps its line, unpriced: the person prices it on the draft.
      }
      lines.push(withLineAmounts({
        productId: l.productId,
        // The model requires a description; an article that no longer exists keeps its line.
        description: p?.name || id,
        quantity,
        unit: p?.unit || 'pcs',
        unitPrice,
        discount: 0,
        taxRate: p?.taxRate ?? defaultVatRate,
        warehouseId: m.fromWarehouseId || undefined,
        ...(steps.length ? { priceExplanation: steps } : {}),
      } as any))
    }
  }
  return lines
}

/** The lines of an invoice that say something: the form keeps a blank one at the bottom. */
function filledLinesOf(invoice: any): any[] {
  return (invoice.lines || []).filter((l: any) => l.productId || String(l.description || '').trim())
}

/** Dispatched quantity per product over an invoice's notes. */
function dispatchedByProduct(movements: any[]): Map<string, number> {
  const qty = new Map<string, number>()
  for (const m of movements) {
    for (const l of m.lines || []) {
      const id = idOf(l.productId)
      qty.set(id, (qty.get(id) || 0) + num(l.quantity))
    }
  }
  return qty
}

export interface QuantityDifference {
  productId: string
  name: string
  dispatched: number
  invoiced: number
}

/**
 * Where an invoice's lines say something other than what its notes delivered, per stock-held article. An invoice
 * linked to notes moves no stock, so every stock-held quantity on it must be one the notes dispatched: more of an
 * article, or one they do not carry, would be invoiced and never leave; less would leave delivered goods that no
 * invoice can ever charge (a note is claimed whole). Lines that hold no stock are nobody's to compare.
 */
function quantityDifferences(movements: any[], lines: any[], products: Map<string, ProductInfo>): QuantityDifference[] {
  const tracked = (id: string) => products.get(id)?.trackInventory !== false
  const dispatched = dispatchedByProduct(movements)
  const invoiced = new Map<string, number>()
  for (const l of lines) {
    const id = idOf(l.productId)
    if (!id || !tracked(id)) continue
    invoiced.set(id, (invoiced.get(id) || 0) + num(l.quantity))
  }
  const out: QuantityDifference[] = []
  for (const id of new Set([...invoiced.keys(), ...[...dispatched.keys()].filter(tracked)])) {
    const d = dispatched.get(id) || 0
    const i = invoiced.get(id) || 0
    if (Math.abs(d - i) > EPS) out.push({ productId: id, name: products.get(id)?.name || id, dispatched: d, invoiced: i })
  }
  return out
}

function stockSourceFor(movements: any[], unnamed: any[]): Record<string, any> {
  return {
    marker: `${DISPATCH_MARKER}${movements.map(m => idOf(m._id)).join(',')}`,
    docNumber: movements.map(m => m.movementNumber).join(', '),
    movementIds: movements.map(m => m._id),
    ...(unnamed.length ? { customerGivenTo: unnamed.map(m => m._id) } : {}),
    detectedBy: 'manual',
    linkedAt: new Date(),
  }
}

function statusEntry(status: string, fromStatus: string | undefined, userId: string, reason: string) {
  return { status, ...(fromStatus ? { fromStatus } : {}), changedAt: new Date(), changedBy: userId, reason }
}

/**
 * Claim the notes for `invoiceId`: one compare-and-set per note on the `invoiceId` it was read with, in `_id` order
 * (so two requests for overlapping sets meet on the same first note, and one of them takes none). A note that names
 * no customer takes `customerId` in the same update, guarded on still naming none. On a lost race it gives back what
 * it took and throws 409.
 */
async function claimDispatches(orgId: string, invoiceId: unknown, movements: any[], customerId: string): Promise<void> {
  const claimed: any[] = []
  const sorted = [...movements].sort((a, b) => idOf(a._id).localeCompare(idOf(b._id)))
  for (const m of sorted) {
    const unnamed = !m.contactId
    const res = await StockMovement.updateOne(
      { _id: m._id, orgId, type: 'dispatch', status: 'completed', invoiceId: m.invoiceId ?? null, ...(unnamed ? { contactId: null } : {}) } as any,
      { $set: { invoiceId, ...(unnamed ? { contactId: customerId } : {}) } },
    ).exec()
    if (res.modifiedCount === 1) {
      claimed.push(m)
      continue
    }
    await releaseClaims(orgId, invoiceId, claimed.map(c => c._id), claimed.filter(c => !c.contactId).map(c => c._id))
    throw new DispatchInvoiceError(409, 'dispatch_already_invoiced', `${m.movementNumber} was invoiced by another document just now`, {
      movementId: idOf(m._id), movementNumber: m.movementNumber,
    })
  }
}

/** One audit entry per note that took (or gave back) a customer. Nothing else records it. */
function auditCustomer(orgId: string, userId: string, invoiceId: string, movements: any[], change: { oldValue: string | null; newValue: string | null }): void {
  for (const m of movements) {
    createAuditEntry({
      orgId, userId, action: 'update', module: 'warehouse', entityType: 'stock_movement',
      entityId: idOf(m._id), entityName: m.movementNumber, correlationId: invoiceId,
      changes: [{ field: 'contactId', ...change }],
    })
  }
}

function auditInvoiced(orgId: string, userId: string, invoiceId: string, invoiceNumber: string, movements: any[]): void {
  for (const m of movements) {
    createAuditEntry({
      orgId, userId, action: 'invoiced', module: 'warehouse', entityType: 'stock_movement',
      entityId: idOf(m._id), entityName: m.movementNumber, correlationId: invoiceId,
      changes: [{ field: 'invoice', oldValue: null, newValue: invoiceNumber }],
    })
  }
}

/**
 * Give the notes an invoice claims back. Only the claims it still holds: never another invoice's. A customer this
 * invoice wrote goes with its claim: a completed movement cannot be edited, so a wrong choice has no other way back.
 */
export async function releaseDispatchLinks(orgId: string, invoice: any, userId?: string): Promise<number> {
  const ids = linkedDispatchIds(invoice)
  if (!ids.length) return 0
  const invoiceId = idOf(invoice._id ?? invoice.id)
  const givenTo: unknown[] = invoice.stockSource?.customerGivenTo || []
  const held: any[] = givenTo.length
    ? await StockMovement.find({ orgId, _id: { $in: givenTo }, invoiceId } as any, { movementNumber: 1 }).lean().exec()
    : []
  const released = await releaseClaims(orgId, invoiceId, ids, givenTo)
  if (released) {
    logger.info({ orgId, invoiceId, released }, 'dispatch-invoice: stock notes released by their invoice')
    if (userId) auditCustomer(orgId, userId, invoiceId, held, { oldValue: idOf(invoice.contactId), newValue: null })
  }
  return released
}

// ── Making the invoice ──────────────────────────────────────────────────────────────────────

export interface InvoiceFromDispatchesInput {
  movementIds: string[]
  /** The customer, for notes that name none. It must not contradict one that does. */
  contactId?: string
  /** The currency of the form this invoice is made from: an invoice in another than the org's is refused. */
  currency?: string
  issueDate?: string
  dueDate?: string
  notes?: string
  paymentMethod?: string
  /** The language „Словом" is written in: the form's. */
  locale?: string
}

interface Actor { id: string; firstName?: string; lastName?: string }

/**
 * The prices the engine resolves are the org's, and nothing converts them. An invoice in another currency taking
 * them would charge them in the wrong money, so its lines are not written from a note.
 */
function refuseForeignInvoice(currency: string | undefined, baseCurrency: string, number?: string): void {
  if (!currency || currency === baseCurrency) return
  throw new DispatchInvoiceError(422, 'invoice_foreign_currency', `${number || 'An invoice'} in ${currency} cannot take the organization's prices, which are in ${baseCurrency}`, { currency, baseCurrency })
}

/** A sales invoice is due a month after it is issued, as its form proposes. */
function plusOneMonth(d: Date): Date {
  const out = new Date(d)
  out.setMonth(out.getMonth() + 1)
  return out
}

/** The billing address an invoice copies from a contact, the way the invoice form picks it. */
function billingAddressOf(contact: any): Record<string, string> {
  const list: any[] = contact?.addresses || []
  const a = list.find(x => x.type === 'billing' && x.isDefault) || list.find(x => x.type === 'billing') || list.find(x => x.isDefault) || list[0]
  if (!a) return { street: '-', city: '-', postalCode: '-', country: '-' }
  return { street: a.street || '-', city: a.city || '-', ...(a.state ? { state: a.state } : {}), postalCode: a.postalCode || '-', country: a.country || '-' }
}

/**
 * A DRAFT sales invoice for `movementIds`: the customer, the notes' lines, quantities and warehouses, each at the
 * price resolved for that customer, linked to the notes. The user reads the prices and issues it.
 */
export async function createInvoiceFromDispatches(orgId: string, actor: Actor, input: InvoiceFromDispatchesInput): Promise<any> {
  const movements = await loadInvoiceableDispatches(orgId, input.movementIds, actor.id)
  const { customerId, unnamed } = await settleCustomer(orgId, movements, input.contactId, true)
  const [defaults, products, contact] = await Promise.all([
    orgDefaults(orgId),
    productsOf(orgId, movements.flatMap(m => (m.lines || []).map((l: any) => idOf(l.productId)))),
    Contact.findOne({ orgId, _id: customerId } as any, { addresses: 1 }).lean().exec(),
  ])
  refuseForeignInvoice(input.currency, defaults.currency)
  const lines = await invoiceLinesFrom(orgId, movements, products, customerId, defaults.vat)
  if (!lines.length) throw new DispatchInvoiceError(422, 'nothing_to_invoice', 'The stock notes carry no quantities to invoice')
  const totals = invoiceTotalsOf(lines)
  const issueDate = input.issueDate ? new Date(input.issueDate) : new Date(isoDay(new Date()))
  const numbers = movements.map(m => m.movementNumber).join(', ')
  const preparedBy = [actor.firstName, actor.lastName].filter(Boolean).join(' ').trim()

  let invoice: any = null
  for (let attempt = 0; attempt < 3 && !invoice; attempt++) {
    const invoiceNumber = (await getNextDraftInvoiceNumber(orgId, 'outgoing', 'invoice'))
      || (await getNextInvoiceNumber(orgId, 'outgoing', 'invoice'))
    try {
      invoice = (await Invoice.create({
        orgId,
        invoiceNumber,
        type: 'invoice',
        direction: 'outgoing',
        status: 'draft',
        statusHistory: [statusEntry('draft', undefined, actor.id, `from_dispatch ${numbers}`)],
        numberHistory: [{ number: invoiceNumber, allocatedAt: new Date(), status: 'draft' }],
        contactId: customerId,
        issueDate,
        dueDate: input.dueDate ? new Date(input.dueDate) : plusOneMonth(issueDate),
        currency: defaults.currency,
        exchangeRate: 1,
        ...(input.paymentMethod ? { paymentMethod: input.paymentMethod } : {}),
        ...(preparedBy ? { preparedBy } : {}),
        // Every outgoing document carries „Словом" (`useDocumentForm.buildPayload`); so does this one.
        notes: upsertAmountInWords(input.notes || '', totals.total, totals.subtotal, defaults.currency, input.locale || 'bg'),
        lines,
        ...totals,
        totalBase: totals.total,
        amountPaid: 0,
        amountDue: totals.total,
        billingAddress: billingAddressOf(contact),
        stockSource: stockSourceFor(movements, unnamed),
        createdBy: actor.id,
      } as any)).toObject()
    } catch (e: any) {
      // The draft counter handed out a number some document already has: draw the next one.
      if (e?.code !== 11000 || !/invoiceNumber/.test(String(e?.message))) throw e
      logger.warn({ orgId, invoiceNumber, attempt }, 'dispatch-invoice: draft number already taken, retrying')
    }
  }
  if (!invoice) throw new DispatchInvoiceError(409, 'number_unavailable', 'Could not allocate the invoice number after 3 attempts')

  try {
    await claimDispatches(orgId, invoice._id, movements, customerId)
  } catch (e) {
    // Lost to a concurrent invoice: this one never was.
    await Invoice.deleteOne({ _id: invoice._id, orgId } as any).exec()
    throw e
  }

  const id = idOf(invoice._id)
  createAuditEntry({
    orgId, userId: actor.id, action: 'create', module: 'invoicing', entityType: 'invoice', entityId: id,
    entityName: invoice.invoiceNumber, changes: [{ field: 'stockNotes', oldValue: null, newValue: numbers }],
  })
  auditCustomer(orgId, actor.id, id, unnamed, { oldValue: null, newValue: customerId })
  auditInvoiced(orgId, actor.id, id, invoice.invoiceNumber, movements)
  logger.info({ orgId, invoice: invoice.invoiceNumber, notes: numbers }, 'dispatch-invoice: invoice made from stock notes')
  return getRepos().invoices.findOne({ id, orgId } as any)
}

export interface LinkDispatchesOptions {
  /**
   * The user was told the invoice's typed stock lines go. Without it an invoice whose lines say something other
   * than the notes delivered stays refused, with the differences named.
   */
  replaceLines?: boolean
  /** The customer the user sees, when the invoice may not have one saved. */
  contactId?: string
}

/** An invoice line as the audit trail keeps it: the article, how many, at what price. */
function auditedLine(l: any) {
  return { productId: idOf(l.productId) || null, description: l.description, quantity: num(l.quantity), unitPrice: num(l.unitPrice) }
}

/**
 * FR-22.62: put the notes on an invoice that already exists, a draft.
 *
 * An invoice linked to notes moves no stock at all, so its stock-held lines must say what the notes delivered. Where
 * they already do, the invoice keeps every line as typed: the link changes what it does to the stock and nothing
 * else. An empty draft takes the notes' lines at the customer's prices. One whose lines differ is refused with the
 * differences (`invoice_lines_differ`), and with `replaceLines` the notes' lines take the place of its stock-held
 * ones, while the lines that hold no stock stay. What the invoice says about itself stays in every case: its number,
 * dates, payment method and notes.
 *
 * An invoice written against a customer order or a reservation is not linked: its lines release the order's holds as
 * they dispatch, and one that moves nothing would leave them standing. The question at issue still offers to issue
 * it as it is.
 */
export async function linkDispatchesToInvoice(orgId: string, actor: Actor, invoiceId: string, movementIds: string[], opts: LinkDispatchesOptions = {}): Promise<{ invoice: any; linesWritten: boolean }> {
  if (!isId(invoiceId)) throw new DispatchInvoiceError(404, 'not_found', 'Invoice not found')
  const invoice: any = await Invoice.findOne({ _id: invoiceId, orgId } as any).lean().exec()
  if (!invoice) throw new DispatchInvoiceError(404, 'not_found', 'Invoice not found')
  if (invoice.type !== 'invoice' || invoice.direction !== 'outgoing') {
    throw new DispatchInvoiceError(422, 'not_a_sales_invoice', 'Only a sales invoice can be linked to stock notes')
  }
  if (invoice.status !== 'draft') throw new DispatchInvoiceError(422, 'invoice_not_draft', `${invoice.invoiceNumber} is no longer a draft`)
  if (invoice.stockSource?.marker) {
    throw new DispatchInvoiceError(409, 'invoice_already_linked', `${invoice.invoiceNumber} already takes its goods from ${invoice.stockSource.docNumber || 'another document'}`)
  }
  const filled = filledLinesOf(invoice)
  if (invoice.orderId || invoice.internalOrderId || filled.some((l: any) => Object.values(l.orderRef || {}).some(Boolean))) {
    throw new DispatchInvoiceError(422, 'invoice_on_order', `${invoice.invoiceNumber} is written against an order: its lines release that order's reservations as they dispatch`)
  }
  const movements = await loadInvoiceableDispatches(orgId, movementIds, actor.id)
  if (opts.contactId && invoice.contactId && idOf(opts.contactId) !== idOf(invoice.contactId)) {
    throw new DispatchInvoiceError(422, 'customer_mismatch', `${invoice.invoiceNumber} names another customer: save the invoice first`)
  }
  const { customerId, unnamed } = await settleCustomer(orgId, movements, idOf(invoice.contactId) || opts.contactId, false)
  const [defaults, products] = await Promise.all([
    orgDefaults(orgId),
    productsOf(orgId, [
      ...movements.flatMap(m => (m.lines || []).map((l: any) => idOf(l.productId))),
      ...filled.map((l: any) => idOf(l.productId)).filter(Boolean),
    ]),
  ])

  // The lines this link writes, or null where the invoice keeps its own.
  let lines: any[] | null = null
  const differences = quantityDifferences(movements, filled, products)
  if (!filled.length || differences.length) {
    if (filled.length && !opts.replaceLines) {
      const first = differences[0]
      throw new DispatchInvoiceError(422, 'invoice_lines_differ',
        `${invoice.invoiceNumber} does not say what ${movements.map(m => m.movementNumber).join(', ')} delivered: „${first.name}" was dispatched ${first.dispatched} and is invoiced ${first.invoiced}`
        + (differences.length > 1 ? ` (+${differences.length - 1} more)` : ''),
        { lines: differences, typedLines: filled.length })
    }
    refuseForeignInvoice(invoice.currency, defaults.currency, invoice.invoiceNumber)
    const holdsStock = (l: any) => !!l.productId && products.get(idOf(l.productId))?.trackInventory !== false
    lines = [
      ...await invoiceLinesFrom(orgId, movements, products, customerId, defaults.vat),
      ...filled.filter((l: any) => !holdsStock(l)),
    ]
    if (!lines.length) throw new DispatchInvoiceError(422, 'nothing_to_invoice', 'The stock notes carry no quantities to invoice')
  }

  // Link first, guarded on the invoice still being the unlinked draft that was read, then claim. A lost claim puts
  // the invoice back the way it was.
  const link = stockSourceFor(movements, unnamed)
  const set: Record<string, any> = { contactId: customerId, stockSource: link }
  const before: Record<string, any> = {}
  const unsetOnUndo: Record<string, 1> = { stockSource: 1 }
  if (invoice.contactId) before.contactId = invoice.contactId
  else unsetOnUndo.contactId = 1
  let totals: ReturnType<typeof invoiceTotalsOf> | null = null
  if (lines) {
    totals = invoiceTotalsOf(lines)
    Object.assign(before, {
      lines: invoice.lines || [], notes: invoice.notes ?? '',
      subtotal: num(invoice.subtotal), discountTotal: num(invoice.discountTotal), taxTotal: num(invoice.taxTotal),
      total: num(invoice.total), totalBase: num(invoice.totalBase), amountDue: num(invoice.amountDue),
    })
    Object.assign(set, {
      lines,
      ...totals,
      // In the org's currency (a foreign one is refused above), whatever a stale rate on the invoice says.
      totalBase: totals.total,
      amountDue: round2(totals.total - num(invoice.amountPaid)),
      // „Словом" says the total: it follows it, in the language it was written in.
      notes: upsertAmountInWords(invoice.notes || '', totals.total, totals.subtotal, defaults.currency, amountInWordsLocale(invoice.notes) || 'bg'),
    })
  }
  // ⚠ `unclaimedDraft`, not a status: a link inside an invoice's `/send` would change what it is issuing. And a
  // compare-and-set on what was read: the lines were judged from that read, so a draft edited since is refused.
  const linked = await Invoice.findOneAndUpdate(
    { _id: invoiceId, orgId, updatedAt: invoice.updatedAt ?? null, ...unclaimedDraft(), 'stockSource.marker': { $in: [null, ''] } } as any,
    { $set: set },
    { new: true },
  ).lean().exec()
  if (!linked) throw new DispatchInvoiceError(409, 'invoice_already_linked', `${invoice.invoiceNumber} changed meanwhile: reload it`)
  try {
    await claimDispatches(orgId, invoice._id, movements, customerId)
  } catch (e) {
    // Only the draft this request linked: an invoice issued or linked meanwhile must not get the old lines back.
    await Invoice.updateOne({ _id: invoiceId, orgId, status: 'draft', 'stockSource.marker': link.marker } as any, { ...(Object.keys(before).length ? { $set: before } : {}), $unset: unsetOnUndo }).exec()
    throw e
  }

  const numbers = movements.map(m => m.movementNumber).join(', ')
  createAuditEntry({
    orgId, userId: actor.id, action: 'update', module: 'invoicing', entityType: 'invoice', entityId: invoiceId,
    entityName: invoice.invoiceNumber,
    changes: [
      { field: 'stockNotes', oldValue: null, newValue: numbers },
      // The invoice no longer holds what was typed, and this is the only record of it.
      ...(lines && totals && filled.length ? [
        { field: 'lines', oldValue: filled.map(auditedLine), newValue: lines.map(auditedLine) },
        { field: 'subtotal', oldValue: num(invoice.subtotal), newValue: totals.subtotal },
        { field: 'taxTotal', oldValue: num(invoice.taxTotal), newValue: totals.taxTotal },
        { field: 'total', oldValue: num(invoice.total), newValue: totals.total },
      ] : []),
      ...(invoice.contactId ? [] : [{ field: 'contactId', oldValue: null, newValue: customerId }]),
    ],
  })
  auditCustomer(orgId, actor.id, invoiceId, unnamed, { oldValue: null, newValue: customerId })
  auditInvoiced(orgId, actor.id, invoiceId, invoice.invoiceNumber, movements)
  // `linesWritten`: the invoice no longer says what was typed, so its form stops for the person to read it.
  return { invoice: await getRepos().invoices.findOne({ id: invoiceId, orgId } as any), linesWritten: lines !== null }
}

// ── The notes a customer has not been invoiced for yet (FR-22.62's picker) ───────────────────

export interface InvoiceableDispatch {
  id: string
  number: string
  date: Date
  warehouseId?: string
  lineCount: number
  /** Units over its lines. Not a value: a note's amounts are costs, and an invoice charges prices. */
  quantity: number
  /** It names no customer, and takes the invoice's. */
  noCustomer?: boolean
  /** Its notes, when it names no customer: all there is to tell whose goods they were. */
  notes?: string
}

/** What deciding on a note reads: `invoicingStateOf` and `asInvoiceable`. */
const DISPATCH_FIELDS = { movementNumber: 1, date: 1, fromWarehouseId: 1, 'lines.productId': 1, 'lines.quantity': 1, invoiceId: 1, type: 1, status: 1, contactId: 1, notes: 1, reversedBy: 1, recordOnly: 1 }

function asInvoiceable(m: any): InvoiceableDispatch {
  const moved = (m.lines || []).filter((l: any) => num(l.quantity) > 0)
  return {
    id: idOf(m._id),
    number: m.movementNumber,
    date: m.date,
    warehouseId: m.fromWarehouseId ? idOf(m.fromWarehouseId) : undefined,
    lineCount: moved.length,
    quantity: moved.reduce((s: number, l: any) => s + num(l.quantity), 0),
    ...(m.contactId ? {} : { noCustomer: true, ...(m.notes ? { notes: m.notes } : {}) }),
  }
}

/**
 * The claims a note can stand free under: none, or one a voided invoice still lists (a release a crash left
 * unfinished, `finishReleases`). ⚠ Asked in the query, never filtered after it: nearly every dispatch of a customer
 * is the one an invoice booked for itself, and a read of the newest few hundred would hold nothing else.
 */
async function freeOf(orgId: string): Promise<Record<string, any>> {
  const unreleased = await Invoice.distinct('_id', { orgId, status: { $in: RELEASED }, 'stockSource.marker': { $regex: `^${DISPATCH_MARKER}` } } as any).exec()
  return unreleased.length ? { $or: [{ invoiceId: null }, { invoiceId: { $in: unreleased } }] } : { invoiceId: null }
}

/**
 * The notes an invoice to this customer can take: the customer's own, then the ones that name no customer (which
 * take the invoice's). Each group newest first, up to `limit`.
 */
export async function invoiceableDispatchesOf(orgId: string, contactId: string, limit = 50): Promise<InvoiceableDispatch[]> {
  if (!isId(contactId)) return []
  const free = await freeOf(orgId)
  const uninvoiced = async (customer: string | null) => {
    const rows: any[] = await StockMovement.find({ orgId, contactId: customer, type: 'dispatch', status: 'completed', ...free } as any, DISPATCH_FIELDS)
      .sort({ date: -1, _id: -1 }).limit(limit * 3).lean().exec()
    const states = await invoicingByMovement(orgId, rows)
    return rows.filter(m => states.get(idOf(m._id))?.invoiceable).slice(0, limit).map(asInvoiceable)
  }
  return [...await uninvoiced(contactId), ...await uninvoiced(null)]
}

// ── Before an invoice dispatches its own goods (FR-22.61b) ───────────────────────────────────

export interface DispatchOverlap {
  /** The invoice's lines that say something. */
  typedLines: number
  notes: InvoiceableDispatch[]
  /** The invoice names no customer, and neither do these notes: a link has to be told who. */
  needsCustomer?: boolean
}

/**
 * The unclaimed stock notes an invoice may be for, when issuing it would dispatch its goods a second time.
 *
 * Only a draft sales invoice that will dispatch: one linked to anything moves none (and a quote, a note or a cash
 * sale is not asked), and a line dispatches only with a product that holds stock, a warehouse and a quantity. A note
 * counts when it took goods out of stock, lies within `DISPATCH_OVERLAP_WINDOW_DAYS` of the invoice's issue date,
 * nobody has claimed it (`invoicingStateOf`) and it shares a line with the invoice, by the receipts' own rule of
 * evidence:
 *
 *   - naming the invoice's customer, any stock-held article in common;
 *   - naming no customer, an article in common at the same quantity on one line. Articles alone are no evidence
 *     there: a shop sells the same articles every week;
 *   - naming another customer, never.
 */
export async function dispatchesOverlapping(orgId: string, invoice: any): Promise<DispatchOverlap | null> {
  if (invoice.type !== 'invoice' || invoice.direction !== 'outgoing' || invoice.status !== 'draft' || invoice.stockSource?.marker) return null
  const dispatching = (invoice.lines || []).filter((l: any) => l.productId && l.warehouseId && num(l.quantity) > 0)
  if (!dispatching.length) return null
  const products = await productsOf(orgId, dispatching.map((l: any) => idOf(l.productId)))
  const quantities = new Map<string, number[]>()
  for (const l of dispatching) {
    const id = idOf(l.productId)
    const p = products.get(id)
    if (p && p.trackInventory !== false) quantities.set(id, [...(quantities.get(id) || []), num(l.quantity)])
  }
  if (!quantities.size) return null

  const at = new Date(invoice.issueDate ?? Date.now()).getTime()
  const span = DISPATCH_OVERLAP_WINDOW_DAYS * DAY_MS
  const customer = idOf(invoice.contactId)
  const rows: any[] = await StockMovement.find(
    {
      orgId, type: 'dispatch', status: 'completed',
      date: { $gte: new Date(at - span), $lte: new Date(at + span) },
      fromWarehouseId: { $ne: null },
      'lines.productId': { $in: [...quantities.keys()] },
      contactId: customer ? { $in: [customer, null] } : null,
      ...await freeOf(orgId),
    } as any,
    DISPATCH_FIELDS,
  ).sort({ date: -1, _id: -1 }).limit(OVERLAP_SCAN_LIMIT).lean().exec()
  if (!rows.length) return null

  const shares = (m: any) => (m.lines || []).some((l: any) => {
    const invoiced = quantities.get(idOf(l.productId))
    const q = num(l.quantity)
    if (!invoiced || !(q > 0)) return false
    return !!m.contactId || invoiced.some(i => Math.abs(i - q) <= EPS)
  })
  const states = await invoicingByMovement(orgId, rows)
  const notes = rows
    .filter(m => states.get(idOf(m._id))?.invoiceable && shares(m))
    .sort((a, b) => Number(!a.contactId) - Number(!b.contactId))
    .slice(0, OVERLAP_REPORT_LIMIT)
    .map(asInvoiceable)
  return notes.length ? { typedLines: filledLinesOf(invoice).length, notes, ...(customer ? {} : { needsCustomer: true }) } : null
}

// ── What a linked invoice may become ────────────────────────────────────────────────────────

/**
 * Check a `PUT` to an invoice made from stock notes (a note is invoiced once and whole).
 *
 * The invoice moves no stock, so every stock-held quantity on it must be one its notes dispatched
 * (`quantityDifferences`). Prices, discounts, units, tax rates, the text and lines that hold no stock stay free. Nor
 * may the invoice change customer: the goods went to that one.
 */
export async function checkLinkedInvoiceEdit(orgId: string, existing: any, body: { contactId?: string; lines?: any[] }): Promise<void> {
  if (!isDispatchLinked(existing)) return
  if (body.contactId !== undefined && body.contactId && idOf(body.contactId) !== idOf(existing.contactId)) {
    throw new DispatchInvoiceError(422, 'customer_mismatch', `${existing.invoiceNumber} is for goods its customer received on ${existing.stockSource.docNumber}: it cannot change customer`)
  }
  if (!Array.isArray(body.lines)) return
  const movements: any[] = await StockMovement.find(
    { orgId, _id: { $in: linkedDispatchIds(existing) } } as any,
    { movementNumber: 1, 'lines.productId': 1, 'lines.quantity': 1 },
  ).lean().exec()
  const products = await productsOf(orgId, [
    ...body.lines.map(l => idOf(l.productId)).filter(Boolean),
    ...movements.flatMap(m => (m.lines || []).map((l: any) => idOf(l.productId))),
  ])
  const differences = quantityDifferences(movements, body.lines, products)
  if (!differences.length) return
  const first = differences[0]
  throw new DispatchInvoiceError(422, 'dispatch_quantity_mismatch',
    `${existing.invoiceNumber} invoices ${movements.map(m => m.movementNumber).join(', ')} whole: „${first.name}" was dispatched ${first.dispatched} and is invoiced ${first.invoiced}`
    + (differences.length > 1 ? ` (+${differences.length - 1} more)` : '')
    + '. An invoice made from a stock note invoices what was delivered; a difference with the customer is settled by a credit or debit note.',
    // The first difference by name too: the form words the refusal in the user's language with it.
    { lines: differences, name: first.name, dispatched: first.dispatched, invoiced: first.invoiced })
}

// ── Reading the link ────────────────────────────────────────────────────────────────────────

export interface LinkedDispatch {
  id: string
  number: string
  date: Date
  status: string
  /** This invoice still holds it (a voided invoice has given it back). */
  held: boolean
  /** What it delivered. No costs: a role that prices an invoice need not see them. */
  lines: Array<{ productId: string; quantity: number }>
}

/** The notes an invoice was made from, for its form: links, and the quantities its stock-held lines are held to. */
export async function linkedDispatchesOf(orgId: string, invoice: any): Promise<LinkedDispatch[]> {
  const ids = linkedDispatchIds(invoice)
  if (!ids.length) return []
  const rows: any[] = await StockMovement.find(
    { orgId, _id: { $in: ids } } as any,
    { movementNumber: 1, date: 1, status: 1, 'lines.productId': 1, 'lines.quantity': 1, invoiceId: 1 },
  ).lean().exec()
  const invoiceId = idOf(invoice._id ?? invoice.id)
  const byId = new Map(rows.map(r => [idOf(r._id), r]))
  return ids.filter(id => byId.has(id)).map(id => {
    const m = byId.get(id)
    return {
      id,
      number: m.movementNumber,
      date: m.date,
      status: m.status,
      held: idOf(m.invoiceId) === invoiceId,
      lines: (m.lines || []).map((l: any) => ({ productId: idOf(l.productId), quantity: num(l.quantity) })),
    }
  })
}

export interface DispatchInvoicingForPage {
  invoiceable: boolean
  /** It may be invoiced, and the page asks for the customer first. */
  needsCustomer?: boolean
  /** Why it may not, when nothing else on the page says so: a held note names its document. */
  notInvoiceable?: { code: NonNullable<DispatchInvoicingState['reason']>; number?: string }
  /** The live document that holds it: its invoice, or the sale that booked it. */
  sale?: DispatchInvoicingState['invoice']
  /** A release finished just now: the note as it now stands, in place of what the page read. */
  contactId?: unknown
  invoiceId?: unknown
}

/** For the movement page: the document that holds the dispatch, and whether an invoice may be made from it. */
export async function dispatchInvoicingFor(orgId: string, movement: any, userId?: string): Promise<DispatchInvoicingForPage> {
  const { current, state } = await settledState(orgId, movement, userId)
  const held = !!state.invoice && !RELEASED.includes(state.invoice.status)
  return {
    ...(current === movement ? {} : { contactId: current.contactId ?? null, invoiceId: current.invoiceId ?? null }),
    invoiceable: state.invoiceable,
    ...(state.needsCustomer ? { needsCustomer: true } : {}),
    ...(state.reason && !held ? { notInvoiceable: { code: state.reason, ...(state.invoice ? { number: state.invoice.number } : {}) } } : {}),
    ...(held ? { sale: state.invoice } : {}),
  }
}
