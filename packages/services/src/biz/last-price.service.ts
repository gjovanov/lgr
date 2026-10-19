import { mongoose } from 'db/connection'
import { Invoice } from 'db/models'

const { Types } = mongoose

/**
 * #145 — "the last price used for this product for this customer".
 *
 * The most recent ISSUED outgoing sales document to `contactId` that carries the product decides
 * it: a sales invoice or a cash sale. Not a draft (a price nobody charged), not a voided or
 * cancelled one (a price that was taken back), not a proforma (an offer, not a sale) and not a
 * credit or debit note (a correction, whose unit price is not a selling price).
 *
 * ⚠ The line's `unitPrice` — the NET price before the line discount — because that is what an
 * invoice line's price field holds and what this price is copied into. A discount the customer
 * got last time is a separate decision, not part of their price.
 */

export interface LastPrice {
  price: number
  invoiceId: string
  invoiceNumber: string
  issueDate: Date
  currency: string
}

export const LAST_PRICE_TYPES = ['invoice', 'cash_sale'] as const
export const LAST_PRICE_EXCLUDED_STATUSES = ['draft', 'voided', 'cancelled', 'converted'] as const
const MAX_PRODUCTS = 200

export async function lastPricesForContact(
  orgId: string,
  contactId: string,
  productIds: string[],
  options: { currency?: string; excludeInvoiceId?: string } = {},
): Promise<Record<string, LastPrice>> {
  const ids = [...new Set(productIds)].filter(id => Types.ObjectId.isValid(id)).slice(0, MAX_PRODUCTS)
  if (!ids.length || !Types.ObjectId.isValid(contactId)) return {}
  const productOids = ids.map(id => new Types.ObjectId(id))

  const match: Record<string, any> = {
    orgId: new Types.ObjectId(orgId),
    contactId: new Types.ObjectId(contactId),
    direction: 'outgoing',
    type: { $in: [...LAST_PRICE_TYPES] },
    status: { $nin: [...LAST_PRICE_EXCLUDED_STATUSES] },
    'lines.productId': { $in: productOids },
  }
  // ⚠ A price in another currency is not this document's price: 12.00 BGN is not 12.00 EUR.
  if (options.currency) match.currency = options.currency
  // The document being edited must not answer for itself.
  if (options.excludeInvoiceId && Types.ObjectId.isValid(options.excludeInvoiceId)) {
    match._id = { $ne: new Types.ObjectId(options.excludeInvoiceId) }
  }

  const rows = await Invoice.aggregate([
    { $match: match },
    // Newest first; on the same day the later-created document is the later price.
    { $sort: { issueDate: -1, createdAt: -1 } },
    { $unwind: '$lines' },
    { $match: { 'lines.productId': { $in: productOids } } },
    {
      $group: {
        _id: '$lines.productId',
        price: { $first: '$lines.unitPrice' },
        invoiceId: { $first: '$_id' },
        invoiceNumber: { $first: '$invoiceNumber' },
        issueDate: { $first: '$issueDate' },
        currency: { $first: '$currency' },
      },
    },
  ]).exec()

  const out: Record<string, LastPrice> = {}
  for (const r of rows) {
    if (typeof r.price !== 'number' || !Number.isFinite(r.price)) continue
    out[String(r._id)] = {
      price: r.price,
      invoiceId: String(r.invoiceId),
      invoiceNumber: r.invoiceNumber,
      issueDate: r.issueDate,
      currency: r.currency,
    }
  }
  return out
}
