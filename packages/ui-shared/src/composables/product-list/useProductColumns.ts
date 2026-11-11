import { computed, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { capOfTier, type CapabilityId } from 'config/access'
import { TIER_COLUMNS } from '../product-price-columns'
import { useAccess } from '../../access/useAccess'
import type { ActiveFilter } from './product-list-params'

/**
 * FR-28.22 — the columns of the product list, defined once for the Products list and the product
 * dialog, so the dialog can show what the list shows (FR-28.23) and the user's saved choice
 * (`lgr:grid-cols:<userId>:<orgId>:inventory.products`) means the same in both.
 *
 * `productColumnHeaders` is a pure function of the translator and the options (`unit/product-columns.test.ts`
 * holds it); `useProductColumns` only wires it to the app's language.
 */

/** The columns `ProductCell` draws. The name and the row menu are the view's own. */
export const PRODUCT_CELL_KEYS: readonly string[] = [
  'sku', 'type', 'stock', 'reserved', 'onOrder', 'suppliers', 'lastPurchase', 'lastCost', 'minStockLevel', 'toOrder',
  'purchasePrice', 'sellingPrice', ...TIER_COLUMNS.map((c) => c.key), 'isActive',
  // The till's catalog.
  'stockAvailable',
]

/**
 * The name column is never narrower than this (owner, 2026-11-11): at 180 px a name of 30 to 40 characters, which is
 * most of a real catalogue, stood on two lines whenever the other columns took the room. This fits a 36-character
 * name in capitals („4294 АРОМАТИЗАТОР - СПАРКО - ВАНИЛИЯ") on one line; a longer one still wraps. The price is that
 * the list no longer fits 1366 px even with the price tiers hidden: it scrolls sideways there, with the name and the
 * row menu pinned (`product-actions.spec`).
 */
export const NAME_MIN_WIDTH = '360px'
/** The price columns take FR-22.23's 8 px gutters, which is what lets the whole list fit 1920 px in Bulgarian. */
const PRICE_CELL = { headerProps: { class: 'px-2' }, cellProps: { class: 'px-2' } }

export interface ProductColumnsOptions {
  /** Supplier facts are incoming-document data (`bills.view`): a role without it is offered none of the columns. */
  seesSuppliers: boolean
  /** Only a list that can hold deactivated articles shows who is active. */
  activeFilter: ActiveFilter
  /** The row menu: the Products list has one, the dialog does not. */
  withActions?: boolean
  /**
   * Columns that start shown even though the list hides them, for a screen whose price is one of them
   * (a bill starts from the purchase price). A user's own choice still wins: this only moves the default.
   */
  shownByDefault?: readonly string[]
  /** The till's catalog has its own, shorter set of columns. */
  source?: 'products' | 'till'
  /**
   * FR-27.6 (`products.costs`): without it no cost figure is offered, the purchase price, the „Доставна цена" slot or
   * the last purchase's cost. The server sends none of them either. Default: offered.
   */
  seesCosts?: boolean
  /** FR-27.11.D: which price levels the role sees (the selling price, a slot). Default: every one. */
  sees?: (cap: CapabilityId) => boolean
}

type Translate = (key: string) => string

export function productColumnHeaders(t: Translate, opts: ProductColumnsOptions): any[] {
  const shown = new Set(opts.shownByDefault ?? [])
  /** `defaultHidden` for a column, unless this screen starts with it shown. */
  const hidden = (key: string, hide = true) => (hide && !shown.has(key) ? { defaultHidden: true } : {})

  if (opts.source === 'till') {
    return [
      { title: t('warehouse.sku'), key: 'sku', sortable: true },
      { title: t('common.name'), key: 'name', sortable: true, minWidth: NAME_MIN_WIDTH },
      { title: t('warehouse.category'), key: 'category', sortable: true },
      { title: t('common.type'), key: 'type', sortable: true },
      { title: t('warehouse.unit'), key: 'unit', sortable: false },
      { title: t('pos.stock'), key: 'stockAvailable', sortable: false, align: 'end' as const },
      { title: t('warehouse.sellingPrice'), key: 'sellingPrice', sortable: false, align: 'end' as const },
    ]
  }

  return [
    { title: t('warehouse.sku'), key: 'sku', sortable: true },
    { title: t('common.name'), key: 'name', sortable: true, fixed: 'start' as const, minWidth: NAME_MIN_WIDTH },
    { title: t('warehouse.category'), key: 'category', sortable: true },
    { title: t('common.type'), key: 'type' },
    { title: t('warehouse.stock'), key: 'stock' },
    { title: t('warehouse.supply.reserved'), key: 'reserved', align: 'end' as const },
    { title: t('warehouse.supply.onOrder'), key: 'onOrder', align: 'end' as const },
    // FR-28.6: who sold it to us, right after what is on order — where "what do we do about it" is asked. None of
    // these sorts: they are read from the documents, not a field of the article. The supplier names are shown;
    // the last purchase and its cost, the minimum and what to order wait on the cog (`defaultHidden`), so a
    // user's saved columns neither lose the names nor gain the rest.
    ...(opts.seesSuppliers ? [
      // The names are cut inside a capped box and the column takes the price columns' 8 px gutters: with it shown by
      // default the list still fits 1366 px without the tiers (FR-22.23, product-actions.spec).
      { title: t('warehouse.supplierFacts.column'), key: 'suppliers', sortable: false, ...PRICE_CELL },
      { title: t('warehouse.supplierFacts.lastPurchase'), key: 'lastPurchase', sortable: false, ...hidden('lastPurchase') },
      ...(opts.seesCosts === false ? [] : [{ title: t('warehouse.supplierFacts.lastCost'), key: 'lastCost', sortable: false, align: 'end' as const, ...hidden('lastCost'), ...PRICE_CELL }]),
    ] : []),
    { title: t('warehouse.supplierFacts.minimum'), key: 'minStockLevel', align: 'end' as const, ...hidden('minStockLevel') },
    { title: t('warehouse.supplierFacts.toOrder'), key: 'toOrder', sortable: false, align: 'end' as const, ...hidden('toOrder') },
    { title: t('warehouse.unit'), key: 'unit' },
    ...(opts.seesCosts === false ? [] : [{ title: t('warehouse.purchasePrice'), key: 'purchasePrice', align: 'end' as const, ...hidden('purchasePrice'), ...PRICE_CELL }]),
    ...(opts.sees && !opts.sees('products.price:selling') ? [] : [{ title: t('warehouse.sellingPrice'), key: 'sellingPrice', align: 'end' as const, ...PRICE_CELL }]),
    // A column per price tier, headed by the tier's name and sorted by its price (the server reads
    // the tier out of `tier_<slot>`); the slots regal prices by are shown, the rest wait on the cog.
    // FR-27.11.D: only the slots the role sees (the buying-price one is a cost figure).
    ...TIER_COLUMNS.filter((c) => {
      const cap = capOfTier(c.name)
      return cap === 'products.costs' ? opts.seesCosts !== false : !opts.sees || opts.sees(cap)
    })
      .map((c) => ({ title: c.name, key: c.key, align: 'end' as const, ...hidden(c.key, c.defaultHidden), ...PRICE_CELL })),
    // FR-22.48: only when the list can hold deactivated articles. Among active ones it says "yes"
    // on every row, and its width is what keeps the row actions inside 1366 px. It takes the price columns' 8 px
    // gutters too: the tick column of FR-28.13 is 48 px of that width, and "all statuses" has to fit as it did.
    ...(opts.activeFilter === 'active' ? [] : [{ title: t('common.active'), key: 'isActive', align: 'center' as const, ...PRICE_CELL }]),
    ...(opts.withActions === false ? [] : [{ title: t('common.actions'), key: 'actions', sortable: false, fixed: 'end' as const }]),
  ]
}

export interface UseProductColumnsOptions extends Omit<ProductColumnsOptions, 'activeFilter' | 'shownByDefault'> {
  activeFilter: Ref<ActiveFilter>
  shownByDefault?: () => readonly string[]
}

export function useProductColumns(opts: UseProductColumnsOptions) {
  const { t } = useI18n()
  const access = useAccess()
  const headers = computed(() => productColumnHeaders((k) => t(k), {
    seesCosts: access.can('products.costs'),
    sees: (cap) => access.can(cap),
    seesSuppliers: opts.seesSuppliers,
    activeFilter: opts.activeFilter.value,
    withActions: opts.withActions,
    shownByDefault: opts.shownByDefault?.(),
    source: opts.source,
  }))
  return { headers }
}
