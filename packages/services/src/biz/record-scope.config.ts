/**
 * Record Scope Configuration
 *
 * Maps module names to entity repository keys and their ownership fields.
 * When a user has `ownRecordsOnly=true` for a module, all queries on
 * these entities are automatically filtered by the ownership field.
 *
 * Entities not listed here are "org-wide" — no record scoping applies.
 * (e.g., Account, Product, Warehouse, ProductCategory, PriceList)
 */

export interface RecordScopeSpec {
  repoKey: string          // Key in RepositoryRegistry
  filter: (userId: string) => Record<string, any>
}

export const RECORD_SCOPE_CONFIG: Record<string, RecordScopeSpec[]> = {
  payroll: [
    { repoKey: 'payrollRuns', filter: () => ({}) },  // org-wide (managers see all)
    { repoKey: 'payslips', filter: (uid) => ({ employeeId: uid }) },
    { repoKey: 'timesheets', filter: (uid) => ({ employeeId: uid }) },
  ],
}

/**
 * Get the record scope filter for a specific repo key and user.
 * Returns null if no scoping applies (org-wide entity or module not scoped).
 */
export function getRecordScopeFilter(
  ownRecordsModules: string[],
  repoKey: string,
  userId: string,
): Record<string, any> | null {
  for (const module of ownRecordsModules) {
    const specs = RECORD_SCOPE_CONFIG[module]
    if (!specs) continue
    const spec = specs.find(s => s.repoKey === repoKey)
    if (spec) {
      const filter = spec.filter(userId)
      if (Object.keys(filter).length > 0) return filter
    }
  }
  return null
}
