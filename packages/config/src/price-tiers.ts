import { PRICE_TIERS } from './constants'
import { followsPurchasePrice, marginOver, roundPrice, roundTo } from './price-precision'

/**
 * What a person READS for a price slot, and the purchase price an article takes from its „Цена 2" (owner, 2026-11-15).
 *
 * ── A label, never a key ──────────────────────────────────────────────────────────────────────────────────────────
 * The first slot of `PRICE_TIERS` is STORED as „Доставна цена" and stays so everywhere it is a key:
 * `Product.priceTiers[].name`, the access rules (`access/fields.ts#COST_TIER_NAMES`), tier-name tags, sort keys, the
 * tests that address the slot, and above all the imports. ⚠ PlusMinus's column „Доставна цена" / „Дост. цена", and a
 * receipt's „Цена" (its delivery price), feed THIS slot, and every importer goes on reading them into it by that name
 * (`doc-import/map-movement.ts#buildTiers`, `scripts/seed-products.ts`, `scripts/receive-new-products.ts`,
 * `files/compare-snapshot.service.ts`). Renaming the stored slot would cut the catalogue off from its source.
 *
 * What the shop calls that figure is „Цена с търговска отстъпка", the price with the trade discount, and writes it
 * „Цена с ТО". So wherever the slot's name is DRAWN (a grid heading, the product form's row, a price menu, a price
 * trail) it goes through `tierLabel`, and wherever a person TYPES a slot's name `canonicalTierName` takes the label
 * back to the key. A label is never stored and never sent.
 *
 * ⚠ In Bulgarian the name is „Цена с ТО" in BOTH forms (owner, 2026-11-16). For a day the long form spelled the term
 * out with the short one in brackets; that spelling is in `RETIRED_TIER_LABELS`: never drawn, still read.
 *
 * Import-pure: the SPA and the server's renderers read the same table.
 */

/** The stored name of the slot PlusMinus's „Доставна цена" feeds: `PRICE_TIERS[0]`. A cost figure (`products.costs`). */
export const DELIVERY_TIER_NAME = 'Доставна цена'

export type TierLabelLocale = 'bg' | 'en' | 'de' | 'mk'
/** `short` where width matters (a heading, a menu, a chip); `long` where there is room (a form row, a dialog). */
export type TierLabelForm = 'short' | 'long'

const TIER_LABELS: Readonly<Record<string, Readonly<Record<TierLabelLocale, Readonly<Record<TierLabelForm, string>>>>>> = {
  [DELIVERY_TIER_NAME]: {
    bg: { short: 'Цена с ТО', long: 'Цена с ТО' },
    en: { short: 'Trade-discount price', long: 'Price with trade discount' },
    de: { short: 'Preis mit Handelsrabatt', long: 'Preis mit Handelsrabatt' },
    mk: { short: 'Цена со ТП', long: 'Цена со трговски попуст' },
  },
}

/**
 * Labels a slot was drawn by once. `tierLabel` never returns one; `tierNameOfLabel` still takes each back to its
 * slot, so a name typed from memory, or a heading in a sheet made while the label stood, does not name a new tier
 * beside the slot it meant.
 */
const RETIRED_TIER_LABELS: Readonly<Record<string, readonly string[]>> = {
  // The Bulgarian long form of 2026-11-15, until the owner's "it should have been named „Цена с ТО"" a day later.
  [DELIVERY_TIER_NAME]: ['Цена с търговска отстъпка (Цена с ТО)'],
}

/** As the access rules and the grids find a slot: spaces and case ignored („Доставнацена", an import's folded heading). */
const squash = (name: unknown) => String(name ?? '').replace(/\s+/g, '').toLowerCase()

const LABELS_BY_KEY = new Map(Object.entries(TIER_LABELS).map(([name, labels]) => [squash(name), labels]))
/** Every label of every locale, and every retired one → the stored name it stands for. */
const NAME_BY_LABEL = new Map<string, string>([
  ...Object.entries(TIER_LABELS).flatMap(([name, byLocale]) =>
    Object.values(byLocale).flatMap((forms) => Object.values(forms).map((label): [string, string] => [squash(label), name]))),
  ...Object.entries(RETIRED_TIER_LABELS).flatMap(([name, labels]) => labels.map((label): [string, string] => [squash(label), name])),
])
const CANONICAL_BY_KEY = new Map(PRICE_TIERS.map((t) => [squash(t.name), t.name]))

function localeOf(locale: unknown): TierLabelLocale {
  const two = String(locale ?? '').slice(0, 2).toLowerCase()
  return two === 'bg' || two === 'de' || two === 'mk' ? two : 'en'
}

/** Does this slot read differently from how it is stored? */
export function hasTierLabel(name: unknown): boolean {
  return LABELS_BY_KEY.has(squash(name))
}

/**
 * The name to DRAW for a price slot: its label in `locale` when it has one, else the name as it is (the „Цена N"
 * slots, an org's own tier names, a tag or contact price). Never store what this returns.
 */
export function tierLabel(name: unknown, locale?: string | null, form: TierLabelForm = 'short'): string {
  const labels = LABELS_BY_KEY.get(squash(name))
  return labels ? labels[localeOf(locale)][form] : String(name ?? '')
}

/** The stored name a LABEL stands for, in any locale and either form („Цена с ТО" → „Доставна цена"); null for anything else. */
export function tierNameOfLabel(typed: unknown): string | null {
  return NAME_BY_LABEL.get(squash(typed)) ?? null
}

