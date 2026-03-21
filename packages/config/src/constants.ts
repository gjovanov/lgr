export const ROLES = ['admin', 'manager', 'accountant', 'hr_manager', 'warehouse_manager', 'sales', 'member', 'nra_auditor'] as const
export type Role = (typeof ROLES)[number]

export const PERMISSIONS = [
  'accounting.read', 'accounting.write', 'accounting.post',
  'trade.read', 'trade.write', 'trade.adjust', 'trade.send',
  'payroll.read', 'payroll.write', 'payroll.approve',
  'hr.read', 'hr.write', 'hr.approve_leave',
  'crm.read', 'crm.write',
  'erp.read', 'erp.write',
  'admin.users', 'admin.settings', 'admin.audit',
] as const
export type Permission = (typeof PERMISSIONS)[number]

export const MODULES = [
  'accounting', 'trade', 'payroll', 'hr', 'crm', 'erp',
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
  accountant: ['accounting.read', 'accounting.write', 'accounting.post', 'trade.read', 'trade.write', 'trade.send'],
  hr_manager: ['hr.read', 'hr.write', 'hr.approve_leave', 'payroll.read', 'payroll.write', 'payroll.approve'],
  warehouse_manager: ['trade.read', 'trade.write', 'trade.adjust'],
  sales: ['crm.read', 'crm.write', 'trade.read', 'trade.write'],
  member: ['accounting.read', 'trade.read', 'payroll.read', 'hr.read', 'crm.read', 'erp.read'],
  nra_auditor: ['accounting.read', 'trade.read', 'erp.read', 'admin.audit'],
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

export const LEAD_SOURCES = ['website', 'referral', 'cold_call', 'email', 'social', 'event', 'other'] as const
export const DEAL_STATUSES = ['open', 'won', 'lost'] as const

export const PRODUCTION_ORDER_STATUSES = ['planned', 'in_progress', 'quality_check', 'completed', 'cancelled'] as const
export const CONSTRUCTION_PROJECT_STATUSES = ['planning', 'active', 'on_hold', 'completed', 'cancelled'] as const

// ── Multi-App Architecture ──

export const APP_IDS = ['accounting', 'trade', 'payroll', 'hr', 'crm', 'erp'] as const
export type AppId = (typeof APP_IDS)[number]

export const APP_REGISTRY: Record<AppId, {
  name: string
  icon: string
  color: string
  port: number
  uiPort: number
  requiredPermission: string
  description: string
}> = {
  accounting: { name: 'Accounting', icon: 'mdi-chart-bar', color: '#4caf50', port: 4010, uiPort: 4011, requiredPermission: 'accounting.read', description: 'Chart of accounts, journal entries, financial statements' },
  trade:      { name: 'Trade',      icon: 'mdi-store', color: '#2196f3', port: 4030, uiPort: 4031, requiredPermission: 'trade.read', description: 'Products, stock, invoices, contacts, payments' },
  payroll:    { name: 'Payroll',    icon: 'mdi-cash-multiple', color: '#9c27b0', port: 4040, uiPort: 4041, requiredPermission: 'payroll.read', description: 'Employees, payroll runs, payslips, timesheets' },
  hr:         { name: 'HR',         icon: 'mdi-account-group', color: '#00bcd4', port: 4050, uiPort: 4051, requiredPermission: 'hr.read', description: 'Departments, leave management, documents' },
  crm:        { name: 'CRM',        icon: 'mdi-trending-up', color: '#e91e63', port: 4060, uiPort: 4061, requiredPermission: 'crm.read', description: 'Leads, deals, pipelines, activities' },
  erp:        { name: 'ERP',        icon: 'mdi-factory', color: '#795548', port: 4070, uiPort: 4071, requiredPermission: 'erp.read', description: 'Manufacturing, production, POS' },
}

export const PLAN_APP_LIMITS: Record<string, number> = {
  free: 6,
  starter: 6,
  pro: 6,
  professional: 6,
  enterprise: 6,
}
