import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { getRepos } from 'services/context'
import { buildScopedRepos } from 'services/biz/scoped-repos'
import { getRecordScopeFilter, RECORD_SCOPE_CONFIG } from 'services/biz/record-scope.config'
import { getNextNumber } from 'services/biz/sequence.service'

let repos: ReturnType<typeof getRepos>

beforeAll(async () => {
  await setupTestDB()
  repos = getRepos()
})

afterAll(async () => {
  await teardownTestDB()
})

beforeEach(async () => {
  await clearCollections()
})

describe('Record Scope Config', () => {
  it('returns filter for scoped module', () => {
    const filter = getRecordScopeFilter(['sales'], 'salesOrders', 'user123')
    expect(filter).toEqual({ userId: 'user123' })
  })

  it('returns null for org-wide entity', () => {
    const filter = getRecordScopeFilter(['sales'], 'quotationTemplates', 'user123')
    expect(filter).toBeNull()
  })

  it('returns null when module not in ownRecordsModules', () => {
    const filter = getRecordScopeFilter(['purchase'], 'salesOrders', 'user123')
    expect(filter).toBeNull()
  })

  it('returns null for empty ownRecordsModules', () => {
    const filter = getRecordScopeFilter([], 'salesOrders', 'user123')
    expect(filter).toBeNull()
  })

  it('handles $or filter for project tasks', () => {
    const filter = getRecordScopeFilter(['project'], 'projectTasks', 'user123')
    expect(filter).toHaveProperty('$or')
    expect(filter!.$or).toHaveLength(2)
  })
})

