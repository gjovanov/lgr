import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestProduct, createTestContact } from '../helpers/factories'
import { createAuditEntry, diffChanges, queryAuditLogs, queryDistinctFilters, searchEntitiesByType, searchUsers } from 'services/biz/audit-log.service'
import { AuditLog } from 'db/models'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

async function waitForAudit(orgId: any, expectedCount: number, timeout = 2000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const count = await AuditLog.countDocuments({ orgId })
    if (count >= expectedCount) return
    await new Promise(r => setTimeout(r, 50))
  }
}

describe('Audit Log Service', () => {
  it('should create an audit log entry with entityName', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)

    createAuditEntry({
      orgId: String(org._id), userId: String(user._id),
      action: 'create', module: 'warehouse', entityType: 'product',
      entityId: String(org._id), entityName: 'Widget X',
    })

    await waitForAudit(org._id, 1)
    const logs = await AuditLog.find({ orgId: org._id }).lean()
    expect(logs).toHaveLength(1)
    expect(logs[0].action).toBe('create')
    expect((logs[0] as any).entityName).toBe('Widget X')
  })

  it('should store field-level changes and redact sensitive fields', async () => {
    const changes = diffChanges(
      { name: 'Old', sellingPrice: 100, category: 'A', password: 'secret1' },
      { name: 'New', sellingPrice: 120, category: 'A', password: 'secret2' },
    )

    expect(changes).toHaveLength(3)
    expect(changes[0]).toEqual({ field: 'name', oldValue: 'Old', newValue: 'New' })
    expect(changes[1]).toEqual({ field: 'sellingPrice', oldValue: 100, newValue: 120 })
    expect(changes[2]).toEqual({ field: 'password', oldValue: '[REDACTED]', newValue: '[REDACTED]' })
  })

  it('should query with multi-value filters', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)

    for (const [action, module] of [['create', 'warehouse'], ['update', 'warehouse'], ['create', 'invoicing'], ['delete', 'accounting']]) {
      createAuditEntry({ orgId: String(org._id), userId: String(user._id), action, module, entityType: 'test', entityId: String(org._id) })
    }
    await waitForAudit(org._id, 4)

    const byModules = await queryAuditLogs(String(org._id), { modules: ['warehouse', 'invoicing'] })
    expect(byModules.total).toBe(3)

    const byActions = await queryAuditLogs(String(org._id), { actions: ['create', 'delete'] })
    expect(byActions.total).toBe(3)
  })

  it('should return distinct filter values', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)

    createAuditEntry({ orgId: String(org._id), userId: String(user._id), action: 'create', module: 'warehouse', entityType: 'product', entityId: String(org._id) })
    createAuditEntry({ orgId: String(org._id), userId: String(user._id), action: 'update', module: 'invoicing', entityType: 'invoice', entityId: String(org._id) })
    await waitForAudit(org._id, 2)

    const filters = await queryDistinctFilters(String(org._id))
    expect(filters.modules).toContain('warehouse')
    expect(filters.modules).toContain('invoicing')
    expect(filters.actions).toContain('create')
    expect(filters.entityTypes).toContain('product')
  })

  it('should search entities by type', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { name: 'Alpha Widget' })
    await createTestProduct(org._id, { sku: 'B', name: 'Beta Widget' })

    const results = await searchEntitiesByType(String(org._id), 'product', 'Widget')
    expect(results.length).toBeGreaterThanOrEqual(2)
    expect(results[0].label).toContain('Widget')
  })

  it('should search users', async () => {
    const org = await createTestOrg()
    await createTestUser(org._id, { firstName: 'John', lastName: 'Doe', email: 'john@test.com', username: 'johndoe' })

    const results = await searchUsers(String(org._id), 'John')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].label).toContain('John')
  })

  it('should paginate results', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)

    for (let i = 0; i < 5; i++) {
      createAuditEntry({ orgId: String(org._id), userId: String(user._id), action: 'update', module: 'warehouse', entityType: 'product', entityId: String(org._id) })
    }
    await waitForAudit(org._id, 5)

    const page0 = await queryAuditLogs(String(org._id), { page: 0, size: 2 })
    expect(page0.auditLogs).toHaveLength(2)
    expect(page0.total).toBe(5)
    expect(page0.totalPages).toBe(3)
  })

  it('diffChanges should ignore metadata fields', () => {
    const changes = diffChanges(
      { _id: '123', id: '123', orgId: 'abc', createdAt: new Date(), name: 'A' },
      { _id: '123', id: '123', orgId: 'abc', createdAt: new Date(), name: 'B' },
    )
    expect(changes).toHaveLength(1)
    expect(changes[0].field).toBe('name')
  })

  it('should return empty for unknown entity type search', async () => {
    const org = await createTestOrg()
    const results = await searchEntitiesByType(String(org._id), 'nonexistent', 'test')
    expect(results).toHaveLength(0)
  })
})
