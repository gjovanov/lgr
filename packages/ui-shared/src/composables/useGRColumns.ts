import { ref, computed, watch, type Ref } from 'vue'
import { PRICE_TIERS, PRICE_TIER_COLUMN_PREFIX } from 'config/constants'

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
  /** Heading: a label key in ui-shared locales — or, for a tier, the tier's own name (`label`). */
  i18n?: string
  /** A literal heading: a price tier's name, which is data and is not translated. */
  label?: string
  inputType: 'text' | 'number' | 'select' | 'autocomplete'
  /** Map onto the product update payload. */
  productField?: string
  /** A price tier column: the NAME of the tier it shows and edits (`gr-product-update.ts`). */
  tierName?: string
  defaultOn: boolean
  align?: 'start' | 'end'
}

/** The tiers a column is shown for until the user picks others: the headings these forms always had. */
const DEFAULT_TIER_NAMES: readonly string[] = ['Цена 1', 'Цена 2', 'Цена 3']

export const GR_COLUMNS: GRColumn[] = [
  // Basic product fields
  { key: 'type',         section: 'basic',   i18n: 'warehouse.grCol.type',         inputType: 'select',       productField: 'type',       defaultOn: false },
  { key: 'categoryId',   section: 'basic',   i18n: 'warehouse.grCol.category',     inputType: 'autocomplete', productField: 'categoryId', defaultOn: false },
  { key: 'unit',         section: 'basic',   i18n: 'warehouse.grCol.unit',         inputType: 'autocomplete', productField: 'unit',       defaultOn: false },
  // Pricing
  { key: 'purchasePrice', section: 'pricing', i18n: 'warehouse.grCol.purchasePrice', inputType: 'number', productField: 'purchasePrice', defaultOn: true,  align: 'end' },
  { key: 'sellingPrice',  section: 'pricing', i18n: 'warehouse.grCol.sellingPrice',  inputType: 'number', productField: 'sellingPrice',  defaultOn: true,  align: 'end' },
  { key: 'taxRate',       section: 'pricing', i18n: 'warehouse.grCol.taxRate',       inputType: 'number', productField: 'taxRate',       defaultOn: false, align: 'end' },
  // Price tiers: one column per canonical slot, headed by the tier's NAME and finding it on the
  // product BY NAME (as the Products list's tier columns do, `product-price-columns.ts`). They
  // were ten positional columns, „Цена 1..10" over slots 0..9 — on the 13-slot layout that put
  // Доставна цена under „Цена 1", Цена на едро under „Цена 2" and Цена 0 under „Цена 3".
  ...PRICE_TIERS.map((t): GRColumn => ({
    key: `${PRICE_TIER_COLUMN_PREFIX}${t.key}`,
    section: 'tier',
    label: t.name,
    inputType: 'number',
    tierName: t.name,
    defaultOn: DEFAULT_TIER_NAMES.includes(t.name),
    align: 'end',
  })),
]

const DEFAULT_SELECTION = GR_COLUMNS.filter(c => c.defaultOn).map(c => c.key)

/**
 * A key saved before the tier columns went by name: `price3` was the column headed „Цена 3", so
 * it is the column of the tier named „Цена 3" now — the user picked it by that heading.
 */
function currentKey(key: string): string {
  const m = /^price(\d+)$/.exec(key)
  return m ? `${PRICE_TIER_COLUMN_PREFIX}${m[1]}` : key
}

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
      // Legacy fallback: before the user id was wired correctly, prefs were saved
      // under the 'anon' key — keep honouring them until the user re-saves.
      const raw = localStorage.getItem(storageKey.value)
        ?? localStorage.getItem(`lgr:gr-columns:anon:${unwrap(opts.orgId) || 'no-org'}`)
      if (raw) {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr) && arr.every(s => typeof s === 'string')) {
          // Drop any keys no longer in the catalog (forward-compat if we remove columns later).
          const keys = new Set(arr.map(currentKey))
          selected.value = GR_COLUMNS.filter(c => keys.has(c.key)).map(c => c.key)
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