describe('Scoped Repository', () => {
  it('filters sales orders by userId when scoped', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    const user1 = '000000000000000000000001'
    const user2 = '000000000000000000000002'

    // Create 2 sales orders, one per user
    const name1 = await getNextNumber(orgId, 'SO')
    await repos.salesOrders.create({
      orgId, name: name1, state: 'draft', partnerId: orgId, currency: 'EUR', exchangeRate: 1,
      lines: [], amountUntaxed: 0, amountTax: 0, amountTotal: 0,
      invoiceStatus: 'nothing', deliveryStatus: 'pending',
      invoiceIds: [], movementIds: [], requireSignature: false, requirePayment: false,
      userId: user1, createdBy: user1,
    } as any)

    const name2 = await getNextNumber(orgId, 'SO')
    await repos.salesOrders.create({
      orgId, name: name2, state: 'draft', partnerId: orgId, currency: 'EUR', exchangeRate: 1,
      lines: [], amountUntaxed: 0, amountTax: 0, amountTotal: 0,
      invoiceStatus: 'nothing', deliveryStatus: 'pending',
      invoiceIds: [], movementIds: [], requireSignature: false, requirePayment: false,
      userId: user2, createdBy: user2,
    } as any)

    // Unscoped: both visible
    const all = await repos.salesOrders.findMany({ orgId } as any)
    expect(all).toHaveLength(2)

    // Scoped as user1: only their order visible
    const scoped1 = buildScopedRepos(['sales'], user1, repos)
    const user1Orders = await scoped1.salesOrders.findMany({ orgId } as any)
    expect(user1Orders).toHaveLength(1)
    expect(user1Orders[0].userId).toBe(user1)

    // Scoped as user2: only their order visible
    const scoped2 = buildScopedRepos(['sales'], user2, repos)
    const user2Orders = await scoped2.salesOrders.findMany({ orgId } as any)
    expect(user2Orders).toHaveLength(1)
    expect(user2Orders[0].userId).toBe(user2)
  })

  it('does not scope when ownRecordsModules is empty', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)

    await repos.salesOrders.create({
      orgId, name: await getNextNumber(orgId, 'SO'), state: 'draft', partnerId: orgId,
      currency: 'EUR', exchangeRate: 1, lines: [], amountUntaxed: 0, amountTax: 0, amountTotal: 0,
      invoiceStatus: 'nothing', deliveryStatus: 'pending', invoiceIds: [], movementIds: [],
      requireSignature: false, requirePayment: false,
      userId: '000000000000000000000001', createdBy: '000000000000000000000001',
    } as any)

    const scoped = buildScopedRepos([], '000000000000000000000099', repos)
    const orders = await scoped.salesOrders.findMany({ orgId } as any)
    expect(orders).toHaveLength(1) // No scoping, sees all
  })

  it('scoped findById returns null for other users record', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    const user1 = '000000000000000000000001'
    const user2 = '000000000000000000000002'

    const order = await repos.salesOrders.create({
      orgId, name: await getNextNumber(orgId, 'SO'), state: 'draft', partnerId: orgId,
      currency: 'EUR', exchangeRate: 1, lines: [], amountUntaxed: 0, amountTax: 0, amountTotal: 0,
      invoiceStatus: 'nothing', deliveryStatus: 'pending', invoiceIds: [], movementIds: [],
      requireSignature: false, requirePayment: false,
      userId: user1, createdBy: user1,
    } as any)

    // User1 can see it
    const scoped1 = buildScopedRepos(['sales'], user1, repos)
    const found1 = await scoped1.salesOrders.findById(order.id)
    expect(found1).not.toBeNull()

    // User2 cannot see it
    const scoped2 = buildScopedRepos(['sales'], user2, repos)
    const found2 = await scoped2.salesOrders.findById(order.id)
    expect(found2).toBeNull()
  })

  it('scoped update returns null for other users record', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)

    const order = await repos.salesOrders.create({
      orgId, name: await getNextNumber(orgId, 'SO'), state: 'draft', partnerId: orgId,
      currency: 'EUR', exchangeRate: 1, lines: [], amountUntaxed: 0, amountTax: 0, amountTotal: 0,
      invoiceStatus: 'nothing', deliveryStatus: 'pending', invoiceIds: [], movementIds: [],
      requireSignature: false, requirePayment: false,
      userId: '000000000000000000000001', createdBy: '000000000000000000000001',
    } as any)

    // Another user cannot update
    const scoped = buildScopedRepos(['sales'], '000000000000000000000002', repos)
    const updated = await scoped.salesOrders.update(order.id, { notes: 'hacked' } as any)
    expect(updated).toBeNull()

    // Original is unchanged
    const original = await repos.salesOrders.findById(order.id)
    expect(original!.notes).toBeUndefined()
  })

  it('scoped delete returns false for other users record', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)

    const order = await repos.salesOrders.create({
      orgId, name: await getNextNumber(orgId, 'SO'), state: 'draft', partnerId: orgId,
      currency: 'EUR', exchangeRate: 1, lines: [], amountUntaxed: 0, amountTax: 0, amountTotal: 0,
      invoiceStatus: 'nothing', deliveryStatus: 'pending', invoiceIds: [], movementIds: [],
      requireSignature: false, requirePayment: false,
      userId: '000000000000000000000001', createdBy: '000000000000000000000001',
    } as any)

    const scoped = buildScopedRepos(['sales'], '000000000000000000000002', repos)
    const deleted = await scoped.salesOrders.delete(order.id)
    expect(deleted).toBe(false)

    // Still exists
    const check = await repos.salesOrders.findById(order.id)
    expect(check).not.toBeNull()
  })

  it('helpdesk tickets scoped by assigneeId OR createdBy', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    const agent1 = '000000000000000000000001'
    const agent2 = '000000000000000000000002'

    // Ticket assigned to agent1
    await repos.tickets.create({
      orgId, name: await getNextNumber(orgId, 'TKT'), description: 'test',
      channelSource: 'manual', stageName: 'New', state: 'new', priority: 'normal',
      slaStatus: 'on_track', totalHours: 0,
      assigneeId: agent1, createdBy: agent2,  // created by agent2 but assigned to agent1
    } as any)

    // Ticket created by agent1 (not assigned)
    await repos.tickets.create({
      orgId, name: await getNextNumber(orgId, 'TKT'), description: 'test2',
      channelSource: 'manual', stageName: 'New', state: 'new', priority: 'normal',
      slaStatus: 'on_track', totalHours: 0,
      createdBy: agent1,  // no assignee
    } as any)

    // Ticket for agent2 only
    await repos.tickets.create({
      orgId, name: await getNextNumber(orgId, 'TKT'), description: 'test3',
      channelSource: 'manual', stageName: 'New', state: 'new', priority: 'normal',
      slaStatus: 'on_track', totalHours: 0,
      assigneeId: agent2, createdBy: agent2,
    } as any)

    // Agent1 sees 2 tickets (assigned + created)
    const scoped1 = buildScopedRepos(['helpdesk'], agent1, repos)
    const tickets1 = await scoped1.tickets.findMany({ orgId } as any)
    expect(tickets1).toHaveLength(2)

    // Agent2 sees 2 tickets (assigned + created, one is both)
    const scoped2 = buildScopedRepos(['helpdesk'], agent2, repos)
    const tickets2 = await scoped2.tickets.findMany({ orgId } as any)
    expect(tickets2).toHaveLength(2)
  })
})
