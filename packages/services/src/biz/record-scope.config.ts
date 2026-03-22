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
  sales: [
    { repoKey: 'salesOrders', filter: (uid) => ({ userId: uid }) },
    { repoKey: 'quotationTemplates', filter: () => ({}) },  // org-wide, no scoping
  ],
  purchase: [
    { repoKey: 'purchaseOrders', filter: (uid) => ({ userId: uid }) },
    { repoKey: 'blanketOrders', filter: (uid) => ({ createdBy: uid }) },
    { repoKey: 'reorderRules', filter: () => ({}) },  // org-wide
  ],
  project: [
    { repoKey: 'projects', filter: (uid) => ({ $or: [{ managerId: uid }, { memberIds: uid }, { createdBy: uid }] }) },
    { repoKey: 'projectTasks', filter: (uid) => ({ $or: [{ assigneeIds: uid }, { createdBy: uid }] }) },
    { repoKey: 'projectMilestones', filter: () => ({}) },  // scoped via project
    { repoKey: 'projectTimesheets', filter: (uid) => ({ employeeId: uid }) },
    { repoKey: 'fieldServiceTasks', filter: (uid) => ({ assigneeId: uid }) },
  ],
  helpdesk: [
    { repoKey: 'tickets', filter: (uid) => ({ $or: [{ assigneeId: uid }, { createdBy: uid }] }) },
    { repoKey: 'helpdeskTeams', filter: () => ({}) },  // org-wide
    { repoKey: 'slaPolicies', filter: () => ({}) },  // org-wide
    { repoKey: 'knowledgeArticles', filter: () => ({}) },  // org-wide (access via accessLevel)
  ],
  crm: [
    { repoKey: 'leads', filter: (uid) => ({ userId: uid }) },
    { repoKey: 'deals', filter: (uid) => ({ userId: uid }) },
    { repoKey: 'pipelines', filter: () => ({}) },  // org-wide
    { repoKey: 'activities', filter: (uid) => ({ userId: uid }) },
  ],
  payroll: [
    { repoKey: 'payrollRuns', filter: () => ({}) },  // org-wide (managers see all)
    { repoKey: 'payslips', filter: (uid) => ({ employeeId: uid }) },
    { repoKey: 'timesheets', filter: (uid) => ({ employeeId: uid }) },
  ],
  hr: [
    { repoKey: 'leaveRequests', filter: (uid) => ({ createdBy: uid }) },
    { repoKey: 'businessTrips', filter: (uid) => ({ createdBy: uid }) },
    { repoKey: 'employeeDocuments', filter: () => ({}) },  // org-wide
  ],
  documents: [
    { repoKey: 'documents', filter: (uid) => ({ $or: [{ ownerId: uid }, { accessLevel: { $ne: 'private' } }] }) },
    { repoKey: 'documentWorkspaces', filter: () => ({}) },  // org-wide
    { repoKey: 'signatureRequests', filter: (uid) => ({ createdBy: uid }) },
  ],
  subscriptions: [
    { repoKey: 'subscriptions', filter: (uid) => ({ createdBy: uid }) },
  ],
  planning: [
    { repoKey: 'shifts', filter: (uid) => ({ $or: [{ employeeId: uid }, { createdBy: uid }] }) },
    { repoKey: 'shiftTemplates', filter: () => ({}) },  // org-wide
    { repoKey: 'appointments', filter: (uid) => ({ assigneeId: uid }) },
    { repoKey: 'appointmentTypes', filter: () => ({}) },  // org-wide
  ],
  fleet: [
    { repoKey: 'vehicles', filter: (uid) => ({ driverId: uid }) },
    { repoKey: 'vehicleCosts', filter: () => ({}) },  // scoped via vehicle
  ],
  erp: [
    { repoKey: 'productionOrders', filter: (uid) => ({ createdBy: uid }) },
    // BOM, work centers, routings, ECOs, restaurant floors, kitchen orders — org-wide
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
