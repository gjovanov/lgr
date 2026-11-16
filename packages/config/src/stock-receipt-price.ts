import { PRICE_TIER_NAMES } from './constants'
import { canonicalTierName } from './price-tiers'
import { capOfTier, seesLevel } from './access/fields'
import type { CapabilityId } from './access/catalogue'
import type { Grant } from './access/grant'

/**
 * Which price a supplier bill's „Складова разписка" prints (owner, 2026-11-15).
 *
 * The sheet goes to the people in the warehouse, who price the goods from it. So its price column shows one price
 * LEVEL of each article, as the catalogue holds it on the day it is printed, and the person printing chooses the level.
 *
 * ONE list, for the dialog that offers the levels and for the route that prints them
 * (`GET /invoicing/export/:id?doc=stock_receipt&priceLevel=<key>`):
 *   - `selling`: the selling price;
 *   - a canonical slot (`PRICE_TIERS`), by its STORED name, which is also its key. A screen and the sheet draw it
 *     through `price-tiers#tierLabel` („Доставна цена" reads „Цена с ТО");
 *   - `booked`: the unit prices the receipt itself was booked at. It is what the sheet printed before it asked, and it
 *     is last in the list.
 * A tier an organization named itself (outside the slots) is not a level here, as it is no column of the Products list.
 *
 * Who may print which level is FR-27.11's rule, the one the product routes apply (`access/fields.ts`): the route
 * refuses a level the caller's role does not see, and the dialog offers only the others.
 *
 * Import-pure: the SPA and the server read the same list.
 */

export const STOCK_RECEIPT_SELLING = 'selling'
export const STOCK_RECEIPT_BOOKED = 'booked'
/** The level the dialog starts on, and the one a request that names none prints. */
export const STOCK_RECEIPT_DEFAULT_TIER = 'Цена на едро'

export type StockReceiptPriceLevel =
  | { key: typeof STOCK_RECEIPT_SELLING; kind: 'selling' }
  | { key: string; kind: 'tier'; tier: string }
  | { key: typeof STOCK_RECEIPT_BOOKED; kind: 'booked' }

const BOOKED: StockReceiptPriceLevel = { key: STOCK_RECEIPT_BOOKED, kind: 'booked' }

/** Every level, in the order the dialog lists them. */
export const STOCK_RECEIPT_PRICE_LEVELS: readonly StockReceiptPriceLevel[] = [
  { key: STOCK_RECEIPT_SELLING, kind: 'selling' },
  ...PRICE_TIER_NAMES.map((tier): StockReceiptPriceLevel => ({ key: tier, kind: 'tier', tier })),
  BOOKED,
]

/**
 * What a role must hold to print a level. Null for `booked`: it asks nothing beyond the print itself, which shows
 * what the bill and its receipts already show whoever may open them.
 */
export function capOfStockReceiptLevel(level: StockReceiptPriceLevel): CapabilityId | null {
  if (level.kind === 'selling') return 'products.price:selling'
  return level.kind === 'tier' ? capOfTier(level.tier) : null
}

/**
 * The level a `priceLevel` names, or null when it names none. A slot is found as every reader of a slot's name finds
 * it (`canonicalTierName`: „Цена2" is „Цена 2", a label is its slot).
 */
export function stockReceiptLevelOf(key: unknown): StockReceiptPriceLevel | null {
  const text = typeof key === 'string' ? key.trim() : ''
  if (!text) return null
  const name = canonicalTierName(text)
  return STOCK_RECEIPT_PRICE_LEVELS.find((l) => l.key === name) ?? null
}

/** The levels this grant may print, in the list's order. `booked` is always one of them. */
export function visibleStockReceiptLevels(grant: Grant | null | undefined): StockReceiptPriceLevel[] {
  return STOCK_RECEIPT_PRICE_LEVELS.filter((l) => seesLevel(grant, capOfStockReceiptLevel(l)))
}

/**
 * The level to start from: `preferred` (the person's last choice) while it is still a level this grant sees, else
 * „Цена на едро", else the first level the grant sees. A request that names no level prints this one too, so a
 * caller that knows nothing of levels gets what the dialog would have offered first.
 */
export function startingStockReceiptLevel(grant: Grant | null | undefined, preferred?: unknown): StockReceiptPriceLevel {
  const visible = visibleStockReceiptLevels(grant)
  const seen = (key: unknown) => {
    const level = stockReceiptLevelOf(key)
    return level && visible.find((v) => v.key === level.key)
  }
  return seen(preferred) || seen(STOCK_RECEIPT_DEFAULT_TIER) || visible[0] || BOOKED
}

/** What a print request comes to: the level it prints, or why it prints none. */
export type StockReceiptLevelAnswer =
  | { level: StockReceiptPriceLevel }
  | { refused: 'unknown_price_level' }
  | { refused: 'capability_required'; capability: CapabilityId }

/**
 * The route's answer to `?priceLevel=`. None asked: the level the dialog would open on for this grant. A name that
 * is no level is refused as unknown, never read as the default. A level the grant does not see is refused by the
 * capability it takes, whatever a dialog offered (FR-27.11: the server decides).
 */
export function stockReceiptLevelFor(grant: Grant | null | undefined, asked: unknown): StockReceiptLevelAnswer {
  if (asked === undefined || asked === null || asked === '') return { level: startingStockReceiptLevel(grant) }
  const level = stockReceiptLevelOf(asked)
  if (!level) return { refused: 'unknown_price_level' }
  const capability = capOfStockReceiptLevel(level)
  return capability === null || seesLevel(grant, capability) ? { level } : { refused: 'capability_required', capability }
}
