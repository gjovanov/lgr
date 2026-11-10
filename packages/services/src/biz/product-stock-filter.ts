import type { Filter, IBatchRepository, IProduct } from 'dal'
import { columnFigures } from './product-stock-sort.js'

/**
 * FR-28.3 / .4 / .5 — the Products list's quantity filters: a range on the stock figure, "below minimum",
 * and the option to count open orders.
 *
 * ONE stock figure (`columnFigures('stock')`, what the Stock column and its sort show): the sum of `quantity`
 * over the warehouses, or the chosen warehouse's. The sort ranks an article it does not name last, because
 * its cell shows a dash. A filter asks a different question — "how many are there?" — and an article with no
 * stock row has none: it is at 0, so "out of stock" finds a never-stocked article, and so does "below minimum".
 *
 * ONE "below minimum" (FR-28.5): the Reports `stock-levels` rule — `minStockLevel > 0` and the figure under it,
 * an unset minimum meaning "no threshold", never zero — plus the articles that report drops for having no
 * stock row at all, which is exactly what a reorder list is for. A service (`trackInventory: false`) has no
 * stock and never matches a quantity filter.
 *
 * With a warehouse chosen the figure is that warehouse's. The list's warehouse filter also hides the articles
 * with nothing there (`product.controller.ts`); when a quantity filter is set it decides instead, so "below
 * minimum in warehouse X" lists what X has run out of.
 */
export interface StockFilter {
  stockMin?: number
  stockMax?: number
  belowMin?: boolean
  /** `projected`: the figure is on hand − reserved + on order (the option "count open orders"). */
  basis?: 'onHand' | 'projected'
  warehouseId?: string
}

const asNumber = (v: unknown): number | undefined => {
  if (v === undefined || v === null || String(v).trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
const asFlag = (v: unknown): boolean => v === true || v === 'true' || v === '1'

/** The filter a request's query string asks for. A value that is no number is not a bound. */
export function parseStockFilter(query: Record<string, unknown>): StockFilter {
  const filter: StockFilter = {}
  const min = asNumber(query.stockMin)
  const max = asNumber(query.stockMax)
  if (min !== undefined) filter.stockMin = min
  if (max !== undefined) filter.stockMax = max
  if (asFlag(query.belowMin)) filter.belowMin = true
  if (query.basis === 'projected') filter.basis = 'projected'
  if (query.warehouseId) filter.warehouseId = String(query.warehouseId)
  return filter
}

/** Whether the request filters by quantity at all (a basis alone changes the figure, not the rows). */
export function hasStockFilter(f: StockFilter): boolean {
  return f.stockMin !== undefined || f.stockMax !== undefined || !!f.belowMin
}

/** An article the figures do not name has none. */
export function figureOf(figures: ReadonlyMap<string, number>, productId: string): number {
  return figures.get(productId) ?? 0
}

/** The part of a product the filters read. */
export interface StockFilterProduct {
  trackInventory?: boolean | null
  minStockLevel?: number | null
}

/** Whether an article, at this figure, passes the filter. Pure: the rule in one place. */
export function passesStockFilter(figure: number, product: StockFilterProduct, f: StockFilter): boolean {
  if (product.trackInventory === false) return false
  if (f.stockMin !== undefined && figure < f.stockMin) return false
  if (f.stockMax !== undefined && figure > f.stockMax) return false
  if (f.belowMin) {
    const min = Number(product.minStockLevel) || 0
    if (!(min > 0 && figure < min)) return false
  }
  return true
}

/**
 * The ids of the articles `filter` finds that also pass the quantity filter. `filter` is the list's own query
 * (search, category, … and whatever id restriction is already in force), so the answer is its narrowing.
 */
export async function productIdsPassingStockFilter(
  products: IBatchRepository<IProduct>,
  orgId: string,
  filter: Filter<IProduct>,
  f: StockFilter,
): Promise<Set<string>> {
  const projected = f.basis === 'projected'
  const [candidates, onHand, reserved, onOrder] = await Promise.all([
    products.aggregate<{ _id: unknown; trackInventory?: boolean; minStockLevel?: number }>([
      { $match: filter },
      { $project: { trackInventory: 1, minStockLevel: 1 } },
    ] as any),
    columnFigures(orgId, 'stock', f.warehouseId),
    projected ? columnFigures(orgId, 'reserved', f.warehouseId) : Promise.resolve(new Map<string, number>()),
    projected ? columnFigures(orgId, 'onOrder', f.warehouseId) : Promise.resolve(new Map<string, number>()),
  ])
  const passing = new Set<string>()
  for (const c of candidates) {
    const id = String(c._id)
    const figure = +(figureOf(onHand, id) - figureOf(reserved, id) + figureOf(onOrder, id)).toFixed(3)
    if (passesStockFilter(figure, c, f)) passing.add(id)
  }
  return passing
}
