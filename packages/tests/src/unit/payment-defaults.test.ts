import { describe, it, expect } from 'bun:test'
// PURE module — reached by path like document-payload: `invoicing-ui` is a private app package.
import { defaultPaymentMethod, outstandingAmount } from '../../../invoicing-ui/src/composables/payment-defaults'

/**
 * FR-22.7 (B-9): the record-payment dialog suggests what the document still owes, by the method
 * the document says it is paid with. It suggested the whole total and a bank transfer: it read a
 * `paidAmount` the API never returns (the field is `amountPaid`).
 */

const OFFERED = ['cash', 'card', 'bank_transfer', 'cash_on_delivery']

describe('outstandingAmount', () => {
  it('is the total less what has been paid, from `amountPaid`', () => {
    expect(outstandingAmount({ total: 120, amountPaid: 50 })).toBe(70)
    // The row the dialog is opened from carries amountPaid, never paidAmount.
    expect(outstandingAmount({ total: 120, amountPaid: 50, paidAmount: 0 } as any)).toBe(70)
  })

  it('is the whole total when nothing has been paid', () => {
    expect(outstandingAmount({ total: 183.6 })).toBe(183.6)
    expect(outstandingAmount({ total: 183.6, amountPaid: 0 })).toBe(183.6)
  })

  it('is rounded to the cent and never negative', () => {
    expect(outstandingAmount({ total: 100.1, amountPaid: 33.37 })).toBe(66.73)
    expect(outstandingAmount({ total: 100, amountPaid: 150 })).toBe(0)
    expect(outstandingAmount(null)).toBe(0)
  })
})

describe('defaultPaymentMethod', () => {
  it("is the document's own method when the dialog offers it", () => {
    expect(defaultPaymentMethod({ paymentMethod: 'card' }, OFFERED)).toBe('card')
    expect(defaultPaymentMethod({ paymentMethod: 'cash' }, OFFERED)).toBe('cash')
    expect(defaultPaymentMethod({ paymentMethod: 'cash_on_delivery' }, OFFERED)).toBe('cash_on_delivery')
  })

  it('falls back to a bank transfer, the old default, when the document names none the dialog offers', () => {
    expect(defaultPaymentMethod({}, OFFERED)).toBe('bank_transfer')
    expect(defaultPaymentMethod({ paymentMethod: '' }, OFFERED)).toBe('bank_transfer')
    expect(defaultPaymentMethod({ paymentMethod: 'check' }, OFFERED)).toBe('bank_transfer')
    expect(defaultPaymentMethod(undefined, OFFERED)).toBe('bank_transfer')
  })
})
