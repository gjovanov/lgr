export const ROLES = ['admin', 'manager', 'accountant', 'hr_manager', 'warehouse_manager', 'sales', 'member', 'nra_auditor'] as const
export type Role = (typeof ROLES)[number]

export const PERMISSIONS = [
  'accounting.read', 'accounting.write', 'accounting.post',
  'trade.read', 'trade.write', 'trade.adjust', 'trade.send',
  'payroll.read', 'payroll.write', 'payroll.approve',
  'hr.read', 'hr.write', 'hr.approve_leave',
  'crm.read', 'crm.write',
  'erp.read', 'erp.write',
  'project.read', 'project.write', 'project.timesheet',
  'helpdesk.read', 'helpdesk.write', 'helpdesk.manage',
  'sales.read', 'sales.write', 'sales.confirm', 'sales.invoice',
  'purchase.read', 'purchase.write', 'purchase.confirm', 'purchase.approve',
  'documents.read', 'documents.write', 'documents.sign', 'documents.manage',
  'subscriptions.read', 'subscriptions.write', 'subscriptions.manage',
  'approvals.read', 'approvals.write', 'approvals.manage',
  'planning.read', 'planning.write', 'planning.manage',
  'recruitment.read', 'recruitment.write', 'recruitment.manage',
  'fleet.read', 'fleet.write',
  'maintenance.read', 'maintenance.write', 'maintenance.manage',
  'knowledge.read', 'knowledge.write', 'knowledge.manage',
  'field_service.read', 'field_service.write', 'field_service.manage',
  'admin.users', 'admin.settings', 'admin.audit',
] as const
export type Permission = (typeof PERMISSIONS)[number]

