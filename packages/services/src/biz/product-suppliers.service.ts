import { mongoose } from 'db/connection'
import { Contact, Invoice, Order, Org, Product, StockMovement } from 'db/models'
import { can, type AccessCaller } from './access/evaluate.js'
import { BILL_RECEIVED_STATUSES } from './reservation.service.js'
import { findRecordedProductIds, findRecordedProductIdsBySuppliers, getRecordedPreferred } from './recorded-suppliers.service.js'

const { Types } = mongoose
type ObjectId = InstanceType<typeof Types.ObjectId>

/**
 * FR-28 — which suppliers an article was bought from, read from the documents.
 *
 * Nothing here is stored. A purchase reaches the database through a dozen writers (three places a bill
 * becomes `received`, `confirmMovement`, the receipt-to-bill link and its undo, a PUT of an issued bill that
 * re-posts nothing, a void), and issued documents are editable in every status. A stored "last supplier"
 * would drift from the document it was copied from, with nothing to mark it. So the question is asked of
 * the documents each time, behind three indexes (`Invoice { orgId, direction, 'lines.productId' }`,
 * `Invoice { orgId, direction, contactId }`, `StockMovement { orgId, type, contactId }`), and the interface
 * below says nothing about how: a stored view can replace the bodies if an organization outgrows the budget
 * `FR-28.2` sets, and `product-suppliers.flow.test.ts` can then run both over one fixture.
 *
 * What counts as "procured through supplier S" (§2.2):
 *   1. A BILL: an incoming `invoice` in a received status (`BILL_RECEIVED_STATUSES`) naming S, for each of
 *      its lines that names the article. Date: `issueDate`. Price: the line's `unitPrice`, in the bill's
 *      currency.
 *   2. A RECEIPT no bill covers: a completed `receipt` movement naming S that no document holds. Date: the
 *      movement's `date`. Price: the line's `unitCost`, in the organization's base currency.
 *
 * Not evidence: a draft, voided or cancelled bill; an incoming credit or debit note (a return is not
 * procurement); a record-only or reversed receipt; a receipt that names no supplier; a supplier order
 * (that is intent, and has its own figure, "On order").
 *
 * "No bill covers it" is the receipt's `invoiceId`, the CLAIM `receipt-bill.service.ts` writes:
 *   - unset: nobody holds it, so it is a purchase of its own;
 *   - a RECEIVED bill: that bill is the purchase (a bill and the receipt it covers count once, as the bill);
 *   - a DRAFT bill made from it ("bill from receipt"): the draft is not evidence yet, and the goods were
 *     received, so the receipt keeps carrying the purchase until the bill is received. Without this the
 *     fact would vanish between making the draft and receiving it, which is the path FR-22.31 recommends;
 *   - a voided or cancelled bill: the bill's own receipt was reversed with it, and a receipt the bill only
 *     claimed was given back (`releaseReceiptLinks`), so neither is held.
 */

const OBJECT_ID = /^[0-9a-f]{24}$/i

/** The default cap of facts the Products list asks for per article. */
export const SUPPLIER_FACTS_PER_PRODUCT = 5
/** The documents the Suppliers tab lists behind the facts. */
export const SUPPLIER_TAB_DOCUMENTS = 10

export type SupplierDocumentKind = 'bill' | 'receipt'

export interface SupplierFact {
  supplierId: string
  supplierName: string
  /** The date of the most recent document: a bill's issue date, a receipt's date. */
  lastPurchasedAt: Date
  /** The unit price on that document. Absent for a caller who may not see prices. */
  lastUnitPrice?: number
  /** The currency of `lastUnitPrice`: the bill's, or the organization's for a receipt. */
  currency?: string
  /** Everything bought from this supplier, summed over the documents. */
  quantity: number
  /** How many documents (bills and uncovered receipts) say so. */
  documents: number
  lastDocument: { kind: SupplierDocumentKind; id: string; number: string }
}

export interface SupplierFactOptions {
  /** False: leave `lastUnitPrice` and `currency` out (the caller may not see costs). */
  includePrices?: boolean
}

/** One document behind a fact, for the Suppliers tab. */
export interface SupplierDocument {
  kind: SupplierDocumentKind
  id: string
  number: string
  date: Date
  supplierId: string
  supplierName: string
  quantity: number
  unitPrice?: number
  currency?: string
}

// ── Who may see it ──────────────────────────────────────────────────────────────────────────────────

/**
 * Supplier facts are incoming-document data: who we buy from, when, at what price. FR-26 keeps counter staff
 * away from incoming documents, so the facts go only to a caller who may read bills.
 */
