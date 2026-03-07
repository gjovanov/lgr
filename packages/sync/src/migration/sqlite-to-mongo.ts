import type { RepositoryRegistry, RepositoryKey } from 'dal'
import type { Database } from 'bun:sqlite'
import { IdMapper } from './id-mapper.js'
import type { MigrationResult, MigrationOptions } from './mongo-to-sqlite.js'

/**
 * Migration order for SQLite -> MongoDB (same order as forward migration).
 */
function getMigrationOrder(): Array<{ name: string; repoKey: RepositoryKey; fkTableMap: Record<string, string> }> {
  // Same as mongo-to-sqlite but IDs go in reverse direction
  return [
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
    { name: 'fiscal_periods', repoKey: 'fiscalPeriods', fkTableMap: { org_id: 'orgs', fiscal_year_id: 'fiscal_years' } },
    { name: 'employees', repoKey: 'employees', fkTableMap: { org_id: 'orgs', manager_id: 'employees' } },
    { name: 'stock_levels', repoKey: 'stockLevels', fkTableMap: { org_id: 'orgs', product_id: 'products', warehouse_id: 'warehouses' } },
    { name: 'bank_accounts', repoKey: 'bankAccounts', fkTableMap: { org_id: 'orgs', account_id: 'accounts' } },
    { name: 'price_lists', repoKey: 'priceLists', fkTableMap: { org_id: 'orgs' } },
    { name: 'bill_of_materials', repoKey: 'billOfMaterials', fkTableMap: { org_id: 'orgs', product_id: 'products' } },
    { name: 'invoices', repoKey: 'invoices', fkTableMap: { org_id: 'orgs', contact_id: 'contacts' } },
    { name: 'journal_entries', repoKey: 'journalEntries', fkTableMap: { org_id: 'orgs', fiscal_period_id: 'fiscal_periods' } },
    { name: 'stock_movements', repoKey: 'stockMovements', fkTableMap: { org_id: 'orgs' } },
    { name: 'payroll_runs', repoKey: 'payrollRuns', fkTableMap: { org_id: 'orgs' } },
    { name: 'payslips', repoKey: 'payslips', fkTableMap: { org_id: 'orgs', payroll_run_id: 'payroll_runs', employee_id: 'employees' } },
    { name: 'payment_orders', repoKey: 'paymentOrders', fkTableMap: { org_id: 'orgs', contact_id: 'contacts', bank_account_id: 'bank_accounts' } },
    { name: 'cash_orders', repoKey: 'cashOrders', fkTableMap: { org_id: 'orgs', account_id: 'accounts' } },
  ]
}

/**
 * Migrate all data for an org from SQLite to MongoDB.
 * Uses persisted _id_map to restore original MongoDB IDs where possible.
 */
export async function migrateSQLiteToMongo(
  sqliteRepos: RepositoryRegistry,
  mongoRepos: RepositoryRegistry,
  orgId: string,
  sqliteDb: Database,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const { onProgress, batchSize = 500 } = options
  const tables = getMigrationOrder()

  // Load existing ID map (may have been created during initial cloud->desktop migration)
  const idMap = new IdMapper()
  idMap.loadFromSQLite(sqliteDb)

  // For records without an existing mapping, generate new MongoDB ObjectId-like IDs
  const result: MigrationResult = { tables: {}, totalRows: 0, errors: [], idMap }

  for (const table of tables) {
    const sqliteRepo = sqliteRepos[table.repoKey]
    const mongoRepo = mongoRepos[table.repoKey]
    if (!sqliteRepo || !mongoRepo) continue

    try {
      let page = 0
      let tableCount = 0

      while (true) {
        const { items } = await sqliteRepo.findAll(
          { orgId } as any,
          { page, size: batchSize },
        )
        if (items.length === 0) break

        for (const item of items) {
          try {
            const sqliteId = item.id
            // Try to restore the original MongoDB ID
            let mongoId = idMap.getMongoId(table.name, sqliteId)
            if (!mongoId) {
              // Generate a new 24-char hex ID (MongoDB ObjectId format)
              mongoId = generateObjectIdLike()
              idMap.set(table.name, mongoId, sqliteId)
            }

            // Remap FKs (reverse: sqliteId -> mongoId)
            const remapped = remapEntityReverse(item as Record<string, unknown>, table.fkTableMap, idMap)
            remapped.id = mongoId

            await mongoRepo.create(remapped as any)
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

  // Persist updated ID map
  idMap.persistToSQLite(sqliteDb)

  return result
}

function remapEntityReverse(
  entity: Record<string, unknown>,
  fkTableMap: Record<string, string>,
  idMap: IdMapper,
): Record<string, unknown> {
  const remapped = { ...entity }
  for (const [field, value] of Object.entries(remapped)) {
    if (typeof value !== 'string') continue
    if (field === 'id') continue

    if (fkTableMap[field]) {
      const mongoId = idMap.getMongoId(fkTableMap[field], value)
      if (mongoId) remapped[field] = mongoId
    }
  }
  return remapped
}

function generateObjectIdLike(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}
