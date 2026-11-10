import type { TierLike } from '../product-price-columns'

/**
 * FR-28.22 — what the product list engine (`useProductList`) hands its two users: the Products list
 * and the product dialog.
 */

/** A row as `GET /warehouse/product` answers it, or as the till's catalog does once normalized. */
export interface ProductRow {
  _id: string
  sku: string
  name: string
  category: string
  type: string
  unit: string
  purchasePrice: number
  sellingPrice: number
  taxRate?: number
  priceTiers?: TierLike[]
  isActive: boolean
  trackInventory?: boolean
  minStockLevel?: number
  maxStockLevel?: number
  /** The till's catalog: what the session's warehouse has, `null` for a service. */
  stockAvailable?: number | null
  /** The row exactly as its endpoint answered it: what a pick hands back to the screen. */
  raw?: any
}

/**
 * `GET /warehouse/product-supplier/by-products` — the wire shape (`SupplierFact` in product-suppliers.service). A
 * supplier only a person recorded (FR-28.9) has no document behind it: no `lastPurchasedAt`, `documents` 0.
 */
export interface SupplierFact {
  supplierId: string
  supplierName: string
  lastPurchasedAt?: string
  lastUnitPrice?: number
  currency?: string
  quantity: number
  documents: number
}

export interface StockBadge {
  warehouseId: string
  warehouseName: string
  quantity: number
  availableQuantity: number
}

/** `getProductsSupplyTotals` — the definitions of the product's stock tab, summed. */
export interface SupplyTotals {
  reserved: number
  incoming: number
  reservedIncoming: number
  planned: number
}

export const NO_SUPPLY: SupplyTotals = { reserved: 0, incoming: 0, reservedIncoming: 0, planned: 0 }