export const MODULES = [
  'accounting', 'trade', 'payroll', 'hr', 'crm', 'erp', 'sales', 'purchase', 'project', 'helpdesk', 'documents', 'subscriptions', 'approvals', 'planning', 'recruitment', 'fleet', 'maintenance', 'knowledge', 'field_service',
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
  accountant: ['accounting.read', 'accounting.write', 'accounting.post', 'trade.read', 'trade.write', 'trade.send', 'sales.read', 'purchase.read'],
  hr_manager: ['hr.read', 'hr.write', 'hr.approve_leave', 'payroll.read', 'payroll.write', 'payroll.approve', 'recruitment.read', 'recruitment.write', 'recruitment.manage', 'fleet.read', 'fleet.write'],
  warehouse_manager: ['trade.read', 'trade.write', 'trade.adjust', 'purchase.read', 'purchase.write'],
  sales: ['crm.read', 'crm.write', 'trade.read', 'trade.write', 'sales.read', 'sales.write', 'sales.confirm', 'sales.invoice', 'project.read', 'documents.read'],
  member: ['accounting.read', 'trade.read', 'payroll.read', 'hr.read', 'crm.read', 'erp.read', 'project.read', 'helpdesk.read', 'documents.read', 'subscriptions.read', 'approvals.read', 'planning.read', 'fleet.read', 'maintenance.read', 'knowledge.read', 'field_service.read'],
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

export const SALES_ORDER_STATES = ['draft', 'sent', 'confirmed', 'invoiced', 'done', 'cancelled'] as const
export const PURCHASE_ORDER_STATES = ['draft', 'sent', 'to_approve', 'confirmed', 'received', 'billed', 'done', 'cancelled'] as const

export const PROJECT_STATES = ['active', 'on_hold', 'done', 'cancelled'] as const
export const TASK_STATES = ['open', 'in_progress', 'done', 'cancelled'] as const
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export const TICKET_STATES = ['new', 'in_progress', 'waiting', 'resolved', 'closed'] as const
export const TICKET_CHANNELS = ['email', 'form', 'chat', 'phone', 'manual'] as const
export const SLA_STATUSES = ['on_track', 'at_risk', 'breached'] as const

export const SUBSCRIPTION_STATES = ['draft', 'active', 'paused', 'cancelled', 'expired', 'closed'] as const
export const APPROVAL_STATES = ['pending', 'approved', 'rejected', 'cancelled'] as const
export const SHIFT_STATES = ['draft', 'published', 'confirmed', 'completed', 'cancelled'] as const
export const APPOINTMENT_STATES = ['scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show'] as const

// Recruitment & Appraisals
export const JOB_POSITION_STATES = ['draft', 'published', 'closed', 'cancelled'] as const
export const APPLICANT_STATES = ['new', 'initial_review', 'interview', 'offer', 'hired', 'refused', 'withdrawn'] as const
export const APPRAISAL_STATES = ['draft', 'scheduled', 'in_progress', 'completed', 'cancelled'] as const

// Fleet
export const VEHICLE_STATES = ['active', 'in_service', 'out_of_service', 'sold', 'scrapped'] as const
export const FUEL_TYPES = ['gasoline', 'diesel', 'electric', 'hybrid', 'lpg', 'cng', 'hydrogen'] as const
export const VEHICLE_COST_TYPES = ['fuel', 'insurance', 'maintenance', 'repair', 'tax', 'toll', 'parking', 'fine', 'other'] as const

// Maintenance
export const MAINTENANCE_TYPES = ['preventive', 'corrective', 'predictive', 'condition_based'] as const
export const MAINTENANCE_STATES = ['draft', 'confirmed', 'in_progress', 'done', 'cancelled'] as const

// Knowledge
export const KNOWLEDGE_ACCESS_LEVELS = ['private', 'internal', 'public'] as const

// Field Service
export const FIELD_SERVICE_STATES = ['scheduled', 'in_progress', 'done', 'cancelled'] as const

// Manufacturing (Advanced MRP + PLM)
export const ECO_STATES = ['draft', 'in_review', 'approved', 'applied', 'rejected'] as const
export const ECO_TYPES = ['bom_change', 'routing_change', 'product_change'] as const

// POS Restaurant
export const TABLE_SHAPES = ['square', 'round', 'rectangle'] as const
export const TABLE_STATES = ['available', 'occupied', 'reserved'] as const
export const KITCHEN_ORDER_STATES = ['pending', 'in_progress', 'ready', 'served', 'cancelled'] as const
export const KITCHEN_LINE_STATES = ['pending', 'preparing', 'ready', 'served'] as const

export const DOCUMENT_ACCESS_LEVELS = ['private', 'workspace', 'public'] as const
export const SIGNATURE_REQUEST_STATES = ['draft', 'sent', 'partially_signed', 'completed', 'cancelled', 'expired'] as const
export const SIGNER_STATES = ['waiting', 'sent', 'signed', 'refused'] as const

// ── Multi-App Architecture ──

export const APP_IDS = ['accounting', 'trade', 'payroll', 'hr', 'crm', 'erp', 'sales', 'purchase', 'project', 'helpdesk', 'documents', 'subscriptions', 'planning'] as const
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
  sales:      { name: 'Sales',     icon: 'mdi-cart-outline', color: '#7C4DFF', port: 4090, uiPort: 4091, requiredPermission: 'sales.read', description: 'Quotations, sales orders, customer management' },
  purchase:   { name: 'Purchase',  icon: 'mdi-truck-delivery', color: '#FF6F00', port: 4100, uiPort: 4101, requiredPermission: 'purchase.read', description: 'RFQs, purchase orders, vendor management' },
  project:  { name: 'Project',  icon: 'mdi-clipboard-check-outline', color: '#00897B', port: 4110, uiPort: 4111, requiredPermission: 'project.read', description: 'Projects, tasks, timesheets, milestones' },
  helpdesk: { name: 'Helpdesk', icon: 'mdi-face-agent', color: '#E53935', port: 4120, uiPort: 4121, requiredPermission: 'helpdesk.read', description: 'Tickets, SLA, teams, knowledge base' },
  documents: { name: 'Documents', icon: 'mdi-file-document-multiple', color: '#5C6BC0', port: 4130, uiPort: 4131, requiredPermission: 'documents.read', description: 'Document management, workspaces, e-signatures' },
  subscriptions: { name: 'Subscriptions', icon: 'mdi-autorenew', color: '#26A69A', port: 4140, uiPort: 4141, requiredPermission: 'subscriptions.read', description: 'Recurring subscriptions, billing cycles, auto-renewal' },
  planning: { name: 'Planning', icon: 'mdi-calendar-clock', color: '#AB47BC', port: 4150, uiPort: 4151, requiredPermission: 'planning.read', description: 'Shifts, scheduling, appointments, resource planning' },
}

export const PLAN_APP_LIMITS: Record<string, number> = {
  free: 4,           // accounting, trade, hr, crm
  starter: 8,        // + sales, purchase, project, helpdesk
  pro: 13,
  professional: 13,  // all apps
  enterprise: 13,    // all apps + priority support
}
