import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath } from './org-path'
import type { PriceStep } from './documents'

/** `warehouse-api/src/controllers/pricing.controller.ts`, `/org/:orgId/pricing`: a line's price, and the last ones. */
const BASE = '/pricing'

/** The query of `GET /resolve`: the article, for whom, how many. */
export interface PriceResolveParams {
  productId: string
  contactId?: string
  /** As text: the route reads `Number(quantity)`. */
  quantity?: string
}

/**
 * `services/biz/pricing.service.ts#PriceResolution`, through `redactResolution`: the price the chain ends on, and its
 * steps. A role that does not see a price level is not told its step (FR-27.11.C.6).
 */
export interface PriceResolution {
  finalPrice: number
  steps: PriceStep[]
}

export async function resolvePrice(params: PriceResolveParams): Promise<PriceResolution> {
  const { data } = await httpClient.get(orgPath(`${BASE}/resolve`), { params })
  return data
}

/** The query of `GET /last-prices`. */
export interface LastPricesParams {
  contactId: string
  /** Ids, comma-separated. */
  productIds: string
  currency?: string
  /** The document being edited: its own lines are not its last price. */
  excludeId?: string
}

/** The last price the customer paid for an article, and the document it was on. */
export interface LastPrice {
  price: number
  invoiceId: string
  invoiceNumber: string
  /** ISO text on the wire. */
  issueDate: string
  currency: string
}

/** By article id; an article never sold to the customer is not named. */
export async function getLastPrices(params: LastPricesParams): Promise<{ prices: Record<string, LastPrice> }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/last-prices`), { params })
  return data
}
