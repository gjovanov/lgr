import { PRICE_TIERS } from '../constants'
import type { CapabilityId } from './catalogue'
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

/**
 * FR-27.11 (#529, owner 2026-11-10) — price levels: one figure an article carries, which a role sees or does not.
 *   - the selling price (`products.price:selling`);
 *   - a level per `PRICE_TIERS` slot but „Доставна цена" (a cost figure): Цена на едро, Цена 0 … Цена 10
 *     (`products.price:wholesale`, `products.price:0` …), found by name as the Products grid finds them (spaces
 *     ignored, `tierPrice`);
 *   - every other price (`products.price:other`): a tier named outside the slots, and the legacy category, tag and
 *     contact prices.
 * Levels are grants: a level a role was not given is hidden. The legacy compiler grants them all.
 */
export const PRICE_LEVELS: readonly { cap: CapabilityId; tier?: string }[] = [
  { cap: 'products.price:selling' },
  ...PRICE_TIERS.filter(t => t.key !== 'delivery').map(t => ({ cap: `products.price:${t.key}` as CapabilityId, tier: t.name })),
  { cap: 'products.price:other' },
]
export const PRICE_LEVEL_CAPS: readonly CapabilityId[] = PRICE_LEVELS.map(l => l.cap)

const squash = (name: unknown) => String(name ?? '').replace(/\s+/g, '').toLowerCase()
const COST_TIER_KEYS = new Set(['доставнацена'])
const TIER_LEVEL = new Map(PRICE_LEVELS.filter(l => l.tier).map(l => [squash(l.tier), l.cap]))

/** The capability that shows a tier slot: the cost figures for „Доставна цена", its level for a slot, else "other". */
export function capOfTier(name: unknown): CapabilityId {
  const key = squash(name)
  if (COST_TIER_KEYS.has(key)) return 'products.costs'
  return TIER_LEVEL.get(key) ?? 'products.price:other'
}

/** The capability a price source needs: a resolution step or a Select-price option (`type` and its tier's name). */
export function capOfPriceSource(src: { type?: string | null; name?: string | null; label?: string | null }): CapabilityId | null {
  switch (src?.type) {
    case 'base': return 'products.price:selling'
    case 'tier': return capOfTier(src.name ?? src.label)
    case 'category': case 'tag': case 'contact': return 'products.price:other'
    default: return null // an override is the person's own figure
  }
}

/** Does this grant see every price and the costs? Then nothing is redacted, and the record goes out as it is. */
export function seesEveryPrice(grant: Grant | null | undefined): boolean {
  return !!grant && (!!grant.all || [...PRICE_LEVEL_CAPS, 'products.costs' as CapabilityId].every(c => (grant as any).caps.has(c)))
}

/** Does this grant see a level (null: a source no level gates, an override)? */
export function seesLevel(grant: Grant | null | undefined, cap: CapabilityId | null): boolean {
  return cap === null || (!!grant && can(grant, cap))
}

export function seesCosts(grant: Grant | null | undefined): boolean {
  return !!grant && can(grant, 'products.costs')
}

/**
 * A product as this role may read it: no cost figure without `products.costs` (FR-27.6), and no price of a level it
 * was not given (FR-27.11.C.1): the selling price, a tier slot, the legacy tag and contact prices. Absent, never blank.
 * The same object when the role sees everything.
 */
export function redactProduct<T extends Record<string, any>>(grant: Grant | null | undefined, product: T): T {
  if (!product || seesEveryPrice(grant)) return product
  const costs = seesCosts(grant)
  const out: Record<string, any> = { ...product }
  if (!costs) for (const f of COST_FIELDS) delete out[f]
  if (!seesLevel(grant, 'products.price:selling')) delete out.sellingPrice
  if (!seesLevel(grant, 'products.price:other')) {
    delete out.tagPrices
    delete out.customPrices
  }
  if (Array.isArray(out.priceTiers)) {
    out.priceTiers = out.priceTiers
      .filter((t: any) => seesLevel(grant, capOfTier(t?.name)))
      .map((t: any) => {
        const plain = t?.toObject ? t.toObject() : t
        if (costs) return plain
        // A margin over the cost gives the cost back, on every slot, visible or not.
        const { percent: _margin, ...rest } = plain
        return rest
      })
  }
  if (!costs && Array.isArray(out.variants)) out.variants = out.variants.map((v: any) => redactVariant(v))
  return out as T
}

