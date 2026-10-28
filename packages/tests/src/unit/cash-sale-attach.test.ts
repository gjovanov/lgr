import { describe, it, expect } from 'bun:test'
import { fitsAsLast, overClaimed, matchInvoiceLines, type Claim, type SaleLineLeft } from 'services/biz/cash-sale-invoice.service'

/**
 * FR-21 §11 — attaching an existing invoice to a cash sale: which sale line each invoice line is,
 * and whether the attached invoice's claim fits when it comes last.
 */

const claim = (id: string, lines: Record<string, number>): Claim => ({ id, lines: new Map(Object.entries(lines)) })

describe('fitsAsLast', () => {
  const sold = new Map([['L1', 5], ['L2', 4]])

  it('takes what every other live claim leaves, whatever its own _id', () => {
    // The attached invoice is OLDER (a) than the conversion (b): it still comes last.
    const claims = [claim('a', { L1: 3 }), claim('b', { L1: 3 })]
    expect(fitsAsLast(sold, claims, 'a')).toEqual([{ lineId: 'L1', remaining: 2, requested: 3 }])
    // overClaimed alone would have let it in: it checks an older claim only against older ones.
    expect(overClaimed(sold, claims, 'a')).toEqual([])
  })

  it('fits when the others leave enough', () => {
    expect(fitsAsLast(sold, [claim('a', { L1: 2, L2: 4 }), claim('b', { L1: 3 })], 'a')).toEqual([])
  })

  it('ignores another claim that is itself giving way', () => {
    // c does not fit beside b, so c holds nothing and a fits.
    expect(fitsAsLast(sold, [claim('b', { L1: 4 }), claim('c', { L1: 3 }), claim('a', { L1: 1 })], 'a')).toEqual([])
  })
})

describe('matchInvoiceLines', () => {
  const sale = (lineId: string, productId: string, remaining: number, unitPrice = 10, extra: Partial<SaleLineLeft> = {}): SaleLineLeft =>
    ({ lineId, productId, description: productId, remaining, unitPrice, discount: 0, taxRate: 20, ...extra })
  const inv = (id: string, productId: string | null, quantity: number, unitPrice = 10, extra: Record<string, any> = {}) =>
    ({ id, productId, description: productId || 'Транспорт', quantity, unitPrice, discount: 0, taxRate: 20, ...extra })

  it('maps each line to the sale line of its article and terms', () => {
    const m = matchInvoiceLines([inv('i1', 'bolt', 2), inv('i2', 'nut', 1, 5)], [sale('s1', 'bolt', 5), sale('s2', 'nut', 4, 5)])
    expect(m.ok).toBe(true)
    if (m.ok) expect([...m.map]).toEqual([['i1', 's1'], ['i2', 's2']])
  })

  it('puts the larger line first, each in the tightest room', () => {
    // Two sale lines of the same bolt: 3 and 5 left. 5 must go to the 5, 3 to the 3.
    const m = matchInvoiceLines([inv('i1', 'bolt', 3), inv('i2', 'bolt', 5)], [sale('s1', 'bolt', 3), sale('s2', 'bolt', 5)])
    expect(m.ok).toBe(true)
    if (m.ok) expect(new Map(m.map)).toEqual(new Map([['i2', 's2'], ['i1', 's1']]))
  })

  it('shares one sale line between lines of the same article', () => {
    expect(matchInvoiceLines([inv('i1', 'bolt', 2), inv('i2', 'bolt', 2)], [sale('s1', 'bolt', 4)]).ok).toBe(true)
    const over = matchInvoiceLines([inv('i1', 'bolt', 3), inv('i2', 'bolt', 2)], [sale('s1', 'bolt', 4)])
    expect(over.ok ? '' : over.code).toBe('line_quantity_exceeds')
  })

  it('refuses a line the sale does not have, at the same terms', () => {
    const codeOf = (r: any) => (r.ok ? 'ok' : r.code)
    expect(codeOf(matchInvoiceLines([inv('i1', 'washer', 1)], [sale('s1', 'bolt', 5)]))).toBe('line_not_in_cash_sale')
    expect(codeOf(matchInvoiceLines([inv('i1', 'bolt', 1, 11)], [sale('s1', 'bolt', 5)]))).toBe('line_terms_differ')
    expect(codeOf(matchInvoiceLines([inv('i1', 'bolt', 1, 10, { taxRate: 9 })], [sale('s1', 'bolt', 5)]))).toBe('line_terms_differ')
    expect(codeOf(matchInvoiceLines([inv('i1', null, 1)], [sale('s1', 'bolt', 5)]))).toBe('line_without_product')
    // Half a cent is the same price; a cent is not.
    expect(codeOf(matchInvoiceLines([inv('i1', 'bolt', 1, 10.004)], [sale('s1', 'bolt', 5)]))).toBe('ok')
    expect(codeOf(matchInvoiceLines([inv('i1', 'bolt', 1, 10.01)], [sale('s1', 'bolt', 5)]))).toBe('line_terms_differ')
  })

  it('against an imported till day, takes the article at its own price, never at another VAT', () => {
    const codeOf = (r: any) => (r.ok ? 'ok' : r.code)
    // A till day's line is the day's average: value ÷ quantity.
    const day = [sale('s1', 'bolt', 5, 9.7667)]
    expect(codeOf(matchInvoiceLines([inv('i1', 'bolt', 2, 10)], day, { tillDay: true }))).toBe('ok')
    expect(codeOf(matchInvoiceLines([inv('i1', 'bolt', 2, 10)], day))).toBe('line_terms_differ')
    expect(codeOf(matchInvoiceLines([inv('i1', 'bolt', 2, 10, { taxRate: 9 })], day, { tillDay: true }))).toBe('line_terms_differ')
    expect(codeOf(matchInvoiceLines([inv('i1', 'bolt', 6, 10)], day, { tillDay: true }))).toBe('line_quantity_exceeds')
  })

  it('lets a line of no quantity through without a claim', () => {
    const m = matchInvoiceLines([inv('i1', 'bolt', 2), inv('i2', null, 0)], [sale('s1', 'bolt', 5)])
    expect(m.ok).toBe(true)
    if (m.ok) expect([...m.map]).toEqual([['i1', 's1']])
  })
})
