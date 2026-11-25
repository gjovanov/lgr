import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath, type ListPage } from './org-path'

/** `api/src/warehouse/controllers/inventory-count.controller.ts`, `/org/:orgId/warehouse/inventory-count`. */
const BASE = '/warehouse/inventory-count'

export interface InventoryCountLine {
  productId: string
  systemQuantity: number
  countedQuantity: number
  variance: number
  /** Left out for a role without the cost figures (FR-27.11.C.1). */
  varianceCost?: number
  notes?: string
  /** The one read (`GET /:id`) adds the article's name, SKU, barcode and unit. */
  productName?: string
  productSku?: string
  productBarcode?: string
  productUnit?: string
}

/** A count as the routes answer it (the repository's entity). Its number is `countNumber`: only the list adds `number`. */
export interface InventoryCount {
  _id: string
  id: string
  countNumber: string
  warehouseId: string
  date: string
  status: 'draft' | 'in_progress' | 'completed'
  type: string
  notes?: string
  lines: InventoryCountLine[]
  adjustmentMovementId?: string
  completedAt?: string
}

/** A line as the form sends it. The server prices it from the stock level's average cost (FR-27.11.C.4). */
export interface InventoryCountLineBody {
  productId: string
  systemQuantity: number
  countedQuantity: number
  variance: number
}

/**
 * The body of `POST /` and `PUT /:id`. Their schemas take any object (`clientCreate` / `clientUpdate` then hold it to
 * the model, FR-32.18), so these are the model's fields the form sends; `type` is the model's to judge
 * (`full`, `partial`, `cycle`).
 */
export interface InventoryCountBody {
  warehouseId: string
  date: string
  type: string
  notes?: string
  itemCount?: number
  varianceCount?: number
  lines: InventoryCountLineBody[]
}

export interface InventoryCountListParams {
  /** The counts that have a line of this article. */
  productId?: string
  page?: number
  /** The route's own page is 10; 0 is every count. */
  size?: number
}

export async function listInventoryCounts(params: InventoryCountListParams): Promise<ListPage & { inventoryCounts: InventoryCount[] }> {
  const { data } = await httpClient.get(orgPath(BASE), { params })
  return data
}

/** ⚠ A count that is not there answers `{ inventoryCount: null }`, not a 404. */
export async function getInventoryCount(id: string): Promise<{ inventoryCount: InventoryCount | null }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${id}`))
  return data
}

export async function createInventoryCount(body: InventoryCountBody): Promise<{ inventoryCount: InventoryCount }> {
  const { data } = await httpClient.post(orgPath(BASE), body)
  return data
}

/** A completed count, or one a completion holds, is refused (409). */
export async function updateInventoryCount(id: string, body: InventoryCountBody): Promise<{ inventoryCount: InventoryCount }> {
  const { data } = await httpClient.put(orgPath(`${BASE}/${id}`), body)
  return data
}

/** Books the adjustment movement of its variances, and marks it completed. */
export async function completeInventoryCount(id: string): Promise<{ inventoryCount: InventoryCount | null }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/complete`))
  return data
}
