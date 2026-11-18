import { isCapability, type CapabilityId } from './catalogue'
import { ALL, type Grant } from './grant'
import type { LegacyClaims } from './legacy'
import { templateGrant, templateOf } from './templates'

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

/**
 * FR-27 P3-5 (#529): how a person's role is named outside the roles screens (the org menu, the org picker, an
 * invitation, the SUPTO operators table): a built-in role that still carries its template's name by its template key,
 * which the SPA translates (`settings.roles.<key>`, as it did the legacy key), any other by its name. Display only:
 * nothing decides by it.
 *
 * ⚠ A built-in role the org renamed (`updateRole` renames any but the locked ones, `isLockedRole`; an NRA Auditor role
 * renamed before its lock keeps that name) shows the org's name, as the Roles screen does: the key would be translated
 * back to the template's name, and the org menu and the export would disagree with the Roles screen (#529, answer 4).
 */
export function roleDisplay(role: { isBuiltin?: boolean; templateKey?: string | null; name?: string | null } | null | undefined): string {
  if (!role) return ''
  if (role.isBuiltin && role.templateKey && (!role.name || role.name === templateOf(role.templateKey)?.name)) return role.templateKey
  return role.name ?? ''
}

/**
 * #529 (owner, 2026-11-18): the built-in roles an organization cannot edit, by its template key. The Administrator is
 * locked by what it is (`all`); the NRA Auditor (Read Only) is the audit profile of Наредба Н-18, Appendix 29 т. 19, and
 * the SUPTO documents describe exactly what it reads, so no organization adds to it (or takes from it, or renames it).
 */
export const LOCKED_TEMPLATE_KEYS: readonly string[] = ['nra_auditor']

/**
 * Whether an organization may not edit this role (`role.service#updateRole` refuses it, 409, and the editor shows it
 * read-only): the Administrator (`all`) and the built-in role of a `LOCKED_TEMPLATE_KEYS` template.
 *
 * ⚠ The lock refuses changes; it rewrites nothing. An NRA Auditor role an organization edited or renamed before the
 * lock keeps what it holds and its name: no migration resets it.
 */
export function isLockedRole(role: RoleLike | null | undefined): boolean {
  if (!role) return false
  return !!role.all || (!!role.isBuiltin && !!role.templateKey && LOCKED_TEMPLATE_KEYS.includes(role.templateKey))
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
