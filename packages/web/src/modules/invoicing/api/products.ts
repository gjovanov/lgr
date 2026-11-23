import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath, type ListPage } from './org-path'

/** `warehouse-api/src/controllers/product.controller.ts`, `/org/:orgId/warehouse/product`. */
const BASE = '/warehouse/product'

/** A price tier of an article (`IProductPriceTier`). Dates are ISO text on the wire. */
export interface ProductPriceTier {
  name: string
  percent?: number
  finalPrice: number
  manualOverride?: boolean
  contactIds?: string[]
  tags?: string[]
  minQuantity?: number
  validFrom?: string
  validTo?: string
}

/**
 * An article as the routes answer it: the repository's entity, through `redactProduct`. A role without the cost
 * figures gets no purchase price, standard cost or tier margins (FR-27.6), so those are optional here.
 */
export interface Product {
  _id: string
  id: string
  sku: string
  barcode?: string
  name: string
  description?: string
  category: string
  categoryId?: string
  type: string
  unit: string
  purchasePrice?: number
  sellingPrice?: number
  currency?: string
  taxRate?: number
  trackInventory?: boolean
  tags?: string[]
  priceTiers?: ProductPriceTier[]
  isActive: boolean
}

export interface ProductListParams {
  search?: string
  /** Ids, comma-separated: these articles, whatever the other filters. */
  ids?: string
  page?: number
  size?: number
}

export async function listProducts(params: ProductListParams): Promise<ListPage & { products: Product[] }> {
  const { data } = await httpClient.get(orgPath(BASE), { params })
  return data
}

/** `id` is put in the path as given: encode one that did not come from a record. A missing article is a 404. */
export async function getProduct(id: string): Promise<{ product: Product }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${id}`))
  return data
}
