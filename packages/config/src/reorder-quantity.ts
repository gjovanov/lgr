/**
 * FR-28 D-9 — how much to order of an article. Import-pure: the Products list's „To order" column
 * (`useProductList.toOrder`) and the order dialog's preview (`services/biz/orders-from-products.service.ts`)
 * both read it from here, so the figure on the list and the quantity the dialog starts from cannot differ.
 *
 *   position = on hand − reserved + on order    (scoped as the list is: the warehouse filter, or all of them)
 *   target   = the maximum when there is one, else the minimum
 *   to order = target − position, only for an article at or below its minimum
 *
 * A service, or an article that carries neither a minimum nor a maximum, has nothing to reorder against.
 */
export interface ReorderArticle {
  trackInventory?: boolean | null
  minStockLevel?: number | null
  maxStockLevel?: number | null
}

const num = (v: unknown): number => Number(v) || 0

/** Where an article stands: on hand − reserved + on order. Rounded to what a quantity can hold (3 decimals). */
export function reorderPosition(onHand: number, reserved: number, onOrder: number): number {
  return +(num(onHand) - num(reserved) + num(onOrder)).toFixed(3)
}

/** True when there is no minimum or maximum to order up to, or the article is a service. */
export function hasNoReorderLevels(article: ReorderArticle): boolean {
  return article.trackInventory === false || (!num(article.minStockLevel) && !num(article.maxStockLevel))
}

/**
 * The list's „To order" figure: what brings the article back to its maximum (its minimum when it has no
 * maximum). `null` when there is nothing to order — a service, an article with no levels, one that is still
 * above its minimum, or one whose position already reaches the target.
 */
export function toOrderQuantity(article: ReorderArticle, position: number): number | null {
  if (hasNoReorderLevels(article)) return null
  const min = num(article.minStockLevel)
  const max = num(article.maxStockLevel)
  if (min > 0 && position >= min) return null
  const quantity = (max > 0 ? max : min) - position
  return quantity > 0 ? quantity : null
}

/**
 * The quantity the order dialog starts from (D-9): `max(1, target − position)`. It is the list's „To order"
 * figure wherever the list shows one (and at least 1 where that figure is a fraction); an article the list shows
 * a dash for — a service, one with no levels, one above its minimum — starts at the larger of 1 and what is
 * missing from its target.
 */
export function suggestedOrderQuantity(article: ReorderArticle, position: number): number {
  if (hasNoReorderLevels(article)) return 1
  const target = num(article.maxStockLevel) > 0 ? num(article.maxStockLevel) : num(article.minStockLevel)
  return Math.max(1, +(target - position).toFixed(3))
}
