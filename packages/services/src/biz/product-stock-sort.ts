import { mongoose } from 'db/connection'
import { Order, StockLevel } from 'db/models'
import type { Filter, IBatchRepository, IProduct, PageResult } from 'dal'
import { getProductsSupplyTotals } from './product-supply.service.js'
import { ORDER_HOLDING_STATUSES } from './reservation.service.js'
import { findPageSortedByKeys } from './sorted-page.js'

const { Types } = mongoose

/**
 * The Products list sorts by its stock columns too: „Наличност" (`stock`), „Резервирано"
 * (`reserved`) and „Поръчано" (`onOrder`). None of them is a field of the product. Each sorts by
 * the figure its cell shows, summed over the warehouses or taken from the one the list is
 * filtered on, and an article whose cell shows a dash goes last either way, then by name.
 */
export type StockColumn = 'stock' | 'reserved' | 'onOrder'
const STOCK_COLUMNS: readonly StockColumn[] = ['stock', 'reserved', 'onOrder']

/** The stock column a Products-list sort key names, or null when it names none. */
export function stockColumnForSortKey(sortBy: string | undefined | null): StockColumn | null {
  return STOCK_COLUMNS.find((c) => c === sortBy) ?? null
}

/**
 * Each article's figure in the column, for the articles whose cell shows one.
 * - `stock`: on hand, from the stock levels the badges list. A level at 0 shows no badge.
 * - `reserved` / `onOrder`: the list's own figures (`getProductsSupplyTotals`, FR-22.45), asked
 *   only about the articles that can have one — something held on the shelf, or on a sent order.
 */
async function columnFigures(orgId: string, column: StockColumn, warehouseId?: string): Promise<Map<string, number>> {
  const org = new Types.ObjectId(orgId)
  // A warehouse id that is no id matches nothing, as it does in the list's own filter.
  const inWarehouse = warehouseId
    ? { warehouseId: Types.ObjectId.isValid(warehouseId) ? new Types.ObjectId(warehouseId) : warehouseId }
    : {}
  const figures = new Map<string, number>()

  if (column === 'stock') {
    const rows = await StockLevel.aggregate([
      { $match: { orgId: org, quantity: { $ne: 0 }, ...inWarehouse } },
      { $group: { _id: '$productId', quantity: { $sum: '$quantity' } } },
    ]).exec()
    for (const r of rows) figures.set(String(r._id), r.quantity)
    return figures
  }

  const candidates: unknown[] = column === 'reserved'
    ? await StockLevel.distinct('productId', { orgId: org, reservedQuantity: { $ne: 0 }, ...inWarehouse } as any).exec()
    : await Order.distinct('supplierGroups.lines.productId', { orgId: org, status: { $in: ORDER_HOLDING_STATUSES } } as any).exec()
  const totals = await getProductsSupplyTotals(orgId, candidates.map(String), { warehouseId })
  for (const [id, t] of Object.entries(totals)) {
    const figure = column === 'reserved' ? t.reserved : t.incoming
    if (figure) figures.set(id, figure)
  }
  return figures
}

/** One page of the filtered products, ordered by a stock column's figure. */
export async function findProductsByStockColumn(
  products: IBatchRepository<IProduct>,
  orgId: string,
  filter: Filter<IProduct>,
  column: StockColumn,
  warehouseId: string | undefined,
  order: 1 | -1,
  page: number,
  size: number,
): Promise<PageResult<IProduct>> {
  const figures = await columnFigures(orgId, column, warehouseId)
  return findPageSortedByKeys(products, filter, figures, order, page, size, 'name')
}
