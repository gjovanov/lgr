import { mongoose } from 'db/connection'
import { Invoice, InternalOrder, Product } from 'db/models'
import { chargeablePrice, linePricePinned } from 'config/order-line-price'
import { can, type AccessCaller } from './access/evaluate'
import { listPriceOptions, resolvePrice } from './pricing.service'
import { NOT_PAYMENT_RECEIPT } from './sale-counting'

/**
 * #724 — two rules the sales documents' forms hold, held by the routes too (owner, 2026-11-12).
 *
 * 1. **A price typed on a line is the role's to give** (FR-27 `sales-docs.manual-price`; "Manual price, unavailable for
 *    Seller, but available for Sales Consultant"). A session without it saves a line price the form could have given
 *    it: one the engine offers for the line, or one already charged. Never another figure (`typedPriceRefusal`, and
 *    `pinnedPriceRefusal` for the price a customer order's invoice will charge).
 * 2. **An outgoing article line's unit is its article's** ("the unit is read-only once a product is chosen";
 *    `withArticleUnits`). Nothing is refused: the unit the form never lets anybody choose is simply not the line's.
 *
 * "Could have given it" is the whole of what the forms offer a person who may not type, so a save the form makes is
 * never refused:
 *   - the article's selling price (a pick starts there), every price `listPriceOptions(all)` lists (the price menu, the
 *     Select-price icon, the document-wide price) and the resolved one (`resolvePrice`: what a line takes by itself);
 *   - what the document already carries: a save of an unchanged line, a conversion's draft, an invoice for a cash sale;
 *   - what the client was already charged for the article, on a document of theirs (the Last price box, „Копирай", a
 *     credit note's lines from its invoice): a price somebody gave this client, not one the person made up;
 *   - on an invoice line converted from a customer order, that order line's price.
 * A typed line (no article) is held the same way with nothing offered: 0, or a price it already carries or was
 * already charged at.
 *
 * ⚠ The price options are read WITHOUT the role's price-level filter (FR-27.11): `resolvePrice` hands the form a level
 * the role does not see when the client's tags pick it (D-13), and a save of it is no typed price.
 */

const { isValidObjectId } = mongoose

/** Half the last decimal a price keeps (`PRICE_DECIMALS` = 4): a figure rounded on the way is the same price. */
const PRICE_TOLERANCE = 0.00005

/** How many of the client's earlier documents a save reads for the prices they were charged. */
const HISTORY_DOCUMENTS = 2000

/** The line's article, as the routes read it (`productId`, or the older `product`); '' for a typed line. */
export const articleOf = (line: any): string => String(line?.productId ?? line?.product ?? '')

export interface UnofferedLine {
  /** 1-based, as the form numbers its lines. */
  line: number
  productId?: string
  unitPrice: number
}

export interface PriceRefusal {
  code: 'price_not_offered'
  capabilities: ['sales-docs.manual-price']
  message: string
  lines: UnofferedLine[]
}

interface Priced {
  index: number
  key: string
  price: number
  quantity: number
}

class Accepted {
  private readonly prices = new Map<string, number[]>()

  add(key: string, price: unknown): void {
    if (price === null || price === undefined || price === '') return
    const n = Number(price)
    if (!Number.isFinite(n)) return
    const list = this.prices.get(key)
    if (list) list.push(n)
    else this.prices.set(key, [n])
  }

  addLines(lines: readonly any[] | null | undefined, priceOf: (l: any) => unknown = l => l?.unitPrice): void {
    for (const l of lines ?? []) this.add(articleOf(l), priceOf(l))
  }

  holds(key: string, price: number): boolean {
    return (this.prices.get(key) ?? []).some(p => Math.abs(p - price) <= PRICE_TOLERANCE)
  }
}

const idOf = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null
  const s = String((v as any)?._id ?? v)
  return isValidObjectId(s) ? s : null
}

