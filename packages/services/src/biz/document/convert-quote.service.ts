import { kindOfDocument, writesKind } from 'config/access'
import { QUOTE_CONVERTS_TO, isQuoteType } from 'config/constants'
import { Invoice } from 'db/models'
import { getRepos } from '../../context.js'
import { grantOf } from '../access/evaluate.js'
import { createAuditEntry } from '../audit-log.service.js'
import { getNextDraftInvoiceNumber, getNextInvoiceNumber } from '../invoice-numbering.service.js'
import { syncOrderForInvoice } from '../reservation.service.js'
import { statusEntry } from './document-checks.js'
import { refuse } from './refused.js'

/**
 * FR-22.22: a quote becomes the next document, once. A proforma becomes an invoice; an offer becomes a
 * proforma or an invoice (`target`: the invoice when none is named, the only target a proforma has).
 *
 * The new document is a DRAFT under a number of its own draft series, as a draft made by hand is
 * (FR-22.3): issuing it draws the issued number, so no number of a series is left on no document. It
 * carries the deal over — the lines and prices, how it is paid, where it is made, what it is filed
 * under, the validity as its due date — and names where it came from: `proformaId`, `offerId` (a
 * proforma made from an offer passes the offer on to its invoice). Nothing moves: no stock, no entry,
 * until the invoice is issued.
 *
 * ⚠ Once, even for two presses at once (a double click, two tabs, „→ Проформа" and „→ Фактура" on one
 * offer): the quote is marked converted by a compare-and-set AFTER its new draft exists, and the press
 * that loses takes its draft back and is told what won. A crash in between leaves an unlinked draft a
 * person can delete, never a quote converted into nothing.
 *
 * FR-32.21 (#797): moved whole from `POST /invoices/:id/convert`. The answer is `{ invoice }`, or a `Refused` with the
 * route's status and body.
 */
