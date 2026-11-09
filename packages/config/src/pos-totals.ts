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
 *
 * The total is the sale's. The VAT and net a sale STORES are its device's (`deviceTotals` below,
 * #554): where its lines do not print exactly and it spans two rates, the device is given the
 * total shared out per rate in the lines' proportions, which can sit a cent from each rate's own
 * rounding here, and its VAT with it. The till's screen (`tillTotals`) and the cash-sale form
 * show those, so what a person reads before saving is what is stored and printed.
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
  const byRate = new Map<number, number>()
  let discount = 0
  for (const line of lines) {
    const base = line.quantity * line.unitPrice
    const lineDiscount = base * ((line.discount || 0) / 100)
    const rate = line.taxRate || 0
    discount += lineDiscount
    byRate.set(rate, (byRate.get(rate) || 0) + (base - lineDiscount) * (1 + rate / 100))
  }

  let total = 0
  let taxTotal = 0
  for (const [rate, gross] of byRate) {
    const rounded = roundCents(gross)
    total += rounded
    taxTotal += roundCents((rounded * rate) / (100 + rate))
  }
  total = roundCents(total)
  taxTotal = roundCents(taxTotal)
  const discountTotal = roundCents(discount)

  return { subtotal: roundCents(total - taxTotal + discountTotal), discountTotal, taxTotal, total }
}

export interface RateShare {
  rate: number
  gross: number
}

/** A document's money as the share rules read it: its total, and each line's rate and gross `lineTotal`. */
export interface GrossSource {
  total?: number
  discountTotal?: number
  lines?: { taxRate?: number; lineTotal?: number }[]
}

const num = (v: unknown) => Number(v) || 0
const toCents = (v: number) => Math.round(num(v) * 100)
const sum = (ns: number[]) => ns.reduce((s, n) => s + n, 0)

/**
 * `cents` shared out in proportion to `weights`, to the cent, largest remainder first. Whole
 * numbers, so nothing is lost to the floats. Null when a weight is negative or nothing weighs.
 */
export function apportion(weights: number[], cents: number): number[] | null {
  if (weights.some(w => w < 0)) return null
  const whole = sum(weights)
  if (whole <= 0) return null
  const exact = weights.map(w => (w * cents) / whole)
  const shares = exact.map(x => Math.floor(x + 1e-9))
  let left = cents - sum(shares)
  const order = exact.map((x, i) => ({ i, rest: x - Math.floor(x + 1e-9) })).sort((a, b) => b.rest - a.rest || a.i - b.i)
  for (const { i } of order) {
    if (left <= 0) break
    shares[i]++
    left--
  }
  return shares
}

/**
 * The document's money per VAT rate, adding up to its total exactly. A line's `lineTotal` is gross
 * on every invoice-side document (FR-21.5); lines and total can still differ by rounding, and the
 * total is what is owed, so it is shared out in the lines' proportions.
 */
export function grossByRate(doc: GrossSource): RateShare[] | null {
  const byRate = new Map<number, number>()
  for (const l of doc.lines || []) {
    const rate = num(l.taxRate)
    byRate.set(rate, (byRate.get(rate) || 0) + num(l.lineTotal))
  }
  const rates = [...byRate.keys()]
  const shares = apportion(rates.map(r => toCents(byRate.get(r)!)), toCents(num(doc.total)))
  return shares && rates.map((rate, i) => ({ rate, gross: shares[i] / 100 }))
}

/** The VAT in a rate's gross, to the cent, as a fiscal device takes it out of the gross it adds up for that rate. */
export function vatOf(share: RateShare): number {
  return roundCents((share.gross * share.rate) / (100 + share.rate))
}

