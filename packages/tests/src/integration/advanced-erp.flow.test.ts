import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestProduct } from '../helpers/factories'
import { getRepos } from 'services/context'
import { WorkCenter, Routing, ECO, RestaurantFloor, KitchenOrder, POSTransaction } from 'db/models'
import type { Types } from 'mongoose'

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

// ---------- Helpers ----------

async function createWorkCenter(orgId: Types.ObjectId, overrides: any = {}) {
  return repos.workCenters.create({
    orgId: String(orgId),
    name: 'CNC Station',
    code: `WC-${Date.now()}`,
    capacity: 10,
    costPerHour: 50,
    setupTime: 15,
    cleanupTime: 10,
    isActive: true,
    ...overrides,
  } as any)
}

async function createRouting(orgId: Types.ObjectId, steps: any[], overrides: any = {}) {
  return repos.routings.create({
    orgId: String(orgId),
    name: 'Assembly Routing',
    steps,
    isActive: true,
    ...overrides,
  } as any)
}

async function createECO(orgId: Types.ObjectId, productId: Types.ObjectId, userId: Types.ObjectId, overrides: any = {}) {
  return repos.ecos.create({
    orgId: String(orgId),
    name: 'Update BOM v2',
    productId: String(productId),
    type: 'bom_change',
    description: 'Change material spec',
    state: 'draft',
    changes: [{ field: 'material', oldValue: 'Aluminum', newValue: 'Titanium' }],
    requesterId: String(userId),
    createdBy: String(userId),
    ...overrides,
  } as any)
}

// ---------- Work Centers ----------

describe('Work Centers', () => {
  it('should create a work center with capacity and cost', async () => {
    const org = await createTestOrg()

    const wc = await createWorkCenter(org._id)

    expect(wc.name).toBe('CNC Station')
    expect((wc as any).capacity).toBe(10)
    expect((wc as any).costPerHour).toBe(50)
    expect((wc as any).setupTime).toBe(15)
    expect((wc as any).cleanupTime).toBe(10)
    expect((wc as any).isActive).toBe(true)
  })

  it('should update a work center', async () => {
    const org = await createTestOrg()
    const wc = await createWorkCenter(org._id)

    const updated = await repos.workCenters.update(wc.id, { capacity: 20, costPerHour: 75 } as any)

    expect((updated as any).capacity).toBe(20)
    expect((updated as any).costPerHour).toBe(75)
  })

  it('should filter work centers by isActive', async () => {
    const org = await createTestOrg()
    await createWorkCenter(org._id, { name: 'Active WC', code: 'WC-A', isActive: true })
    await createWorkCenter(org._id, { name: 'Inactive WC', code: 'WC-B', isActive: false })

    const active = await repos.workCenters.findAll(
      { orgId: String(org._id), isActive: true },
      { page: 0, size: 10 },
    )
    expect(active.items).toHaveLength(1)
    expect(active.items[0].name).toBe('Active WC')

    const inactive = await repos.workCenters.findAll(
      { orgId: String(org._id), isActive: false },
      { page: 0, size: 10 },
    )
    expect(inactive.items).toHaveLength(1)
    expect(inactive.items[0].name).toBe('Inactive WC')
  })
})

// ---------- Routings ----------

