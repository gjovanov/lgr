import type { Grant } from 'config/access'
import { tierLabel } from 'config/price-tiers'
import { startingStockReceiptLevel, visibleStockReceiptLevels, type StockReceiptPriceLevel } from 'config/stock-receipt-price'
import { rememberedSetting } from 'ui-shared/composables/useUserDefaults'

/**
 * Which price a bill's „Складова разписка" prints, as its dialog offers and remembers it (owner, 2026-11-15).
 *
 * The levels and who sees them are `config/stock-receipt-price`: the list the route validates against, so the
 * dialog never offers a level the route would refuse. What is kept here is the person's last choice, per user and
 * org (`lgr:stock-receipt-price:<user>:<org>`): the level's key, which is what the route takes.
 */
const store = rememberedSetting<string>('stock-receipt-price')

export interface PriceLevelItem {
  /** The level's key: `selling`, `booked`, or a slot's stored name. What is remembered and what is sent. */
  value: string
  /** What a person reads: a slot by its label, never by the name it is stored under. */
  title: string
}

/** A level's name on screen. The selling price reads as it does on the product form and in the price pickers. */
export function stockReceiptLevelLabel(level: StockReceiptPriceLevel, t: (key: string) => string, locale?: string): string {
  if (level.kind === 'selling') return t('warehouse.sellingPrice')
  if (level.kind === 'booked') return t('invoicing.stockReceipt.booked')
  return tierLabel(level.tier, locale)
}

/** The dialog's list: the levels this role sees, in order, each under its name in the app's language. */
export function priceLevelItems(grant: Grant, t: (key: string) => string, locale?: string): PriceLevelItem[] {
  return visibleStockReceiptLevels(grant).map((level) => ({ value: level.key, title: stockReceiptLevelLabel(level, t, locale) }))
}

/**
 * The level the dialog opens on: the person's last choice, on any bill, while it is still a level their role sees;
 * until they have chosen, or once it is gone, „Цена на едро" (or the first level the role sees).
 */
export function startingPriceLevel(grant: Grant): string {
  return startingStockReceiptLevel(grant, store.read()).key
}

export function rememberPriceLevel(key: string): void {
  store.write(key)
}