/**
 * The stored name for what a person typed or a file's heading said: a label of any locale goes back to its slot
 * („Цена с ТО" → „Доставна цена"), a canonical name comes back in its canonical spelling („Цена2" → „Цена 2"), and
 * anything else is returned as it was typed.
 */
export function canonicalTierName(typed: unknown): string {
  const text = String(typed ?? '')
  return tierNameOfLabel(text) ?? CANONICAL_BY_KEY.get(squash(text)) ?? text
}

// ── The purchase price ──────────────────────────────────────────────────────────────────────────────────────────

/** The slot the purchase price is taken from. */
export const PURCHASE_BASIS_TIER_NAME = 'Цена 2'
/** „Покупна цена" = „Цена 2" / 1.2 (owner, 2026-11-15). An approximation: PlusMinus keeps no buying price. */
export const PURCHASE_PRICE_DIVISOR = 1.2

/**
 * The purchase price an article takes from its „Цена 2": `price2 / 1.2`, to the four decimals a price keeps, a half
 * going up. Null when there is no „Цена 2" to take it from (absent, zero, negative, not a number).
 *
 * Until 2026-11-15 an import wrote the delivery price as the purchase price. They are different figures: what
 * PlusMinus calls „Доставна цена" is the price with the trade discount, and it keeps no buying price at all.
 *
 * ⚠ The division is rounded to eight decimals first. A double cannot hold most quotients (0.0471 / 1.2 is
 * 0.03925 exactly and arrives a hair under it), and rounding that to four places directly sends the half down.
 */
export function purchasePriceFromTier2(price2: unknown): number | null {
  const n = Number(price2)
  if (!Number.isFinite(n) || !(n > 0)) return null
  return roundPrice(roundTo(n / PURCHASE_PRICE_DIVISOR, 8))
}

export interface TierPriceLike {
  name?: string | null
  finalPrice?: number | null
}

/** A slot's price on an article by its NAME (spaces and case ignored), 0 when it has none. */
export function tierFinalPrice(tiers: readonly TierPriceLike[] | null | undefined, name: string): number {
  const want = squash(name)
  const tier = (Array.isArray(tiers) ? tiers : []).find((t) => squash(t?.name) === want)
  const price = Number(tier?.finalPrice)
  return Number.isFinite(price) && price > 0 ? price : 0
}

/**
 * The purchase price of an article an import CREATES: by the rule when the document or row carries a „Цена 2", else
 * the delivery price as before, so the field is never empty. `prices` is the row's price columns by name, however the
 * heading was folded („Цена2").
 *
 * ⚠ Creation only. An import never writes the purchase price of an article that exists (`PROTECTED_TIERS`,
 * `persist-movement.ts`): the real buying price comes from the bills entered in LGR, and a later receipt must not
 * put an approximation back over it.
 */
export function purchasePriceForNewProduct(deliveryPrice: unknown, prices: Readonly<Record<string, unknown>> | null | undefined): number {
  const want = squash(PURCHASE_BASIS_TIER_NAME)
  const entry = Object.entries(prices ?? {}).find(([name]) => squash(name) === want)
  const delivery = Number(deliveryPrice)
  return purchasePriceFromTier2(entry?.[1]) ?? (Number.isFinite(delivery) && delivery > 0 ? delivery : 0)
}

/** How far a stored margin may stand from the true one and still be it (percentage points). */
export const MARGIN_TOLERANCE = 0.05

export interface MarginTier {
  name?: string | null
  percent?: number | null
  finalPrice?: number | null
  manualOverride?: boolean | null
}

/**
 * An article's purchase price was CORRECTED from `oldPurchase` to `newPurchase` (the one-time script, not a change in
 * what the goods cost): which slots' margins move, so that no price does. Returns the new `percent` by slot index,
 * for the slots whose margin changes; every `finalPrice` and `manualOverride` stays as stored.
 *
 * A slot's `percent` is its margin over the purchase price, and the screens' cascade (`price-precision.ts#cascadeTiers`)
 * knows three kinds of slot. Each keeps its kind:
 *   - fixed by hand (`manualOverride`, which is every price an import wrote): the price stands and the margin is what
 *     moves, exactly as the cascade does it;
 *   - following the purchase price (not fixed, priced at the old purchase price plus its margin): the cascade would
 *     move its PRICE, which a correction must not do. It takes the margin that gives the same price over the new
 *     purchase price, and so still follows it;
 *   - any other (a backfilled slot at 0 %, an empty one): left as stored. Given a true margin it would start
 *     following the purchase price, and a later edit would move a price nobody chose.
 * A slot that would follow the NEW purchase price as it is stored counts as following too, so that a second run
 * over what the first one wrote changes nothing. And a stored margin within `MARGIN_TOLERANCE` of the true one is
 * the true one: an import writes a margin to one decimal.
 */
export function marginsAfterPurchaseChange(tiers: readonly MarginTier[] | null | undefined, oldPurchase: unknown, newPurchase: unknown): Map<number, number> {
  const out = new Map<number, number>()
  if (!(Number(newPurchase) > 0)) return out
  ;(Array.isArray(tiers) ? tiers : []).forEach((tier, i) => {
    const price = Number(tier?.finalPrice)
    if (!Number.isFinite(price) || !(price > 0)) return
    const shape = { percent: Number(tier.percent) || 0, finalPrice: price, manualOverride: !!tier.manualOverride }
    if (!shape.manualOverride && !followsPurchasePrice(shape, oldPurchase) && !followsPurchasePrice(shape, newPurchase)) return
    const percent = marginOver(newPurchase, price)
    if (Math.abs(percent - shape.percent) > MARGIN_TOLERANCE) out.set(i, percent)
  })
  return out
}
