import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestProduct,
  createTestWarehouse,
  createTestContact,
  createTestInvoice,
} from '../helpers/factories'
import { StockMovement, ProductCategory, Product } from 'db/models'
import { reportById, validateParams } from 'services/biz/report-registry'
import type { Types } from 'mongoose'

/**
 * FR-07 (#16) — „Складови операции".
 *
 * The two behaviours worth guarding are the traps the handler is written around: the
 * effective date (an invoice-linked movement belongs to the INVOICE's month, not the
 * booking month) and returns netting negatively.
 */

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

const entry = () => reportById('warehouse-operations')!
const run = (orgId: string, params: Record<string, any>) =>
  entry().handler!({ orgId, params: validateParams(entry(), params), output: 'table' })

let movementSeq = 0

async function movement(orgId: Types.ObjectId, userId: Types.ObjectId, over: Record<string, any>) {
  return StockMovement.create({
    orgId,
    movementNumber: `SM-${++movementSeq}-${Date.now()}`,
    status: 'completed',
    createdBy: userId,
    ...over,
  } as any)
}

async function seed() {
  const org = await createTestOrg()
  const orgId = org._id as Types.ObjectId
  const userId = orgId // any ObjectId works for createdBy in these reads
  const wh = await createTestWarehouse(orgId)
  const whId = wh._id as Types.ObjectId
  const supplier = await createTestContact(orgId, { type: 'supplier', companyName: 'Supplier Ltd' })
  const customer = await createTestContact(orgId, { type: 'customer', companyName: 'Customer Ltd' })
  const bolt = await createTestProduct(orgId, { sku: 'BOLT-1', name: 'Bolt', unit: 'pcs', avgCost: 2 })
  const nut = await createTestProduct(orgId, { sku: 'NUT-1', name: 'Nut', unit: 'pcs', avgCost: 1 })

  return { orgId, userId, whId, supplier, customer, bolt, nut }
}

