/**
 * FR-27 Phase 3, P3-1 (#529) — whether `scripts/access-model.ts --all` moves an org one step towards `roles`. Pure: the
 * script reads the facts, this decides, and a test holds the rules.
 *
 * Two steps, never one, because an org on `legacy` counts nothing (`services/biz/access/shadow.ts` compares only on
 * `shadow` and `roles`): its "0 differences" proves nothing.
 *   - `--set shadow`: an org on `legacy` moves to `shadow`, where the legacy rules still decide and every answer the
 *     roles would give differently is counted. Anyone without a role is first given one with exactly their access
 *     (migration 0015's own code), so the count is of the roles that will decide. Nobody's access changes.
 *   - `--set roles`: an org on `shadow` moves to `roles` once it has been there `minDays` full days, with no difference
 *     since it moved, and nobody without a role.
 * An org is never moved back, and an org already where it is asked to be is left as it is.
 */

export type AccessModel = 'legacy' | 'shadow' | 'roles'

export interface OrgFacts {
  slug: string
  model: AccessModel
  /** People of the org with no role: after the roles were given, on a run that gives them. */
  withoutRole: number
  /** When the org was last moved to `shadow` (its audit entry), or null when nothing says so. */
  shadowSince: Date | null
  /** Differences counted since `shadowSince` (rows' counts summed). */
  differences: number
}

export interface Advance {
  move: boolean
  /** One line: why it moves, or why not. */
  reason: string
}

const DAY_MS = 24 * 60 * 60 * 1000

export function advance(facts: OrgFacts, target: 'shadow' | 'roles', opts: { now: Date; minDays: number }): Advance {
  const { model } = facts
  if (model === target) return { move: false, reason: `already on ${target}` }
  if (model === 'roles') return { move: false, reason: 'on roles already: never moved back' }

  if (target === 'shadow') {
    if (model !== 'legacy') return { move: false, reason: `on ${model}` }
    if (facts.withoutRole) return { move: false, reason: `${facts.withoutRole} person(s) without a role that 0015 can give: give one in Settings → Roles & access` }
    return { move: true, reason: 'legacy → shadow' }
  }

  // target === 'roles'
  if (model !== 'shadow') return { move: false, reason: `on ${model}: --set shadow first, and a day there` }
  if (facts.withoutRole) return { move: false, reason: `${facts.withoutRole} person(s) without a role` }
  if (!facts.shadowSince) return { move: false, reason: 'nothing says since when it is on shadow: move it by hand after reading its report' }
  const days = (opts.now.getTime() - facts.shadowSince.getTime()) / DAY_MS
  if (days < opts.minDays) return { move: false, reason: `on shadow for ${days.toFixed(1)} day(s), less than ${opts.minDays}` }
  if (facts.differences) return { move: false, reason: `${facts.differences} difference(s) since it moved to shadow: read --org ${facts.slug}` }
  return { move: true, reason: `shadow → roles (${days.toFixed(1)} day(s) on shadow, 0 differences)` }
}
