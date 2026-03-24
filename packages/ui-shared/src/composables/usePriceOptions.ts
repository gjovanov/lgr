import { httpClient } from './useHttpClient'

export interface PriceOption {
  key: string
  name: string
  price: number
  type: 'base' | 'tag' | 'contact' | 'category'
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
  const price = option.price.toFixed(2)
  return `${price} — ${option.name}`
}
