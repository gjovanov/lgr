/**
 * POS totals: ONE implementation shared by the terminal screen, the server's validation and
 * the printed receipt.
 *
 * They used to be computed twice. The screen rounded VAT line by line and the server did
 * not, and a ±0.02 tolerance let the difference through. So a valve at 17.8952 net asked the
 * customer for 21.48 while the receipt printed a total of 21.47 with 0.01 change. A strainer
 * at 4.2233 net was taken for 5.06 on a 5.07 sale.
 *
 * Prices are NET. The customer pays the VAT-inclusive amount, rounded to the cent once per
 * VAT rate, the way a fiscal device totals a receipt. VAT is taken back out of that rounded
 * gross per rate, as the device prints it, and the net is what remains. So the printed
 * subtotal − discount + VAT always equals the total to the cent: no more 17.90 + 3.58
 * printed above a 21.47 total.
 */
export interface PosTotalsLine {
  quantity: number
  unitPrice: number
  /** Percent. */
  discount?: number
  /** Percent. */
  taxRate?: number
}

export interface PosTotals {
  subtotal: number
  discountTotal: number
  taxTotal: number
  total: number
}

export function computePosTotals(lines: PosTotalsLine[]): PosTotals {
  const grossByRate = new Map<number, number>()
  let discount = 0
  for (const line of lines) {
    const base = line.quantity * line.unitPrice
    const lineDiscount = base * ((line.discount || 0) / 100)
    const rate = line.taxRate || 0
    discount += lineDiscount
    grossByRate.set(rate, (grossByRate.get(rate) || 0) + (base - lineDiscount) * (1 + rate / 100))
  }

  let total = 0
  let taxTotal = 0
  for (const [rate, gross] of grossByRate) {
    const rounded = roundCents(gross)
    total += rounded
    taxTotal += roundCents((rounded * rate) / (100 + rate))
  }
  total = roundCents(total)
  taxTotal = roundCents(taxTotal)
  const discountTotal = roundCents(discount)

  return { subtotal: roundCents(total - taxTotal + discountTotal), discountTotal, taxTotal, total }
}

/**
 * Half away from zero, to the cent. The relative epsilon is what keeps 8.575 from becoming
 * 8.57: its binary value sits just below the half, and an absolute epsilon (the usual
 * `n + Number.EPSILON`) is too small to lift it once the value is above a few units.
 */
export function roundCents(n: number): number {
  return Math.round(n * 100 * (1 + Number.EPSILON)) / 100
}
