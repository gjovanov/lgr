import type { RepositoryRegistry } from 'dal'
import { PERMISSIONS } from 'config/constants'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'

interface PermissionSetDef {
  name: string
  description: string
  permissions: string[]
  ownRecordsOnly: Record<string, boolean>
  isAdmin: boolean
  isDefault: boolean
}

const DEFAULT_PERMISSION_SETS: PermissionSetDef[] = [
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
    description: 'Full access to all modules except admin settings',
    permissions: PERMISSIONS.filter(p => !p.startsWith('admin.')),
    ownRecordsOnly: {},
    isAdmin: false,
    isDefault: false,
  },
  {
    name: 'Sales Representative',
    description: 'Sales, CRM, and trade operations — own records only',
    permissions: [
      'sales.read', 'sales.write', 'sales.confirm', 'sales.invoice',
      'crm.read', 'crm.write',
      'trade.read', 'trade.write', 'trade.send',
      'project.read', 'project.timesheet',
    ],
    ownRecordsOnly: { sales: true, crm: true },
    isAdmin: false,
    isDefault: false,
  },
  {
    name: 'Accountant',
    description: 'Accounting, trade, and reporting access',
    permissions: [
      'accounting.read', 'accounting.write', 'accounting.post',
      'trade.read', 'trade.write', 'trade.send',
      'sales.read', 'purchase.read',
    ],
    ownRecordsOnly: {},
    isAdmin: false,
    isDefault: false,
  },
  {
    name: 'HR Officer',
    description: 'HR, payroll, and recruitment management',
    permissions: [
      'hr.read', 'hr.write', 'hr.approve_leave',
      'payroll.read', 'payroll.write', 'payroll.approve',
      'recruitment.read', 'recruitment.write', 'recruitment.manage',
      'fleet.read', 'fleet.write',
    ],
    ownRecordsOnly: {},
    isAdmin: false,
    isDefault: false,
  },
  {
    name: 'Warehouse Manager',
    description: 'Trade operations and purchase management',
    permissions: [
      'trade.read', 'trade.write', 'trade.adjust',
      'purchase.read', 'purchase.write', 'purchase.confirm',
    ],
    ownRecordsOnly: {},
    isAdmin: false,
    isDefault: false,
  },
  {
    name: 'Project Member',
    description: 'Project tasks and timesheets — own records only',
    permissions: [
      'project.read', 'project.write', 'project.timesheet',
    ],
    ownRecordsOnly: { project: true },
    isAdmin: false,
    isDefault: false,
  },
  {
    name: 'Support Agent',
    description: 'Helpdesk tickets and knowledge base — own tickets only',
    permissions: [
      'helpdesk.read', 'helpdesk.write',
      'knowledge.read', 'knowledge.write',
    ],
    ownRecordsOnly: { helpdesk: true },
    isAdmin: false,
    isDefault: false,
  },
  {
    name: 'Member (Read Only)',
    description: 'Read-only access to all modules',
    permissions: PERMISSIONS.filter(p => p.endsWith('.read')),
    ownRecordsOnly: {},
    isAdmin: false,
    isDefault: true,
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
export const ROLE_TO_PERMISSION_SET: Record<string, string> = {
  admin: 'Administrator',
  manager: 'Manager',
  accountant: 'Accountant',
  hr_manager: 'HR Officer',
  warehouse_manager: 'Warehouse Manager',
  sales: 'Sales Representative',
  member: 'Member (Read Only)',
  nra_auditor: 'Accountant',
}
