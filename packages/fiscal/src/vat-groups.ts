/**
 * Bulgarian VAT group mapping for fiscal printers.
 *
 * The groups are fixed by Наредба Н-18, чл. 27, ал. 1 — every fiscal device is programmed
 * with them, whatever its manufacturer:
 *
 *   А — sales exempt from VAT, taxed at 0 %, or not subject to VAT
 *   Б — sales taxed at 20 %
 *   В — liquid fuels sold through fuel meters (never used by LGR)
 *   Г — sales taxed at 9 %
 *
 * ⚠ This file used to map 20 % goods → А, 20 % services → Б, 9 % → В and 0 % → Г. On a real
 * device that books every 20 % sale of goods as VAT-exempt. It went unnoticed only because
 * the POS printed non-fiscal text receipts, which carry no VAT groups at all. There is no
 * goods/services split in Н-18: both are Б at 20 %.
 */

import type { VatGroup } from './types.js'

export interface VatGroupConfig {
  group: VatGroup
  rate: number
  label: string
}

/** The Н-18 groups, in device order. */
export const DEFAULT_VAT_GROUPS: VatGroupConfig[] = [
  { group: 'А', rate: 0, label: 'Exempt / 0 % / not subject to VAT' },
  { group: 'Б', rate: 20, label: 'Standard rate (20 %)' },
  { group: 'В', rate: 20, label: 'Liquid fuels via fuel meters' },
  { group: 'Г', rate: 9, label: 'Reduced rate (9 %)' },
]

/**
 * Map a product's tax rate percentage to its Н-18 fiscal VAT group.
 *
 * @param taxRate - The product's tax rate as a percentage (e.g., 20 for 20%)
 * @param _isService - Ignored. Kept so existing call sites compile: Н-18 has no separate
 *   group for services — a 20 % service is Б, exactly like a 20 % good.
 */
export function mapTaxRateToVatGroup(taxRate: number, _isService: boolean = false): VatGroup {
  if (taxRate >= 18) return 'Б'
  if (taxRate >= 7) return 'Г'
  return 'А'
}