export function canSeeSupplierFacts(user: AccessCaller | null | undefined): boolean {
  return can(user, 'bills.view')
}

/**
 * The price on a fact is a cost (FR-27.11.C.1): `lastUnitPrice` on a fact and `unitPrice` on a document are purchase
 * prices by another route. So they go with `products.costs`, on top of the facts' own `bills.view` (who we bought
 * from, and when, is not a price level). On the legacy model whoever reads a bill reads products, and so their costs:
 * the same answer as before.
 */
export function canSeeSupplierPrices(user: AccessCaller | null | undefined): boolean {
  return canSeeSupplierFacts(user) && can(user, 'products.costs')
}

// ── The documents that count ────────────────────────────────────────────────────────────────────────

const oid = (v: unknown) => new Types.ObjectId(String(v))
const idStr = (v: unknown) => (v == null ? '' : String(v))
const num = (v: unknown) => Number(v) || 0

/** The well-formed, lower-case, distinct ids; anything else would be a CastError, and matches nothing. */
function validIds(ids: Iterable<unknown>): string[] {
  return [...new Set([...ids].map((i) => idStr(i).trim().toLowerCase()).filter((i) => OBJECT_ID.test(i)))]
}

/** A received bill that names its supplier. Aggregation-ready: the ids are ObjectIds. */
export function billEvidenceFilter(orgId: string): Record<string, unknown> {
  return {
    orgId: oid(orgId),
    direction: 'incoming',
    type: 'invoice',
    status: { $in: BILL_RECEIVED_STATUSES },
    contactId: { $type: 'objectId' },
  }
}

/**
 * The draft bills made from goods receipts. Each holds its receipts with a claim (`invoiceId` on the
 * movement) while it is a draft, and a draft is not evidence, so what it holds is evidence itself.
 */
async function draftClaimBillIds(orgId: string): Promise<ObjectId[]> {
  const rows = await Invoice.find(
    { orgId: oid(orgId), direction: 'incoming', type: 'invoice', status: 'draft', 'stockSource.movementIds.0': { $exists: true } } as any,
    { _id: 1 },
  ).lean().exec()
  return rows.map((r: any) => r._id)
}

/** A completed receipt that names its supplier and that no received bill holds. */
export function receiptEvidenceFilter(orgId: string, draftClaims: ObjectId[]): Record<string, unknown> {
  return {
    orgId: oid(orgId),
    type: 'receipt',
    status: 'completed',
    recordOnly: { $ne: true },
    reversedBy: { $exists: false },
    contactId: { $type: 'objectId' },
    // `null` matches an unset field too: nobody holds it. Or only a draft bill does.
    $or: [{ invoiceId: null }, ...(draftClaims.length ? [{ invoiceId: { $in: draftClaims } }] : [])],
  }
}

interface Evidence {
  productId: string
  supplierId: string
  at: Date
  quantity: number
  documents: number
  price?: number
  currency?: string
  kind: SupplierDocumentKind
  id: string
  number: string
}

/** The lines of a document that name one of the articles, and nothing else of them. */
const onlyLinesOf = (pids: ObjectId[]) => ({
  $filter: { input: '$lines', as: 'l', cond: { $in: ['$$l.productId', pids] } },
})

async function billEvidence(orgId: string, pids: ObjectId[]): Promise<Evidence[]> {
  const rows: any[] = await Invoice.aggregate([
    { $match: { ...billEvidenceFilter(orgId), 'lines.productId': { $in: pids } } },
    { $project: { contactId: 1, issueDate: 1, currency: 1, invoiceNumber: 1, lines: onlyLinesOf(pids) } },
    { $unwind: '$lines' },
    { $sort: { issueDate: -1, _id: -1 } },
    {
      $group: {
        _id: { p: '$lines.productId', s: '$contactId' },
        quantity: { $sum: '$lines.quantity' },
        docs: { $addToSet: '$_id' },
        at: { $first: '$issueDate' },
        price: { $first: '$lines.unitPrice' },
        currency: { $first: '$currency' },
        id: { $first: '$_id' },
        number: { $first: '$invoiceNumber' },
      },
    },
    { $project: { quantity: 1, documents: { $size: '$docs' }, at: 1, price: 1, currency: 1, id: 1, number: 1 } },
  ]).exec()
  return rows.map((r) => ({
    productId: idStr(r._id.p), supplierId: idStr(r._id.s), at: r.at, quantity: num(r.quantity), documents: r.documents,
    price: r.price == null ? undefined : num(r.price), currency: r.currency || undefined,
    kind: 'bill' as const, id: idStr(r.id), number: r.number || '',
  }))
}

