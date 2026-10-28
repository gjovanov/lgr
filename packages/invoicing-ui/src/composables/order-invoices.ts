/**
 * The invoices an order's form lists (FR-22.36), from the `lookup.invoices` its GET returns: the
 * sales invoices converted from it and the supplier invoices booked against it. Pure, unit-tested.
 */

export interface OrderInvoiceInfo {
  invoiceNumber?: string
  type?: string
  direction?: string
  status?: string
  total?: number
  currency?: string
  issueDate?: string
  contactId?: string
}

export interface OrderInvoiceRow {
  id: string
  number: string
  /** The i18n key of what kind of document it is. */
  typeKey: string
  status: string
  total: number
  currency: string
  issueDate?: string
  contactId?: string
  route: { name: string; params: { id: string } }
}

/** Where a document opens. Credit and debit notes open in the sales form, as everywhere else. */
function routeName(i: OrderInvoiceInfo): string {
  if (i.type === 'proforma') return 'invoicing.proforma.edit'
  if (i.type === 'cash_sale') return 'invoicing.cash-sales.edit'
  if (i.direction === 'incoming' && (i.type || 'invoice') === 'invoice') return 'invoicing.purchases.edit'
  return 'invoicing.sales.edit'
}

function typeKey(i: OrderInvoiceInfo): string {
  if ((i.type || 'invoice') !== 'invoice') return `invoicing.docType.${i.type}`
  return i.direction === 'incoming' ? 'invoicing.linkedInvoices.incoming' : 'invoicing.linkedInvoices.outgoing'
}

/** Oldest first, as they happened; a document without a date keeps its place by number. */
export function orderInvoiceRows(invoices: Record<string, OrderInvoiceInfo> | null | undefined): OrderInvoiceRow[] {
  return Object.entries(invoices || {})
    .map(([id, i]) => ({
      id,
      number: i.invoiceNumber || '…',
      typeKey: typeKey(i),
      status: i.status || 'draft',
      total: Number(i.total) || 0,
      currency: i.currency || '',
      issueDate: i.issueDate,
      contactId: i.contactId,
      route: { name: routeName(i), params: { id } },
    }))
    .sort((a, b) => String(a.issueDate || '').localeCompare(String(b.issueDate || '')) || a.number.localeCompare(b.number))
}
