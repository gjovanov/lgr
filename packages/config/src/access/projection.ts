import { AREAS, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES, type Area, type Permission } from '../constants'
import type { CapabilityId } from './catalogue'
import type { Grant } from './grant'
import { LEGACY_BRIDGE, LEGACY_CANNOT_WITHHOLD, LEGACY_ROLE_CAPS, NOT_WITH_AN_AREAS_LIST, areaOfCap, compileLegacy } from './legacy'
import { sameGrant } from './roles'

/**
 * FR-27 §4 step 3 (#529) — what a release that reads no roles serves a role's people: the legacy role key,
 * permissions and areas whose compiled grant is the role's, or as much of it as they can say.
 *
 * ⚠ Never more than the role: a permission is in only when everything it gives (its areas aside) the role holds, a
 * role key only when every check that reads its name the role passes, and an area only when the role holds
 * something of it. `exact` says whether the projection is the role; a role that is not is `needsRelease`: an org
 * on the legacy model, or a master on an older release, would serve its people less than it says.
 *
 * Import-pure.
 */
export interface Projection {
  legacy: { role: string; permissions: string[]; areas?: string[] }
  exact: boolean
}

type Cap = CapabilityId

export function projectGrant(grant: Grant): Projection {
  if (grant.all) return { legacy: { role: 'admin', permissions: [...DEFAULT_ROLE_PERMISSIONS.admin] }, exact: true }
  const has = (c: string) => grant.caps.has(c as Cap)

  // The role key: the one whose name-given capabilities the role holds most of, all of them; else `member`.
  let role = 'member'
  let best = 0
  for (const key of ROLES) {
    if (key === 'admin') continue
    const caps = LEGACY_ROLE_CAPS[key] ?? []
    if (caps.length > best && caps.every(has)) {
      role = key
      best = caps.length
    }
  }

  // The permissions whose every capability the role holds, once `areas` (when a list) has taken its own away.
  const permissionsWith = (areas: readonly Area[] | undefined) => PERMISSIONS.filter(p => LEGACY_BRIDGE[p as Permission].every(c => {
    if (has(c)) return true
    if (!areas) return false
    const a = areaOfCap(c)
    return (!!a && !areas.includes(a)) || (NOT_WITH_AN_AREAS_LIST as readonly string[]).includes(c)
  }))

  // First with no areas list: what most roles are, and a list also takes #493's items away.
  const plain = { role, permissions: permissionsWith(undefined) }
  const plainGrant = compileLegacy(plain)
  if (sameGrant(plainGrant, grant)) return { legacy: plain, exact: true }

  // Then with the list of the areas the role holds anything of; kept where it says more of the role. ⚠ A plain
  // projection gives every session without a list what such a list takes away (`org.switch`…): where the role lacks
  // it, only the list stays within the role.
  const kept = AREAS.filter(a => [...grant.caps].some(c => areaOfCap(c) === a))
  const listed = { role, permissions: permissionsWith(kept), areas: [...kept] }
  const listedGrant = compileLegacy(listed)
  // What the legacy model cannot withhold (the cost figures) is never what makes a projection exceed the role.
  const within = (g: Grant) => !g.all && [...g.caps].every(c => grant.caps.has(c) || LEGACY_CANNOT_WITHHOLD.includes(c))
  const size = (g: Grant) => (g.all ? Infinity : g.caps.size)
  const legacy = !within(plainGrant) || size(listedGrant) > size(plainGrant) ? listed : plain
  return { legacy, exact: sameGrant(legacy === listed ? listedGrant : plainGrant, grant) }
}