/**
 * #554 — the VAT a fiscal device takes out of this document. A device adds up the money of each VAT rate and takes
 * the VAT out of that, and what it adds up is `grossByRate` either way: `linesOnDevice` (services, receipt-lines)
 * gives it the lines only when they come to those amounts exactly, and a line per rate at them when they do not. So
 * a document storing this books what its receipt printed.
 *
 * `computePosTotals` rounds each rate's own gross instead. Those amounts are the same where the lines print exactly.
 * Where they do not, and the sale spans two rates, the total can be shared out a cent differently between the
 * rates, and the VAT moves with it. A till sale of 4.2233 net at 20 % and 5.5555 at 9 % comes to 11.13 either way.
 * Its rates' own gross is 5.07 and 6.06, VAT 0.85 + 0.50; its lines say 5.06 and 6.06, so the device is given 5.06
 * and 6.07 and takes out 0.84 + 0.50.
 *
 * Null where a rate's total is negative, which no device takes.
 */
export function deviceTaxTotal(doc: GrossSource): number | null {
  const gross = grossByRate(doc)
  return gross && roundCents(sum(gross.map(vatOf)))
}

/**
 * A sale's VAT and net as its device books them (`deviceTaxTotal`): what the till and the back office store, and
 * what their screens show. The total stands, since it is what the customer pays, and the net is what is left of
 * it. Null where the money cannot be shared per rate: the totals the door computed stand.
 */
export function deviceTotals(doc: GrossSource): { taxTotal: number; subtotal: number } | null {
  const taxTotal = deviceTaxTotal(doc)
  return taxTotal === null ? null : { taxTotal, subtotal: roundCents(num(doc.total) - taxTotal + num(doc.discountTotal)) }
}

/**
 * A till line's VAT and net. The till stores their sum, rounded, as the line's gross (FR-21.5, `fromPosTransaction`),
 * which is what `grossByRate` shares the sale's total by. So the server computes them from the line's terms, whatever
 * the request says (#573); the terminal sends the same.
 *
 * The terminal gives no discount, and for it these are the amounts they always were. A discount, which only an API
 * client sends, comes off the net, as `computePosTotals` takes it off the total.
 */
export function tillLineAmounts(line: PosTotalsLine): { taxAmount: number; lineTotal: number } {
  const base = line.quantity * line.unitPrice
  const net = base - base * ((line.discount || 0) / 100)
  return {
    taxAmount: Math.round(net * ((line.taxRate || 0) / 100) * 100) / 100,
    lineTotal: net,
  }
}

/** A till sale's totals as the till will store them: `computePosTotals`' total, the VAT and net its device books. */
export function tillTotals(cart: PosTotalsLine[]): PosTotals {
  const t = computePosTotals(cart)
  const lines = cart.map((l) => {
    const a = tillLineAmounts(l)
    return { taxRate: l.taxRate || 0, lineTotal: Math.round((a.lineTotal + a.taxAmount) * 100) / 100 }
  })
  return { ...t, ...deviceTotals({ total: t.total, discountTotal: t.discountTotal, lines }) }
}

/**
 * What returning `milli` thousandths of a line is worth, in cents: what the line's running total comes to once it is
 * back, less what the parts standing on it took. The whole line is worth `value`; `returned` of its `sold` are back,
 * for `taken`. Never by rounding each part on its own, and never by where the earlier parts stood: one of those can be
 * given back while a later one stands, which moved the rest along by a cent and left the last unit nothing to come
 * back on. So the parts come to `value` exactly, in whatever pieces, whichever of them is given back, and the last one
 * takes the rest. One function: the storno's claim, and the dialog that says how much goes back.
 */
export function partOfLine(value: number, sold: number, returned: number, taken: number, milli: number): number {
  if (!(sold > 0)) return 0
  return Math.max(0, Math.round((value * (returned + milli)) / sold) - taken)
}

/**
 * Half away from zero, to the cent. The relative epsilon is what keeps 8.575 from becoming
 * 8.57: its binary value sits just below the half, and an absolute epsilon (the usual
 * `n + Number.EPSILON`) is too small to lift it once the value is above a few units.
 */
export function roundCents(n: number): number {
  return Math.round(n * 100 * (1 + Number.EPSILON)) / 100
}
