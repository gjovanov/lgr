import { MAX_PRICE_TIERS } from 'config/constants'

/**
 * „С актуализация на продукт" — a document line's staged edits to its product, and what of them
 * reaches the product. Shared by the two forms that offer it: the goods receipt (inventory) and
 * the supplier bill (invoicing).
 *
 * A line is SEEDED from the catalog when its product is chosen: what the product columns show
 * (`productUpdate`, `priceTiers`) and a copy of the same that nothing edits, its BASE
 * (`productBase`). The payload carries what differs from the base and nothing else, so:
 *   - a document saved without touching those columns updates no product at all;
 *   - a field nobody touched is never written back as it was read — a price changed elsewhere
 *     while the form was open stays changed;
 *   - a tier goes by its NAME, with only what changed on it, and the server merges it into the
 *     product's tiers by name (`services/biz/product-update.service.ts`): the filters these forms
 *     do not show survive, and no slot is padded in.
 *
 * A line staged some other way — the receipt form's import of a разписка stages the prices the
 * document carries — has no base: everything it stages is a change, as it always was.
 *
 * Pure — no Vue, no I/O — so `unit/gr-product-update.test.ts` holds the rules.
 */

/** The product fields the forms stage, in the order of their columns. */
export const GR_PRODUCT_FIELDS = ['type', 'categoryId', 'unit', 'purchasePrice', 'sellingPrice', 'taxRate'] as const

const NUMERIC_FIELDS = new Set<string>(['purchasePrice', 'sellingPrice', 'taxRate'])

/**
 * A tier that is not fixed by hand follows the purchase price when its price is the purchase price
 * plus its percent — to the cent the product form rounds a recomputed tier to.
 */
const DERIVED_TOLERANCE = 0.005

export interface GRTier {
  name: string
  percent?: number
  finalPrice?: number
  manualOverride?: boolean
  contactIds?: string[]
  tags?: string[]
  minQuantity?: number | null
  validFrom?: string | Date | null
  validTo?: string | Date | null
}

export interface GRBase {
  /** The product the line was seeded from: a line given another product is seeded again. */
  productId: string
  fields: Record<string, any>
  tiers: Array<{ name: string; percent: number; finalPrice: number; manualOverride: boolean }>
}

