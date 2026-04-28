import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * Canonical list of unit-of-measure codes used across the app. Adding/removing here
 * propagates to the Products form, the invoice line items "Unit" column, and any other
 * place that should share the same vocabulary.
 *
 * Translations live under `warehouse.uom.<code>` in each locale file.
 */
export const UOM_CODES = [
  'pcs', 'pair', 'set', 'box', 'pack', 'dozen',
  'g', 'kg', 'ton', 'lb', 'oz',
  'ml', 'L', 'm3', 'gal',
  'mm', 'cm', 'm', 'km', 'in', 'ft',
  'm2', 'ha',
  'hr', 'day', 'month',
] as const

export type UomCode = typeof UOM_CODES[number]

export interface UomOption {
  value: string
  title: string
}

export function useProductUnits() {
  const { t } = useI18n()

  const uomOptions = computed<UomOption[]>(() =>
    UOM_CODES.map(code => ({
      value: code,
      title: `${t(`warehouse.uom.${code}`)} (${code})`,
    })),
  )

  return { uomOptions, UOM_CODES }
}
