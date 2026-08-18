import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestContact,
  createTestProduct,
  createTestWarehouse,
  createTestStockLevel,
} from '../helpers/factories'
import { InternalOrder, Invoice, Order, Reservation, StockLevel } from 'db/models'
import { mongoose } from 'db/connection'
import { syncOrderForInvoice } from 'services/biz/reservation.service'
import { checkCrossWarehouseAvailability } from 'services/biz/stock-transfer.service'
import {
  createReservation,
  preemptReservation,
  reserveAvailableForInternalOrder,
  getInternalOrderSuggestions,
  generateExternalOrder,
} from 'services/biz/reservation-ops.service'

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

async function captureRejection<T>(p: Promise<T>): Promise<Error | null> {
  try {
    await p
    return null
  } catch (e: any) {
    return e
  }
}

const USER = () => String(new Types.ObjectId())
const days = (n: number) => new Date(Date.now() + n * 24 * 3600 * 1000)

async function makeOrdi(orgId: any, contactId: any, productId: any, opts: {
  n: number
  quantity?: number
  deadline?: Date
  priority?: string
  warehouseId?: any
  status?: string
}) {
  return InternalOrder.create({
    orgId,
    orderNumber: `ORDI-2026-000${opts.n}`,
    status: opts.status || 'confirmed',
    statusHistory: [{ status: opts.status || 'confirmed', changedAt: new Date() }],
    contactId,
    issueDate: new Date(),
    requestedDeliveryDate: opts.deadline || days(7),
    priority: opts.priority || 'normal',
    warehouseId: opts.warehouseId,
    currency: 'EUR',
    exchangeRate: 1,
    lines: [{ productId, description: 'line', quantity: opts.quantity ?? 300, unit: 'pcs' }],
    createdBy: new Types.ObjectId(),
  } as any) as any
}

async function buildFixture() {
  const org = await createTestOrg()
  const clientA = await createTestContact(org._id, { companyName: 'Клиент А' })
  const clientB = await createTestContact(org._id, { companyName: 'Клиент Б' })
  const product = await createTestProduct(org._id, { name: 'ГАЙКА М10 - DIN 934' })
  const wh = await createTestWarehouse(org._id, { isDefault: true })
  await createTestStockLevel(org._id, product._id, wh._id, { quantity: 500, availableQuantity: 500, avgCost: 0.05 } as any)
  return { org, clientA, clientB, product, wh }
}

