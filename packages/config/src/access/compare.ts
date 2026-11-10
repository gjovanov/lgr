import type { CapabilityId, FeatureId } from './catalogue'
import { can, type Grant } from './grant'
import { EDITOR_FEATURES, levelOf, levelsOf, type Level } from './levels'
import { PAGE_ACCESS, canOpen } from './pages'

/**
 * FR-27.9 (#529) — the role tools: who can do something, two roles side by side, and what a role opens. Read off the
 * same grants and rules the server decides by, so the answer is the server's. Import-pure.
 */

/** Every capability the editor shows (its levels and extras), in catalogue order: what "Who can…" asks about. */
export const ASKABLE_CAPABILITIES: readonly CapabilityId[] = EDITOR_FEATURES.flatMap(f => {
  const l = levelsOf(f)
  return [...l.full, ...l.extras]
})

/** Of these roles, the ones whose grant holds the capability (the Administrator always does). */
export function whoCan<R>(roles: readonly R[], grantOf: (role: R) => Grant, cap: CapabilityId): R[] {
  return roles.filter(r => can(grantOf(r), cap))
}

export interface FeatureComparison {
  feature: FeatureId
  a: Level
  b: Level
  /** What the first role holds of the feature and the second does not, and the other way round. */
  onlyA: CapabilityId[]
  onlyB: CapabilityId[]
  differs: boolean
}

/** Two grants feature by feature: each one's level, and the capabilities one holds that the other does not. */
export function compareGrants(a: Grant, b: Grant): FeatureComparison[] {
  return EDITOR_FEATURES.map(f => {
    const l = levelsOf(f)
    const caps = [...l.full, ...l.extras]
    const onlyA = caps.filter(c => can(a, c) && !can(b, c))
    const onlyB = caps.filter(c => can(b, c) && !can(a, c))
    return { feature: f.id, a: levelOf(f, a), b: levelOf(f, b), onlyA, onlyB, differs: onlyA.length > 0 || onlyB.length > 0 }
  })
}

/** The pages a grant opens (`config/access/pages.ts`), in their order: a role's menus, ★ and „+ Нов", previewed. */
export function pagesOpenedBy(grant: Grant): string[] {
  return Object.keys(PAGE_ACCESS).filter(id => canOpen(id, grant))
}
