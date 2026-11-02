import { describe, it, expect } from 'bun:test'
import { documentAmounts, editedAmounts, withLineAmounts } from 'services/biz/document-amounts'
import { movesPrintedMoney } from 'services/biz/cash-register/receipt-lines'

/** The doors' side is `integration/invoice-edit-amounts.flow.test.ts`. */

const l = (quantity: number, unitPrice: number, extra: Record<string, unknown> = {}) => ({ quantity, unitPrice, taxRate: 20, ...extra })

describe('withLineAmounts', () => {
  it('rounds to the cent, as the form does: no binary noise is stored', () => {
    expect(withLineAmounts(l(3, 0.1))).toMatchObject({ taxAmount: 0.06, lineTotal: 0.36 })
  })

  it('takes the discount off before the VAT', () => {
    expect(withLineAmounts(l(2, 100, { discount: 10 }))).toMatchObject({ taxAmount: 36, lineTotal: 216 })
  })

  it('keeps what the client sent, zero included', () => {
    expect(withLineAmounts(l(2, 100, { taxAmount: 0, lineTotal: 200 }))).toMatchObject({ taxAmount: 0, lineTotal: 200 })
  })

  it('reads a line with no terms as nothing, never as NaN', () => {
    expect(withLineAmounts({})).toEqual({ unit: 'pcs', description: '', taxAmount: 0, lineTotal: 0 })
  })
})

describe('documentAmounts', () => {
  it('sums the VAT its lines sent, or what their numbers make where they sent none', () => {
    expect(documentAmounts({ lines: [l(1, 10, { taxAmount: 2.01 }), l(1, 10)], total: 24.01 }).taxTotal).toBe(4.01)
  })

  it('rounds that sum once, so three lines of 0.066 are 0.20 and not 0.21: the total the client reckoned', () => {
    expect(documentAmounts({ lines: [l(1, 0.33), l(1, 0.33), l(1, 0.33)], total: 1.19 }).taxTotal).toBe(0.2)
  })

  it('takes the header it was sent, under either name, and the base from the total and the rate', () => {
    expect(documentAmounts({ lines: [l(1, 10)], taxTotal: 1.5, total: 12 }).taxTotal).toBe(1.5)
    expect(documentAmounts({ lines: [l(1, 10)], taxAmount: 1.6, total: 12 }).taxTotal).toBe(1.6)
    expect(documentAmounts({ lines: [], total: 12, exchangeRate: 1.5 }).totalBase).toBe(18)
    expect(documentAmounts({ lines: [], total: 12 }).totalBase).toBe(12)
    expect(documentAmounts({ lines: [], total: 12, totalBase: 99 }).totalBase).toBe(99)
  })
})

describe('editedAmounts', () => {
  const stored = { lines: [l(2, 10, { taxAmount: 4, lineTotal: 24 }), l(1, 5, { taxAmount: 1, lineTotal: 6 })], total: 30, exchangeRate: 1 }

  it('an edit of neither lines nor money leaves nothing to write', () => {
    expect(editedAmounts(stored, {})).toEqual({})
  })

  it('the same terms in another order are the same lines', () => {
    const sent = [l(1, 5), l(2, 10)]
    const out = editedAmounts(stored, { lines: sent })
    expect(Object.keys(out)).toEqual(['lines'])
    expect(out.lines).toEqual(sent.map(withLineAmounts))
  })

  it('a different quantity, price, discount or rate are not', () => {
    for (const sent of [l(3, 10), l(2, 11), l(2, 10, { discount: 5 }), l(2, 10, { taxRate: 9 })]) {
      expect(editedAmounts(stored, { lines: [sent, l(1, 5)], total: 30 })).toHaveProperty('taxTotal')
    }
  })

  it('reads a stored line that lost its amounts as what its numbers make', () => {
    const lost = { lines: [l(2, 10)], total: 24 }
    expect(Object.keys(editedAmounts(lost, { lines: [l(2, 10)] }))).toEqual(['lines'])
    expect(movesPrintedMoney(lost, { lines: [l(2, 10, { taxAmount: 4, lineTotal: 24 })] })).toBe(false)
    expect(movesPrintedMoney(lost, { lines: [l(3, 10)] })).toBe(true)
  })
})
