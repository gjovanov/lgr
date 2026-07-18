import { ref, computed, watch, type Ref } from 'vue'

/**
 * Goods-receipt-with-update column catalog + localStorage persistence.
 * One row per user × org. Selection survives reloads.
 *
 * The composable is pure: caller passes user/org IDs (typically from its own app store).
 * The storage key is intentionally shared between the inventory movements form and the
 * invoicing bills form — same catalog, one selection per user × org.
 */

export type GRColumnSection = 'basic' | 'pricing' | 'tier'

export interface GRColumn {
  key: string
  section: GRColumnSection
  i18n: string                      // label key in ui-shared locales
  inputType: 'text' | 'number' | 'select' | 'autocomplete'
  /** Map onto the product update payload. For tiers: priceTiers[i].finalPrice */
  productField?: string
  /** For tier slots only: which tier index (0-9) this column edits */
  tierIndex?: number
  defaultOn: boolean
  align?: 'start' | 'end'
}

export const GR_COLUMNS: GRColumn[] = [
  // Basic product fields
  { key: 'type',         section: 'basic',   i18n: 'warehouse.grCol.type',         inputType: 'select',       productField: 'type',       defaultOn: false },
  { key: 'categoryId',   section: 'basic',   i18n: 'warehouse.grCol.category',     inputType: 'autocomplete', productField: 'categoryId', defaultOn: false },
  { key: 'unit',         section: 'basic',   i18n: 'warehouse.grCol.unit',         inputType: 'autocomplete', productField: 'unit',       defaultOn: false },
  // Pricing
  { key: 'purchasePrice', section: 'pricing', i18n: 'warehouse.grCol.purchasePrice', inputType: 'number', productField: 'purchasePrice', defaultOn: true,  align: 'end' },
  { key: 'sellingPrice',  section: 'pricing', i18n: 'warehouse.grCol.sellingPrice',  inputType: 'number', productField: 'sellingPrice',  defaultOn: true,  align: 'end' },
  { key: 'taxRate',       section: 'pricing', i18n: 'warehouse.grCol.taxRate',       inputType: 'number', productField: 'taxRate',       defaultOn: false, align: 'end' },
  // Price tier slots (edit priceTiers[i].finalPrice)
  ...Array.from({ length: 10 }, (_, i) => ({
    key: `price${i + 1}`,
    section: 'tier' as GRColumnSection,
    i18n: `warehouse.grCol.price${i + 1}`,
    inputType: 'number' as const,
    tierIndex: i,
    defaultOn: i < 3,  // show price1..3 by default
    align: 'end' as const,
  })),
]

const DEFAULT_SELECTION = GR_COLUMNS.filter(c => c.defaultOn).map(c => c.key)

export interface UseGRColumnsOpts {
  /** Reactive user id (may change on login/logout). Falls back to 'anon'. */
  userId?: Ref<string | undefined> | (() => string | undefined)
  /** Reactive org id. Falls back to 'no-org'. */
  orgId?: Ref<string | undefined> | (() => string | undefined)
}

function unwrap(v: Ref<string | undefined> | (() => string | undefined) | undefined): string | undefined {
  if (!v) return undefined
  return typeof v === 'function' ? v() : v.value
}

export function useGRColumns(opts: UseGRColumnsOpts = {}) {
  const storageKey = computed(() => {
    const userId = unwrap(opts.userId) || 'anon'
    const orgId = unwrap(opts.orgId) || 'no-org'
    return `lgr:gr-columns:${userId}:${orgId}`
  })

  const selected = ref<string[]>([])

  function load() {
    try {
      const raw = localStorage.getItem(storageKey.value)
      if (raw) {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr) && arr.every(s => typeof s === 'string')) {
          // Drop any keys no longer in the catalog (forward-compat if we remove columns later).
          selected.value = arr.filter(k => GR_COLUMNS.some(c => c.key === k))
          return
        }
      }
    } catch { /* corrupt JSON → fall through */ }
    selected.value = [...DEFAULT_SELECTION]
  }

  function save() {
    try { localStorage.setItem(storageKey.value, JSON.stringify(selected.value)) }
    catch { /* quota or private-browsing — ignore */ }
  }

  watch(selected, save, { deep: true })
  watch(storageKey, load, { immediate: true })

  const activeColumns = computed<GRColumn[]>(() =>
    GR_COLUMNS.filter(c => selected.value.includes(c.key)),
  )

  function toggle(key: string) {
    const next = new Set(selected.value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    // Preserve catalog order.
    selected.value = GR_COLUMNS.filter(c => next.has(c.key)).map(c => c.key)
  }

  function selectAll()  { selected.value = GR_COLUMNS.map(c => c.key) }
  function selectNone() { selected.value = [] }
  function resetDefaults() { selected.value = [...DEFAULT_SELECTION] }

  return { selected, activeColumns, toggle, selectAll, selectNone, resetDefaults }
}