async function receiptEvidence(orgId: string, pids: ObjectId[], draftClaims: ObjectId[], baseCurrency: string): Promise<Evidence[]> {
  const rows: any[] = await StockMovement.aggregate([
    { $match: { ...receiptEvidenceFilter(orgId, draftClaims), 'lines.productId': { $in: pids } } },
    { $project: { contactId: 1, date: 1, movementNumber: 1, lines: onlyLinesOf(pids) } },
    { $unwind: '$lines' },
    { $sort: { date: -1, _id: -1 } },
    {
      $group: {
        _id: { p: '$lines.productId', s: '$contactId' },
        quantity: { $sum: '$lines.quantity' },
        docs: { $addToSet: '$_id' },
        at: { $first: '$date' },
        price: { $first: '$lines.unitCost' },
        id: { $first: '$_id' },
        number: { $first: '$movementNumber' },
      },
    },
    { $project: { quantity: 1, documents: { $size: '$docs' }, at: 1, price: 1, id: 1, number: 1 } },
  ]).exec()
  return rows.map((r) => ({
    productId: idStr(r._id.p), supplierId: idStr(r._id.s), at: r.at, quantity: num(r.quantity), documents: r.documents,
    price: r.price == null ? undefined : num(r.price), currency: baseCurrency,
    kind: 'receipt' as const, id: idStr(r.id), number: r.number || '',
  }))
}

async function baseCurrencyOf(orgId: string): Promise<string> {
  const org: any = await Org.findOne({ _id: orgId } as any, { 'settings.baseCurrency': 1 }).lean().exec()
  return org?.settings?.baseCurrency || 'EUR'
}

const byRecency = (a: { lastPurchasedAt: Date; supplierId: string }, b: { lastPurchasedAt: Date; supplierId: string }) =>
  b.lastPurchasedAt.getTime() - a.lastPurchasedAt.getTime() || (a.supplierId < b.supplierId ? -1 : a.supplierId > b.supplierId ? 1 : 0)

/**
 * Per article, its supplier facts with no names yet, in the default order. The one place a bill's and a
 * receipt's evidence is merged: `getSupplierFacts` names them, `getDefaultSuppliers` does not need to.
 */
async function collectFacts(orgId: string, productIds: string[]): Promise<Map<string, SupplierFact[]>> {
  const ids = validIds(productIds)
  const out = new Map<string, SupplierFact[]>(ids.map((id) => [id, []]))
  if (!ids.length) return out
  const pids = ids.map(oid)

  const draftClaims = await draftClaimBillIds(orgId)
  const [bills, baseCurrency] = await Promise.all([billEvidence(orgId, pids), baseCurrencyOf(orgId)])
  const receipts = await receiptEvidence(orgId, pids, draftClaims, baseCurrency)

  const merged = new Map<string, SupplierFact & { productId: string }>()
  for (const e of [...bills, ...receipts]) {
    const key = `${e.productId}|${e.supplierId}`
    const cur = merged.get(key)
    if (!cur) {
      merged.set(key, {
        productId: e.productId, supplierId: e.supplierId, supplierName: '', lastPurchasedAt: e.at,
        lastUnitPrice: e.price, currency: e.currency, quantity: e.quantity, documents: e.documents,
        lastDocument: { kind: e.kind, id: e.id, number: e.number },
      })
      continue
    }
    cur.quantity += e.quantity
    cur.documents += e.documents
    // The later document says what the last purchase was; on the same instant a bill outranks a receipt.
    const later = e.at.getTime() - cur.lastPurchasedAt.getTime()
    if (later > 0 || (later === 0 && e.kind === 'bill' && cur.lastDocument.kind === 'receipt')) {
      cur.lastPurchasedAt = e.at
      cur.lastUnitPrice = e.price
      cur.currency = e.currency
      cur.lastDocument = { kind: e.kind, id: e.id, number: e.number }
    }
  }
  for (const { productId, ...fact } of merged.values()) {
    fact.quantity = +fact.quantity.toFixed(3)
    out.get(productId)!.push(fact as SupplierFact)
  }
  for (const list of out.values()) list.sort(byRecency)
  return out
}

const nameOfContact = (c: any) => c?.companyName || [c?.firstName, c?.lastName].filter(Boolean).join(' ') || ''

async function namesOf(orgId: string, supplierIds: Iterable<string>): Promise<Map<string, string>> {
  const ids = validIds(supplierIds)
  if (!ids.length) return new Map()
  const rows: any[] = await Contact.find({ orgId: oid(orgId), _id: { $in: ids.map(oid) } } as any, { companyName: 1, firstName: 1, lastName: 1 }).lean().exec()
  return new Map(rows.map((c) => [idStr(c._id), nameOfContact(c)]))
}

