import { PRICE_TIERS, PRICE_TIER_COLUMN_PREFIX } from 'config/constants'

/**
 * The Products list's price-tier columns: one per canonical slot (`PRICE_TIERS`: Доставна цена,
 * Цена на едро, Цена 0..Цена 10), each printing that tier's price on the row and sorting by it
 * (`services/biz/product-tier-sort.ts`). The six in `DEFAULT_TIER_COLUMNS` are shown; the other
 * seven are offered on the grid's cog (`defaultHidden`, `useGridColumns`).
 *
 * A column finds its tier by NAME, never by position: an article holds the slots its import or
 * its form wrote, in their order, and an org may name its own (acme's „Price 1..10"). Those leave
 * the columns empty rather than print one tier under another's heading.
 *
 * Pure — no Vue, no window — so `unit/product-price-columns.test.ts` holds the rules.
 */

/** The tiers the list shows until the user hides them. */
export const DEFAULT_TIER_COLUMNS: readonly string[] = ['Доставна цена', 'Цена на едро', 'Цена 1', 'Цена 2', 'Цена 4', 'Цена 5']

export interface TierColumn {
  /** The grid column's key, and its sort key (`tier_1`): what saved column choices and the URL hold. */
  key: string
  /** The tier it prints, and its heading. */
  name: string
  defaultHidden: boolean
}

export const TIER_COLUMNS: readonly TierColumn[] = PRICE_TIERS.map((t) => ({
  key: `${PRICE_TIER_COLUMN_PREFIX}${t.key}`,
  name: t.name,
  defaultHidden: !DEFAULT_TIER_COLUMNS.includes(t.name),
}))

export interface TierLike {
  name?: string | null
  finalPrice?: number | null
}

/**
 * „Цена1" and „Цена 1" are one slot, as „Ценанаедро" and „Цена на едро" are (an import's wrapped
 * heading). Case is kept, as the server's sort keeps it, so a cell and its sort never disagree.
 */
const squash = (s: unknown) => String(s ?? '').replace(/\s+/g, '')

/**
 * The named tier's price on an article, or null when it has none there: no such slot, or a zero
 * one, which is no price at that level (the price picker does not offer it, `listPriceOptions`).
 */
export function tierPrice(tiers: readonly TierLike[] | null | undefined, name: string): number | null {
  const want = squash(name)
  const tier = (Array.isArray(tiers) ? tiers : []).find((t) => squash(t?.name) === want)
  const price = Number(tier?.finalPrice)
  return Number.isFinite(price) && price > 0 ? price : null
}

/**
 * A unit price, to four decimals: a fastener's 0.0472 € is not 0.05 €, and two tiers a tenth of a
 * cent apart must not print alike (the price picker keeps them too, `formatPriceItem`).
 */
export function formatUnitPrice(amount: number, currency: string, locale: string): string {
  const n = Number(amount) || 0
  const digits = { minimumFractionDigits: 2, maximumFractionDigits: 4 }
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, ...digits }).format(n)
  } catch {
    // A malformed currency code, which Intl refuses: the figure, then the code.
    return `${new Intl.NumberFormat(locale, digits).format(n)} ${currency}`
  }
}
