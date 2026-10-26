import { describe, it, expect } from 'bun:test'
import { orderInvoiceRows } from '../../../invoicing-ui/src/composables/order-invoices'

/**
 * FR-22.36 — the order forms list their invoices, from the `lookup.invoices` the order's GET
 * returns, each number opening its own form.
 */

describe('the invoices an order lists', () => {
  const rows = orderInvoiceRows({
    b: { invoiceNumber: 'BILL-2026-00003', type: 'invoice', direction: 'incoming', status: 'received', total: 12, currency: 'EUR', issueDate: '2026-10-21T00:00:00.000Z', contactId: 's1' },
    a: { invoiceNumber: 'INV-2026-00010', type: 'invoice', direction: 'outgoing', status: 'sent', total: 30, currency: 'BGN', issueDate: '2026-10-20T00:00:00.000Z', contactId: 'c1' },
    c: { invoiceNumber: 'CN-2026-00001', type: 'credit_note', direction: 'outgoing', status: 'draft', total: 5, issueDate: '2026-10-22T00:00:00.000Z' },
    d: { invoiceNumber: 'PRF-2026-00002', type: 'proforma', direction: 'outgoing', status: 'converted', total: 30, issueDate: '2026-10-19T00:00:00.000Z' },
  })

  it('in the order they were issued', () => {
    expect(rows.map((r) => r.number)).toEqual(['PRF-2026-00002', 'INV-2026-00010', 'BILL-2026-00003', 'CN-2026-00001'])
  })

  it('opens each in its own form: a supplier invoice in the purchase form, a note in the sales form', () => {
    expect(Object.fromEntries(rows.map((r) => [r.number, r.route]))).toEqual({
      'PRF-2026-00002': { name: 'invoicing.proforma.edit', params: { id: 'd' } },
      'INV-2026-00010': { name: 'invoicing.sales.edit', params: { id: 'a' } },
      'BILL-2026-00003': { name: 'invoicing.purchases.edit', params: { id: 'b' } },
      'CN-2026-00001': { name: 'invoicing.sales.edit', params: { id: 'c' } },
    })
  })

  it('says which way an invoice goes, and names other documents by type', () => {
    expect(rows.map((r) => r.typeKey)).toEqual([
      'invoicing.docType.proforma',
      'invoicing.linkedInvoices.outgoing',
      'invoicing.linkedInvoices.incoming',
      'invoicing.docType.credit_note',
    ])
  })

  it('keeps the figures and leaves an unknown currency to the order', () => {
    expect(rows[1]).toMatchObject({ status: 'sent', total: 30, currency: 'BGN', contactId: 'c1' })
    expect(rows[3].currency).toBe('')
  })

  it('lists nothing for an order without invoices', () => {
    expect(orderInvoiceRows(undefined)).toEqual([])
    expect(orderInvoiceRows({})).toEqual([])
  })
})