function redactVariant(v: any) {
  if (!v || typeof v !== 'object') return v
  const out = { ...(v.toObject ? v.toObject() : v) }
  for (const f of COST_FIELDS) delete out[f]
  return out
}

export function redactProducts<T extends Record<string, any>>(grant: Grant | null | undefined, products: readonly T[]): T[] {
  return seesEveryPrice(grant) ? [...products] : products.map(p => redactProduct(grant, p))
}

/** A stock level (or any row carrying a product's average cost) for a role without `products.costs`. */
export function redactStockCost<T extends Record<string, any>>(grant: Grant | null | undefined, row: T): T {
  if (!row || seesCosts(grant)) return row
  const out: Record<string, any> = { ...row }
  for (const f of STOCK_COST_FIELDS) delete out[f]
  return out as T
}

/**
 * What a write by this role may change: never a figure it cannot see (FR-27.11.C.4). A form that was shown less is not
 * trusted: the body's hidden fields go (the costs, the selling price, the legacy tag and contact prices), and its
 * `priceTiers` merge by slot. A hidden slot keeps its stored value where it stood; a visible one takes the body's (by
 * name, once: a form that padded its slots by position adds no second one), or goes when the body dropped it; a new
 * name the body adds goes last. Without the costs, each slot's margin is the stored one.
 */
