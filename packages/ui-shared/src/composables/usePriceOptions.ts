import { httpClient } from './useHttpClient'

export interface PriceOption {
  key: string
  name: string
  price: number
  type: 'base' | 'tag' | 'contact' | 'category' | 'tier'
}

export interface PriceOptionsResult {
  options: PriceOption[]
  resolvedKey: string
}

export async function fetchPriceOptions(
  orgUrl: string,
  productId: string,
  contactId?: string,
  quantity?: number,
): Promise<PriceOptionsResult> {
  try {
    const params: Record<string, string> = { productId }
    if (contactId) params.contactId = contactId
    if (quantity) params.quantity = String(quantity)
    const { data } = await httpClient.get(`${orgUrl}/pricing/options`, { params })
    return data
  } catch {
    return { options: [], resolvedKey: '' }
  }
}

export function formatPriceItem(option: PriceOption, currency?: string): string {
  // Legacy price tiers carry 4-decimal unit prices (e.g. 0.0071) — never round them away.
  const price = option.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4, useGrouping: false })
  return `${price} — ${option.name}`
}
