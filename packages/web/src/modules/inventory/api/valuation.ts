import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath } from './org-path'

/** An article's line of the valuation (`services/biz/costing.service.ts#getInventoryValuation`). */
export interface ValuationItem {
  productId: string
  name: string
  costingMethod: string
  totalQty: number
  avgCost: number
  totalValue: number
}

/**
 * `GET /warehouse/cost-layer/valuation` (`warehouse-api/src/controllers/cost-layer.controller.ts`): the stock at its
 * cost, of one warehouse or of all. Cost figures through and through: a role without them is refused (403).
 */
export async function getValuation(params: { warehouseId?: string }): Promise<{ items: ValuationItem[]; totalValue: number }> {
  const { data } = await httpClient.get(orgPath('/warehouse/cost-layer/valuation'), { params })
  return data
}
