export const ROLES = ['admin', 'manager', 'accountant', 'warehouse_manager', 'member', 'nra_auditor'] as const
export type Role = (typeof ROLES)[number]

export const PERMISSIONS = [
  'accounting.read', 'accounting.write', 'accounting.post',
  'inventory.read', 'inventory.write', 'inventory.adjust',
  'invoicing.read', 'invoicing.write', 'invoicing.send',
  'pos.read', 'pos.write',
  'payroll.read', 'payroll.write', 'payroll.approve',
  'admin.users', 'admin.settings', 'admin.audit',
] as const
export type Permission = (typeof PERMISSIONS)[number]

/**
 * Maps legacy `trade.*` permissions to their new granular equivalents.
 * Used to expand existing JWTs and DB records during the transition period.
 */
export const LEGACY_PERMISSION_MAP: Record<string, string[]> = {
  'trade.read': ['inventory.read', 'invoicing.read', 'pos.read'],
  'trade.write': ['inventory.write', 'invoicing.write', 'pos.write'],
  'trade.adjust': ['inventory.adjust'],
  'trade.send': ['invoicing.send'],
}

export const MODULES = [
  'accounting', 'inventory', 'invoicing', 'pos', 'payroll', 'reports',
] as const
export type Module = (typeof MODULES)[number]

export const CURRENCIES = [
  'EUR', 'USD', 'GBP', 'CHF', 'MKD', 'BGN', 'RSD', 'HRK', 'BAM',
  'JPY', 'CNY', 'AUD', 'CAD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF',
] as const

export const SUBSCRIPTION_PLANS = ['free', 'starter', 'professional', 'enterprise'] as const

export const DEFAULT_ROLE_PERMISSIONS: Record<Role, string[]> = {
  admin: ['admin.users', 'admin.settings', ...PERMISSIONS.filter(p => !p.startsWith('admin.'))],
  manager: PERMISSIONS.filter(p => !p.startsWith('admin.')).slice(),
  accountant: ['accounting.read', 'accounting.write', 'accounting.post', 'invoicing.read', 'invoicing.write', 'invoicing.send', 'inventory.read'],
  warehouse_manager: ['inventory.read', 'inventory.write', 'inventory.adjust'],
  member: ['accounting.read', 'inventory.read', 'invoicing.read', 'payroll.read'],
  nra_auditor: ['accounting.read', 'inventory.read', 'invoicing.read', 'pos.read', 'admin.audit'],
}

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const
export const ACCOUNT_SUB_TYPES = [
  'current_asset', 'fixed_asset', 'other_asset',
  'current_liability', 'long_term_liability',
  'owner_equity', 'retained_earnings',
  'operating_revenue', 'other_revenue',
  'operating_expense', 'cost_of_goods_sold', 'other_expense',
] as const

export const INVOICE_TYPES = ['invoice', 'proforma', 'credit_note', 'debit_note'] as const
export const INVOICE_DIRECTIONS = ['outgoing', 'incoming'] as const
export const INVOICE_STATUSES = ['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'voided', 'cancelled'] as const

export const PRODUCT_TYPES = ['goods', 'service', 'raw_material', 'finished_product'] as const
export const MOVEMENT_TYPES = ['receipt', 'dispatch', 'transfer', 'adjustment', 'return', 'production_in', 'production_out'] as const

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'] as const
export const EMPLOYEE_STATUSES = ['active', 'on_leave', 'terminated', 'suspended'] as const

export const DOCUMENT_ACCESS_LEVELS = ['private', 'workspace', 'public'] as const

// ── Multi-App Architecture ──

export const APP_IDS = ['accounting', 'inventory', 'invoicing', 'pos', 'payroll', 'reports'] as const
export type AppId = (typeof APP_IDS)[number]

export const APP_REGISTRY: Record<AppId, {
  name: string
  icon: string
  color: string
  devPort: number
  path: string
  requiredPermission: string
  description: string
}> = {
  accounting: { name: 'Accounting', icon: 'mdi-chart-bar',     color: '#4caf50', devPort: 4011, path: '/accounting/', requiredPermission: 'accounting.read', description: 'Chart of accounts, journal entries, financial statements' },
  inventory:  { name: 'Inventory',  icon: 'mdi-warehouse',     color: '#ff9800', devPort: 4031, path: '/inventory/', requiredPermission: 'inventory.read', description: 'Products, stock, movements, valuations' },
  invoicing:  { name: 'Invoicing',  icon: 'mdi-receipt-text',  color: '#2196f3', devPort: 4021, path: '/invoicing/', requiredPermission: 'invoicing.read', description: 'Contacts, invoices, payments' },
  pos:        { name: 'POS',        icon: 'mdi-point-of-sale', color: '#e91e63', devPort: 4091, path: '/pos/',       requiredPermission: 'pos.read', description: 'Point of sale, sessions, fiscal' },
  payroll:    { name: 'Payroll',    icon: 'mdi-cash-multiple',  color: '#9c27b0', devPort: 4041, path: '/payroll/',  requiredPermission: 'payroll.read', description: 'Employees, payroll runs, payslips, timesheets' },
  // FR-06 (#14): P1 gates the Reports tile on `invoicing.read` rather than a new
  // `reports.read` — that is exactly the audience the two reports it hosts serve
  // today (incl. the read-only `member` and `nra_auditor`), and it needs no
  // permission backfill nor a re-login for already-issued JWTs. Dedicated
  // `reports.*` permissions are deferred to P2, when the SUPTO 18.1-18.9 UI lands.
  // The per-report `permission` in the report registry is the real content gate.
  reports:    { name: 'Reports',    icon: 'mdi-file-chart',    color: '#8e24aa', devPort: 4101, path: '/reports/',  requiredPermission: 'invoicing.read', description: 'Reports & exports' },
}

export const PLAN_APP_LIMITS: Record<string, number> = {
  free: 6,
  starter: 6,
  pro: 6,
  professional: 6,
  enterprise: 6,
}