describe('warehouse-operations — operation families', () => {
  it('sums dispatches per product for sales', async () => {
    const s = await seed()
    await movement(s.orgId, s.userId, {
      type: 'dispatch', date: new Date('2026-05-10'), fromWarehouseId: s.whId, contactId: s.customer._id,
      lines: [
        { productId: s.bolt._id, quantity: 10, unitCost: 5, totalCost: 50 },
        { productId: s.nut._id, quantity: 4, unitCost: 2.5, totalCost: 10 },
      ],
    })
    await movement(s.orgId, s.userId, {
      type: 'dispatch', date: new Date('2026-05-12'), fromWarehouseId: s.whId,
      lines: [{ productId: s.bolt._id, quantity: 5, unitCost: 6, totalCost: 30 }],
    })

    const res = await run(String(s.orgId), { operation: 'sales', period: { preset: 'custom', from: '2026-05-01', to: '2026-05-31' } })

    const bolt = res.rows.find(r => r.sku === 'BOLT-1')!
    expect(bolt.quantity).toBe(15)
    expect(bolt.value).toBe(80)
    // Weighted average, not (5 + 6) / 2.
    expect(bolt.avgPrice).toBeCloseTo(80 / 15, 3)
    expect(res.totals!.value).toBe(90)
  })

  it('sums receipts for purchases and ignores dispatches', async () => {
    const s = await seed()
    await movement(s.orgId, s.userId, {
      type: 'receipt', date: new Date('2026-05-10'), toWarehouseId: s.whId, contactId: s.supplier._id,
      lines: [{ productId: s.bolt._id, quantity: 100, unitCost: 1.5, totalCost: 150 }],
    })
    await movement(s.orgId, s.userId, {
      type: 'dispatch', date: new Date('2026-05-11'), fromWarehouseId: s.whId,
      lines: [{ productId: s.bolt._id, quantity: 10, unitCost: 5, totalCost: 50 }],
    })

    const purchases = await run(String(s.orgId), { operation: 'purchases', period: { preset: 'custom', from: '2026-05-01', to: '2026-05-31' } })
    expect(purchases.rows).toHaveLength(1)
    expect(purchases.rows[0].quantity).toBe(100)
    expect(purchases.rows[0].value).toBe(150)
  })

  it('excludes transfers, adjustments and production movements', async () => {
    const s = await seed()
    for (const type of ['transfer', 'adjustment', 'production_in', 'production_out']) {
      await movement(s.orgId, s.userId, {
        type, date: new Date('2026-05-10'), fromWarehouseId: s.whId, toWarehouseId: s.whId,
        lines: [{ productId: s.bolt._id, quantity: 7, unitCost: 1, totalCost: 7 }],
      })
    }
    const sales = await run(String(s.orgId), { operation: 'sales', period: { preset: 'custom', from: '2026-05-01', to: '2026-05-31' } })
    expect(sales.rows).toHaveLength(0)
  })

  it('excludes draft movements', async () => {
    const s = await seed()
    await movement(s.orgId, s.userId, {
      type: 'dispatch', status: 'draft', date: new Date('2026-05-10'), fromWarehouseId: s.whId,
      lines: [{ productId: s.bolt._id, quantity: 10, unitCost: 5, totalCost: 50 }],
    })
    const res = await run(String(s.orgId), { operation: 'sales', period: { preset: 'custom', from: '2026-05-01', to: '2026-05-31' } })
    expect(res.rows).toHaveLength(0)
  })

  it('nets customer returns negatively against sales', async () => {
    const s = await seed()
    await movement(s.orgId, s.userId, {
      type: 'dispatch', date: new Date('2026-05-10'), fromWarehouseId: s.whId,
      lines: [{ productId: s.bolt._id, quantity: 10, unitCost: 5, totalCost: 50 }],
    })
    // A customer return comes back INTO the warehouse.
    await movement(s.orgId, s.userId, {
      type: 'return', date: new Date('2026-05-15'), toWarehouseId: s.whId,
      lines: [{ productId: s.bolt._id, quantity: 3, unitCost: 5, totalCost: 15 }],
    })

    const res = await run(String(s.orgId), { operation: 'sales', period: { preset: 'custom', from: '2026-05-01', to: '2026-05-31' } })
    expect(res.rows[0].quantity).toBe(7)
    expect(res.rows[0].value).toBe(35)
  })

  it('leaves a supplier return out of the sales side', async () => {
    const s = await seed()
    // Goods going back OUT to a supplier negate a purchase, not a sale.
    await movement(s.orgId, s.userId, {
      type: 'return', date: new Date('2026-05-15'), fromWarehouseId: s.whId,
      lines: [{ productId: s.bolt._id, quantity: 3, unitCost: 2, totalCost: 6 }],
    })
    const sales = await run(String(s.orgId), { operation: 'sales', period: { preset: 'custom', from: '2026-05-01', to: '2026-05-31' } })
    expect(sales.rows).toHaveLength(0)

    const purchases = await run(String(s.orgId), { operation: 'purchases', period: { preset: 'custom', from: '2026-05-01', to: '2026-05-31' } })
    expect(purchases.rows[0].quantity).toBe(-3)
    expect(purchases.rows[0].value).toBe(-6)
  })
})

describe('warehouse-operations — the effective-date trap', () => {
  it('files an invoice-linked movement under the INVOICE month, not the booking month', async () => {
    const s = await seed()
    // createInvoiceStockMovement stamps `date: new Date()`, so a June invoice booked in
    // July has a July movement date. June is the correct answer.
    const invoice = await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
      issueDate: new Date('2026-06-30'), type: 'invoice', direction: 'outgoing',
    })
    await movement(s.orgId, s.userId, {
      type: 'dispatch', date: new Date('2026-07-01'), fromWarehouseId: s.whId,
      invoiceId: invoice._id,
      lines: [{ productId: s.bolt._id, quantity: 10, unitCost: 5, totalCost: 50 }],
    })

    const june = await run(String(s.orgId), { operation: 'sales', period: { preset: 'custom', from: '2026-06-01', to: '2026-06-30' } })
    expect(june.rows).toHaveLength(1)
    expect(june.rows[0].quantity).toBe(10)

    const july = await run(String(s.orgId), { operation: 'sales', period: { preset: 'custom', from: '2026-07-01', to: '2026-07-31' } })
    expect(july.rows).toHaveLength(0)
  })

  it('falls back to the movement date when there is no invoice', async () => {
    const s = await seed()
    await movement(s.orgId, s.userId, {
      type: 'receipt', date: new Date('2026-06-15'), toWarehouseId: s.whId,
      lines: [{ productId: s.bolt._id, quantity: 20, unitCost: 1, totalCost: 20 }],
    })
    const june = await run(String(s.orgId), { operation: 'purchases', period: { preset: 'custom', from: '2026-06-01', to: '2026-06-30' } })
    expect(june.rows).toHaveLength(1)
  })
})

