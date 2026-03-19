import type { DalConfig, RepositoryRegistry } from 'dal'
import { openDatabase } from './connection.js'
import { runMigrations } from './migrations/runner.js'
import { SQLiteRepository, type ChildTableConfig } from './base.repository.js'

export { SQLiteRepository, type ChildTableConfig } from './base.repository.js'
export { openDatabase, closeDatabase, getDatabase } from './connection.js'
export { runMigrations } from './migrations/runner.js'
export { toRow, toEntity } from './entity-mapper.js'
export { translateFilter, toSnakeCase } from './filter-translator.js'

// ── Child table configs for entities with embedded arrays ──

const invoiceChildren: ChildTableConfig[] = [
  { tableName: 'invoice_lines', parentFk: 'invoice_id', entityField: 'lines' },
  { tableName: 'invoice_payments', parentFk: 'invoice_id', entityField: 'payments' },
]

const journalEntryChildren: ChildTableConfig[] = [
  { tableName: 'journal_entry_lines', parentFk: 'journal_entry_id', entityField: 'lines' },
]

const stockMovementChildren: ChildTableConfig[] = [
  { tableName: 'stock_movement_lines', parentFk: 'movement_id', entityField: 'lines' },
]

const inventoryCountChildren: ChildTableConfig[] = [
  { tableName: 'inventory_count_lines', parentFk: 'inventory_count_id', entityField: 'lines' },
]

const priceListChildren: ChildTableConfig[] = [
  { tableName: 'price_list_items', parentFk: 'price_list_id', entityField: 'items' },
]

const contactChildren: ChildTableConfig[] = [
  { tableName: 'contact_addresses', parentFk: 'contact_id', entityField: 'addresses' },
  { tableName: 'contact_bank_details', parentFk: 'contact_id', entityField: 'bankDetails' },
]

const fixedAssetChildren: ChildTableConfig[] = [
  { tableName: 'fixed_asset_depreciation', parentFk: 'fixed_asset_id', entityField: 'depreciationSchedule' },
]

const bankReconciliationChildren: ChildTableConfig[] = [
  { tableName: 'bank_reconciliation_items', parentFk: 'reconciliation_id', entityField: 'items' },
]

const taxReturnChildren: ChildTableConfig[] = [
  { tableName: 'tax_return_lines', parentFk: 'tax_return_id', entityField: 'lines' },
]

const payrollRunChildren: ChildTableConfig[] = [
  { tableName: 'payroll_run_items', parentFk: 'payroll_run_id', entityField: 'items' },
]

const payslipChildren: ChildTableConfig[] = [
  { tableName: 'payslip_earnings', parentFk: 'payslip_id', entityField: 'earnings' },
  { tableName: 'payslip_deductions', parentFk: 'payslip_id', entityField: 'deductions' },
]

const employeeChildren: ChildTableConfig[] = [
  { tableName: 'employee_deductions', parentFk: 'employee_id', entityField: 'deductions' },
  { tableName: 'employee_benefits', parentFk: 'employee_id', entityField: 'benefits' },
]

const pipelineChildren: ChildTableConfig[] = [
  { tableName: 'pipeline_stages', parentFk: 'pipeline_id', entityField: 'stages' },
]

const dealChildren: ChildTableConfig[] = [
  { tableName: 'deal_products', parentFk: 'deal_id', entityField: 'products' },
]

const bomChildren: ChildTableConfig[] = [
  { tableName: 'bom_materials', parentFk: 'bom_id', entityField: 'materials' },
]

const productionOrderChildren: ChildTableConfig[] = [
  { tableName: 'production_stages', parentFk: 'production_order_id', entityField: 'stages' },
  { tableName: 'materials_consumed', parentFk: 'production_order_id', entityField: 'materialsConsumed' },
]

const constructionProjectChildren: ChildTableConfig[] = [
  { tableName: 'construction_phases', parentFk: 'project_id', entityField: 'phases' },
  { tableName: 'construction_team_members', parentFk: 'project_id', entityField: 'team' },
  { tableName: 'construction_materials', parentFk: 'project_id', entityField: 'materials' },
]

const posTransactionChildren: ChildTableConfig[] = [
  { tableName: 'pos_transaction_lines', parentFk: 'transaction_id', entityField: 'lines' },
  { tableName: 'pos_transaction_payments', parentFk: 'transaction_id', entityField: 'payments' },
]

const businessTripChildren: ChildTableConfig[] = [
  { tableName: 'business_trip_expenses', parentFk: 'trip_id', entityField: 'expenses' },
]

const productChildren: ChildTableConfig[] = [
  { tableName: 'product_custom_prices', parentFk: 'product_id', entityField: 'customPrices' },
  { tableName: 'product_tag_prices', parentFk: 'product_id', entityField: 'tagPrices' },
  { tableName: 'product_variants', parentFk: 'product_id', entityField: 'variants' },
]