export interface GRLine {
  productId?: string
  productUpdate?: Record<string, any>
  priceTiers?: GRTier[]
  productBase?: GRBase
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function round4(v: number): number {
  return +v.toFixed(4)
}

/**
 * „Цена1" and „Цена 1" name one slot (an import's wrapped heading), as the Products list and the
 * server's merge read them. Case is kept.
 */
export function tierKey(name: unknown): string {
  return String(name ?? '').replace(/\s+/g, '')
}

/** The tier of that name among `tiers`, if there is one. */
export function findTier<T extends { name?: string }>(tiers: readonly T[] | null | undefined, name: string): T | undefined {
  const key = tierKey(name)
  return (tiers || []).find(t => tierKey(t?.name) === key)
}

/** A tier's price as its column shows it: blank when the product holds no tier of that name. */
export function tierPriceOf(tiers: readonly GRTier[] | null | undefined, name: string): number | undefined {
  return findTier(tiers, name)?.finalPrice
}

/** Whether the line's staged edits were seeded from the product it now names. */
export function isSeeded(line: GRLine): boolean {
  return !!line.productId && !!line.productBase && line.productBase.productId === String(line.productId)
}

/** Nothing is staged on the line: no field, no tier. */
export function stagesNothing(line: GRLine): boolean {
  return !Object.keys(line.productUpdate || {}).length && !(line.priceTiers || []).length
}

/**
 * Whether a bulk seed (a loaded document, an import, the switch turned on) should seed `line`: it
 * names a product, was not seeded from it, and stages nothing a seed would overwrite.
 */
export function needsSeed(line: GRLine): boolean {
  return !!line.productId && !isSeeded(line) && stagesNothing(line)
}

/**
 * The line's staged edits and their base, from the product as the catalog has it. `productId` is
 * the id the line names it by, when the caller has it (the product's own otherwise).
 */
export function seedFromProduct(product: any, productId?: string): Required<Pick<GRLine, 'productUpdate' | 'priceTiers' | 'productBase'>> {
  const fields: Record<string, any> = {
    type: product?.type,
    categoryId: product?.categoryId ? String(product.categoryId?._id ?? product.categoryId) : undefined,
    unit: product?.unit,
    purchasePrice: num(product?.purchasePrice),
    sellingPrice: num(product?.sellingPrice),
    taxRate: num(product?.taxRate),
  }
  const tiers = (product?.priceTiers || []).map((t: any) => ({
    name: String(t?.name || ''),
    percent: num(t?.percent),
    finalPrice: num(t?.finalPrice),
    manualOverride: !!t?.manualOverride,
  }))
  return {
    productUpdate: { ...fields },
    priceTiers: tiers.map((t: GRBase['tiers'][number]) => ({ ...t })),
    productBase: { productId: String(productId ?? product?._id ?? product?.id ?? ''), fields, tiers },
  }
}

/**
 * A value typed into a product column, kept as typed: a number field is read as a number when the
 * payload is built. Coercing it here would hand the input back „12" while „12." is being typed.
 * A blank one stages nothing for that field.
 */
export function setProductField(line: GRLine, field: string, value: unknown): void {
  if (!line.productUpdate) line.productUpdate = {}
  line.productUpdate[field] = value === '' ? undefined : value
}

/**
 * A price typed into a tier's column. A tier the product does not hold yet is added under that
 * name — a slot of its own, never another tier's. Typed means fixed: the tier stops following the
 * purchase price (`manualOverride`), as on the product form. A cleared column is no price at that
 * level (0), and a negative or unreadable one changes nothing.
 */
export function setTierPrice(line: GRLine, name: string, value: unknown): void {
  const n = value === '' || value === null || value === undefined ? 0 : Number(value)
  if (!Number.isFinite(n) || n < 0) return
  if (!Array.isArray(line.priceTiers)) line.priceTiers = []
  const tier = findTier(line.priceTiers, name)
  if (tier) {
    tier.finalPrice = n
    tier.manualOverride = true
  } else if (n > 0) {
    // Only what was typed: on a line staged without a base the product may hold this tier after
    // all, and a percent sent along would overwrite its own (the server gives a new tier 0).
    line.priceTiers.push({ name, finalPrice: n, manualOverride: true })
  }
}

/**
 * The document's unit price is the article's new purchase price: stage it, and move the tiers that
 * follow the purchase price along — each to the new price plus its percent, as the product form
 * recomputes them.
 *
 * A tier follows only when it was DERIVED from the purchase price in the catalog: not fixed by hand,
 * and priced at the purchase price plus its percent when the line was seeded. Any other keeps its
 * price — the backfilled slots (the selling price, with a percent of 0), a tier an import or the
 * product form fixed. Snapping those to the purchase price wrote a price nobody chose, often into a
 * column the form was not even showing. A line with no base cannot tell them apart, and only its
 * purchase price moves.
 */
export function cascadePurchasePrice(line: GRLine, purchase: unknown): void {
  const p = Number(purchase)
  if (!Number.isFinite(p) || p <= 0) return
  if (!line.productUpdate) line.productUpdate = {}
  line.productUpdate.purchasePrice = p
  if (!isSeeded(line)) return
  const base = line.productBase!
  const basePurchase = num(base.fields.purchasePrice)
  if (!(basePurchase > 0)) return
  // Back at the catalog's purchase price, a tier is back at the catalog's price — not at the same
  // figure recomputed to more decimals than the product form stored, which would read as a change.
  const unchanged = Math.abs(p - basePurchase) < 1e-9
  for (const tier of line.priceTiers || []) {
    if (tier.manualOverride) continue
    const was = findTier(base.tiers, tier.name)
    if (!was || was.manualOverride) continue
    if (Math.abs(was.finalPrice - basePurchase * (1 + was.percent / 100)) > DERIVED_TOLERANCE) continue
    tier.finalPrice = unchanged ? was.finalPrice : round4(p * (1 + num(tier.percent) / 100))
  }
}

function sameValue(field: string, a: unknown, b: unknown): boolean {
  if (NUMERIC_FIELDS.has(field)) return Math.abs(num(a) - num(b)) < 1e-9
  return String(a ?? '') === String(b ?? '')
}

/** The fields a tier can carry on its way to the server — only those the staged tier has. */
const TIER_WIRE_FIELDS = ['percent', 'finalPrice', 'manualOverride', 'contactIds', 'tags', 'minQuantity', 'validFrom', 'validTo'] as const

/** What one line changes on its product, or null when it changes nothing. */
export function productUpdateOf(line: GRLine): Record<string, any> | null {
  if (!line.productId) return null // free text: no product to update
  const base = isSeeded(line) ? line.productBase! : null
  const out: Record<string, any> = { productId: line.productId }
  let changed = false

  for (const [k, v] of Object.entries(line.productUpdate || {})) {
    if (v === undefined || v === '') continue
    // A number field holds what was typed; one that does not read as a number changes nothing.
    if (NUMERIC_FIELDS.has(k) && !Number.isFinite(Number(v))) continue
    if (base && sameValue(k, v, base.fields[k])) continue
    out[k] = NUMERIC_FIELDS.has(k) ? Number(v) : v
    changed = true
  }

  const staged = (line.priceTiers || []).filter(t => !!t?.name)
  let tiers: Record<string, any>[] = []
  if (base) {
    for (const t of staged) {
      const price = num(t.finalPrice)
      const was = findTier(base.tiers, t.name)
      // A tier the product holds goes when its price or its fixing changed; one it does not, when
      // it was given a price — a slot added to hold nothing would be the padding this replaced.
      if (was ? Math.abs(was.finalPrice - price) < 1e-9 && was.manualOverride === !!t.manualOverride : !(price > 0)) continue
      tiers.push({ name: t.name, finalPrice: price, manualOverride: !!t.manualOverride })
    }
  } else if (staged.some(t => t.manualOverride || num(t.finalPrice) > 0)) {
    // Staged without a base: every tier as staged, with only the fields it carries — a field it
    // does not carry (the filters, on an import's copy) is left to the product.
    tiers = staged.slice(0, MAX_PRICE_TIERS).map(t => {
      const wire: Record<string, any> = { name: t.name }
      for (const f of TIER_WIRE_FIELDS) {
        if ((t as any)[f] !== undefined) wire[f] = (t as any)[f]
      }
      wire.finalPrice = num(t.finalPrice)
      return wire
    })
  }
  if (tiers.length) {
    out.priceTiers = tiers
    changed = true
  }
  return changed ? out : null
}

/** `productUpdates[]` for the payload: one entry per line that changes its product. */
export function buildProductUpdates(lines: readonly GRLine[] | null | undefined): Record<string, any>[] {
  const out: Record<string, any>[] = []
  for (const line of lines || []) {
    const u = productUpdateOf(line)
    if (u) out.push(u)
  }
  return out
}
