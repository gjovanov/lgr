/**
 * ⚠ `hr_manager` and `sales` were missing here while being live everywhere else: the payroll
 * and HR controllers gate on them by name, `user.controller`'s body schema accepts them, and
 * `tests/helpers/seed.ts` creates a user for each. Because they had no `DEFAULT_ROLE_PERMISSIONS`
 * entry, both of those seeded users were created with `permissions: undefined`, and promoting
 * anyone into either role through the API left their OLD permissions in place (see the
 * `|| existing.permissions` fallback in user.controller's PUT).
 *
 * This list is the single source: the Users screen builds its role picker from it.
 */
export const ROLES = ['admin', 'manager', 'accountant', 'hr_manager', 'warehouse_manager', 'sales', 'seller', 'sales_consultant', 'member', 'nra_auditor'] as const
export type Role = (typeof ROLES)[number]

export const PERMISSIONS = [
  // FR-25: `accounting.file` generates a return's files and records that a person filed them.
  'accounting.read', 'accounting.write', 'accounting.post', 'accounting.file',
  // FR-25 §5: replacing a month of a books org's journal with PlusMinus's. Admins only by default.
  'accounting.import',
  'inventory.read', 'inventory.write', 'inventory.adjust',
  // FR-26.7: writes transfer movements and nothing else. `inventory.write` keeps every type.
  'inventory.transfer',
  'invoicing.read', 'invoicing.write', 'invoicing.send',
  'pos.read', 'pos.write',
  'payroll.read', 'payroll.write', 'payroll.approve',
  // FR-25 §3.11: `payroll.read` is a run's totals. Anything about one person needs `payroll.personal`.
  'payroll.personal',
  // FR-25 §5.1: bringing a company's filed payroll in. It needs `payroll.personal` as well.
  'payroll.import',
  // FR-6.2 (#14): `reports.read` opens the Reports app; `reports.export` is the extra
  // step of taking data OUT of it (XLSX/PDF). The per-report `permission` in the report
  // registry still gates CONTENT — holding reports.read does not reveal a report whose
  // module permission you lack.
  'reports.read', 'reports.export',
  'admin.users', 'admin.settings', 'admin.audit',
] as const
export type Permission = (typeof PERMISSIONS)[number]

export const MODULES = [
  'accounting', 'inventory', 'invoicing', 'pos', 'payroll', 'reports',
] as const
export type Module = (typeof MODULES)[number]

export const CURRENCIES = [
  'EUR', 'USD', 'GBP', 'CHF', 'MKD', 'BGN', 'RSD', 'HRK', 'BAM',
  'JPY', 'CNY', 'AUD', 'CAD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF',
] as const

export const SUBSCRIPTION_PLANS = ['free', 'starter', 'professional', 'enterprise'] as const

/** Who runs a fiscal device: its connection, its operators and its reports. */
export const FISCAL_ADMIN_ROLES: readonly string[] = ['admin', 'manager', 'warehouse_manager']

const SELLER_PERMISSIONS = ['invoicing.read', 'invoicing.write', 'invoicing.send', 'pos.read', 'pos.write', 'inventory.read', 'inventory.transfer'] as const

const MANAGER_GRANTED_BY_NAME: readonly string[] = ['payroll.approve', 'payroll.personal', 'payroll.import', 'accounting.import']

export const DEFAULT_ROLE_PERMISSIONS: Record<Role, string[]> = {
  admin: ['admin.users', 'admin.settings', ...PERMISSIONS.filter(p => !p.startsWith('admin.'))],
  // ⚠ Everything but administration, less what is granted by name: one person's pay, reading it and
  // approving it (a manager held `payroll.approve` and only a role name on the route refused it,
  // FR-25 §3.11), and importing a company's books (FR-25 R1) or its people (FR-25 §5.1). The seeded
  // Manager set is this list.
  manager: PERMISSIONS.filter(p => !p.startsWith('admin.') && !MANAGER_GRANTED_BY_NAME.includes(p)),
  accountant: ['accounting.read', 'accounting.write', 'accounting.post', 'accounting.file', 'invoicing.read', 'invoicing.write', 'invoicing.send', 'inventory.read', 'reports.read', 'reports.export'],
  // Payroll is the whole job, approval included.
  hr_manager: ['payroll.read', 'payroll.write', 'payroll.approve', 'payroll.personal', 'payroll.import', 'reports.read', 'reports.export'],
  warehouse_manager: ['inventory.read', 'inventory.write', 'inventory.adjust', 'reports.read', 'reports.export'],
  // Sells and invoices; reads stock rather than moving it.
  sales: ['invoicing.read', 'invoicing.write', 'invoicing.send', 'inventory.read', 'pos.read', 'pos.write', 'reports.read'],
  // FR-26.3: sells at the counter and on paper, moves stock between warehouses, and sees nothing
  // else. `DEFAULT_ROLE_AREAS` carves the rest out of the modules these permissions open.
  seller: [...SELLER_PERMISSIONS],
  sales_consultant: [...SELLER_PERMISSIONS],
  // A read-only member may open the Reports app but not carry data out of it.
  // ⚠ No payroll: what people are paid is no default of being in the org (FR-25 §3.11). Stored sets
  // and users' own lists still carry it until `scripts/backfill-member-payroll-read.ts --execute`.
  member: ['accounting.read', 'inventory.read', 'invoicing.read', 'reports.read'],
  // The NRA auditor's whole job is pulling the SUPTO tables out — it needs the export right.
  nra_auditor: ['accounting.read', 'inventory.read', 'invoicing.read', 'pos.read', 'admin.audit', 'reports.read', 'reports.export'],
}

