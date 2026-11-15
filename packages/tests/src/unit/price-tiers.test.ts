import { describe, it, expect } from 'bun:test'
import { PRICE_TIERS } from 'config/constants'
import { COST_TIER_NAMES, capOfTier } from 'config/access'
import {
  DELIVERY_TIER_NAME, PURCHASE_BASIS_TIER_NAME, canonicalTierName, hasTierLabel, marginsAfterPurchaseChange,
  purchasePriceForNewProduct, purchasePriceFromTier2, tierFinalPrice, tierLabel, tierNameOfLabel,
} from 'config/price-tiers'
import { productColumnHeaders } from 'ui-shared/composables/product-list/useProductColumns'
import { GR_COLUMNS, grColumnLabel } from 'ui-shared/composables/useGRColumns'
import { priceOptionLabel, priceStepLabel } from 'ui-shared/composables/usePriceOptions'
import { buildTiers } from 'services/biz/doc-import/map-movement'
import { newProductDoc } from 'services/biz/doc-import/persist-movement'

/**
 * `config/price-tiers` (owner, 2026-11-15): what a person reads for the slot stored as „Доставна цена", and the
 * purchase price an article takes from its „Цена 2".
 */

describe('the slot stored as „Доставна цена" is a key, and reads „Цена с ТО"', () => {
  it('is still the first canonical slot, a cost figure, under its stored name', () => {
    expect(PRICE_TIERS[0]).toEqual({ key: 'delivery', name: DELIVERY_TIER_NAME })
    expect(DELIVERY_TIER_NAME).toBe('Доставна цена')
    expect(COST_TIER_NAMES).toEqual([DELIVERY_TIER_NAME])
    expect(capOfTier(DELIVERY_TIER_NAME)).toBe('products.costs')
  })

  it('has a short and a long label per language, and English for a language it does not know', () => {
    expect([tierLabel(DELIVERY_TIER_NAME, 'bg'), tierLabel(DELIVERY_TIER_NAME, 'bg', 'long')]).toEqual(['Цена с ТО', 'Цена с търговска отстъпка (Цена с ТО)'])
    expect([tierLabel(DELIVERY_TIER_NAME, 'en'), tierLabel(DELIVERY_TIER_NAME, 'en', 'long')]).toEqual(['Trade-discount price', 'Price with trade discount'])
    expect(tierLabel(DELIVERY_TIER_NAME, 'de', 'long')).toBe('Preis mit Handelsrabatt')
    expect([tierLabel(DELIVERY_TIER_NAME, 'mk'), tierLabel(DELIVERY_TIER_NAME, 'mk', 'long')]).toEqual(['Цена со ТП', 'Цена со трговски попуст'])
    expect(tierLabel(DELIVERY_TIER_NAME, 'bg-BG')).toBe('Цена с ТО')
    expect(tierLabel(DELIVERY_TIER_NAME, undefined)).toBe('Trade-discount price')
    // An import's folded heading is the same slot.
    expect(tierLabel('Доставнацена', 'bg')).toBe('Цена с ТО')
  })

  it('draws every other name as it is', () => {
    for (const t of PRICE_TIERS.slice(1)) expect(tierLabel(t.name, 'bg', 'long')).toBe(t.name)
    expect(tierLabel('Price 3', 'en')).toBe('Price 3')
    expect(PRICE_TIERS.filter((t) => hasTierLabel(t.name)).map((t) => t.key)).toEqual(['delivery'])
  })

  it('takes a typed label back to the stored name, and never the other way', () => {
    for (const typed of ['Цена с ТО', 'цена с то', 'Цена с търговска отстъпка (Цена с ТО)', 'Price with trade discount', 'Trade-discount price', 'Preis mit Handelsrabatt', 'Цена со ТП', 'Цена со трговски попуст']) {
      expect(tierNameOfLabel(typed)).toBe(DELIVERY_TIER_NAME)
      expect(canonicalTierName(typed)).toBe(DELIVERY_TIER_NAME)
      // A label is no cost-slot name to the access rules: it must never be what is stored.
      expect(capOfTier(canonicalTierName(typed))).toBe('products.costs')
    }
    expect(tierNameOfLabel('Доставна цена')).toBeNull()
    expect(tierNameOfLabel('Цена 2')).toBeNull()
    expect(canonicalTierName('Цена2')).toBe('Цена 2')
    expect(canonicalTierName('Моя цена ')).toBe('Моя цена ')
  })

  it('heads the Products list, the goods receipt and the price menus with the label, keyed by the slot', () => {
    const t = (k: string) => k
    const head = (locale: string) => productColumnHeaders(t, { seesSuppliers: false, activeFilter: 'active', locale }).find((h: any) => h.key === 'tier_delivery')
    expect(head('bg')).toMatchObject({ key: 'tier_delivery', title: 'Цена с ТО' })
    expect(head('en').title).toBe('Trade-discount price')
    expect(productColumnHeaders(t, { seesSuppliers: false, activeFilter: 'active', locale: 'bg', seesCosts: false }).some((h: any) => h.key === 'tier_delivery')).toBe(false)

    const col = GR_COLUMNS.find((c) => c.key === 'tier_delivery')!
    expect([col.tierName, col.label]).toEqual([DELIVERY_TIER_NAME, DELIVERY_TIER_NAME])
    expect(grColumnLabel(col, t, 'bg')).toBe('Цена с ТО')
    expect(grColumnLabel(GR_COLUMNS.find((c) => c.key === 'tier_2')!, t, 'bg')).toBe('Цена 2')
    expect(grColumnLabel(GR_COLUMNS.find((c) => c.key === 'purchasePrice')!, t, 'bg')).toBe('warehouse.grCol.purchasePrice')

    expect(priceOptionLabel({ name: DELIVERY_TIER_NAME, type: 'tier' }, t, 'bg')).toBe('Цена с ТО')
    expect(priceOptionLabel({ name: 'Цена 4', type: 'tier' }, t, 'bg')).toBe('Цена 4')
    // A tag or contact price is named by a person: drawn as named, whatever the name.
    expect(priceOptionLabel({ name: DELIVERY_TIER_NAME, type: 'tag' }, t, 'bg')).toBe(DELIVERY_TIER_NAME)
    expect(priceStepLabel({ type: 'tier', label: DELIVERY_TIER_NAME }, 'bg')).toBe('Цена с търговска отстъпка (Цена с ТО)')
    expect(priceStepLabel({ type: 'base', label: 'Selling price' }, 'bg')).toBe('Selling price')
  })
})