/** What the engine offers an article: its selling price, every named price, the resolved one. */
async function addOffered(orgId: string, accepted: Accepted, pending: Priced[], contactId: string | undefined): Promise<void> {
  const seen = new Set<string>()
  for (const p of pending) {
    if (!p.key || !isValidObjectId(p.key) || seen.has(`${p.key}|${p.quantity}`)) continue
    seen.add(`${p.key}|${p.quantity}`)
    // Another organization's article, or one gone: nothing offered (the route's reference checks say the rest).
    const product: any = await Product.findOne({ _id: p.key, orgId } as any, { sellingPrice: 1 }).lean().exec()
    if (!product) continue
    // A pick starts from the selling price: an article without one starts at 0.
    accepted.add(p.key, product.sellingPrice ?? 0)
    try {
      const { options } = await listPriceOptions(orgId, p.key, contactId, p.quantity, undefined, { all: true })
      for (const o of options) accepted.add(p.key, o.price)
    } catch { /* no options: the selling price stands */ }
    try {
      accepted.add(p.key, (await resolvePrice(orgId, p.key, contactId, p.quantity)).finalPrice)
    } catch { /* no resolution */ }
  }
}

/**
 * What the client was charged before, on documents of theirs (this one left out). A payment receipt repeats its
 * invoice's lines, so it says nothing the invoice does not (`NOT_PAYMENT_RECEIPT`).
 */
async function addHistory(orgId: string, accepted: Accepted, contactId: string, excludeId?: string): Promise<void> {
  const notThis = excludeId && isValidObjectId(excludeId) ? { _id: { $ne: excludeId } } : {}
  const earlier = await Invoice.find(
    { orgId, contactId, direction: 'outgoing', status: { $nin: ['voided', 'cancelled'] }, ...NOT_PAYMENT_RECEIPT, ...notThis } as any,
    { 'lines.productId': 1, 'lines.unitPrice': 1 },
  ).sort({ issueDate: -1 }).limit(HISTORY_DOCUMENTS).lean().exec()
  for (const doc of earlier as any[]) accepted.addLines(doc.lines)
}

function refusal(left: Priced[], what: 'line' | 'order'): PriceRefusal {
  const numbers = left.map(p => p.index + 1)
  const where = numbers.length === 1 ? `line ${numbers[0]}` : `lines ${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`
  const price = what === 'order' ? 'The price chosen on' : 'The price on'
  return {
    code: 'price_not_offered',
    capabilities: ['sales-docs.manual-price'],
    message: `${price} ${where} is not one offered for its article. Your role picks a line's price from the prices offered; typing one is not part of it.`,
    lines: left.map(p => ({ line: p.index + 1, ...(p.key ? { productId: p.key } : {}), unitPrice: p.price })),
  }
}

export interface PricedDocument {
  direction?: string | null
  contactId?: unknown
  relatedInvoiceId?: unknown
  lines?: readonly any[] | null
}

/**
 * Rule 1 on a sales document: null when this session may save these line prices, else why not (403). Only an outgoing
 * document, only a session without `sales-docs.manual-price`; an Administrator and every role that may type pass at
 * once, and a save that sends no lines asks nothing.
 *
 * `stored` is the document's lines before this save, `excludeId` its id (an update).
 */
export async function typedPriceRefusal(
  orgId: string,
  user: AccessCaller | null | undefined,
  doc: PricedDocument,
  opts: { stored?: readonly any[] | null; excludeId?: string } = {},
): Promise<PriceRefusal | null> {
  if (doc.direction !== 'outgoing' || !Array.isArray(doc.lines) || !doc.lines.length) return null
  if (!user || can(user, 'sales-docs.manual-price')) return null

  const lines: Priced[] = doc.lines.map((l: any, index: number) => ({
    index,
    key: articleOf(l),
    price: Number(l?.unitPrice) || 0,
    quantity: Number(l?.quantity) > 0 ? Number(l.quantity) : 1,
  }))
  const accepted = new Accepted()
  const pending = () => lines.filter(p => !accepted.holds(p.key, p.price))

  // A typed line at no price is what the form makes of one; the document's own lines are not this save's figures.
  accepted.add('', 0)
  accepted.addLines(opts.stored)
  if (!pending().length) return null

  const relatedId = idOf(doc.relatedInvoiceId)
  if (relatedId) {
    const related: any = await Invoice.findOne({ _id: relatedId, orgId } as any, { 'lines.productId': 1, 'lines.unitPrice': 1 }).lean().exec()
    accepted.addLines(related?.lines)
  }
  const contactId = idOf(doc.contactId) ?? undefined
  if (contactId) await addHistory(orgId, accepted, contactId, opts.excludeId)
  if (!pending().length) return null

  // An invoice line converted from a customer order: that order line's price.
  const orderIds = [...new Set(pending().map(p => idOf(doc.lines![p.index]?.orderRef?.internalOrderId)).filter((id): id is string => !!id))]
  if (orderIds.length) {
    const orders = await InternalOrder.find({ orgId, _id: { $in: orderIds } } as any, { 'lines.productId': 1, 'lines.expectedUnitPrice': 1 }).lean().exec()
    for (const o of orders as any[]) accepted.addLines(o.lines, l => l?.expectedUnitPrice)
  }
  if (!pending().length) return null

  await addOffered(orgId, accepted, pending(), contactId)
  const left = pending()
  return left.length ? refusal(left, 'line') : null
}