// ── The three questions ─────────────────────────────────────────────────────────────────────────────

/**
 * FR-28.1: per article, who we bought it from — the date and unit price of the last purchase, how much, in how
 * many documents, and the document last used — most recent supplier first. Every article asked about gets an
 * entry, empty included, so a list can tell "no supplier" from "not loaded". Ids that are not ObjectIds are
 * ignored.
 */
export async function getSupplierFacts(
  orgId: string,
  productIds: string[],
  opts: SupplierFactOptions = {},
): Promise<Record<string, SupplierFact[]>> {
  const facts = await collectFacts(orgId, productIds)
  const names = await namesOf(orgId, [...facts.values()].flatMap((list) => list.map((f) => f.supplierId)))
  const out: Record<string, SupplierFact[]> = {}
  for (const [productId, list] of facts) {
    out[productId] = list.map((f) => {
      const named: SupplierFact = { ...f, supplierName: names.get(f.supplierId) ?? '' }
      if (opts.includePrices === false) {
        delete named.lastUnitPrice
        delete named.currency
      }
      return named
    })
  }
  return out
}

/**
 * FR-28.1: the articles any of these suppliers sold us (a bill or an uncovered receipt says so), and, since
 * FR-28.9, the articles a person recorded the supplier for: a recorded link counts beside the documents (§2.3).
 */
export async function findProductIdsBySuppliers(orgId: string, supplierIds: string[]): Promise<string[]> {
  const suppliers = validIds(supplierIds).map(oid)
  if (!suppliers.length) return []
  const draftClaims = await draftClaimBillIds(orgId)
  const [fromBills, fromReceipts, recorded] = await Promise.all([
    Invoice.distinct('lines.productId', { ...billEvidenceFilter(orgId), contactId: { $in: suppliers } } as any).exec(),
    StockMovement.distinct('lines.productId', { ...receiptEvidenceFilter(orgId, draftClaims), contactId: { $in: suppliers } } as any).exec(),
    findRecordedProductIdsBySuppliers(orgId, supplierIds),
  ])
  return validIds([...fromBills, ...fromReceipts, ...recorded])
}

/** Every article with at least one supplier fact, or a supplier a person recorded for it (FR-28.9). */
async function findProductIdsWithAnySupplier(orgId: string): Promise<Set<string>> {
  const draftClaims = await draftClaimBillIds(orgId)
  const [fromBills, fromReceipts, recorded] = await Promise.all([
    Invoice.distinct('lines.productId', billEvidenceFilter(orgId) as any).exec(),
    StockMovement.distinct('lines.productId', receiptEvidenceFilter(orgId, draftClaims) as any).exec(),
    findRecordedProductIds(orgId),
  ])
  return new Set(validIds([...fromBills, ...fromReceipts, ...recorded]))
}

/** FR-28.1: the articles of the organization with neither a document that says a supplier sold it to us nor a recorded supplier. */
export async function findProductIdsWithoutSupplier(orgId: string): Promise<string[]> {
  const [withSupplier, all] = await Promise.all([
    findProductIdsWithAnySupplier(orgId),
    Product.distinct('_id', { orgId: oid(orgId) } as any).exec(),
  ])
  return validIds(all).filter((id) => !withSupplier.has(id))
}

// ── The default supplier ────────────────────────────────────────────────────────────────────────────

export interface DefaultSupplier {
  supplierId: string
  /** What named it: a person's recorded preference, the most recent purchase, or the newest supplier order carrying the article. */
  basis: 'recorded' | 'purchase' | 'order'
  /** The supplier order, when `basis` is 'order'. */
  orderNumber?: string
}

/**
 * FR-28.11: the supplier to offer for an article, in one rule for every caller (the order dialog of FR-28.16,
 * and `getInternalOrderSuggestions`' `supplierHint`):
 *   1. the RECORDED preferred supplier (FR-28.9), while that contact is still an active supplier: a preference
 *      is a standing decision that goes stale when the supplier stops being one, and the rule then reads on;
 *   2. the supplier of the most recent purchase;
 *   3. the supplier of the newest supplier order with a line for the article, whatever its status (what the
 *      customer-order form's hint was before there were facts);
 *   4. none.
 * Articles with no answer are absent from the map. A handful of queries whatever the number of articles.
 */