describe('Reservation preemption + shortfall coverage', () => {
  it('full preempt moves the hold to the higher-priority order, audit on both sides', async () => {
    const fx = await buildFixture()
    const urgent: any = await makeOrdi(fx.org._id, fx.clientA._id, fx.product._id, { n: 1, deadline: days(2), warehouseId: fx.wh._id })
    const relaxed: any = await makeOrdi(fx.org._id, fx.clientB._id, fx.product._id, { n: 2, deadline: days(20), warehouseId: fx.wh._id })

    const { created: relaxedRes } = await reserveAvailableForInternalOrder(String(fx.org._id), USER(), String(relaxed._id))
    expect(relaxedRes[0].quantity).toBe(300)

    const { source, created } = await preemptReservation(String(fx.org._id), USER(), String(relaxedRes[0]._id), {
      internalOrderId: String(urgent._id),
      internalOrderLineId: String(urgent.lines[0]._id),
    })
    expect(source.status).toBe('cancelled')
    expect(source.cancelReason).toBe('preempted')
    expect(source.quantity).toBe(300) // audit trail keeps the original quantity
    expect(String(source.preemptedBy.internalOrderId)).toBe(String(urgent._id))
    expect(created.status).toBe('active')
    expect(created.quantity).toBe(300)
    expect(created.source).toBe('stock')
    expect(String(created.warehouseId)).toBe(String(fx.wh._id))
    expect(String(created.contactId)).toBe(String(fx.clientA._id))

    // Hold total unchanged; demand counters moved.
    const sl: any = await StockLevel.findOne({ orgId: fx.org._id, warehouseId: fx.wh._id }).lean()
    expect(sl.reservedQuantity).toBe(300)
    const u: any = await InternalOrder.findById(urgent._id).lean()
    expect(u.lines[0].reservedQuantity).toBe(300)
    const rl: any = await InternalOrder.findById(relaxed._id).lean()
    expect(rl.lines[0].reservedQuantity).toBe(0)
  })

  it('partial preempt shrinks the source toward its consumed quantity', async () => {
    const fx = await buildFixture()
    const urgent: any = await makeOrdi(fx.org._id, fx.clientA._id, fx.product._id, { n: 1, deadline: days(2) })
    const relaxed: any = await makeOrdi(fx.org._id, fx.clientB._id, fx.product._id, { n: 2, deadline: days(20) })
    const { created: relaxedRes } = await reserveAvailableForInternalOrder(String(fx.org._id), USER(), String(relaxed._id))
    const res = relaxedRes[0]

    // 100 already invoiced (draft conversion) — releasable = 200.
    const inv = await Invoice.create({
      orgId: fx.org._id,
      invoiceNumber: `DRF-INV-${Date.now()}`,
      type: 'invoice',
      direction: 'outgoing',
      status: 'draft',
      contactId: fx.clientB._id,
      issueDate: new Date(),
      dueDate: new Date(),
      currency: 'EUR',
      exchangeRate: 1,
      lines: [{
        productId: fx.product._id, description: 'x', quantity: 100, unit: 'pcs', unitPrice: 1,
        discount: 0, taxRate: 20, taxAmount: 0, lineTotal: 0, warehouseId: fx.wh._id,
        orderRef: { reservationId: res._id, internalOrderId: relaxed._id, internalOrderLineId: relaxed.lines[0]._id },
      }],
      subtotal: 0, taxTotal: 0, total: 0, totalBase: 0, amountDue: 0,
      billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
      internalOrderId: relaxed._id,
      createdBy: new Types.ObjectId(),
    } as any)
    await syncOrderForInvoice(String(fx.org._id), inv)

    const over = await captureRejection(preemptReservation(String(fx.org._id), USER(), String(res._id), {
      internalOrderId: String(urgent._id),
      internalOrderLineId: String(urgent.lines[0]._id),
      quantity: 250,
    }))
    expect((over as any)?.statusCode).toBe(422)
    expect(String(over?.message)).toContain('releasable')

    const { source, created } = await preemptReservation(String(fx.org._id), USER(), String(res._id), {
      internalOrderId: String(urgent._id),
      internalOrderLineId: String(urgent.lines[0]._id),
      quantity: 150,
    })
    expect(source.status).toBe('active')
    expect(source.quantity).toBe(150) // 300 − 150, floor at consumed 100
    expect(source.invoicedQuantity).toBe(100)
    expect(created.quantity).toBe(150)
  })

  it('preempt guards: product mismatch, same order, closed beneficiary', async () => {
    const fx = await buildFixture()
    const otherProduct = await createTestProduct(fx.org._id, { name: 'ШАЙБА М10 - DIN 125' })
    const urgent: any = await makeOrdi(fx.org._id, fx.clientA._id, otherProduct._id, { n: 1, deadline: days(2) })
    const relaxed: any = await makeOrdi(fx.org._id, fx.clientB._id, fx.product._id, { n: 2, deadline: days(20) })
    const draft: any = await makeOrdi(fx.org._id, fx.clientA._id, fx.product._id, { n: 3, status: 'draft' })
    const { created } = await reserveAvailableForInternalOrder(String(fx.org._id), USER(), String(relaxed._id))
    const res = created[0]

    const mismatch = await captureRejection(preemptReservation(String(fx.org._id), USER(), String(res._id), {
      internalOrderId: String(urgent._id), internalOrderLineId: String(urgent.lines[0]._id),
    }))
    expect((mismatch as any)?.statusCode).toBe(422)
    expect(String(mismatch?.message)).toContain('Product does not match')

    const sameOrder = await captureRejection(preemptReservation(String(fx.org._id), USER(), String(res._id), {
      internalOrderId: String(relaxed._id), internalOrderLineId: String(relaxed.lines[0]._id),
    }))
    expect((sameOrder as any)?.statusCode).toBe(422)
    expect(String(sameOrder?.message)).toContain('already serves')

    const notConfirmed = await captureRejection(preemptReservation(String(fx.org._id), USER(), String(res._id), {
      internalOrderId: String(draft._id), internalOrderLineId: String(draft.lines[0]._id),
    }))
    expect((notConfirmed as any)?.statusCode).toBe(422)
  })

  it('concurrent preempts of one reservation serialize — the pool is never over-granted', async () => {
    const fx = await buildFixture()
    const c: any = await makeOrdi(fx.org._id, fx.clientA._id, fx.product._id, { n: 1, deadline: days(2) })
    const d: any = await makeOrdi(fx.org._id, fx.clientA._id, fx.product._id, { n: 2, deadline: days(3) })
    const relaxed: any = await makeOrdi(fx.org._id, fx.clientB._id, fx.product._id, { n: 3, deadline: days(20) })
    const { created } = await reserveAvailableForInternalOrder(String(fx.org._id), USER(), String(relaxed._id))
    const res = created[0] // 300

    const [r1, r2] = await Promise.all([
      captureRejection(preemptReservation(String(fx.org._id), USER(), String(res._id), {
        internalOrderId: String(c._id), internalOrderLineId: String(c.lines[0]._id),
      })),
      captureRejection(preemptReservation(String(fx.org._id), USER(), String(res._id), {
        internalOrderId: String(d._id), internalOrderLineId: String(d.lines[0]._id),
      })),
    ])

    // Exactly one may win the full 300; the loser gets a clean 422 (or both split is
    // impossible — the source is cancelled by the winner). Verify the invariant:
    const grants: any[] = await Reservation.find({ orgId: fx.org._id, 'preemptedBy.reservationId': res._id } as any).lean()
    const granted = grants.reduce((s, g) => s + g.quantity, 0)
    expect(granted).toBeLessThanOrEqual(300)
    expect([r1, r2].filter((e) => e === null).length + 0).toBe(grants.length > 0 ? [r1, r2].filter((e) => e === null).length : 0)
    expect([r1, r2].some((e) => e === null)).toBe(true) // at least one succeeded
    // Total hold never exceeds the original 300.
    const sl: any = await StockLevel.findOne({ orgId: fx.org._id, warehouseId: fx.wh._id }).lean()
    expect(sl.reservedQuantity).toBeLessThanOrEqual(300)
  })

  it('suggestions rank: free stock, incoming (late flag), preemptable most-deferrable first, higher-priority excluded', async () => {
    const fx = await buildFixture()
    // Current: needs 300 by +2d.
    const current: any = await makeOrdi(fx.org._id, fx.clientA._id, fx.product._id, { n: 1, quantity: 300, deadline: days(2) })
    // Deferrable demand: +20d holds 100; higher-priority: +1d holds 50; ad-hoc client RES 80.
    const deferrable: any = await makeOrdi(fx.org._id, fx.clientB._id, fx.product._id, { n: 2, quantity: 100, deadline: days(20) })
    const higher: any = await makeOrdi(fx.org._id, fx.clientB._id, fx.product._id, { n: 3, quantity: 50, deadline: days(1) })
    await reserveAvailableForInternalOrder(String(fx.org._id), USER(), String(deferrable._id))
    await reserveAvailableForInternalOrder(String(fx.org._id), USER(), String(higher._id))
    await createReservation(String(fx.org._id), USER(), {
      source: 'stock', productId: String(fx.product._id), quantity: 80,
      contactId: String(fx.clientB._id), warehouseId: String(fx.wh._id),
    })

    // Incoming: sent ORDO, allocation 200, expected AFTER the deadline → late.
    const supplier = await createTestContact(fx.org._id, { type: 'supplier', companyName: 'Fastbolt' })
    await Order.create({
      orgId: fx.org._id,
      orderNumber: 'ORDO-2026-00021',
      status: 'sent',
      statusHistory: [{ status: 'sent', changedAt: new Date() }],
      issueDate: new Date(),
      expectedDate: days(5),
      currency: 'EUR',
      exchangeRate: 1,
      supplierGroups: [{
        supplierId: supplier._id,
        lines: [{ productId: fx.product._id, description: 'x', quantity: 200, unit: 'pcs', allocations: [{ warehouseId: fx.wh._id, quantity: 200 }] }],
      }],
      createdBy: new Types.ObjectId(),
    } as any)

    const lines = await getInternalOrderSuggestions(String(fx.org._id), String(current._id))
    expect(lines.length).toBe(1)
    const s = lines[0]
    expect(s.openQuantity).toBe(300)
    // Free stock: 500 − (100+50+80) reserved = 270.
    expect(s.freeStock).toEqual([{ warehouseId: String(fx.wh._id), available: 270 }])
    // Incoming allocation is unreserved and late vs the +2d deadline.
    expect(s.incoming.length).toBe(1)
    expect(s.incoming[0].unreserved).toBe(200)
    expect(s.incoming[0].late).toBe(true)
    // Preemptable: ad-hoc (no deadline) first, then the +20d order; the +1d one excluded.
    expect(s.preemptable.map((p) => p.releasable)).toEqual([80, 100])
    expect(s.preemptable[0].internalOrderId).toBeUndefined()
    expect(s.preemptable[1].internalOrderNumber).toBe('ORDI-2026-0002')
    expect(s.preemptable.some((p) => p.internalOrderNumber === 'ORDI-2026-0003')).toBe(false)
    expect(s.supplierHint?.supplierId).toBe(String(supplier._id))
  })

  it('generate-external creates/extends a draft ORDO with linked reservations; rollback on bad input', async () => {
    const fx = await buildFixture()
    const current: any = await makeOrdi(fx.org._id, fx.clientA._id, fx.product._id, { n: 1, quantity: 300, deadline: days(9), warehouseId: fx.wh._id })
    const supplier = await createTestContact(fx.org._id, { type: 'supplier', companyName: 'Fastbolt' })

    const { order, reservations } = await generateExternalOrder(String(fx.org._id), USER(), String(current._id), {
      draftOrderNumber: 'DRF-ORDO-2026-00001',
      lines: [{ internalOrderLineId: String(current.lines[0]._id), quantity: 200, supplierId: String(supplier._id) }],
    })
    expect(order.status).toBe('draft')
    expect(order.orderNumber).toBe('DRF-ORDO-2026-00001')
    expect(order.supplierGroups.length).toBe(1)
    expect(order.supplierGroups[0].lines[0].quantity).toBe(200)
    expect(String(order.supplierGroups[0].lines[0].allocations[0].warehouseId)).toBe(String(fx.wh._id))
    expect(reservations.length).toBe(1)
    expect(reservations[0].source).toBe('order')
    expect(String(reservations[0].allocationId)).toBe(String(order.supplierGroups[0].lines[0].allocations[0]._id))
    const ordi: any = await InternalOrder.findById(current._id).lean()
    expect(ordi.lines[0].reservedQuantity).toBe(200)

    // Append the remaining 100 to the same draft.
    const appended = await generateExternalOrder(String(fx.org._id), USER(), String(current._id), {
      orderId: String(order._id),
      lines: [{ internalOrderLineId: String(current.lines[0]._id), quantity: 100, supplierId: String(supplier._id) }],
    })
    expect(String(appended.order._id)).toBe(String(order._id))
    expect(appended.order.supplierGroups.length).toBe(1)
    expect(appended.order.supplierGroups[0].lines.length).toBe(2)
    const ordi2: any = await InternalOrder.findById(current._id).lean()
    expect(ordi2.lines[0].reservedQuantity).toBe(300)

    // Bad line id → clean failure, nothing persisted.
    const before = await Promise.all([Order.countDocuments({ orgId: fx.org._id }), Reservation.countDocuments({ orgId: fx.org._id })])
    const bad = await captureRejection(generateExternalOrder(String(fx.org._id), USER(), String(current._id), {
      draftOrderNumber: 'DRF-ORDO-2026-00002',
      lines: [{ internalOrderLineId: String(new Types.ObjectId()), quantity: 10, supplierId: String(supplier._id) }],
    }))
    expect((bad as any)?.statusCode).toBe(404)
    const after = await Promise.all([Order.countDocuments({ orgId: fx.org._id }), Reservation.countDocuments({ orgId: fx.org._id })])
    expect(after).toEqual(before)
  })

  it('cross-warehouse pre-flight exempts reservation-backed lines up to their open quantity', async () => {
    const fx = await buildFixture()
    const ordi: any = await makeOrdi(fx.org._id, fx.clientA._id, fx.product._id, { n: 1, quantity: 300 })
    const { created } = await reserveAvailableForInternalOrder(String(fx.org._id), USER(), String(ordi._id))
    const res = created[0]

    // Without the reservationId the pre-flight sees only 200 free → shortfall.
    const bare = await checkCrossWarehouseAvailability(String(fx.org._id), [
      { productId: String(fx.product._id), warehouseId: String(fx.wh._id), quantity: 300 },
    ])
    expect(bare.sufficient).toBe(false)

    // With it, the line consumes its own hold → sufficient.
    const exempted = await checkCrossWarehouseAvailability(String(fx.org._id), [
      { productId: String(fx.product._id), warehouseId: String(fx.wh._id), quantity: 300, reservationId: String(res._id) },
    ])
    expect(exempted.sufficient).toBe(true)

    // Excess beyond the reservation still competes for free stock.
    const excess = await checkCrossWarehouseAvailability(String(fx.org._id), [
      { productId: String(fx.product._id), warehouseId: String(fx.wh._id), quantity: 600, reservationId: String(res._id) },
    ])
    expect(excess.sufficient).toBe(false)
  })
})
