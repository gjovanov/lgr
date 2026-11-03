import type { RepositoryRegistry } from 'dal'
import { DEFAULT_ROLE_AREAS, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLE_PERMISSION_SET_NAMES, type Area } from 'config/constants'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'

interface PermissionSetDef {
  name: string
  description: string
  permissions: string[]
  ownRecordsOnly: Record<string, boolean>
  /** FR-26: only on the sets that are held to areas; absent = every area. */
  areas?: Area[]
  isAdmin: boolean
  isDefault: boolean
}

export const DEFAULT_PERMISSION_SETS: PermissionSetDef[] = [
  {
    name: 'Administrator',
    description: 'Full access to all modules',
    permissions: [...PERMISSIONS],
    ownRecordsOnly: {},
    isAdmin: true,
    isDefault: false,
  },
  {
    name: 'Manager',
    description: 'Full access to all modules except admin settings and one person\'s pay',
    permissions: [...DEFAULT_ROLE_PERMISSIONS.manager],
    ownRecordsOnly: {},
    isAdmin: false,
    isDefault: false,
  },
  // These two follow their roles' defaults. They granted the legacy `trade.*`, which expanded
  // to more than the role has: an accountant got stock and point-of-sale writes.
  {
    name: 'Accountant',
    description: 'Accounting, invoicing and reporting access',
    permissions: [...DEFAULT_ROLE_PERMISSIONS.accountant],
    ownRecordsOnly: {},
    isAdmin: false,
    isDefault: false,
  },
  {
    name: 'Warehouse Manager',
    description: 'Stock operations and reporting',
    permissions: [...DEFAULT_ROLE_PERMISSIONS.warehouse_manager],
    ownRecordsOnly: {},
    isAdmin: false,
    isDefault: false,
  },
  {
    name: 'Member (Read Only)',
    description: 'Read-only access to every module except payroll',
    // ⚠ Not `DEFAULT_ROLE_PERMISSIONS.member`, which holds no `pos.read`. Payroll is out of both (FR-25).
    permissions: PERMISSIONS.filter(p => p.endsWith('.read') && p !== 'payroll.read'),
    ownRecordsOnly: {},
    isAdmin: false,
    isDefault: true,
  },
  // FR-26.4: the counter's two roles. Their areas carve Orders, bills, payments, prices, stock
  // control and the catalog export out of the modules their permissions open.
  {
    name: 'Seller',
    description: 'Sales documents, the till and stock transfers; no orders, bills, payments or prices',
    permissions: [...DEFAULT_ROLE_PERMISSIONS.seller],
    ownRecordsOnly: {},
    areas: [...DEFAULT_ROLE_AREAS.seller!],
    isAdmin: false,
    isDefault: false,
  },
  {
    name: 'Sales Consultant',
    description: 'What a Seller does, and orders and reservations',
    permissions: [...DEFAULT_ROLE_PERMISSIONS.sales_consultant],
    ownRecordsOnly: {},
    areas: [...DEFAULT_ROLE_AREAS.sales_consultant!],
    isAdmin: false,
    isDefault: false,
  },
  // A tax inspector reads and exports and changes nothing. A set outranks the role's defaults at
  // sign-in, and this role used to map to Accountant: writes, and no audit log.
  {
    name: 'NRA Auditor (Read Only)',
    description: 'Read-only access for a tax inspector, with the audit log and report export',
    permissions: [...DEFAULT_ROLE_PERMISSIONS.nra_auditor],
    ownRecordsOnly: {},
    isAdmin: false,
    isDefault: false,
  },
]

/**
 * Seed default permission sets for an org. Idempotent.
 */
export async function seedDefaultPermissionSets(orgId: string, repos?: RepositoryRegistry): Promise<void> {
  const r = repos ?? getRepos()

  for (const def of DEFAULT_PERMISSION_SETS) {
    const existing = await r.permissionSets.findOne({ orgId, name: def.name } as any)
    if (existing) continue

    await r.permissionSets.create({
      orgId,
      name: def.name,
      description: def.description,
      permissions: def.permissions,
      ownRecordsOnly: def.ownRecordsOnly,
      ...(def.areas ? { areas: def.areas } : {}),
      isAdmin: def.isAdmin,
      isDefault: def.isDefault,
      isSystem: true,
    } as any)
  }

  logger.info({ orgId, count: DEFAULT_PERMISSION_SETS.length }, 'Default permission sets seeded')
}

/**
 * Map old role to permission set name for migration.
 */
export const ROLE_TO_PERMISSION_SET: Record<string, string> = { ...ROLE_PERMISSION_SET_NAMES }