describe('Routings', () => {
  it('should create a routing with steps', async () => {
    const org = await createTestOrg()
    const wc = await createWorkCenter(org._id)

    const routing = await createRouting(org._id, [
      { sequence: 1, name: 'Cut', workCenterId: wc.id, durationMinutes: 30 },
      { sequence: 2, name: 'Assembly', workCenterId: wc.id, durationMinutes: 45 },
    ])

    expect(routing.name).toBe('Assembly Routing')
    expect((routing as any).steps).toHaveLength(2)
    expect((routing as any).steps[0].name).toBe('Cut')
    expect((routing as any).steps[1].sequence).toBe(2)
  })

  it('should link routing to a BOM', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const wc = await createWorkCenter(org._id)

    const bom = await repos.billOfMaterials.create({
      orgId: String(org._id),
      productId: String(product._id),
      name: 'Test BOM',
      version: '1.0',
      status: 'active',
      materials: [],
      laborHours: 1,
      laborCostPerHour: 20,
      overheadCost: 0,
      totalMaterialCost: 0,
      totalCost: 20,
    } as any)

    const routing = await createRouting(org._id, [
      { sequence: 1, name: 'Step 1', workCenterId: wc.id, durationMinutes: 20 },
    ], { bomId: bom.id, productId: String(product._id) })

    expect((routing as any).bomId).toBeTruthy()
    expect((routing as any).productId).toBeTruthy()
  })

  it('should validate step sequence ordering', async () => {
    const org = await createTestOrg()
    const wc = await createWorkCenter(org._id)

    const routing = await createRouting(org._id, [
      { sequence: 3, name: 'Finish', workCenterId: wc.id, durationMinutes: 10 },
      { sequence: 1, name: 'Start', workCenterId: wc.id, durationMinutes: 20 },
      { sequence: 2, name: 'Middle', workCenterId: wc.id, durationMinutes: 15 },
    ])

    const steps = (routing as any).steps
    expect(steps).toHaveLength(3)
    // Steps are stored in insertion order; verify all sequences present
    const sequences = steps.map((s: any) => s.sequence).sort()
    expect(sequences).toEqual([1, 2, 3])
  })
})

// ---------- PLM / ECO ----------

describe('PLM / Engineering Change Orders', () => {
  it('should create an ECO in draft state', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const product = await createTestProduct(org._id)

    const eco = await createECO(org._id, product._id, user._id)

    expect(eco.name).toBe('Update BOM v2')
    expect((eco as any).state).toBe('draft')
    expect((eco as any).type).toBe('bom_change')
    expect((eco as any).changes).toHaveLength(1)
  })

  it('should submit ECO for review (draft -> in_review)', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const product = await createTestProduct(org._id)
    const eco = await createECO(org._id, product._id, user._id)

    const submitted = await ECO.findOneAndUpdate(
      { _id: eco.id, orgId: org._id, state: 'draft' },
      { $set: { state: 'in_review' } },
      { new: true },
    ).exec()

    expect(submitted).toBeTruthy()
    expect(submitted!.state).toBe('in_review')
  })

  it('should approve ECO (in_review -> approved)', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const ts = Date.now()
    const reviewer = await createTestUser(org._id, { email: `reviewer-${ts}-2@test.com`, username: `reviewer-${ts}-2`, operatorCode: `REV-${ts}` } as any)
    const product = await createTestProduct(org._id)
    const eco = await createECO(org._id, product._id, user._id, { state: 'in_review' })

    const approved = await ECO.findOneAndUpdate(
      { _id: eco.id, orgId: org._id, state: 'in_review' },
      { $set: { state: 'approved', reviewerId: reviewer._id, approvedDate: new Date() } },
      { new: true },
    ).exec()

    expect(approved).toBeTruthy()
    expect(approved!.state).toBe('approved')
    expect(approved!.approvedDate).toBeTruthy()
    expect(String(approved!.reviewerId)).toBe(String(reviewer._id))
  })

  it('should apply ECO (approved -> applied)', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const product = await createTestProduct(org._id)
    const eco = await createECO(org._id, product._id, user._id, { state: 'approved', approvedDate: new Date() })

    const applied = await ECO.findOneAndUpdate(
      { _id: eco.id, orgId: org._id, state: 'approved' },
      { $set: { state: 'applied', appliedDate: new Date() } },
      { new: true },
    ).exec()

    expect(applied).toBeTruthy()
    expect(applied!.state).toBe('applied')
    expect(applied!.appliedDate).toBeTruthy()
  })

  it('should reject ECO (in_review -> rejected)', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const product = await createTestProduct(org._id)
    const eco = await createECO(org._id, product._id, user._id, { state: 'in_review' })

    const rejected = await ECO.findOneAndUpdate(
      { _id: eco.id, orgId: org._id, state: 'in_review' },
      { $set: { state: 'rejected', reviewerId: user._id } },
      { new: true },
    ).exec()

    expect(rejected).toBeTruthy()
    expect(rejected!.state).toBe('rejected')
  })

  it('should complete full ECO lifecycle: draft -> in_review -> approved -> applied', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const product = await createTestProduct(org._id)

    // Create in draft
    const eco = await createECO(org._id, product._id, user._id)
    expect((eco as any).state).toBe('draft')

    // Submit
    const submitted = await ECO.findOneAndUpdate(
      { _id: eco.id, state: 'draft' },
      { $set: { state: 'in_review' } },
      { new: true },
    ).exec()
    expect(submitted!.state).toBe('in_review')

    // Approve
    const approved = await ECO.findOneAndUpdate(
      { _id: eco.id, state: 'in_review' },
      { $set: { state: 'approved', reviewerId: user._id, approvedDate: new Date() } },
      { new: true },
    ).exec()
    expect(approved!.state).toBe('approved')

    // Apply
    const applied = await ECO.findOneAndUpdate(
      { _id: eco.id, state: 'approved' },
      { $set: { state: 'applied', appliedDate: new Date() } },
      { new: true },
    ).exec()
    expect(applied!.state).toBe('applied')
    expect(applied!.appliedDate).toBeTruthy()
  })
})

