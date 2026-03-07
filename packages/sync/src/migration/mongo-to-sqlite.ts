import type { RepositoryRegistry, RepositoryKey } from 'dal'
import { IdMapper } from './id-mapper.js'
import { getParentTables } from '../change-tracker/table-registry.js'

export interface MigrationResult {
  tables: Record<string, number>
  totalRows: number
  errors: Array<{ table: string; id: string; error: string }>
  idMap: IdMapper
}

export interface MigrationOptions {
  onProgress?: (table: string, count: number, total: number) => void
  batchSize?: number
}

/**
 * Migration order respecting FK dependencies.
 * Independent tables first, highly dependent tables last.
 */
function getMigrationOrder(): Array<{ name: string; repoKey: RepositoryKey; fkTableMap: Record<string, string> }> {
  return [
    // Independent tables
    { name: 'orgs', repoKey: 'orgs', fkTableMap: { owner_id: 'users' } },
    { name: 'users', repoKey: 'users', fkTableMap: { org_id: 'orgs' } },
    { name: 'departments', repoKey: 'departments', fkTableMap: { org_id: 'orgs', parent_id: 'departments' } },
    { name: 'warehouses', repoKey: 'warehouses', fkTableMap: { org_id: 'orgs' } },
    { name: 'accounts', repoKey: 'accounts', fkTableMap: { org_id: 'orgs', parent_id: 'accounts' } },
    { name: 'contacts', repoKey: 'contacts', fkTableMap: { org_id: 'orgs' } },
    { name: 'products', repoKey: 'products', fkTableMap: { org_id: 'orgs' } },
    { name: 'leave_types', repoKey: 'leaveTypes', fkTableMap: { org_id: 'orgs' } },
    { name: 'pipelines', repoKey: 'pipelines', fkTableMap: { org_id: 'orgs' } },
    { name: 'fiscal_years', repoKey: 'fiscalYears', fkTableMap: { org_id: 'orgs' } },
    { name: 'exchange_rates', repoKey: 'exchangeRates', fkTableMap: { org_id: 'orgs' } },
    { name: 'tags', repoKey: 'tags', fkTableMap: { org_id: 'orgs' } },

    // First-level dependents
    { name: 'fiscal_periods', repoKey: 'fiscalPeriods', fkTableMap: { org_id: 'orgs', fiscal_year_id: 'fiscal_years' } },
    { name: 'employees', repoKey: 'employees', fkTableMap: { org_id: 'orgs', manager_id: 'employees' } },
    { name: 'stock_levels', repoKey: 'stockLevels', fkTableMap: { org_id: 'orgs', product_id: 'products', warehouse_id: 'warehouses' } },
    { name: 'bank_accounts', repoKey: 'bankAccounts', fkTableMap: { org_id: 'orgs', account_id: 'accounts' } },
    { name: 'price_lists', repoKey: 'priceLists', fkTableMap: { org_id: 'orgs' } },
    { name: 'bill_of_materials', repoKey: 'billOfMaterials', fkTableMap: { org_id: 'orgs', product_id: 'products' } },
    { name: 'org_apps', repoKey: 'orgApps', fkTableMap: { org_id: 'orgs' } },
    { name: 'invites', repoKey: 'invites', fkTableMap: { org_id: 'orgs' } },
    { name: 'leads', repoKey: 'leads', fkTableMap: { org_id: 'orgs' } },
    { name: 'activities', repoKey: 'activities', fkTableMap: { org_id: 'orgs', contact_id: 'contacts', deal_id: 'deals', lead_id: 'leads' } },

    // Second-level dependents
    { name: 'leave_balances', repoKey: 'leaveBalances', fkTableMap: { org_id: 'orgs', employee_id: 'employees', leave_type_id: 'leave_types' } },
    { name: 'leave_requests', repoKey: 'leaveRequests', fkTableMap: { org_id: 'orgs', employee_id: 'employees', leave_type_id: 'leave_types' } },
    { name: 'business_trips', repoKey: 'businessTrips', fkTableMap: { org_id: 'orgs', employee_id: 'employees' } },
    { name: 'employee_documents', repoKey: 'employeeDocuments', fkTableMap: { org_id: 'orgs', employee_id: 'employees' } },
    { name: 'timesheets', repoKey: 'timesheets', fkTableMap: { org_id: 'orgs', employee_id: 'employees' } },
    { name: 'bank_reconciliations', repoKey: 'bankReconciliations', fkTableMap: { org_id: 'orgs', bank_account_id: 'bank_accounts' } },
    { name: 'fixed_assets', repoKey: 'fixedAssets', fkTableMap: { org_id: 'orgs', account_id: 'accounts' } },
    { name: 'tax_returns', repoKey: 'taxReturns', fkTableMap: { org_id: 'orgs' } },
    { name: 'pos_sessions', repoKey: 'posSessions', fkTableMap: { org_id: 'orgs', warehouse_id: 'warehouses' } },
    { name: 'deals', repoKey: 'deals', fkTableMap: { org_id: 'orgs', contact_id: 'contacts', pipeline_id: 'pipelines' } },
    { name: 'construction_projects', repoKey: 'constructionProjects', fkTableMap: { org_id: 'orgs' } },
    { name: 'production_orders', repoKey: 'productionOrders', fkTableMap: { org_id: 'orgs', bom_id: 'bill_of_materials', product_id: 'products', warehouse_id: 'warehouses' } },

    // Highly dependent tables
    { name: 'journal_entries', repoKey: 'journalEntries', fkTableMap: { org_id: 'orgs', fiscal_period_id: 'fiscal_periods' } },
    { name: 'invoices', repoKey: 'invoices', fkTableMap: { org_id: 'orgs', contact_id: 'contacts' } },
    { name: 'stock_movements', repoKey: 'stockMovements', fkTableMap: { org_id: 'orgs', from_warehouse_id: 'warehouses', to_warehouse_id: 'warehouses' } },
    { name: 'payroll_runs', repoKey: 'payrollRuns', fkTableMap: { org_id: 'orgs' } },
    { name: 'payslips', repoKey: 'payslips', fkTableMap: { org_id: 'orgs', payroll_run_id: 'payroll_runs', employee_id: 'employees' } },
    { name: 'payment_orders', repoKey: 'paymentOrders', fkTableMap: { org_id: 'orgs', contact_id: 'contacts', bank_account_id: 'bank_accounts' } },
    { name: 'cash_orders', repoKey: 'cashOrders', fkTableMap: { org_id: 'orgs', account_id: 'accounts' } },
    { name: 'pos_transactions', repoKey: 'posTransactions', fkTableMap: { org_id: 'orgs', session_id: 'pos_sessions' } },
    { name: 'inventory_counts', repoKey: 'inventoryCounts', fkTableMap: { org_id: 'orgs', warehouse_id: 'warehouses' } },

    // Remaining
    { name: 'codes', repoKey: 'codes', fkTableMap: { org_id: 'orgs' } },
    { name: 'audit_logs', repoKey: 'auditLogs', fkTableMap: { org_id: 'orgs' } },
    { name: 'files', repoKey: 'files', fkTableMap: { org_id: 'orgs' } },
    { name: 'notifications', repoKey: 'notifications', fkTableMap: { org_id: 'orgs' } },
    { name: 'background_tasks', repoKey: 'backgroundTasks', fkTableMap: { org_id: 'orgs' } },
    { name: 'email_logs', repoKey: 'emailLogs', fkTableMap: { org_id: 'orgs' } },
  ]
}