/**
 * Create a complete RepositoryRegistry backed by SQLite (bun:sqlite).
 */
export async function createSQLiteRepositories(config: DalConfig): Promise<RepositoryRegistry> {
  const dbPath = config.sqlitePath || ':memory:'
  const db = openDatabase(dbPath)
  runMigrations(db)

  return {
    // Core (no child tables — JSON columns for embedded objects)
    orgs: new SQLiteRepository(db, 'orgs'),
    users: new SQLiteRepository(db, 'users'),
    invites: new SQLiteRepository(db, 'invites'),
    codes: new SQLiteRepository(db, 'codes'),
    emailLogs: new SQLiteRepository(db, 'email_logs'),
    auditLogs: new SQLiteRepository(db, 'audit_logs'),
    files: new SQLiteRepository(db, 'files'),
    notifications: new SQLiteRepository(db, 'notifications'),
    backgroundTasks: new SQLiteRepository(db, 'background_tasks'),
    orgApps: new SQLiteRepository(db, 'org_apps'),
    tags: new SQLiteRepository(db, 'tags'),

    // Accounting
    accounts: new SQLiteRepository(db, 'accounts'),
    fiscalYears: new SQLiteRepository(db, 'fiscal_years'),
    fiscalPeriods: new SQLiteRepository(db, 'fiscal_periods'),
    journalEntries: new SQLiteRepository(db, 'journal_entries', journalEntryChildren),
    fixedAssets: new SQLiteRepository(db, 'fixed_assets', fixedAssetChildren),
    bankAccounts: new SQLiteRepository(db, 'bank_accounts'),
    bankReconciliations: new SQLiteRepository(db, 'bank_reconciliations', bankReconciliationChildren),
    taxReturns: new SQLiteRepository(db, 'tax_returns', taxReturnChildren),
    exchangeRates: new SQLiteRepository(db, 'exchange_rates'),

    // Invoicing
    contacts: new SQLiteRepository(db, 'contacts', contactChildren),
    invoices: new SQLiteRepository(db, 'invoices', invoiceChildren),
    paymentOrders: new SQLiteRepository(db, 'payment_orders'),
    cashOrders: new SQLiteRepository(db, 'cash_orders'),

    // Warehouse
    products: new SQLiteRepository(db, 'products', productChildren),
    warehouses: new SQLiteRepository(db, 'warehouses'),
    stockLevels: new SQLiteRepository(db, 'stock_levels'),
    stockMovements: new SQLiteRepository(db, 'stock_movements', stockMovementChildren),
    inventoryCounts: new SQLiteRepository(db, 'inventory_counts', inventoryCountChildren),
    priceLists: new SQLiteRepository(db, 'price_lists', priceListChildren),
    costLayers: new SQLiteRepository(db, 'cost_layers', [
      { tableName: 'cost_layer_serial_numbers', parentFk: 'cost_layer_id', entityField: 'serialNumbers' },
    ]),
    productCategories: new SQLiteRepository(db, 'product_categories'),

    // Payroll
    employees: new SQLiteRepository(db, 'employees', employeeChildren),
    payrollRuns: new SQLiteRepository(db, 'payroll_runs', payrollRunChildren),
    payslips: new SQLiteRepository(db, 'payslips', payslipChildren),
    timesheets: new SQLiteRepository(db, 'timesheets'),

    // HR
    departments: new SQLiteRepository(db, 'departments'),
    leaveTypes: new SQLiteRepository(db, 'leave_types'),
    leaveRequests: new SQLiteRepository(db, 'leave_requests'),
    leaveBalances: new SQLiteRepository(db, 'leave_balances'),
    businessTrips: new SQLiteRepository(db, 'business_trips', businessTripChildren),
    employeeDocuments: new SQLiteRepository(db, 'employee_documents'),

    // CRM
    leads: new SQLiteRepository(db, 'leads'),
    deals: new SQLiteRepository(db, 'deals', dealChildren),
    pipelines: new SQLiteRepository(db, 'pipelines', pipelineChildren),
    activities: new SQLiteRepository(db, 'activities'),

    // ERP
    billOfMaterials: new SQLiteRepository(db, 'bill_of_materials', bomChildren),
    productionOrders: new SQLiteRepository(db, 'production_orders', productionOrderChildren),
    constructionProjects: new SQLiteRepository(db, 'construction_projects', constructionProjectChildren),
    posSessions: new SQLiteRepository(db, 'pos_sessions'),
    posTransactions: new SQLiteRepository(db, 'pos_transactions', posTransactionChildren),
  }
}
