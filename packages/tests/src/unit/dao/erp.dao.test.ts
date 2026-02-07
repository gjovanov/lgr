import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../../setup'
import { bomDao } from 'services/dao/erp/bom.dao'
import { productionOrderDao } from 'services/dao/erp/production-order.dao'
import { constructionProjectDao } from 'services/dao/erp/construction-project.dao'
import { posSessionDao } from 'services/dao/erp/pos-session.dao'
import { posTransactionDao } from 'services/dao/erp/pos-transaction.dao'
import {
  createTestOrg,
  createTestProduct,
  createTestWarehouse,
  createTestBOM,
  createTestProductionOrder,
  createTestConstructionProject,
  createTestPOSSession,
  createTestPOSTransaction,
} from '../../helpers/factories'
import { mongoose } from 'db/connection'
const { Types } = mongoose

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('BomDao', () => {
  it('should find BOMs by product', async () => {
    const org = await createTestOrg({ slug: 'bom-product-org' })
    const product = await createTestProduct(org._id)
    const otherProduct = await createTestProduct(org._id)

    await createTestBOM(org._id, product._id, { name: 'BOM A' })
    await createTestBOM(org._id, product._id, { name: 'BOM B' })
    await createTestBOM(org._id, otherProduct._id, { name: 'BOM C' })

    const results = await bomDao.findByProduct(String(org._id), String(product._id))
    expect(results).toHaveLength(2)
    const names = results.map((b) => b.name).sort()
    expect(names).toEqual(['BOM A', 'BOM B'])
  })

  it('should find active BOMs', async () => {
    const org = await createTestOrg({ slug: 'bom-active-org' })
    const product = await createTestProduct(org._id)

    await createTestBOM(org._id, product._id, { status: 'active', name: 'Active BOM' })
    await createTestBOM(org._id, product._id, { status: 'draft', name: 'Draft BOM' })
    await createTestBOM(org._id, product._id, { status: 'active', name: 'Active BOM 2' })

    const results = await bomDao.findActive(String(org._id))
    expect(results).toHaveLength(2)
    results.forEach((b) => expect(b.status).toBe('active'))
  })
})

describe('ProductionOrderDao', () => {
  it('should find orders by status', async () => {
    const org = await createTestOrg({ slug: 'po-status-org' })
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const bom = await createTestBOM(org._id, product._id)

    await createTestProductionOrder(org._id, bom._id, product._id, warehouse._id, {
      status: 'planned',
      orderNumber: 'PRD-2026-00001',
    })
    await createTestProductionOrder(org._id, bom._id, product._id, warehouse._id, {
      status: 'in_progress',
      orderNumber: 'PRD-2026-00002',
    })
    await createTestProductionOrder(org._id, bom._id, product._id, warehouse._id, {
      status: 'planned',
      orderNumber: 'PRD-2026-00003',
    })

    const planned = await productionOrderDao.findByStatus(String(org._id), 'planned')
    expect(planned).toHaveLength(2)
    planned.forEach((o) => expect(o.status).toBe('planned'))

    const inProgress = await productionOrderDao.findByStatus(String(org._id), 'in_progress')
    expect(inProgress).toHaveLength(1)
  })

  it('should find orders by product', async () => {
    const org = await createTestOrg({ slug: 'po-product-org' })
    const productA = await createTestProduct(org._id)
    const productB = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const bomA = await createTestBOM(org._id, productA._id)
    const bomB = await createTestBOM(org._id, productB._id)

    await createTestProductionOrder(org._id, bomA._id, productA._id, warehouse._id, {
      orderNumber: 'PRD-2026-10001',
    })
    await createTestProductionOrder(org._id, bomA._id, productA._id, warehouse._id, {
      orderNumber: 'PRD-2026-10002',
    })
    await createTestProductionOrder(org._id, bomB._id, productB._id, warehouse._id, {
      orderNumber: 'PRD-2026-10003',
    })

    const results = await productionOrderDao.findByProduct(String(org._id), String(productA._id))
    expect(results).toHaveLength(2)
    results.forEach((o) => expect(String(o.productId)).toBe(String(productA._id)))
  })

  it('should auto-increment order number with PRD-YYYY-00001 format', async () => {
    const org = await createTestOrg({ slug: 'po-autonumber-org' })
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const bom = await createTestBOM(org._id, product._id)
    const year = new Date().getFullYear()

    // First call with no existing orders should return 00001
    const first = await productionOrderDao.getNextOrderNumber(String(org._id))
    expect(first).toBe(`PRD-${year}-00001`)

    // Create an order with that number, then get the next
    await createTestProductionOrder(org._id, bom._id, product._id, warehouse._id, {
      orderNumber: `PRD-${year}-00001`,
    })

    const second = await productionOrderDao.getNextOrderNumber(String(org._id))
    expect(second).toBe(`PRD-${year}-00002`)
  })
})