/**
 * Rule 1 on a customer order: a price CHOSEN on its line (pinned, `config/order-line-price`) is what the order's
 * invoice charges (#695), so it is held as an invoice line's is. An indication (not pinned) charges nothing and is
 * not asked about.
 */
export async function pinnedPriceRefusal(
  orgId: string,
  user: AccessCaller | null | undefined,
  order: { contactId?: unknown; lines?: readonly any[] | null },
  stored?: readonly any[] | null,
): Promise<PriceRefusal | null> {
  if (!Array.isArray(order.lines) || !order.lines.length) return null
  if (!user || can(user, 'sales-docs.manual-price')) return null

  const storedById = new Map((stored ?? []).map((l: any) => [String(l?._id ?? ''), l]))
  const lines: Priced[] = []
  order.lines.forEach((l: any, index: number) => {
    const was = l?._id ? storedById.get(String(l._id)) : undefined
    if (!linePricePinned(l, was)) return
    lines.push({ index, key: articleOf(l), price: chargeablePrice(l.expectedUnitPrice) ?? 0, quantity: Number(l?.quantity) > 0 ? Number(l.quantity) : 1 })
  })
  if (!lines.length) return null

  const accepted = new Accepted()
  const pending = () => lines.filter(p => !accepted.holds(p.key, p.price))
  // A price this order already carries is not this save's (an order saved back, a line moved).
  accepted.addLines(stored, l => l?.expectedUnitPrice)
  if (!pending().length) return null
  await addOffered(orgId, accepted, pending(), idOf(order.contactId) ?? undefined)
  const left = pending()
  return left.length ? refusal(left, 'order') : null
}

/**
 * Rule 2: an outgoing document's lines, each of an article carrying that article's unit, as the form puts it there
 * (`line.unit = product.unit`) and then locks it. A line the document already holds at its unit keeps it (a save of
 * a document from before the rule, or of a conversion's draft, rewrites nothing), and so does a note's line at the
 * unit its invoice sold the article in (`relatedInvoiceId`: the note repeats the lines as they were sold). An article
 * without a unit leaves the line as it is. The importers send the article's unit already (`map-invoice`, the till
 * day's mapper).
 */
export async function withArticleUnits<L extends Record<string, any>>(
  orgId: string,
  direction: string | null | undefined,
  lines: L[] | undefined,
  stored?: readonly any[] | null,
  opts: { relatedInvoiceId?: unknown } = {},
): Promise<L[] | undefined> {
  if (direction !== 'outgoing' || !Array.isArray(lines) || !lines.length) return lines
  const ids = [...new Set(lines.map(articleOf).filter(id => id && isValidObjectId(id)))]
  if (!ids.length) return lines
  const products = await Product.find({ orgId, _id: { $in: ids } } as any, { unit: 1 }).lean().exec()
  const unitOf = new Map((products as any[]).map(p => [String(p._id), typeof p.unit === 'string' ? p.unit : '']))
  const relatedId = idOf(opts.relatedInvoiceId)
  const related: any = relatedId ? await Invoice.findOne({ _id: relatedId, orgId } as any, { 'lines.productId': 1, 'lines.unit': 1 }).lean().exec() : null
  const kept = new Set([...(stored ?? []), ...(related?.lines ?? [])].map((l: any) => `${articleOf(l)}|${l?.unit ?? ''}`))
  return lines.map(l => {
    const key = articleOf(l)
    const unit = unitOf.get(key)
    if (!key || !unit || l.unit === unit || kept.has(`${key}|${l.unit ?? ''}`)) return l
    return { ...l, unit }
  })
}
