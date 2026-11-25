import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath, type ListPage } from './org-path'

/** `api/src/warehouse/controllers/stock-level.controller.ts`, `/org/:orgId/warehouse/stock-level`. */
const BASE = '/warehouse/stock-level'

/**
 * A stock level as the list answers it: the level, with its article's SKU and name and its warehouse's name. A role
 * without the cost figures gets no average cost (FR-27.6). The count form's lean read (`fields: 'count'`) answers
 * only the product, the warehouse, the quantity and the cost, with the names, the unit and the barcode.
 */
export interface StockLevel {
  _id?: string
  productId: string
  warehouseId: string
  quantity: number
  reservedQuantity?: number
  availableQuantity?: number
  avgCost?: number
  productSku: string
  productName: string
  productUnit?: string
  /** The lean read's only (FR-33.2: the count's line filter reads it). */
  productBarcode?: string
  warehouseName: string
}

export interface StockLevelListParams {
  warehouseId?: string
  productId?: string
  page?: number
  /** The route's own page is 10; 0 is every level. */
  size?: number
  /** `'count'`: the count form's lean read of a whole warehouse, past the list's ceiling (FR-30.8). */
  fields?: 'count'
}

export async function listStockLevels(params: StockLevelListParams): Promise<ListPage & { stockLevels: StockLevel[] }> {
  const { data } = await httpClient.get(orgPath(BASE), { params })
  return data
}
