/**
 * FR-22.23: what a document list row offers — exactly what the API allows for it, so no action is
 * shown that the server would refuse. Pure, so `integration/document-row-actions.flow` holds every
 * rule against the real routes (`invoice.controller`). The lists used to offer „Анулирай" on drafts
 * only (the one state where voiding meant nothing: Delete is what a draft wants) and Delete on
 * every row, where the API refuses all but drafts.
 */

export interface RowDoc {
  type?: string
  direction?: string
  status: string
  /** An invoice issued for a cash sale (#171): the list carries the sale's id. */
  cashSaleId?: string
}

/** Statuses of an issued document that still owes money. */
const OWING = ['sent', 'received', 'partially_paid', 'overdue']

/** Issue it („Издай"; „Получи" on a bill): only a draft is issued (`/send`, `/receive`). */
export function canIssue(d: RowDoc): boolean {
  return d.status === 'draft'
}

/** Delete: drafts only (`DELETE /invoices/:id`). */
export function canDelete(d: RowDoc): boolean {
  return d.status === 'draft'
}

/**
 * Void: an issued document `/void` takes — `sent` or `received`, or `paid` for an invoice issued
 * for a cash sale. The API takes a draft too, but a draft is deleted, not voided.
 */
export function canVoid(d: RowDoc): boolean {
  return (d.cashSaleId ? ['paid'] : ['sent', 'received']).includes(d.status)
}

/**
 * Record a payment: an issued document that still owes. (The API refuses voided, cancelled and paid
 * documents; it would take a payment on a draft, which owes nothing yet — except a supplier's bill,
 * which is sometimes paid before its goods are received, as the bills list always offered.)
 */
export function canRecordPayment(d: RowDoc): boolean {
  if (d.type === 'proforma' || d.type === 'cash_sale') return false
  return OWING.includes(d.status) || (d.direction === 'incoming' && d.status === 'draft')
}

/** A credit or debit note corrects an issued invoice (`validateRelatedInvoiceRef`). */
export function canCorrect(d: RowDoc): boolean {
  return (d.type || 'invoice') === 'invoice' && ['sent', 'received', 'partially_paid', 'paid', 'overdue'].includes(d.status)
}

/** Email: an outgoing document once it is issued (FR-10: a draft's DRF- number is never sent). */
export function canEmail(d: RowDoc): boolean {
  return d.direction !== 'incoming' && d.status !== 'draft'
}

/** Copy into a new draft — not an invoice for a cash sale, whose lines are the sale's (#171). */
export function canCopy(d: RowDoc): boolean {
  return !d.cashSaleId
}

/** A proforma becomes an invoice once — and not after it was voided. */
export function canConvert(d: RowDoc): boolean {
  return d.type === 'proforma' && !['converted', 'voided', 'cancelled'].includes(d.status)
}
