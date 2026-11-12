/**
 * A customer order line's price: an indication, or a price chosen for the order.
 *
 * A line starts with the article's selling price, as an indication of what the order is worth; its invoice is priced
 * for the client on the day it is made (`resolvePrice`), whatever the line showed. A price somebody CHOSE on the line
 * (picked from the article's prices with „Select price", or typed) is the order's own: the line is pinned, and the
 * order's invoice charges that price.
 *
 * Import-pure: the form, the route and the conversion read the one rule from here.
 */

export interface PinnableLine {
  productId?: unknown
  expectedUnitPrice?: unknown
  pricePinned?: unknown
}

/** A price that can be charged: a figure above zero. An empty field and a zero are no choice. */
export function chargeablePrice(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * Is the line's price pinned, as this save leaves it?
 *
 * - No price that can be charged: never.
 * - The save says (`true` or `false`): what it says.
 * - The save does not say (a caller that does not know the field: a tab opened before the release, a script): the
 *   stored line's pin stays while its article and its price are the ones stored. Such a caller cannot unpin a line by
 *   saving it back, and a price it changed is not pinned: it did not know it was choosing one.
 */
export function linePricePinned(line: PinnableLine, stored?: PinnableLine | null): boolean {
  const price = chargeablePrice(line.expectedUnitPrice)
  if (price === undefined) return false
  if (typeof line.pricePinned === 'boolean') return line.pricePinned
  return !!stored && stored.pricePinned === true
    && String(stored.productId ?? '') === String(line.productId ?? '')
    && chargeablePrice(stored.expectedUnitPrice) === price
}

/** The price the order's invoice charges for this line when one was chosen; undefined: priced for the client. */
export function pinnedPriceOf(line: PinnableLine | null | undefined): number | undefined {
  return line && line.pricePinned === true ? chargeablePrice(line.expectedUnitPrice) : undefined
}

// ── the form's line, as the user edits it ─────────────────────────────────────
// `pricePinned` is `true` or absent there, never `false`: the form's unsaved-changes check compares the lines as
// JSON, and a `false` nobody set would read as an edit.

export interface EditableLine {
  productId?: string
  expectedUnitPrice?: number | string | null
  pricePinned?: boolean
}

/** A price picked from the article's prices: the line's price, chosen. */
export function pickLinePrice(line: EditableLine, price: number): void {
  line.expectedUnitPrice = price
  line.pricePinned = chargeablePrice(price) !== undefined ? true : undefined
}

/** A price typed into the line's field (`value` is what the field now holds). An emptied field is no choice. */
export function typeLinePrice(line: EditableLine, value: unknown): void {
  line.pricePinned = chargeablePrice(value) !== undefined ? true : undefined
}

/**
 * Back to the client's price at invoicing. `price` is what that would be today, when the caller knows it: the line
 * then shows it, as an indication again.
 */
export function releaseLinePrice(line: EditableLine, price?: number): void {
  line.pricePinned = undefined
  if (chargeablePrice(price) !== undefined) line.expectedUnitPrice = price
}

/**
 * The line's article is set. A price chosen for ANOTHER article is not this one's: the pin goes and the price with
 * it, so the line starts from the new article's own. A line that was not pinned keeps what it shows.
 */
export function setLineArticle(line: EditableLine, productId: string | undefined): void {
  if (line.pricePinned && String(line.productId ?? '') !== String(productId ?? '')) {
    line.pricePinned = undefined
    line.expectedUnitPrice = undefined
  }
  line.productId = productId
}