export async function getDefaultSuppliers(orgId: string, productIds: string[]): Promise<Map<string, DefaultSupplier>> {
  const ids = validIds(productIds)
  const out = new Map<string, DefaultSupplier>()
  if (!ids.length) return out

  const recorded = await getRecordedPreferred(orgId, ids)
  for (const [productId, supplierId] of recorded) out.set(productId, { supplierId, basis: 'recorded' })
  const open = ids.filter((id) => !out.has(id))
  if (!open.length) return out

  const facts = await collectFacts(orgId, open)
  const unanswered: string[] = []
  for (const id of open) {
    const first = facts.get(id)?.[0]
    if (first) out.set(id, { supplierId: first.supplierId, basis: 'purchase' })
    else unanswered.push(id)
  }
  if (!unanswered.length) return out

  const pids = unanswered.map(oid)
  const rows: any[] = await Order.aggregate([
    { $match: { orgId: oid(orgId), 'supplierGroups.lines.productId': { $in: pids } } },
    { $sort: { createdAt: -1, _id: -1 } },
    { $unwind: '$supplierGroups' },
    { $unwind: '$supplierGroups.lines' },
    { $match: { 'supplierGroups.lines.productId': { $in: pids } } },
    { $group: { _id: '$supplierGroups.lines.productId', supplierId: { $first: '$supplierGroups.supplierId' }, orderNumber: { $first: '$orderNumber' } } },
  ]).exec()
  for (const r of rows) {
    if (r.supplierId) out.set(idStr(r._id), { supplierId: idStr(r.supplierId), basis: 'order', orderNumber: r.orderNumber })
  }
  return out
}

// ── The Suppliers tab ───────────────────────────────────────────────────────────────────────────────

export interface SupplierDocumentOptions extends SupplierFactOptions {
  /** False: leave the receipts out (the caller may not open a stock movement). */
  includeReceipts?: boolean
  limit?: number
}

/** The documents behind an article's facts, newest first: the tab lists the last ten. */
export async function getRecentSupplierDocuments(
  orgId: string,
  productId: string,
  opts: SupplierDocumentOptions = {},
): Promise<SupplierDocument[]> {
  const [id] = validIds([productId])
  if (!id) return []
  const limit = opts.limit ?? SUPPLIER_TAB_DOCUMENTS
  const pids = [oid(id)]
  const rows: Array<Omit<SupplierDocument, 'supplierName'>> = []

  const bills: any[] = await Invoice.aggregate([
    { $match: { ...billEvidenceFilter(orgId), 'lines.productId': { $in: pids } } },
    { $sort: { issueDate: -1, _id: -1 } },
    { $limit: limit },
    { $project: { contactId: 1, issueDate: 1, currency: 1, invoiceNumber: 1, lines: onlyLinesOf(pids) } },
  ]).exec()
  for (const b of bills) {
    rows.push({
      kind: 'bill', id: idStr(b._id), number: b.invoiceNumber || '', date: b.issueDate, supplierId: idStr(b.contactId),
      quantity: +(b.lines || []).reduce((s: number, l: any) => s + num(l.quantity), 0).toFixed(3),
      unitPrice: b.lines?.[0]?.unitPrice == null ? undefined : num(b.lines[0].unitPrice), currency: b.currency || undefined,
    })
  }
  if (opts.includeReceipts !== false) {
    const [draftClaims, baseCurrency] = await Promise.all([draftClaimBillIds(orgId), baseCurrencyOf(orgId)])
    const receipts: any[] = await StockMovement.aggregate([
      { $match: { ...receiptEvidenceFilter(orgId, draftClaims), 'lines.productId': { $in: pids } } },
      { $sort: { date: -1, _id: -1 } },
      { $limit: limit },
      { $project: { contactId: 1, date: 1, movementNumber: 1, lines: onlyLinesOf(pids) } },
    ]).exec()
    for (const m of receipts) {
      rows.push({
        kind: 'receipt', id: idStr(m._id), number: m.movementNumber || '', date: m.date, supplierId: idStr(m.contactId),
        quantity: +(m.lines || []).reduce((s: number, l: any) => s + num(l.quantity), 0).toFixed(3),
        unitPrice: m.lines?.[0]?.unitCost == null ? undefined : num(m.lines[0].unitCost), currency: baseCurrency,
      })
    }
  }
  rows.sort((a, b) => b.date.getTime() - a.date.getTime() || (a.id < b.id ? 1 : -1))
  const top = rows.slice(0, limit)
  const names = await namesOf(orgId, top.map((r) => r.supplierId))
  return top.map((r) => {
    const doc: SupplierDocument = { ...r, supplierName: names.get(r.supplierId) ?? '' }
    if (opts.includePrices === false) {
      delete doc.unitPrice
      delete doc.currency
    }
    return doc
  })
}