describe('warehouse-operations — filters', () => {
  it('filters by document type incl. the no-invoice pseudo-types', async () => {
    const s = await seed()
    const invoice = await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
      issueDate: new Date('2026-05-10'), type: 'invoice', direction: 'outgoing',
    })
    await movement(s.orgId, s.userId, {
      type: 'dispatch', date: new Date('2026-05-10'), fromWarehouseId: s.whId, invoiceId: invoice._id,
      lines: [{ productId: s.bolt._id, quantity: 10, unitCost: 5, totalCost: 50 }],
    })
    await movement(s.orgId, s.userId, {
      type: 'dispatch', date: new Date('2026-05-11'), fromWarehouseId: s.whId,
      lines: [{ productId: s.nut._id, quantity: 4, unitCost: 2, totalCost: 8 }],
    })

    const period = { preset: 'custom', from: '2026-05-01', to: '2026-05-31' }

    const invoiced = await run(String(s.orgId), { operation: 'sales', period, docTypes: ['invoice'] })
    expect(invoiced.rows.map(r => r.sku)).toEqual(['BOLT-1'])

    const notes = await run(String(s.orgId), { operation: 'sales', period, docTypes: ['dispatch_note'] })
    expect(notes.rows.map(r => r.sku)).toEqual(['NUT-1'])
  })

  it('filters by contact, product and warehouse', async () => {
    const s = await seed()
    const other = await createTestWarehouse(s.orgId)
    await movement(s.orgId, s.userId, {
      type: 'dispatch', date: new Date('2026-05-10'), fromWarehouseId: s.whId, contactId: s.customer._id,
      lines: [{ productId: s.bolt._id, quantity: 10, unitCost: 5, totalCost: 50 }],
    })
    await movement(s.orgId, s.userId, {
      type: 'dispatch', date: new Date('2026-05-10'), fromWarehouseId: other._id,
      lines: [{ productId: s.nut._id, quantity: 4, unitCost: 2, totalCost: 8 }],
    })
    const period = { preset: 'custom', from: '2026-05-01', to: '2026-05-31' }

    const byWarehouse = await run(String(s.orgId), { operation: 'sales', period, warehouseId: String(s.whId) })
    expect(byWarehouse.rows.map(r => r.sku)).toEqual(['BOLT-1'])

    const byContact = await run(String(s.orgId), { operation: 'sales', period, contactId: String(s.customer._id) })
    expect(byContact.rows.map(r => r.sku)).toEqual(['BOLT-1'])

    const byProduct = await run(String(s.orgId), { operation: 'sales', period, productId: String(s.nut._id) })
    expect(byProduct.rows.map(r => r.sku)).toEqual(['NUT-1'])
  })

  it('includes descendant categories in a product-group filter', async () => {
    const s = await seed()
    const parent = await ProductCategory.create({ orgId: s.orgId, name: 'Fasteners' } as any)
    const child = await ProductCategory.create({ orgId: s.orgId, name: 'Bolts', parentId: parent._id } as any)
    await Product.updateOne({ _id: s.bolt._id }, { $set: { categoryId: child._id } })
    await Product.updateOne({ _id: s.nut._id }, { $set: { categoryId: undefined } })

    await movement(s.orgId, s.userId, {
      type: 'dispatch', date: new Date('2026-05-10'), fromWarehouseId: s.whId,
      lines: [
        { productId: s.bolt._id, quantity: 10, unitCost: 5, totalCost: 50 },
        { productId: s.nut._id, quantity: 4, unitCost: 2, totalCost: 8 },
      ],
    })

    // Picking the PARENT must still find the product filed under the child.
    const res = await run(String(s.orgId), {
      operation: 'sales',
      period: { preset: 'custom', from: '2026-05-01', to: '2026-05-31' },
      categoryId: String(parent._id),
    })
    expect(res.rows.map(r => r.sku)).toEqual(['BOLT-1'])
  })
})