/**
 * The system permission set of each role that has one, by name (`permission-set.seed.ts`). A role
 * change puts the user on it (FR-26.9.1), an invite starts them on it (FR-26.9.2), and the Users
 * screen warns when a user's role and sets disagree (FR-26.9.3).
 */
export const ROLE_PERMISSION_SET_NAMES: Readonly<Record<string, string>> = {
  admin: 'Administrator',
  manager: 'Manager',
  accountant: 'Accountant',
  warehouse_manager: 'Warehouse Manager',
  seller: 'Seller',
  sales_consultant: 'Sales Consultant',
  member: 'Member (Read Only)',
  nra_auditor: 'NRA Auditor (Read Only)',
}

/**
 * FR-26 §2.3: the parts of a module a permission set can be held to. Areas are layered on the
 * module permissions: a session's `areas` claim, when present, lists the only areas it may open.
 *
 * ⚠ Absent and `[]` mean opposite things. Absent (every set and token from before FR-26, every
 * existing role): unrestricted. `[]`: no area at all. Never default the claim to `[]`.
 */
export const AREAS = ['portal', 'orders', 'purchases', 'payments', 'pricing', 'stockControl', 'catalogExport'] as const
export type Area = (typeof AREAS)[number]

/** The areas of a role's users who hold no permission set. Only the FR-26 roles are restricted. */
export const DEFAULT_ROLE_AREAS: Partial<Record<Role, Area[]>> = {
  seller: [],
  sales_consultant: ['orders'],
}

/**
 * May this session open this area? `admin` always may, as on every other rule, and a session
 * without the claim is unrestricted.
 */
export function holdsArea(who: { role?: string; areas?: readonly string[] | null } | null | undefined, area: Area): boolean {
  if (!who) return false
  if (who.role === 'admin') return true
  return !Array.isArray(who.areas) || who.areas.includes(area)
}

/**
 * The claim several permission sets give, most permissive wins (as `ownRecordsOnly`): an
 * `isAdmin` set or any set without `areas` means no claim; otherwise the union of their lists.
 */