export function keepStoredPrices(grant: Grant | null | undefined, body: Record<string, any>, stored: Record<string, any> | null | undefined): Record<string, any> {
  if (seesEveryPrice(grant)) return body
  const costs = seesCosts(grant)
  const out: Record<string, any> = { ...body }
  if (!costs) for (const f of COST_FIELDS) delete out[f]
  if (!seesLevel(grant, 'products.price:selling')) delete out.sellingPrice
  if (!seesLevel(grant, 'products.price:other')) {
    delete out.tagPrices
    delete out.customPrices
  }
  if (Array.isArray(out.priceTiers)) {
    const before: any[] = Array.isArray(stored?.priceTiers) ? stored!.priceTiers.map((t: any) => (t?.toObject ? t.toObject() : t)) : []
    const sent = new Map<string, any>()
    for (const t of out.priceTiers) {
      const key = squash(t?.name)
      if (!seesLevel(grant, capOfTier(t?.name)) || sent.has(key)) continue
      sent.set(key, t)
    }
    const merged: any[] = []
    for (const was of before) {
      const key = squash(was?.name)
      if (!seesLevel(grant, capOfTier(was?.name))) {
        merged.push(was)
        continue
      }
      const now = sent.get(key)
      if (!now) continue
      sent.delete(key)
      merged.push(!costs && was.percent !== undefined ? { ...now, percent: was.percent } : now)
    }
    out.priceTiers = [...merged, ...sent.values()]
  }
  if (!costs && Array.isArray(out.variants) && Array.isArray(stored?.variants)) {
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

/** FR-27.6's name for it, kept for its callers. */
export const keepStoredCosts = keepStoredPrices

/** The label a hidden level's winning price goes out under (FR-27.11.C.6): never the level's own name. */
export const CUSTOMER_PRICE_LABEL = 'Customer price'

/**
 * FR-27.11.C.6: a resolution as this role may read it. Resolution is not visibility: the final price stays, whoever
 * looks. A step of a hidden level goes, unless it is the winning one (the last), which then goes out as
 * "Customer price".
 */
export function redactResolution<T extends { finalPrice?: number; steps?: any[] }>(grant: Grant | null | undefined, r: T): T {
  if (!r || !Array.isArray(r.steps) || seesEveryPrice(grant)) return r
  const last = r.steps.length - 1
  const steps = r.steps.flatMap((s: any, i: number) => {
    if (seesLevel(grant, capOfPriceSource(s))) return [s]
    return i === last ? [{ ...s, type: 'customer', label: CUSTOMER_PRICE_LABEL }] : []
  })
  return { ...r, steps }
}

/**
 * FR-27.11.C.6: the Select-price menu as this role may read it: no option of a hidden level, but the price the
 * customer resolves to (`resolvedKey`), if hidden, as "Customer price".
 */
export function redactPriceOptions<T extends { options?: any[]; resolvedKey?: string }>(grant: Grant | null | undefined, r: T): T {
  if (!r || !Array.isArray(r.options) || seesEveryPrice(grant)) return r
  const options = r.options.flatMap((o: any) => {
    if (seesLevel(grant, capOfPriceSource(o))) return [o]
    return o?.key && o.key === r.resolvedKey ? [{ ...o, type: 'customer', name: CUSTOMER_PRICE_LABEL }] : []
  })
  return { ...r, options }
}

/**
 * FR-27.11.C.3: a sort leaks a figure it never returns (`sortBy=purchasePrice` ranks the shop's articles by cost). The
 * levels a sort key reads, however it is spelled: a Products-list tier column (`tier_<slot>`), a cost figure by any
 * name (alone or as the last part of a path: `lines.unitCost`), the selling price, and any path into `priceTiers`,
 * which reads every level. Empty: the key reads no level.
 */
const COST_SORT_KEYS = new Set([
  'purchaseprice', 'standardcost', 'avgcost', 'unitcost', 'linetotalcost', 'totalcost', 'variancecost', 'runningvalue',
  'expectedunitprice', 'lastunitprice', 'resolvedunitcost', 'costallocations', 'percent', 'lastcost', 'totalvalue',
  'profit', 'margin', 'profitabilitynet', 'profitabilitygross',
])
const TIER_SORT_PREFIX = 'tier_'

export function capsOfSortKey(sortBy: string | null | undefined): CapabilityId[] {
  const key = String(sortBy ?? '').trim()
  if (!key) return []
  if (key.startsWith(TIER_SORT_PREFIX)) {
    const slot = PRICE_TIERS.find(t => t.key === key.slice(TIER_SORT_PREFIX.length))
    return slot ? [capOfTier(slot.name)] : []
  }
  const parts = key.split('.').map(s => s.toLowerCase())
  if (parts[0] === 'pricetiers') return ['products.costs', ...PRICE_LEVEL_CAPS]
  if (parts.some(s => COST_SORT_KEYS.has(s))) return ['products.costs']
  if (parts.at(-1) === 'sellingprice') return ['products.price:selling']
  return []
}

/** The levels a sort needs and the grant lacks, or null: what a list route answers 403 `capability_required` with. */
export function sortRefusal(grant: Grant | null | undefined, sortBy: string | null | undefined): { code: 'capability_required'; capabilities: CapabilityId[]; message: string } | null {
  if (!sortBy || seesEveryPrice(grant)) return null
  const missing = capsOfSortKey(sortBy).filter(c => !seesLevel(grant, c))
  if (!missing.length) return null
  return { code: 'capability_required', capabilities: missing, message: 'Sorting by a price your role does not see.' }
}

/** FR-27.11.C.1: a movement line's cost figures (a dispatch's `unitCost` is its document price, and is withheld too). */
export const MOVEMENT_COST_FIELDS = ['unitCost', 'totalCost', 'costAllocations', 'resolvedUnitCost'] as const

/**
 * A movement line (or a ledger row) as this role may read it: no cost figure without the costs, and a receipt line's
 * product update (its purchase price, selling price and `priceTiers`) by the product's own rule.
 */
export function redactMovementLine<T extends Record<string, any>>(grant: Grant | null | undefined, line: T): T {
  if (!line || seesEveryPrice(grant)) return line
  const out: Record<string, any> = redactProduct(grant, line)
  if (!seesCosts(grant)) for (const f of [...MOVEMENT_COST_FIELDS, 'lineTotalCost', 'runningValue']) delete out[f]
  return out as T
}

/**
 * FR-27.11.C.2: a movement's own total is the sum of its lines' costs, so it goes where they go. With one line it
 * IS that line's cost. `totalAmount` as stored, `total` as the list names it. Absent, never blank; the same object
 * when the role sees the costs.
 */
export const MOVEMENT_TOTAL_FIELDS = ['totalAmount', 'total'] as const

export function redactMovementTotals<T extends Record<string, any>>(grant: Grant | null | undefined, movement: T): T {
  if (!movement || seesCosts(grant)) return movement
  const out: Record<string, any> = { ...movement }
  for (const f of MOVEMENT_TOTAL_FIELDS) delete out[f]
  return out as T
}

/** FR-27.11.C.3: the keys that order a movement list by that total. */
export function sortsByMovementTotal(sortBy: string | null | undefined): boolean {
  return (MOVEMENT_TOTAL_FIELDS as readonly string[]).includes(String(sortBy ?? '').trim())
}
