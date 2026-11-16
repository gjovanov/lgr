import type { CapabilityId } from './catalogue'
import { PRICE_LEVEL_CAPS } from './fields'
import { withImplied } from './levels'

/**
 * #529 (FR-27.11.B) — a role's price levels set by name, as `scripts/role-price-levels.ts` takes them: what the
 * Products row's "Prices it may see" block of the role editor does, without the editor.
 *
 * A level name is what follows `products.price:` (`selling`, `wholesale`, `0` … `10`, `other`), or `costs` for the cost
 * figures (`products.costs`). Every price capability the role holds is taken away, the named ones are given, and
 * everything else the role holds stays.
 *
 * ⚠ A role that writes prices sees them all (`levels.ts#EVERY_PRICE`, FR-27.11.A): a capability the role keeps may
 * bring a withheld level back once the implied helpers are added, as the editor's save adds them. That is reported in
 * `cameBack` rather than written: a role that does not do what was asked.
 */
export const PRICE_CAPS: readonly CapabilityId[] = ['products.costs', ...PRICE_LEVEL_CAPS]

export function priceCapOfLevel(level: string): CapabilityId | null {
  const name = level.trim().toLowerCase()
  if (name === 'costs') return 'products.costs'
  const cap = `products.price:${name}` as CapabilityId
  return PRICE_LEVEL_CAPS.includes(cap) ? cap : null
}

export interface PriceLevelEdit {
  /** What to save: the role's other capabilities and the named levels. */
  caps: CapabilityId[]
  /** Level names no capability answers to: nothing is written while there is one. */
  unknown: string[]
  /** Withheld levels the implied helpers would give back, each with the capabilities of the role that imply it. */
  cameBack: { cap: CapabilityId; from: CapabilityId[] }[]
}

export function withPriceLevels(current: Iterable<CapabilityId>, levels: readonly string[]): PriceLevelEdit {
  const unknown: string[] = []
  const shown = new Set<CapabilityId>()
  for (const level of levels) {
    const cap = priceCapOfLevel(level)
    if (cap) shown.add(cap)
    else unknown.push(level)
  }
  const kept = [...current].filter(c => !PRICE_CAPS.includes(c))
  const caps = [...new Set([...kept, ...shown])].sort() as CapabilityId[]
  const implied = new Set(withImplied(caps))
  const cameBack = PRICE_CAPS
    .filter(cap => !shown.has(cap) && implied.has(cap))
    .map(cap => ({ cap, from: kept.filter(k => withImplied([k]).includes(cap)) }))
  return { caps, unknown, cameBack }
}
