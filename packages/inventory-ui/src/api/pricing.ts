import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath } from './org-path'

/**
 * The body of `POST /warehouse/bulk-pricing/adjust` (`warehouse-api/src/controllers/bulk-pricing.controller.ts`), as
 * its schema declares it. By the articles' tags: their selling price, and their customer and tag prices when asked. By
 * a price tag: the tag prices with that tag.
 */
export interface BulkAdjustBody {
  productTagFilters?: string[]
  customPriceTagFilters?: string[]
  sellingPricePercent?: number
  adjustCustomPrices?: boolean
  customPricePercent?: number
}

/** `services/biz/bulk-pricing.service.ts#BulkAdjustResult`. */
export interface BulkAdjustResult {
  productsUpdated: number
  pricesAdjusted: number
  productChanges: Array<{ productId: string; productName: string; changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> }>
}

export async function bulkAdjustPrices(body: BulkAdjustBody): Promise<BulkAdjustResult> {
  const { data } = await httpClient.post(orgPath('/warehouse/bulk-pricing/adjust'), body)
  return data
}
