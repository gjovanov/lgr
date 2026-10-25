import { mongoose } from 'db/connection'
import { Invoice } from 'db/models'

const { Types } = mongoose

/**
 * Which documents count as a sale, once an invoice can be issued for a cash sale (#171).
 *
 * The cash sale moved the stock and took the money. The invoice issued for it is the tax
 * document for the same sale, so a reader that counted both would count the sale twice. Two
 * rules decide which one counts, and every reader uses one of them:
 *
 *   - **Totals** (the digest, the dashboard, sales history and the product ledger without a
 *     customer): the cash sale counts; an invoice carrying `cashSaleRef` does not.
 *   - **Per customer** (the contact ledger, and the same reports filtered by a customer): the
 *     invoice counts for ITS customer, and a cash sale that has an issued invoice no longer
 *     counts for the cash sale's own contact. That needs no quantity arithmetic, because a cash
 *     sale that names a customer is only ever invoiced whole (`cash-sale-invoice.service.ts`).
 *
 * Credit and debit notes are not touched by either rule. A credit note written against such an
 * invoice is an ordinary correction — it returns the stock and counts negative — so it must
 * keep counting; `cashSaleRef` is only ever set on type `invoice`.
 *
 * FR-21's readers inherit both rules: its counting rule (FR-21.1) is applied on top of these.
 */

/** The `cashSaleRef` field that marks an invoice issued for a cash sale. */
export const CASH_SALE_REF_ID = 'cashSaleRef.cashSaleId'

/** Totals rule, as a match fragment: leave out the invoices issued for a cash sale. */
export const NOT_INVOICE_FOR_CASH_SALE: Record<string, any> = { [CASH_SALE_REF_ID]: { $exists: false } }

/** Statuses of an invoice that is not (or no longer) a document. */
const NOT_A_DOCUMENT = ['draft', 'voided', 'cancelled']

/** True for an invoice issued for a cash sale. */
export function isInvoiceForCashSale(doc: { type?: string; cashSaleRef?: { cashSaleId?: unknown } | null } | null | undefined): boolean {
  return !!doc && doc.type === 'invoice' && !!doc.cashSaleRef?.cashSaleId
}

/**
 * Per-customer rule: the cash sales of `contactId` that an issued invoice now stands for. A
 * customer-scoped reader leaves these out — the invoice is counted instead, for whichever
 * customer it names.
 *
 * `statuses` are the invoice statuses the caller treats as "not a document" (drafts by default:
 * a draft is not counted, so it must not take its cash sale out of the count either).
 */
export async function cashSalesInvoicedAway(
  orgId: string,
  contactId: string,
  opts: { excludeStatuses?: string[] } = {},
): Promise<any[]> {
  const ids = await Invoice.distinct(CASH_SALE_REF_ID, {
    orgId: new Types.ObjectId(orgId),
    type: 'invoice',
    'cashSaleRef.contactId': new Types.ObjectId(contactId),
    status: { $nin: opts.excludeStatuses ?? NOT_A_DOCUMENT },
  } as any).exec()
  return (ids as unknown[]).map(id => new Types.ObjectId(String(id)))
}

/**
 * The match fragment a reader adds for its scope: the totals rule, or — with a customer — the
 * per-customer rule. Returned as an object to spread into the reader's own `$match`.
 */
export async function saleScopeFilter(orgId: string, contactId?: string | null): Promise<Record<string, any>> {
  if (!contactId) return { ...NOT_INVOICE_FOR_CASH_SALE }
  const away = await cashSalesInvoicedAway(orgId, contactId)
  return away.length ? { _id: { $nin: away } } : {}
}