describe('ConstructionProjectDao', () => {
  it('should find projects by client', async () => {
    const org = await createTestOrg({ slug: 'cp-client-org' })
    const clientId = new Types.ObjectId()
    const otherClientId = new Types.ObjectId()

    await createTestConstructionProject(org._id, { clientId, name: 'Project A' })
    await createTestConstructionProject(org._id, { clientId, name: 'Project B' })
    await createTestConstructionProject(org._id, { clientId: otherClientId, name: 'Project C' })

    const results = await constructionProjectDao.findByClient(String(org._id), String(clientId))
    expect(results).toHaveLength(2)
    results.forEach((p) => expect(String(p.clientId)).toBe(String(clientId)))
  })

  it('should find projects by status', async () => {
    const org = await createTestOrg({ slug: 'cp-status-org' })

    await createTestConstructionProject(org._id, { status: 'planning', name: 'Plan 1' })
    await createTestConstructionProject(org._id, { status: 'active', name: 'Active 1' })
    await createTestConstructionProject(org._id, { status: 'planning', name: 'Plan 2' })

    const planning = await constructionProjectDao.findByStatus(String(org._id), 'planning')
    expect(planning).toHaveLength(2)
    planning.forEach((p) => expect(p.status).toBe('planning'))

    const active = await constructionProjectDao.findByStatus(String(org._id), 'active')
    expect(active).toHaveLength(1)
  })
})

describe('PosSessionDao', () => {
  it('should find open sessions', async () => {
    const org = await createTestOrg({ slug: 'pos-open-org' })
    const warehouse = await createTestWarehouse(org._id)
    const cashierId = new Types.ObjectId()

    await createTestPOSSession(org._id, warehouse._id, cashierId, { status: 'open' })
    await createTestPOSSession(org._id, warehouse._id, cashierId, { status: 'closed' })
    await createTestPOSSession(org._id, warehouse._id, cashierId, { status: 'open' })

    const openSessions = await posSessionDao.findOpen(String(org._id))
    expect(openSessions).toHaveLength(2)
    openSessions.forEach((s) => expect(s.status).toBe('open'))
  })

  it('should find sessions by cashier', async () => {
    const org = await createTestOrg({ slug: 'pos-cashier-org' })
    const warehouse = await createTestWarehouse(org._id)
    const cashierA = new Types.ObjectId()
    const cashierB = new Types.ObjectId()

    await createTestPOSSession(org._id, warehouse._id, cashierA)
    await createTestPOSSession(org._id, warehouse._id, cashierA)
    await createTestPOSSession(org._id, warehouse._id, cashierB)

    const results = await posSessionDao.findByCashier(String(org._id), String(cashierA))
    expect(results).toHaveLength(2)
    results.forEach((s) => expect(String(s.cashierId)).toBe(String(cashierA)))
  })
})

describe('PosTransactionDao', () => {
  it('should find transactions by session', async () => {
    const org = await createTestOrg({ slug: 'pos-txn-org' })
    const warehouse = await createTestWarehouse(org._id)
    const cashierId = new Types.ObjectId()
    const createdBy = new Types.ObjectId()

    const sessionA = await createTestPOSSession(org._id, warehouse._id, cashierId)
    const sessionB = await createTestPOSSession(org._id, warehouse._id, cashierId)

    await createTestPOSTransaction(org._id, sessionA._id, createdBy, {
      transactionNumber: 'TXN-2026-00001',
    })
    await createTestPOSTransaction(org._id, sessionA._id, createdBy, {
      transactionNumber: 'TXN-2026-00002',
    })
    await createTestPOSTransaction(org._id, sessionB._id, createdBy, {
      transactionNumber: 'TXN-2026-00003',
    })

    const results = await posTransactionDao.findBySession(String(org._id), String(sessionA._id))
    expect(results).toHaveLength(2)
    results.forEach((t) => expect(String(t.sessionId)).toBe(String(sessionA._id)))
  })
})
