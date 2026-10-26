import { useI18n } from 'vue-i18n'

/**
 * A product's type: the value the API stores, and the name the user reads (FR-22.11).
 *
 * The values are the Product model's enum — `config`'s PRODUCT_TYPES, which
 * `unit/web-catalogue-i18n.test.ts` keeps equal to this list. The names live under
 * `warehouse.productTypes.<type>`. Shown raw until then, the Bulgarian UI said „goods" on the
 * product form, the products list, the product picker and a receipt's update columns.
 */
export const PRODUCT_TYPES = ['goods', 'service', 'raw_material', 'finished_product'] as const
export type ProductType = (typeof PRODUCT_TYPES)[number]

export function useProductTypes() {
  const { t, te } = useI18n()

  /** The type's name; a value the catalogue does not know is shown as it is. */
  function productTypeLabel(type: string | null | undefined): string {
    if (!type) return ''
    const key = `warehouse.productTypes.${type}`
    return te(key) ? t(key) : type
  }

  /** `{ title, value }` items for a v-select: all four types, or the ones a filter offers. */
  function productTypeItems(types: readonly string[] = PRODUCT_TYPES) {
    return types.map(value => ({ title: productTypeLabel(value), value }))
  }

  return { productTypeLabel, productTypeItems }
}
