import { httpClient } from './useHttpClient'

export interface PriceOption {
  key: string
  name: string
  price: number
  /** `customer`: FR-27.11.C.6, the customer's own price at a level the role does not see. */
  type: 'base' | 'tag' | 'contact' | 'category' | 'tier' | 'customer'
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
  all = false,
): Promise<PriceOptionsResult> {
  try {
    const params: Record<string, string> = { productId }
    if (contactId) params.contactId = contactId
    if (quantity) params.quantity = String(quantity)
    if (all) params.all = 'true'
    const { data } = await httpClient.get(`${orgUrl}/pricing/options`, { params })
    return data
  } catch {
    return { options: [], resolvedKey: '' }
  }
}

/**
 * The name to show for an option. The server names the base option "Selling price" in English
 * whatever the UI language; tier, tag and custom prices carry the names users gave them.
 */
export function priceOptionLabel(option: Pick<PriceOption, 'name' | 'type'>, t: (key: string) => string): string {
  if (option.type === 'base') return t('warehouse.sellingPrice')
  // FR-27.11.C.6: never the level's name; the server sends none.
  if (option.type === 'customer') return t('pricing.customerPrice')
  return option.name
}

export function formatPriceItem(option: PriceOption, currency?: string): string {
  // Legacy price tiers carry 4-decimal unit prices (e.g. 0.0071) — never round them away.
  const price = option.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4, useGrouping: false })
  return `${price} — ${option.name}`
}