describe('warehouse-operations — document drill-down', () => {
  it('emits one row per movement line with document identity', async () => {
    const s = await seed()
    const invoice = await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
      issueDate: new Date('2026-05-10'), type: 'invoice', direction: 'outgoing', invoiceNumber: 'INV-2026-00042',
    })
    await movement(s.orgId, s.userId, {
      type: 'dispatch', date: new Date('2026-05-10'), fromWarehouseId: s.whId, invoiceId: invoice._id,
      contactId: s.customer._id,
      lines: [{ productId: s.bolt._id, quantity: 10, unitCost: 5, totalCost: 50 }],
    })

    const res = await run(String(s.orgId), {
      operation: 'sales',
      period: { preset: 'custom', from: '2026-05-01', to: '2026-05-31' },
      groupBy: 'document',
    })

    expect(res.rows).toHaveLength(1)
    expect(res.rows[0].documentNumber).toBe('INV-2026-00042')
    expect(res.rows[0].docType).toBe('invoice')
    expect(res.rows[0].contactName).toBe('Customer Ltd')
    expect(res.meta!.groupBy).toBe('document')
  })

  it('falls back to the movement number when no invoice is linked', async () => {
    const s = await seed()
    const m = await movement(s.orgId, s.userId, {
      type: 'receipt', date: new Date('2026-05-10'), toWarehouseId: s.whId,
      lines: [{ productId: s.bolt._id, quantity: 20, unitCost: 1, totalCost: 20 }],
    })
    const res = await run(String(s.orgId), {
      operation: 'purchases',
      period: { preset: 'custom', from: '2026-05-01', to: '2026-05-31' },
      groupBy: 'document',
    })
    expect(res.rows[0].documentNumber).toBe((m as any).movementNumber)
    expect(res.rows[0].docType).toBe('receipt_note')
  })
})

describe('warehouse-operations — scoping and totals', () => {
  it('never leaks another org\'s movements', async () => {
    const s = await seed()
    const other = await seed()
    await movement(other.orgId, other.userId, {
      type: 'dispatch', date: new Date('2026-05-10'), fromWarehouseId: other.whId,
      lines: [{ productId: other.bolt._id, quantity: 999, unitCost: 1, totalCost: 999 }],
    })
    const res = await run(String(s.orgId), { operation: 'sales', period: { preset: 'custom', from: '2026-05-01', to: '2026-05-31' } })
    expect(res.rows).toHaveLength(0)
  })

  it('totals equal the sum of the rows', async () => {
    const s = await seed()
    await movement(s.orgId, s.userId, {
      type: 'dispatch', date: new Date('2026-05-10'), fromWarehouseId: s.whId,
      lines: [
        { productId: s.bolt._id, quantity: 10, unitCost: 5, totalCost: 50 },
        { productId: s.nut._id, quantity: 4, unitCost: 2, totalCost: 8 },
      ],
    })
    const res = await run(String(s.orgId), { operation: 'sales', period: { preset: 'custom', from: '2026-05-01', to: '2026-05-31' } })
    expect(res.totals!.value).toBeCloseTo(res.rows.reduce((a, r) => a + r.value, 0), 2)
    expect(res.totals!.quantity).toBeCloseTo(res.rows.reduce((a, r) => a + r.quantity, 0), 3)
  })

  it('rejects an inverted custom period', () => {
    let err: any
    try {
      validateParams(entry(), { operation: 'sales', period: { preset: 'custom', from: '2026-06-01', to: '2026-05-01' } })
    } catch (e) { err = e }
    expect(err?.message).toMatch(/after its end/)
  })

  it('rejects an unknown document type', () => {
    let err: any
    try {
      validateParams(entry(), { operation: 'sales', docTypes: ['nonsense'] })
    } catch (e) { err = e }
    expect(err?.message).toMatch(/invalid value/)
  })
})
