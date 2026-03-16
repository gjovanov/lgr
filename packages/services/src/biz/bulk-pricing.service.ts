import { getRepos } from '../context.js'

export interface BulkAdjustOptions {
  productTagFilters?: string[]
  customPriceTagFilters?: string[]
  sellingPricePercent?: number
  adjustCustomPrices?: boolean
  customPricePercent?: number
}

export interface BulkAdjustResult {
  productsUpdated: number
  pricesAdjusted: number
}

/**
 * Bulk-adjust product prices by percentage based on tag filters.
 *
 * Modes:
 * 1. productTagFilters → find products with matching tags → adjust sellingPrice by %
 *    If adjustCustomPrices, also adjust all customPrices[].price and tagPrices[].price
 * 2. customPriceTagFilters → find products with tagPrices matching those tags →
 *    adjust only matching tagPrices[].price entries
 *
 * Negative percentage = price decrease.
 */
export async function bulkAdjustPrices(
  orgId: string,
  options: BulkAdjustOptions,
): Promise<BulkAdjustResult> {
  const r = getRepos()
  let productsUpdated = 0
  let pricesAdjusted = 0

  const sellingPct = options.sellingPricePercent ?? 0
  const customPct = options.customPricePercent ?? options.sellingPricePercent ?? 0
  const multiplier = (pct: number) => 1 + pct / 100

  // Mode 1: Filter by product tags → adjust selling price (+ optionally custom prices)
  if (options.productTagFilters?.length) {
    const filter: any = { orgId, tags: { $in: options.productTagFilters } }
    const products = await r.products.findMany(filter)

    for (const product of products) {
      const updates: any = {}

      if (sellingPct !== 0) {
        updates.sellingPrice = +(product.sellingPrice * multiplier(sellingPct)).toFixed(2)
        pricesAdjusted++
      }

      if (options.adjustCustomPrices && customPct !== 0) {
        if (product.customPrices?.length) {
          updates.customPrices = product.customPrices.map((cp: any) => ({
            ...cp,
            price: +(cp.price * multiplier(customPct)).toFixed(2),
          }))
          pricesAdjusted += product.customPrices.length
        }
        if (product.tagPrices?.length) {
          updates.tagPrices = product.tagPrices.map((tp: any) => ({
            ...tp,
            price: +(tp.price * multiplier(customPct)).toFixed(2),
          }))
          pricesAdjusted += product.tagPrices.length
        }
      }

      if (Object.keys(updates).length > 0) {
        await r.products.update(product.id, updates)
        productsUpdated++
      }
    }
  }

  // Mode 2: Filter by custom price tags → adjust only matching tag prices
  if (options.customPriceTagFilters?.length && customPct !== 0) {
    const tagSet = new Set(options.customPriceTagFilters)

    // Find products that have tagPrices with matching tags
    const filter: any = { orgId, 'tagPrices.tag': { $in: options.customPriceTagFilters } }
    const products = await r.products.findMany(filter)

    for (const product of products) {
      if (!product.tagPrices?.length) continue

      let changed = false
      const updatedTagPrices = product.tagPrices.map((tp: any) => {
        if (tagSet.has(tp.tag)) {
          changed = true
          pricesAdjusted++
          return { ...tp, price: +(tp.price * multiplier(customPct)).toFixed(2) }
        }
        return tp
      })

      if (changed) {
        await r.products.update(product.id, { tagPrices: updatedTagPrices } as any)
        productsUpdated++
      }
    }
  }

  return { productsUpdated, pricesAdjusted }
}
