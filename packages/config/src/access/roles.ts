import { isCapability, type CapabilityId } from './catalogue'
import { ALL, type Grant } from './grant'
import { compileLegacy, type LegacyClaims } from './legacy'
import { templateGrant } from './templates'

/**
 * FR-27.3 (#529) — what a stored role grants. Import-pure: the server resolves it, and the editor shows it.
 *
 * - `all`: the Administrator, every capability, including one a later release adds.
 * - A built-in role never edited: its template's grant, today's (`templates.ts`). It follows the catalogue.
 * - Otherwise: the capabilities it was saved with. ⚠ An id the catalogue does not know is no grant (FR-27.8): a
 *   release that renamed a capability never widens a role, and `unknownCaps` lists what was dropped.
 */
export interface RoleLike {
  all?: boolean
  isBuiltin?: boolean
  edited?: boolean
  templateKey?: string | null
  caps?: readonly string[] | null
}

export function grantOfRole(role: RoleLike | null | undefined): Grant {
  if (!role) return { caps: new Set() }
  if (role.all) return ALL
  if (role.isBuiltin && !role.edited && role.templateKey) return templateGrant(role.templateKey)
  return { caps: new Set((role.caps ?? []).filter(isCapability) as CapabilityId[]) }
}

/** The stored ids of a role the catalogue does not know: shown on the role's page (FR-27.8), never granted. */
export function unknownCaps(role: RoleLike | null | undefined): string[] {
  return (role?.caps ?? []).filter(c => !isCapability(c))
}

/** Whether two grants allow exactly the same. */
export function sameGrant(a: Grant, b: Grant): boolean {
  if (a.all || b.all) return !!a.all && !!b.all
  return a.caps.size === b.caps.size && [...a.caps].every(c => b.caps.has(c))
}

/**
 * The key of an access shape, as migration 0015 groups people by it: role, permissions and areas, sorted. Two people
 * with the same key are given the same role, and a re-run finds it by this key.
 */
export function legacyKeyOf(claims: Required<Pick<LegacyClaims, 'role'>> & { permissions: readonly string[]; areas?: readonly string[] | null }): string {
  const areas = Array.isArray(claims.areas) ? [...claims.areas].sort().join(',') : '*'
  return `${claims.role}|${[...claims.permissions].sort().join(',')}|${areas}`
}

/** The grant those claims compile to: what the person may do today. */
export const grantOfClaims = (claims: LegacyClaims): Grant => compileLegacy(claims)
