import { DEFAULT_ROLE_AREAS, DEFAULT_ROLE_PERMISSIONS, ROLES, type Role } from '../constants'
import type { Grant } from './grant'
import { compileLegacy, type LegacyClaims } from './legacy'

/**
 * FR-27.3 (#529) — the built-in roles: the ten legacy roles, under the same names and with the same access. A
 * template's grant is what its legacy role's defaults compile to (`compileLegacy`), so it equals today's by
 * construction, and it follows the catalogue when a release adds capabilities. `admin` is the Administrator: `*`.
 *
 * The names are the system permission sets' where a role has one (`ROLE_PERMISSION_SET_NAMES`), so a person sees
 * the name they knew. `sales` and `hr_manager`, which had no set, get one here (FR-27.3).
 *
 * Import-pure.
 */
export interface RoleTemplate {
  /** The legacy role it stands for, and its key in scripts and the API (`seed-user.ts --role seller`). */
  key: Role
  name: string
  /** One sentence, in four locales from P1-4: what ends „Sales" against „Seller" (FR-27.4). */
  descriptionKey: string
  /** What the role's users were given before roles: its projection on a release that reads no roles. */
  legacy: Required<Pick<LegacyClaims, 'role'>> & { permissions: string[]; areas?: string[] }
}

const NAMES: Readonly<Record<Role, string>> = {
  admin: 'Administrator',
  manager: 'Manager',
  accountant: 'Accountant',
  hr_manager: 'HR Manager',
  warehouse_manager: 'Warehouse Manager',
  sales: 'Sales',
  seller: 'Seller',
  sales_consultant: 'Sales Consultant',
  member: 'Member (Read Only)',
  nra_auditor: 'NRA Auditor (Read Only)',
}

export const ROLE_TEMPLATES: readonly RoleTemplate[] = ROLES.map(key => {
  const areas = DEFAULT_ROLE_AREAS[key]
  return {
    key,
    name: NAMES[key],
    descriptionKey: `access.roles.${key}.description`,
    legacy: { role: key, permissions: [...DEFAULT_ROLE_PERMISSIONS[key]], ...(areas ? { areas: [...areas] } : {}) },
  }
})

export function templateOf(key: string | null | undefined): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find(t => t.key === key)
}

/**
 * FR-27.11.B (D-5 revised, D-11, D-12; owner, 2026-11-10): what a template ships without, though its legacy role had
 * it. The Seller and the Sales Consultant start without the cost figures, Цена на едро and Цена 0; an organization's
 * administrator ticks them back per role. Every other template keeps every level.
 *
 * ⚠ Only where a role is MADE from the template: a new organization's built-in roles (`seedBuiltinRoles`) and "New role
 * → from a template". `templateGrant` stays the legacy role's access, which an unedited built-in, migration 0015 and
 * every "is this the same access" check read: nobody's access changes.
 */
export const TEMPLATE_WITHHOLDS: Readonly<Partial<Record<Role, readonly string[]>>> = {
  seller: ['products.costs', 'products.price:wholesale', 'products.price:0'],
  sales_consultant: ['products.costs', 'products.price:wholesale', 'products.price:0'],
}

/** A template's grant, today's access of its legacy role. */
export function templateGrant(key: string): Grant {
  const t = templateOf(key)
  return t ? compileLegacy(t.legacy) : { caps: new Set() }
}

/** What a role made from the template starts with: its grant, less what it withholds (FR-27.11.B, D-11, D-12). */
export function templateDefaults(key: string): Grant {
  const grant = templateGrant(key)
  const withheld = TEMPLATE_WITHHOLDS[key as Role]
  if (grant.all || !withheld?.length) return grant
  return { caps: new Set([...grant.caps].filter(c => !withheld.includes(c))) }
}