export async function convertQuote(orgId: string, id: string, user: any, requested: unknown): Promise<unknown> {
  const r = getRepos()

  const quote: any = await r.invoices.findOne({ id, orgId })
  if (!quote) return refuse(404, { message: 'Invoice not found' })
  if (!isQuoteType(quote.type) || quote.direction !== 'outgoing') {
    return refuse(400, { code: 'not_a_quote', message: 'Only a proforma or an offer can be converted' })
  }
  const offered: readonly string[] = QUOTE_CONVERTS_TO[quote.type]
  const target: any = requested ?? offered[0]
  if (!offered.includes(target)) {
    return refuse(400, { code: 'conversion_not_offered', message: `A ${quote.type} is converted into ${offered.map(t => `a ${t}`).join(' or ')}, not into a ${target}` })
  }
  if (quote.status === 'converted') {
    return refuse(400, { code: 'already_converted', message: `${quote.invoiceNumber} is already converted` })
  }
  // A quote withdrawn is not accepted after all. The lists never offered it; the route converted one anyway.
  if (['voided', 'cancelled'].includes(quote.status)) {
    return refuse(400, { code: 'quote_withdrawn', message: `${quote.invoiceNumber} is ${quote.status}: it can no longer be converted` })
  }
  // FR-27.6: what it becomes is a document of its own kind, which the role must make. A role that works
  // proformas and makes no sales documents converted one into an invoice all the same.
  const targetKind = kindOfDocument({ direction: quote.direction, type: target })
  if (!writesKind(grantOf(user), targetKind, 'create')) {
    const feature = targetKind === 'sales' ? 'sales-docs' : targetKind
    return refuse(403, { code: 'capability_required', capabilities: [`${feature}.create`], message: 'The document this converts into is not one your role makes.' })
  }

  // FR-22.3: a DRAFT, so a number of the draft series, as a draft made by hand takes (POST /). It took one
  // from the ISSUED series, and issuing it took another: the first was left on no document.
  const number = (await getNextDraftInvoiceNumber(orgId, quote.direction, target))
    || (await getNextInvoiceNumber(orgId, quote.direction, target))
  // The offer behind it: this one, or the one the proforma was made from.
  const offerId = quote.type === 'offer' ? quote.id : quote.offerId

  const draft: any = {
    orgId,
    type: target,
    direction: quote.direction,
    contactId: quote.contactId,
    invoiceNumber: number,
    numberHistory: [{ number, allocatedAt: new Date(), status: 'draft' }],
    issueDate: new Date(),
    // A quote keeps its validity as its dueDate (B-11): the invoice's due date, the proforma's validity.
    dueDate: quote.dueDate,
    currency: quote.currency,
    exchangeRate: quote.exchangeRate,
    reference: quote.reference,
    lines: quote.lines,
    subtotal: quote.subtotal,
    discountTotal: quote.discountTotal,
    taxTotal: quote.taxTotal,
    total: quote.total,
    totalBase: quote.totalBase,
    amountDue: quote.total,
    notes: quote.notes,
    terms: quote.terms,
    footer: quote.footer,
    // FR-22.22: the deal the customer accepted — how it is paid, where it is made, what it is
    // filed under. A card proforma used to become an invoice with no method, so issuing it left
    // the card sale unpaid (FR-22.19).
    paymentMethod: quote.paymentMethod,
    placeOfTransaction: quote.placeOfTransaction,
    tags: quote.tags || [],
    billingAddress: quote.billingAddress,
    shippingAddress: quote.shippingAddress,
    ...(quote.type === 'proforma' ? { proformaId: quote.id } : {}),
    ...(offerId ? { offerId } : {}),
    status: 'draft',
    statusHistory: [statusEntry('draft', undefined, user.id, `converted_from_${quote.type} ${quote.invoiceNumber}`)],
    createdBy: user.id,
  }
  const created = await r.invoices.create(draft)

  // Once: the quote is taken by a compare-and-set on what it was read as.
  const taken = await Invoice.findOneAndUpdate(
    { _id: id, orgId, type: quote.type, status: quote.status, convertedInvoiceId: null },
    {
      $set: { status: 'converted', convertedInvoiceId: created.id },
      $push: { statusHistory: statusEntry('converted', quote.status, user.id, `converted_to ${created.invoiceNumber}`) },
    },
  ).exec()
  if (!taken) {
    // Another press won (or the quote was voided meanwhile): its draft goes, a gap in a draft series only.
    await r.invoices.deleteInOrg(created.id, orgId)
    const now: any = await Invoice.findOne({ _id: id, orgId }, { status: 1, convertedInvoiceId: 1 }).lean().exec()
    const won: any = now?.convertedInvoiceId
      ? await Invoice.findOne({ _id: now.convertedInvoiceId, orgId }, { invoiceNumber: 1, type: 1 }).lean().exec()
      : null
    return refuse(409, {
      code: 'already_converted',
      ...(won ? { convertedInvoiceId: String(won._id), convertedInvoiceNumber: won.invoiceNumber, convertedInvoiceType: won.type } : {}),
      message: won
        ? `${quote.invoiceNumber} was converted into ${won.invoiceNumber} meanwhile`
        : `${quote.invoiceNumber} changed meanwhile (${now?.status ?? 'deleted'}): it can no longer be converted`,
    })
  }

  // An invoice may have inherited order/reservation refs from the quote's lines — derive the counters
  // (the quote itself never counts: reservation aggregation is scoped to type 'invoice').
  if (target === 'invoice') await syncOrderForInvoice(orgId, created, user.id)

  createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'invoicing', entityType: 'invoice', entityId: created.id, entityName: created.invoiceNumber, correlationId: id })
  createAuditEntry({
    orgId, userId: user.id, action: 'convert', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: quote.invoiceNumber,
    changes: { status: { from: quote.status, to: 'converted' }, [target]: { to: created.invoiceNumber } }, correlationId: id,
  })

  return { invoice: created }
}