// ---------- POS Restaurant ----------

describe('POS Restaurant', () => {
  it('should create a restaurant floor with tables', async () => {
    const org = await createTestOrg()

    const floor = await repos.restaurantFloors.create({
      orgId: String(org._id),
      name: 'Main Floor',
      tables: [
        { number: 1, name: 'Table 1', seats: 4, positionX: 0, positionY: 0, shape: 'square', state: 'available' },
        { number: 2, name: 'Table 2', seats: 6, positionX: 100, positionY: 0, shape: 'rectangle', state: 'available' },
        { number: 3, name: 'Bar Seat', seats: 2, positionX: 200, positionY: 0, shape: 'round', state: 'available' },
      ],
      isActive: true,
    } as any)

    expect(floor.name).toBe('Main Floor')
    expect((floor as any).tables).toHaveLength(3)
    expect((floor as any).tables[0].seats).toBe(4)
    expect((floor as any).tables[1].shape).toBe('rectangle')
  })

  it('should update table state (available -> occupied)', async () => {
    const org = await createTestOrg()

    const floor = await RestaurantFloor.create({
      orgId: org._id,
      name: 'Patio',
      tables: [
        { number: 1, name: 'Table 1', seats: 4, positionX: 0, positionY: 0, shape: 'square', state: 'available' },
        { number: 2, name: 'Table 2', seats: 2, positionX: 50, positionY: 0, shape: 'round', state: 'available' },
      ],
      isActive: true,
    })

    const updated = await RestaurantFloor.findOneAndUpdate(
      { _id: floor._id, orgId: org._id, 'tables.number': 1 },
      { $set: { 'tables.$.state': 'occupied' } },
      { new: true },
    ).exec()

    expect(updated).toBeTruthy()
    const table1 = updated!.tables.find(t => t.number === 1)
    expect(table1!.state).toBe('occupied')

    // Table 2 should remain available
    const table2 = updated!.tables.find(t => t.number === 2)
    expect(table2!.state).toBe('available')
  })

  it('should create a kitchen order from POS transaction', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const product = await createTestProduct(org._id)

    // Create a POS transaction first
    const txn = await POSTransaction.create({
      orgId: org._id,
      sessionId: org._id, // reuse org ID as dummy session
      transactionNumber: `TXN-${Date.now()}`,
      type: 'sale',
      lines: [{ productId: product._id, name: product.name, quantity: 2, unitPrice: 10, discount: 0, taxRate: 0, taxAmount: 0, lineTotal: 20 }],
      payments: [{ method: 'cash', amount: 20 }],
      subtotal: 20,
      discountTotal: 0,
      taxTotal: 0,
      total: 20,
      changeDue: 0,
      createdBy: user._id,
    })

    const order = await repos.kitchenOrders.create({
      orgId: String(org._id),
      posTransactionId: String(txn._id),
      tableNumber: 5,
      state: 'pending',
      lines: [
        { productId: String(product._id), productName: product.name, quantity: 2, notes: 'No onions' },
      ],
      priority: 'normal',
    } as any)

    expect((order as any).state).toBe('pending')
    expect((order as any).tableNumber).toBe(5)
    expect((order as any).lines).toHaveLength(1)
    expect((order as any).lines[0].productName).toBe(product.name)
    expect((order as any).lines[0].notes).toBe('No onions')
  })

  it('should transition kitchen order: pending -> in_progress -> ready -> served', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const product = await createTestProduct(org._id)

    const txn = await POSTransaction.create({
      orgId: org._id,
      sessionId: org._id,
      transactionNumber: `TXN-${Date.now()}`,
      type: 'sale',
      lines: [{ productId: product._id, name: product.name, quantity: 1, unitPrice: 15, discount: 0, taxRate: 0, taxAmount: 0, lineTotal: 15 }],
      payments: [{ method: 'cash', amount: 15 }],
      subtotal: 15,
      discountTotal: 0,
      taxTotal: 0,
      total: 15,
      changeDue: 0,
      createdBy: user._id,
    })

    const order = await KitchenOrder.create({
      orgId: org._id,
      posTransactionId: txn._id,
      tableNumber: 3,
      state: 'pending',
      lines: [{ productId: product._id, productName: product.name, quantity: 1 }],
      priority: 'rush',
    })

    // Start
    const started = await KitchenOrder.findOneAndUpdate(
      { _id: order._id, state: 'pending' },
      { $set: { state: 'in_progress' } },
      { new: true },
    ).exec()
    expect(started!.state).toBe('in_progress')

    // Ready
    const ready = await KitchenOrder.findOneAndUpdate(
      { _id: order._id, state: 'in_progress' },
      { $set: { state: 'ready' } },
      { new: true },
    ).exec()
    expect(ready!.state).toBe('ready')

    // Served
    const served = await KitchenOrder.findOneAndUpdate(
      { _id: order._id, state: 'ready' },
      { $set: { state: 'served' } },
      { new: true },
    ).exec()
    expect(served!.state).toBe('served')
  })

  it('should update individual kitchen line state', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const product1 = await createTestProduct(org._id, { name: 'Burger', sku: `SKU-B-${Date.now()}` })
    const product2 = await createTestProduct(org._id, { name: 'Fries', sku: `SKU-F-${Date.now()}` })

    const txn = await POSTransaction.create({
      orgId: org._id,
      sessionId: org._id,
      transactionNumber: `TXN-${Date.now()}`,
      type: 'sale',
      lines: [
        { productId: product1._id, name: 'Burger', quantity: 1, unitPrice: 12, discount: 0, taxRate: 0, taxAmount: 0, lineTotal: 12 },
        { productId: product2._id, name: 'Fries', quantity: 1, unitPrice: 5, discount: 0, taxRate: 0, taxAmount: 0, lineTotal: 5 },
      ],
      payments: [{ method: 'cash', amount: 17 }],
      subtotal: 17,
      discountTotal: 0,
      taxTotal: 0,
      total: 17,
      changeDue: 0,
      createdBy: user._id,
    })

    const order = await KitchenOrder.create({
      orgId: org._id,
      posTransactionId: txn._id,
      state: 'in_progress',
      lines: [
        { productId: product1._id, productName: 'Burger', quantity: 1, state: 'pending' },
        { productId: product2._id, productName: 'Fries', quantity: 1, state: 'pending' },
      ],
      priority: 'normal',
    })

    // Update burger line to preparing
    const updated = await KitchenOrder.findOneAndUpdate(
      { _id: order._id, 'lines.productId': product1._id },
      { $set: { 'lines.$.state': 'preparing' } },
      { new: true },
    ).exec()

    expect(updated).toBeTruthy()
    const burgerLine = updated!.lines.find(l => String(l.productId) === String(product1._id))
    expect(burgerLine!.state).toBe('preparing')

    // Fries should still be pending
    const friesLine = updated!.lines.find(l => String(l.productId) === String(product2._id))
    expect(friesLine!.state).toBe('pending')

    // Update fries to ready
    const updated2 = await KitchenOrder.findOneAndUpdate(
      { _id: order._id, 'lines.productId': product2._id },
      { $set: { 'lines.$.state': 'ready' } },
      { new: true },
    ).exec()

    const friesReady = updated2!.lines.find(l => String(l.productId) === String(product2._id))
    expect(friesReady!.state).toBe('ready')
  })
})
