/**
 * How many decimals an article's prices and margins keep, and the arithmetic between them.
 *
 * A fastener's unit price is 0.0472 €, not 0.05 €: a price keeps FOUR decimals. A margin over the purchase price keeps
 * THREE (2000.555 %). The product form computes with these and shows them fixed (`DecimalField`), and the goods
 * receipt's cascade (`gr-product-update.ts`) rounds a recomputed tier with the same `roundPrice`, so both give an
 * article the same price from the same purchase price and margin.
 *
 * Pure: no Vue, no I/O. `unit/price-precision.test.ts` holds the rules.
 */

/** Decimal places of a unit price: the selling price, the purchase price, a tier's price. */
export const PRICE_DECIMALS = 4

/** Decimal places of a margin over the purchase price. */
export const PERCENT_DECIMALS = 3

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * `value` to `decimals` places, a half going away from zero, read as the figure is WRITTEN.
 *
 * ⚠ Not `toFixed`: `(2.00005).toFixed(4)` is "2.0000", because the double nearest 2.00005 lies just under it, and a
 * person who typed 2.00005 expects 2.0001 (a purchase price of 0.5 at 0.01 % is 0.50005: the same). Moving the decimal
 * point in the figure's own text first rounds what is written. Anything that is not a finite number is 0, and the
 * answer is never -0.
 */
export function roundTo(value: unknown, decimals: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  const abs = Math.abs(n)
  const text = String(abs)
  // A figure printed with an exponent (1e-7, 1e21) cannot take a second one: it is rounded as the double it is.
  const rounded = text.includes('e')
    ? Number(abs.toFixed(decimals))
    : Number(`${Math.round(Number(`${text}e${decimals}`))}e-${decimals}`)
  return n < 0 && rounded !== 0 ? -rounded : rounded
}

export const roundPrice = (value: unknown): number => roundTo(value, PRICE_DECIMALS)
export const roundPercent = (value: unknown): number => roundTo(value, PERCENT_DECIMALS)

/** The figure with exactly `decimals` places, as a field shows it at rest. Empty for no figure at all. */
export function formatFixed(value: unknown, decimals: number): string {
  if (value === null || value === undefined || value === '') return ''
  const n = Number(value)
  return Number.isFinite(n) ? roundTo(n, decimals).toFixed(decimals) : ''
}

/**
 * What a person typed into a number field, as a number: null for nothing, or for text that is no number. A comma is a
 * decimal point (a field that is not `type="number"` hands the text over as typed).
 */
export function parseTyped(text: unknown): number | null {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null
  const s = String(text ?? '').trim().replace(',', '.')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * A price typed into a line's price field (`PriceCombobox`): `parseTyped`, so "12,5" is 12.5, of text that may still
 * carry an offered price's name after a dash ("10.00 — Selling price"). Null for nothing, for text that is no number,
 * and for a figure under zero.
 */
export function parseTypedPrice(text: unknown): number | null {
  const n = parseTyped(typeof text === 'string' && text.includes('—') ? text.split('—')[0] : text)
  return n === null || n < 0 ? null : n
}

/** The price that stands `percent` over `purchase`, to the decimals a price keeps. */
export function priceAtMargin(purchase: unknown, percent: unknown): number {
  return roundPrice(num(purchase) * (1 + num(percent) / 100))
}

/** How far `price` stands over `purchase`, in percent, to the decimals a margin keeps. 0 with no purchase price. */
export function marginOver(purchase: unknown, price: unknown): number {
  const base = num(purchase)
  return base ? roundPercent(((num(price) - base) / base) * 100) : 0
}