export function mergeAreas(sets: ReadonlyArray<{ isAdmin?: boolean; areas?: readonly string[] | null }>): Area[] | undefined {
  if (!sets.length) return undefined
  const union = new Set<Area>()
  for (const s of sets) {
    if (s.isAdmin || !Array.isArray(s.areas)) return undefined
    for (const a of s.areas) if ((AREAS as readonly string[]).includes(a)) union.add(a as Area)
  }
  return AREAS.filter(a => union.has(a))
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

/**
 * The longest customs tariff number an article keeps (`Product.tariffCode`). A CN code is 8 digits and a TARIC one
 * 10, 22 with its additional codes; the rest is room for how an org writes it. One number for the routes and the form.
 */
export const PRODUCT_TARIFF_CODE_MAX = 50

/**
 * The canonical price-tier slots, in order: what the product form pads an article to, and the
 * Products list's price columns. The imports and the seed name theirs the same
 * (`doc-import/map-movement.ts#TIER_NAMES`, `scripts/seed-products.ts`).
 *
 * `key` stands for the slot where its Cyrillic name cannot go: the list's column key, which is
 * also its sort key in the URL (`usePaginatedTable` keeps only `[A-Za-z0-9_.]` there) — the
 * column is `PRICE_TIER_COLUMN_PREFIX` + `key`, e.g. `tier_1` for „Цена 1".
 */
export const PRICE_TIERS: readonly { key: string; name: string }[] = [
  { key: 'delivery', name: 'Доставна цена' },
  { key: 'wholesale', name: 'Цена на едро' },
  { key: '0', name: 'Цена 0' },
  { key: '1', name: 'Цена 1' },
  { key: '2', name: 'Цена 2' },
  { key: '3', name: 'Цена 3' },
  { key: '4', name: 'Цена 4' },
  { key: '5', name: 'Цена 5' },
  { key: '6', name: 'Цена 6' },
  { key: '7', name: 'Цена 7' },
  { key: '8', name: 'Цена 8' },
  { key: '9', name: 'Цена 9' },
  { key: '10', name: 'Цена 10' },
]
export const PRICE_TIER_NAMES: readonly string[] = PRICE_TIERS.map((t) => t.name)
export const PRICE_TIER_COLUMN_PREFIX = 'tier_'

/**
 * Price-tier slots a product can hold: Доставна цена, Цена на едро, and Цена 0..Цена 10.
 *
 * ONE number for the model's validator, the goods-receipt and bill product updates and every
 * form that pads or truncates tiers. When the tiers went 10 → 13 (04d2c5f4) the forms moved and
 * `sanitizeProductUpdates` kept its own 10, so every receipt "with product update" on an article
 * with a selling price answered 422 (FR-22 B-1).
 */
export const MAX_PRICE_TIERS = PRICE_TIERS.length
export const MOVEMENT_TYPES = ['receipt', 'dispatch', 'transfer', 'adjustment', 'return', 'production_in', 'production_out'] as const

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'] as const
export const EMPLOYEE_STATUSES = ['active', 'on_leave', 'terminated', 'suspended'] as const

export const DOCUMENT_ACCESS_LEVELS = ['private', 'workspace', 'public'] as const

// ── Multi-App Architecture ──

// POS is no app of its own: the till lives in Invoicing. `pos` stays a module with its `pos.*`
// permissions, and an org's old `OrgApp` row for it is simply never read again.
export const APP_IDS = ['accounting', 'inventory', 'invoicing', 'payroll', 'reports', 'files'] as const
export type AppId = (typeof APP_IDS)[number]

export const APP_REGISTRY: Record<AppId, {
  name: string
  icon: string
  color: string
  path: string
  requiredPermission: string
  /** Other permissions that open the tile too (`app-hub.service`). */
  alsoOpenedBy?: readonly string[]
  description: string
}> = {
  accounting: { name: 'Accounting', icon: 'mdi-chart-bar',     color: '#4caf50', path: '/accounting/', requiredPermission: 'accounting.read', description: 'Chart of accounts, journal entries, financial statements' },
  inventory:  { name: 'Inventory',  icon: 'mdi-warehouse',     color: '#ff9800', path: '/inventory/', requiredPermission: 'inventory.read', description: 'Products, stock, movements, valuations' },
  // The till's pages live here, and the server reads the app for any of its permissions, so each of
  // these opens a page of it. `unit/page-registry.test.ts` holds this list to `canOpenPage`.
  invoicing:  { name: 'Invoicing',  icon: 'mdi-receipt-text',  color: '#2196f3', path: '/invoicing/', requiredPermission: 'invoicing.read', alsoOpenedBy: ['invoicing.write', 'invoicing.send', 'pos.read', 'pos.write'], description: 'Contacts, invoices, payments' },
  payroll:    { name: 'Payroll',    icon: 'mdi-cash-multiple',  color: '#9c27b0', path: '/payroll/',  requiredPermission: 'payroll.read', description: 'Employees, payroll runs, payslips, timesheets' },
  // FR-6.1/6.2 (#14): P1 gated this tile on `invoicing.read` to avoid a backfill. P2
  // introduces the real `reports.read` — the SUPTO tables are not an invoicing concern,
  // and a warehouse_manager needs the app without invoicing rights.
  // ⚠ OPS: already-issued JWTs do not carry `reports.*` until re-login, and stored
  // PermissionSets need `scripts/backfill-reports-permissions.ts --execute` FIRST.
  // (Admin sets are exempt: `tokenize()` expands `isAdmin` to all PERMISSIONS.)
  reports:    { name: 'Reports',    icon: 'mdi-file-chart',    color: '#8e24aa', path: '/reports/',  requiredPermission: 'reports.read', description: 'Reports & exports' },
  // Files (#7) — document ingest for the migration workflow. Gated on `admin.settings`
  // (admin-only in practice; `manager` carries no admin.* perms). Switch to `inventory.write`
  // to include managers + warehouse managers without a backfill.
  files:      { name: 'Files',      icon: 'mdi-folder-multiple', color: '#607d8b', path: '/files/',   requiredPermission: 'admin.settings', description: 'Document ingest, versions, audit' },
}

export const PLAN_APP_LIMITS: Record<string, number> = {
  free: 7,
  starter: 7,
  pro: 7,
  professional: 7,
  enterprise: 7,
}
