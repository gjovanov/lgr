/**
 * Bulgarian VAT group mapping for fiscal printers.
 *
 * Bulgarian fiscal printers use letter-coded VAT groups:
 *   А (A) - Standard rate (20%) — goods
 *   Б (B) - Standard rate (20%) — services
 *   В (V) - Reduced rate (9%) — tourism, books, etc.
 *   Г (G) - Zero rate (0%) — exports, intra-community supplies
 *
 * Per Appendix 29, the SUPTO must map each product's tax rate to
 * the correct fiscal VAT group.
 */

import type { VatGroup } from './types.js'

export interface VatGroupConfig {
  group: VatGroup
  rate: number
  label: string
}

/** Default Bulgarian VAT group configuration */
export const DEFAULT_VAT_GROUPS: VatGroupConfig[] = [
  { group: 'А', rate: 20, label: 'Standard rate (goods)' },
  { group: 'Б', rate: 20, label: 'Standard rate (services)' },
  { group: 'В', rate: 9, label: 'Reduced rate' },
  { group: 'Г', rate: 0, label: 'Zero rate' },
]

/**
 * Map a product's tax rate percentage to the correct Bulgarian VAT group.
 *
 * @param taxRate - The product's tax rate as a percentage (e.g., 20 for 20%)
 * @param isService - Whether the product is a service (uses Б instead of А for 20%)
 * @returns The VAT group letter
 */
export function mapTaxRateToVatGroup(taxRate: number, isService: boolean = false): VatGroup {
  if (taxRate >= 18) {
    return isService ? 'Б' : 'А'
  }
  if (taxRate >= 7) {
    return 'В'
  }
  return 'Г'
}