describe('„Покупна цена" = „Цена 2" / 1.2', () => {
  it('rounds to four decimals, a half going up', () => {
    expect(PURCHASE_BASIS_TIER_NAME).toBe('Цена 2')
    expect(purchasePriceFromTier2(1.2)).toBe(1)
    expect(purchasePriceFromTier2(12)).toBe(10)
    expect(purchasePriceFromTier2(0.06)).toBe(0.05)
    expect(purchasePriceFromTier2(1)).toBe(0.8333)
    expect(purchasePriceFromTier2(100)).toBe(83.3333)
    // 0.0471 / 1.2 is 0.03925 exactly; the double is not, and the half must still go up.
    expect(purchasePriceFromTier2(0.0471)).toBe(0.0393)
    expect(purchasePriceFromTier2(0.0003)).toBe(0.0003)
    expect(purchasePriceFromTier2('2.4')).toBe(2)
  })

  it('is null without a „Цена 2" to take it from', () => {
    for (const none of [0, -1, null, undefined, '', 'x', NaN, Infinity]) expect(purchasePriceFromTier2(none)).toBeNull()
  })

  it('a new article: by the rule when the row carries „Цена 2", else the delivery price', () => {
    expect(purchasePriceForNewProduct(0.9, { 'Цена 1': 1.5, 'Цена 2': 1.2 })).toBe(1)
    expect(purchasePriceForNewProduct(0.9, { 'Цена2': 1.2 })).toBe(1)
    expect(purchasePriceForNewProduct(0.9, { 'Цена 1': 1.5 })).toBe(0.9)
    expect(purchasePriceForNewProduct(0.9, { 'Цена 2': 0 })).toBe(0.9)
    expect(purchasePriceForNewProduct(0.9, undefined)).toBe(0.9)
    expect(purchasePriceForNewProduct(undefined, undefined)).toBe(0)
  })

  it('an import creates the article with it, the delivery price in its slot, and margins over the purchase price', () => {
    const doc = newProductDoc('org', { name: 'Болт', unit: 'pcs', cost: 0.9, selling: 2, tiers: { 'Цена 1': 1.5, 'Цена 2': 1.2 } } as any, { sku: 'S-1', categoryName: 'Общи', currency: 'BGN', taxRate: 20 })
    expect(doc.purchasePrice).toBe(1)
    expect(tierFinalPrice(doc.priceTiers, DELIVERY_TIER_NAME)).toBe(0.9)
    const percent = (name: string) => doc.priceTiers.find((t: any) => t.name === name).percent
    expect([percent(DELIVERY_TIER_NAME), percent('Цена 1'), percent('Цена 2')]).toEqual([-10, 50, 20])

    // No „Цена 2" on the document (and the inline „+ Нов продукт", which carries no tiers): as before.
    const plain = newProductDoc('org', { name: 'Гайка', unit: 'pcs', cost: 0.9, tiers: { 'Цена 1': 1.8 } } as any, { sku: 'S-2', categoryName: 'Общи', currency: 'BGN', taxRate: 20 })
    expect(plain.purchasePrice).toBe(0.9)
    expect(plain.priceTiers.find((t: any) => t.name === 'Цена 1').percent).toBe(100)
    expect(buildTiers(0.9, {})[0]).toMatchObject({ name: DELIVERY_TIER_NAME, finalPrice: 0.9, percent: 0 })
  })
})

