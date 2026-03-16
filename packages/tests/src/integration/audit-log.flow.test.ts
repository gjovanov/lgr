import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestProduct, createTestContact } from '../helpers/factories'
import { createAuditEntry, diffChanges, queryAuditLogs } from 'services/biz/audit-log.service'
import { AuditLog } from 'db/models'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

describe('Audit Log Service', () => {
  it('should create an audit log entry', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)

    createAuditEntry({
      orgId: String(org._id),
      userId: String(user._id),
      action: 'create',
      module: 'warehouse',
      entityType: 'product',
      entityId: String(org._id),
    })

    // Wait for fire-and-forget write
    await new Promise(r => setTimeout(r, 200))

    const logs = await AuditLog.find({ orgId: org._id }).lean()
    expect(logs).toHaveLength(1)
    expect(logs[0].action).toBe('create')
    expect(logs[0].module).toBe('warehouse')
    expect(logs[0].entityType).toBe('product')
  })

  it('should store field-level changes', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)

    const changes = diffChanges(
      { name: 'Old Name', sellingPrice: 100, category: 'A' },
      { name: 'New Name', sellingPrice: 120, category: 'A' },
    )

    expect(changes).toHaveLength(2)
    expect(changes[0]).toEqual({ field: 'name', oldValue: 'Old Name', newValue: 'New Name' })
    expect(changes[1]).toEqual({ field: 'sellingPrice', oldValue: 100, newValue: 120 })

    createAuditEntry({
      orgId: String(org._id),
      userId: String(user._id),
      action: 'update',
      module: 'warehouse',
      entityType: 'product',
      entityId: String(org._id),
      changes,
    })

    await new Promise(r => setTimeout(r, 200))

    const logs = await AuditLog.find({ orgId: org._id }).lean()
    expect(logs[0].changes).toHaveLength(2)
    expect(logs[0].changes![0].field).toBe('name')
  })

  it('should query audit logs with filters', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)

    // Create multiple entries
    for (const action of ['create', 'update', 'delete']) {
      createAuditEntry({
        orgId: String(org._id),
        userId: String(user._id),
        action,
        module: 'warehouse',
        entityType: 'product',
        entityId: String(org._id),
      })
    }
    createAuditEntry({
      orgId: String(org._id),
      userId: String(user._id),
      action: 'create',
      module: 'invoicing',
      entityType: 'invoice',
      entityId: String(org._id),
    })

    await new Promise(r => setTimeout(r, 300))

    // Query all
    const all = await queryAuditLogs(String(org._id))
    expect(all.total).toBe(4)

    // Filter by module
    const warehouseOnly = await queryAuditLogs(String(org._id), { module: 'warehouse' })
    expect(warehouseOnly.total).toBe(3)

    // Filter by action
    const creates = await queryAuditLogs(String(org._id), { action: 'create' })
    expect(creates.total).toBe(2)

    // Filter by entity type
    const invoices = await queryAuditLogs(String(org._id), { entityType: 'invoice' })
    expect(invoices.total).toBe(1)
  })

  it('should paginate results', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)

    for (let i = 0; i < 5; i++) {
      createAuditEntry({
        orgId: String(org._id),
        userId: String(user._id),
        action: 'update',
        module: 'warehouse',
        entityType: 'product',
        entityId: String(org._id),
      })
    }

    await new Promise(r => setTimeout(r, 300))

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
})
