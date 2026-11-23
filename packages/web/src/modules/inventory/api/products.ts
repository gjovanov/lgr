import type { PRODUCT_TYPES } from 'config/constants'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath, type ListPage } from './org-path'

/** `warehouse-api/src/controllers/product.controller.ts`, `/org/:orgId/warehouse/product`. */
const BASE = '/warehouse/product'

/** What an article is: the schemas' `PRODUCT_TYPE`, the list `config/constants#PRODUCT_TYPES`. */
export type ProductType = (typeof PRODUCT_TYPES)[number]
export type CostingMethod = 'wac' | 'fifo' | 'lifo' | 'fefo' | 'standard'

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

/** A price for one customer (`IProductCustomPrice`), from before the tiers. */
export interface ProductCustomPrice {
  name: string
  contactId: string
  price: number
  minQuantity?: number
  validFrom?: string
  validTo?: string
}

/** A price for a contact tag (`IProductTagPrice`), from before the tiers. */
export interface ProductTagPrice {
  name: string
  tag: string
  price: number
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
  tariffCode?: string
  description?: string
  category: string
  categoryId?: string
  type: ProductType
  unit: string
  purchasePrice?: number
  sellingPrice?: number
  currency?: string
  taxRate?: number
  trackInventory?: boolean
  minStockLevel?: number
  maxStockLevel?: number
  tags?: string[]
  costingMethod?: CostingMethod | null
  standardCost?: number
  customPrices?: ProductCustomPrice[]
  tagPrices?: ProductTagPrice[]
  priceTiers?: ProductPriceTier[]
  isActive: boolean
}

/** The body of `POST /`, as its schema declares it. The arrays of prices are objects the model judges (`AnObject`). */
export interface ProductCreateBody {
  sku: string
  barcode?: string
  name: string
  tariffCode?: string
  description?: string
  category: string
  type: ProductType
  unit: string
  purchasePrice?: number
  sellingPrice?: number
  currency?: string
  taxRate?: number
  trackInventory?: boolean
  isActive?: boolean
  minStockLevel?: number
  maxStockLevel?: number
  reorderLevel?: number
  reorderQuantity?: number
  tags?: string[]
  costingMethod?: CostingMethod | null
  standardCost?: number | null
  categoryId?: string | null
  customPrices?: ProductCustomPrice[]
  tagPrices?: ProductTagPrice[]
  priceTiers?: ProductPriceTier[]
}

/**
 * The body of `PUT /:id`, as its schema declares it. ⚠ A field the schema does not name never reaches the handler:
 * Elysia drops it and answers 200 (`type` was missing once, and the form's Type never saved on an edit).
 */
export interface ProductUpdateBody {
  sku?: string
  barcode?: string
  name?: string
  tariffCode?: string
  description?: string
  category?: string
  type?: ProductType
  unit?: string
  purchasePrice?: number
  sellingPrice?: number
  currency?: string
  taxRate?: number
  trackInventory?: boolean
  minStockLevel?: number
  maxStockLevel?: number
  tags?: string[]
  costingMethod?: CostingMethod | null
  standardCost?: number
  isActive?: boolean
  categoryId?: string | null
  customPrices?: ProductCustomPrice[]
  tagPrices?: ProductTagPrice[]
  priceTiers?: ProductPriceTier[]
}

/** A body that both routes take: what the article form sends, to the one or the other. */
export type ProductSaveBody = ProductCreateBody & ProductUpdateBody

export interface ProductListParams {
  search?: string
  /** Ids, comma-separated: these articles, whatever the other filters. */
  ids?: string
  page?: number
  size?: number
}

export async function listProducts(params: ProductListParams, signal?: AbortSignal): Promise<ListPage & { products: Product[] }> {
  const { data } = await httpClient.get(orgPath(BASE), { params, signal })
  return data
}

/** `id` is put in the path as given: encode one that did not come from a record. */
export async function getProduct(id: string): Promise<{ product: Product }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${id}`))
  return data
}

export async function createProduct(body: ProductCreateBody): Promise<{ product: Product }> {
  const { data } = await httpClient.post(orgPath(BASE), body)
  return data
}

export async function updateProduct(id: string, body: ProductUpdateBody): Promise<{ product: Product }> {
  const { data } = await httpClient.put(orgPath(`${BASE}/${id}`), body)
  return data
}

/** Deactivates it (the route keeps the record). */
export async function deleteProduct(id: string): Promise<{ message: string }> {
  const { data } = await httpClient.delete(orgPath(`${BASE}/${id}`))
  return data
}