describe('a corrected purchase price moves margins, never prices', () => {
  const slot = (percent: number, finalPrice: number, manualOverride: boolean) => ({ percent, finalPrice, manualOverride })

  it('a slot fixed by hand takes the margin over the new purchase price', () => {
    expect([...marginsAfterPurchaseChange([slot(0, 0.9, true), slot(33.3, 1.2, true)], 0.9, 1)]).toEqual([[0, -10], [1, 20]])
  })

  it('a slot that followed the old purchase price follows the new one; any other is left as stored', () => {
    const tiers = [slot(50, 1.35, false), slot(0, 2, false), slot(0, 0, false)]
    expect([...marginsAfterPurchaseChange(tiers, 0.9, 1)]).toEqual([[0, 35]])
  })

  it('a margin an import wrote to one decimal is the true one, and a second pass changes nothing', () => {
    // 2.4 over 2.0833 is 15.202 %: an import stores 15.2.
    expect(marginsAfterPurchaseChange([slot(15.2, 2.4, true)], 2.0833, 2.0833).size).toBe(0)
    const tiers = [slot(0, 0.9, true), slot(33.3, 1.2, true), slot(50, 1.35, false)]
    const first = marginsAfterPurchaseChange(tiers, 0.9, 1)
    const written = tiers.map((t, i) => ({ ...t, percent: first.get(i) ?? t.percent }))
    expect(marginsAfterPurchaseChange(written, 1, 1).size).toBe(0)
  })

  it('does nothing without a purchase price to stand over', () => {
    expect(marginsAfterPurchaseChange([slot(10, 1, true)], 1, 0).size).toBe(0)
    expect(marginsAfterPurchaseChange(null, 1, 2).size).toBe(0)
  })
})