/**
 * Migrate all data for an org from MongoDB to SQLite.
 * Remaps all IDs using the IdMapper.
 */
export async function migrateMongoToSQLite(
  mongoRepos: RepositoryRegistry,
  sqliteRepos: RepositoryRegistry,
  orgId: string,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const { onProgress, batchSize = 500 } = options
  const tables = getMigrationOrder()
  const idMap = new IdMapper()
  const result: MigrationResult = { tables: {}, totalRows: 0, errors: [], idMap }

  for (const table of tables) {
    const mongoRepo = mongoRepos[table.repoKey]
    const sqliteRepo = sqliteRepos[table.repoKey]
    if (!mongoRepo || !sqliteRepo) continue

    try {
      // Fetch all records for this org
      let page = 0
      let tableCount = 0

      while (true) {
        const { items } = await mongoRepo.findAll(
          { orgId } as any,
          { page, size: batchSize },
        )
        if (items.length === 0) break

        for (const item of items) {
          try {
            const mongoId = item.id
            const sqliteId = crypto.randomUUID()
            idMap.set(table.name, mongoId, sqliteId)

            // Remap FKs
            const remapped = idMap.remapEntity(item as Record<string, unknown>, table.fkTableMap)
            remapped.id = sqliteId

            await sqliteRepo.create(remapped as any)
            tableCount++
          } catch (err: any) {
            result.errors.push({ table: table.name, id: item.id, error: err.message })
          }
        }

        page++
        if (items.length < batchSize) break
      }

      result.tables[table.name] = tableCount
      result.totalRows += tableCount
      onProgress?.(table.name, tableCount, result.totalRows)
    } catch (err: any) {
      result.errors.push({ table: table.name, id: '', error: err.message })
    }
  }

  return result
}
