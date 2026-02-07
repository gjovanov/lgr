export const ROLES = ['admin', 'manager', 'accountant', 'hr_manager', 'warehouse_manager', 'sales', 'member'] as const
export type Role = (typeof ROLES)[number]

export const PERMISSIONS = [
  'accounting.read', 'accounting.write', 'accounting.post',
  'invoicing.read', 'invoicing.write', 'invoicing.send',
  'warehouse.read', 'warehouse.write', 'warehouse.adjust',
  'payroll.read', 'payroll.write', 'payroll.approve',
  'hr.read', 'hr.write', 'hr.approve_leave',
  'crm.read', 'crm.write',
  'erp.read', 'erp.write',
  'admin.users', 'admin.settings',
] as const
export type Permission = (typeof PERMISSIONS)[number]

export const MODULES = [
  'accounting', 'invoicing', 'warehouse', 'payroll', 'hr', 'crm', 'erp',
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
  accountant: ['accounting.read', 'accounting.write', 'accounting.post', 'invoicing.read', 'invoicing.write', 'invoicing.send'],
  hr_manager: ['hr.read', 'hr.write', 'hr.approve_leave', 'payroll.read', 'payroll.write', 'payroll.approve'],
  warehouse_manager: ['warehouse.read', 'warehouse.write', 'warehouse.adjust'],
  sales: ['crm.read', 'crm.write', 'invoicing.read', 'invoicing.write'],
  member: ['accounting.read', 'invoicing.read', 'warehouse.read', 'payroll.read', 'hr.read', 'crm.read', 'erp.read'],
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
