import { describe, it, expect } from 'bun:test'
import { computePosTotals, roundCents, tillLineAmounts, tillTotals } from 'config/pos-totals'

/**
 * The shared POS totals: the terminal screen, the server's validation and the receipt all
 * compute with this one function. The cases are the regal-pz till tests of 2026-09-28, where
 * the screen (VAT rounded per line) and the receipt (VAT unrounded) disagreed by a cent.
 */
describe('computePosTotals', () => {
  it('charges what a fiscal device would print: 17.8952 net at 20 % is 21.47, not 21.48', () => {
    expect(computePosTotals([{ quantity: 1, unitPrice: 17.8952, taxRate: 20 }]))
      .toEqual({ subtotal: 17.89, discountTotal: 0, taxTotal: 3.58, total: 21.47 })
  })

  it('does not undercharge either: 4.2233 net at 20 % is 5.07, not 5.06', () => {
    expect(computePosTotals([{ quantity: 1, unitPrice: 4.2233, taxRate: 20 }]).total).toBe(5.07)
    expect(computePosTotals([{ quantity: 1, unitPrice: 8.692, taxRate: 20 }]).total).toBe(10.43)
  })

  it('keeps round numbers round', () => {
    expect(computePosTotals([{ quantity: 2, unitPrice: 10, taxRate: 20 }]))
      .toEqual({ subtotal: 20, discountTotal: 0, taxTotal: 4, total: 24 })
  })

  it('extracts VAT per rate from the rounded gross, and applies line discounts', () => {
    const totals = computePosTotals([
      { quantity: 3, unitPrice: 1.2345, taxRate: 20 },
      { quantity: 2, unitPrice: 5.55, taxRate: 9 },
      { quantity: 1, unitPrice: 2, taxRate: 0, discount: 10 },
    ])
    // 20 %: 4.4442 → 4.44, VAT 0.74 · 9 %: 12.099 → 12.10, VAT 1.00 · 0 %: 1.80
    expect(totals).toEqual({ subtotal: 16.8, discountTotal: 0.2, taxTotal: 1.74, total: 18.34 })
  })

  it('prints figures that add up: subtotal − discount + VAT = total, for any cart', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    for (let cart = 0; cart < 2000; cart++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => ({
        quantity: 1 + Math.floor(rnd() * 120),
        unitPrice: Math.round(rnd() * 400 * 10000) / 10000, // 4-decimal net prices, like the imports
        taxRate: [0, 9, 20][Math.floor(rnd() * 3)],
        discount: rnd() < 0.2 ? Math.floor(rnd() * 30) : 0,
      }))
      const t = computePosTotals(lines)
      expect(roundCents(t.subtotal - t.discountTotal + t.taxTotal)).toBe(t.total)
      for (const v of Object.values(t)) expect(roundCents(v)).toBe(v)
    }
  })

  it('is empty for an empty cart', () => {
    expect(computePosTotals([])).toEqual({ subtotal: 0, discountTotal: 0, taxTotal: 0, total: 0 })
  })
})

describe('tillTotals (#554)', () => {
  it('what the till shows is what it stores: the VAT its device takes out of the shares its lines give it', () => {
    const cart = [{ quantity: 1, unitPrice: 4.2233, taxRate: 20 }, { quantity: 1, unitPrice: 5.5555, taxRate: 9 }]
    expect(computePosTotals(cart)).toMatchObject({ total: 11.13, taxTotal: 1.35, subtotal: 9.78 })
    // Lines of 5.06 and 6.06 share out 11.13 as 5.06 and 6.07: VAT 0.84 + 0.50.
    expect(tillTotals(cart)).toEqual({ total: 11.13, discountTotal: 0, taxTotal: 1.34, subtotal: 9.79 })
    expect(cart.map(tillLineAmounts)).toEqual([{ taxAmount: 0.84, lineTotal: 4.2233 }, { taxAmount: 0.5, lineTotal: 5.5555 }])
  })

  it('one rate, or lines that print exactly: computePosTotals\' own figures', () => {
    for (const cart of [
      [{ quantity: 3, unitPrice: 17.8952, taxRate: 20 }, { quantity: 7, unitPrice: 4.2233, taxRate: 20 }],
      [{ quantity: 2, unitPrice: 10, taxRate: 20 }, { quantity: 3, unitPrice: 1, taxRate: 9 }],
      [],
    ]) expect(tillTotals(cart)).toEqual(computePosTotals(cart))
  })
})

describe('roundCents', () => {
  it('rounds half away from zero, including values whose binary form sits just below the half', () => {
    expect(roundCents(1.005)).toBe(1.01)
    expect(roundCents(8.575)).toBe(8.58) // `(n + Number.EPSILON) * 100` gives 8.57
    expect(roundCents(1234.565)).toBe(1234.57)
    expect(roundCents(-1234.565)).toBe(-1234.57)
    expect(roundCents(21.47424)).toBe(21.47)
  })
})
