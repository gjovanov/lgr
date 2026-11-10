import { can, type Grant } from './grant'

/**
 * FR-27.6 (#529) — field groups: data a role may read the record without. One `redact*()` per kind of record, called
 * by every serializer that sends it (list, by id, picker, the forms' own reads), so the keys are ABSENT from the JSON,
 * not a column hidden on a screen.
 *
 * `products.costs` (D-5, "Cost figures" in the editor) is what a product cost:
 *   - `purchasePrice`, `standardCost`, and a stock level's `avgCost`;
 *   - the „Доставна цена" price slot (the buying price, `PRICE_TIERS[0]`);
 *   - every slot's `percent`, its margin over the cost: with the final price it gives the cost back.
 *
 * The legacy compiler grants `products.costs` to whoever reads products (`legacy.ts`), so nobody's answer changes
 * until a role leaves it out. Import-pure: the SPA uses the same names to hide the same columns.
 */
export const COST_FIELDS = ['purchasePrice', 'standardCost'] as const
export const COST_TIER_NAMES: readonly string[] = ['Доставна цена']
export const STOCK_COST_FIELDS = ['avgCost'] as const

export function seesCosts(grant: Grant | null | undefined): boolean {
  return !!grant && can(grant, 'products.costs')
}

/** A product as a role without `products.costs` may read it; the same object when it may read everything. */
export function redactProduct<T extends Record<string, any>>(grant: Grant | null | undefined, product: T): T {
  if (!product || seesCosts(grant)) return product
  const out: Record<string, any> = { ...product }
  for (const f of COST_FIELDS) delete out[f]
  if (Array.isArray(out.priceTiers)) {
    out.priceTiers = out.priceTiers
      .filter((t: any) => !COST_TIER_NAMES.includes(t?.name))
      .map((t: any) => {
        const { percent: _margin, ...rest } = t?.toObject ? t.toObject() : t
        return rest
      })
  }
  if (Array.isArray(out.variants)) out.variants = out.variants.map((v: any) => redactVariant(v))
  return out as T
}

function redactVariant(v: any) {
  if (!v || typeof v !== 'object') return v
  const out = { ...(v.toObject ? v.toObject() : v) }
  for (const f of COST_FIELDS) delete out[f]
  return out
}

export function redactProducts<T extends Record<string, any>>(grant: Grant | null | undefined, products: readonly T[]): T[] {
  return seesCosts(grant) ? [...products] : products.map(p => redactProduct(grant, p))
}

/** A stock level (or any row carrying a product's average cost) for a role without `products.costs`. */
export function redactStockCost<T extends Record<string, any>>(grant: Grant | null | undefined, row: T): T {
  if (!row || seesCosts(grant)) return row
  const out: Record<string, any> = { ...row }
  for (const f of STOCK_COST_FIELDS) delete out[f]
  return out as T
}

/**
 * What a write by a role without `products.costs` may change: never a cost it cannot see. The body's cost fields go,
 * and the stored cost slot and every slot's margin come back into the tiers it sends (which it read redacted).
 */
export function keepStoredCosts(grant: Grant | null | undefined, body: Record<string, any>, stored: Record<string, any> | null | undefined): Record<string, any> {
  if (seesCosts(grant)) return body
  const out: Record<string, any> = { ...body }
  for (const f of COST_FIELDS) delete out[f]
  if (Array.isArray(out.priceTiers)) {
    const before: any[] = Array.isArray(stored?.priceTiers) ? stored!.priceTiers.map((t: any) => (t?.toObject ? t.toObject() : t)) : []
    const byName = new Map(before.map(t => [t?.name, t]))
    const seen = new Set<string>()
    const sent = out.priceTiers.filter((t: any) => {
      // Never the cost slot, and each name once: a form that padded its slots by position must not add a second one.
      if (COST_TIER_NAMES.includes(t?.name) || seen.has(t?.name)) return false
      seen.add(t?.name)
      return true
    }).map((t: any) => {
      const was = byName.get(t?.name)
      return was && was.percent !== undefined ? { ...t, percent: was.percent } : t
    })
    // The cost slot where it stood: first, as every product's tiers start with it.
    const costSlots = before.filter(t => COST_TIER_NAMES.includes(t?.name))
    out.priceTiers = [...costSlots, ...sent]
  }
  if (Array.isArray(out.variants) && Array.isArray(stored?.variants)) {
    out.variants = out.variants.map((v: any, i: number) => {
      const was = stored!.variants[i]
      const kept: Record<string, any> = { ...v }
      for (const f of COST_FIELDS) {
        delete kept[f]
        if (was && was[f] !== undefined) kept[f] = was[f]
      }
      return kept
    })
  }
  return out
}
