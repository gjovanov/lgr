import { describe, it, expect } from 'bun:test'
import {
  invoiceLineFrom, invoiceTotalsOf, overClaimed, claimedByLine, mirroredPayments,
} from 'services/biz/cash-sale-invoice.service'
import { isInvoiceForCashSale, NOT_INVOICE_FOR_CASH_SALE } from 'services/biz/sale-counting'
import { buildInvoiceHtml } from 'reporting/pdf/invoice.pdf'

/**
 * #171: the pure parts of an invoice for a cash sale — how a sale's line becomes an invoice
 * line, how claims on the sale's quantities are ordered, and how the cash sale's money is
 * mirrored. The HTTP behaviour is in `integration/cash-sale-invoice.flow.test.ts`.
 */

describe('a cash-sale line on an invoice', () => {
  it('keeps the sale\'s price and VAT and recomputes the amounts gross, as an invoice line is', () => {
    // An imported till day stores lineTotal NET (FR-21 B-5): 3 × 1.3333 = 4.00 net.
    const src = { _id: 'L1', productId: 'P1', description: 'Болт М8', quantity: 3, unit: 'бр', unitPrice: 1.3333, taxRate: 20, sourceText: 'БОЛТ М8' }
    const line = invoiceLineFrom(src as any, 3)
    expect(line).toMatchObject({ productId: 'P1', quantity: 3, unitPrice: 1.3333, taxRate: 20, discount: 0, cashSaleLineId: 'L1', sourceText: 'БОЛТ М8' })
    expect(line.taxAmount).toBe(0.8)
    expect(line.lineTotal).toBe(4.8)
  })

  it('never carries an order reference over', () => {
    const line = invoiceLineFrom({ _id: 'L1', quantity: 1, unitPrice: 1, orderRef: { reservationId: 'R1' } } as any, 1)
    expect(line.orderRef).toBeUndefined()
  })

  it('totals round each component first, like the document forms', () => {
    const totals = invoiceTotalsOf([
      { quantity: 3, unitPrice: 0.0767, discount: 0, taxRate: 20 },
      { quantity: 1, unitPrice: 10, discount: 10, taxRate: 20 },
    ])
    expect(totals).toEqual({ subtotal: 10.23, discountTotal: 1, taxTotal: 1.85, total: 11.08 })
  })
})

describe('claims on a cash sale', () => {
  const sold = new Map([['L1', 5]])
  const claim = (id: string, q: number) => ({ id, lines: new Map([['L1', q]]) })

  it('the earlier claims win; a later one that does not fit gives way', () => {
    const claims = [claim('b', 2), claim('a', 2), claim('c', 2), claim('d', 2)]
    expect(overClaimed(sold, claims, 'a')).toEqual([])
    expect(overClaimed(sold, claims, 'b')).toEqual([])
    expect(overClaimed(sold, claims, 'c')).toEqual([{ lineId: 'L1', remaining: 1, requested: 2 }])
    // `c` gives way, so it holds nothing — `d` is measured against `a` and `b` alone.
    expect(overClaimed(sold, claims, 'd')).toEqual([{ lineId: 'L1', remaining: 1, requested: 2 }])
  })

  it('a later claim that fits behind a misfit still goes through', () => {
    const claims = [claim('a', 4), claim('b', 3), claim('c', 1)]
    expect(overClaimed(sold, claims, 'b')).toHaveLength(1)
    expect(overClaimed(sold, claims, 'c')).toEqual([])
  })

  it('sums what is claimed per line', () => {
    expect(claimedByLine([claim('a', 2), claim('b', 1.5)]).get('L1')).toBe(3.5)
  })
})

describe('the money of the cash sale', () => {
  const day = new Date('2026-10-20')

  it('is one row by the sale\'s method, marked as the cash register\'s', () => {
    expect(mirroredPayments({ invoiceNumber: 'CS-1', paymentMethod: 'card' }, 24, day)).toEqual([
      { date: day, amount: 24, method: 'card', origin: 'cash_register', reference: 'CS-1' },
    ])
  })

  it('splits tender pro rata to the cent, the remainder to the largest part', () => {
    const rows = mirroredPayments({ invoiceNumber: 'CS-2', payments: [{ method: 'cash', amount: 10 }, { method: 'card', amount: 20 }] }, 10, day)
    expect(rows.map(r => [r.method, r.amount])).toEqual([['cash', 3.33], ['card', 6.67]])
    expect(+rows.reduce((s, r) => s + r.amount, 0).toFixed(2)).toBe(10)
  })

  it('files a method the invoice model does not know as other', () => {
    expect(mirroredPayments({ paymentMethod: 'voucher' }, 5, day)[0].method).toBe('other')
  })
})

describe('the counting rule', () => {
  it('marks only invoices that carry the link', () => {
    expect(isInvoiceForCashSale({ type: 'invoice', cashSaleRef: { cashSaleId: 'x' } })).toBe(true)
    expect(isInvoiceForCashSale({ type: 'credit_note', cashSaleRef: { cashSaleId: 'x' } })).toBe(false)
    expect(isInvoiceForCashSale({ type: 'invoice' })).toBe(false)
    expect(NOT_INVOICE_FOR_CASH_SALE).toEqual({ 'cashSaleRef.cashSaleId': { $exists: false } })
  })
})

describe('the printed invoice', () => {
  const invoice = {
    invoiceNumber: 'INV-2026-00007', type: 'invoice', direction: 'outgoing', currency: 'EUR',
    issueDate: new Date('2026-10-22'), taxEventDate: new Date('2026-10-20'),
    subtotal: 20, taxTotal: 4, total: 24,
    lines: [{ description: 'Болт М8', quantity: 2, unit: 'бр', unitPrice: 10, taxRate: 20, lineTotal: 24 }],
    cashSaleRef: { cashSaleId: 'x', number: 'CS-2026-00031', issueDate: new Date('2026-10-20') },
  }
  const html = (inv: any) => buildInvoiceHtml(inv, { name: 'РЕГАЛ ООД' } as any, { companyName: 'Купувач' } as any, undefined, { locale: 'bg' }).html

  it('names the cash sale, and prints the sale\'s date as the tax event', () => {
    const h = html(invoice)
    expect(h).toContain('Към касова продажба')
    expect(h).toContain('CS-2026-00031')
    expect(h).toMatch(/Дата на данъчното събитие: 20\.10\.2026/)
  })

  it('prints nothing of the kind on an ordinary invoice', () => {
    const { cashSaleRef: _c, taxEventDate: _t, ...plain } = invoice
    const h = html(plain)
    expect(h).not.toContain('Към касова продажба')
    expect(h).toMatch(/Дата на данъчното събитие: 22\.10\.2026/)
  })
})
