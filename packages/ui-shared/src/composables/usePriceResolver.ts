import type { AxiosInstance } from 'axios'

export interface PriceStep {
  type: 'base' | 'tag' | 'contact' | 'override'
  label: string
  price: number
}

export interface PriceResolution {
  finalPrice: number
  steps: PriceStep[]
}

/**
 * Composable for resolving product prices based on contact tags and custom pricing.
 */
export function usePriceResolver(httpClient: AxiosInstance) {
  async function resolvePrice(
    orgId: string,
    productId: string,
    contactId?: string,
    quantity?: number,
  ): Promise<PriceResolution> {
    const params: Record<string, string> = { productId }
    if (contactId) params.contactId = contactId
    if (quantity) params.quantity = String(quantity)

    const { data } = await httpClient.get(`/org/${orgId}/pricing/resolve`, { params })
    return data
  }

  function addOverrideStep(steps: PriceStep[], overridePrice: number): PriceStep[] {
    return [...steps, { type: 'override', label: 'User override', price: overridePrice }]
  }

  return { resolvePrice, addOverrideStep }
}
