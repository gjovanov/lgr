import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestContact,
  createTestProduct,
  createTestWarehouse,
  createTestStockLevel,
} from '../helpers/factories'
import { Order, Invoice, Reservation, Sequence, StockLevel } from 'db/models'
import { mongoose } from 'db/connection'
import { syncReservedQuantities } from 'services/biz/reservation.service'
import {
  preflightReservationIdUniqueness,
  copyLegacyDisplayOverrides,
  migrateOrgReservations,
  computeEmbeddedHoldTotals,
  computeReservationHoldTotals,
  diffHoldTotals,
  stripOrgEmbeddedReservations,
} from '../../../../scripts/migrate-order-reservations'

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

/** A legacy order still carrying EMBEDDED reservations (pre-migration shape). */
async function buildLegacyOrder(orgId: any, opts: {
  status?: string
  reservations?: any[]
  productId?: any
  warehouseId: any
  supplierId: any
  received?: number
  orderNumber?: string
}) {
  return Order.create({
    orgId,
    orderNumber: opts.orderNumber || `ORD-2026-${Math.floor(Math.random() * 90000 + 10000)}`,
    status: opts.status || 'sent',
    statusHistory: [{ status: opts.status || 'sent', changedAt: new Date() }],
    issueDate: new Date(),
    currency: 'EUR',
    exchangeRate: 1,
    supplierGroups: [
      {
        supplierId: opts.supplierId,
        lines: [
          {
            productId: opts.productId,
            description: 'legacy line',
            quantity: 1000,
            unit: 'pcs',
            receivedQuantity: opts.received ?? 0,
            allocations: [
              {
                warehouseId: opts.warehouseId,
                quantity: 700,
                receivedQuantity: opts.received ?? 0,
                reservations: opts.reservations || [],
              },
            ],
          },
        ],
      },
    ],
    createdBy: new Types.ObjectId(),
  } as any)
}

describe('Reservation migration (embedded → RES docs)', () => {
  it('migrates embedded reservations preserving _ids, with hold parity and working strip', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    const supplier = await createTestContact(org._id, { type: 'supplier', companyName: 'Sup' })
    const c1 = await createTestContact(org._id, { companyName: 'Клиент Едно' })
    const c2 = await createTestContact(org._id, { companyName: 'Клиент Две' })
    const product = await createTestProduct(org._id, {})
    const wh = await createTestWarehouse(org._id, { isDefault: true })
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 700, availableQuantity: 700 } as any)

    const order: any = await buildLegacyOrder(org._id, {
      status: 'received',
      supplierId: supplier._id,
      productId: product._id,
      warehouseId: wh._id,
      received: 700,
      reservations: [
        { contactId: c1._id, quantity: 300, invoicedQuantity: 100, dispatchedQuantity: 100, invoiceIds: [] },
        { contactId: c2._id, quantity: 200 },
      ],
    })
    const alloc = order.supplierGroups[0].lines[0].allocations[0]
    const [subRes1, subRes2] = alloc.reservations

    // A historic conversion invoice referencing the embedded subdoc id.
    const historic = await Invoice.create({
      orgId: org._id,
      invoiceNumber: 'INV-2026-99001',
      type: 'invoice',
      direction: 'outgoing',
      status: 'sent',
      contactId: c1._id,
      issueDate: new Date(),
      dueDate: new Date(),
      currency: 'EUR',
      exchangeRate: 1,
      lines: [{
        productId: product._id,
        description: 'legacy line',
        quantity: 100,
        unit: 'pcs',
        unitPrice: 1,
        discount: 0,
        taxRate: 20,
        taxAmount: 20,
        lineTotal: 120,
        warehouseId: wh._id,
        orderRef: {
          groupId: order.supplierGroups[0]._id,
          lineId: order.supplierGroups[0].lines[0]._id,
          allocationId: alloc._id,
          reservationId: subRes1._id,
        },
      }],
      subtotal: 100, taxTotal: 20, total: 120, totalBase: 120, amountDue: 120,
      billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
      orderId: order._id,
      createdBy: new Types.ObjectId(),
    } as any)

    const embeddedHolds = await computeEmbeddedHoldTotals(orgId)
    // open 300−100 + 200 = 400; physical 700−100 = 600 → hold 400
    expect(embeddedHolds.get(`${product._id}|${wh._id}`)).toBe(400)

    await preflightReservationIdUniqueness(orgId)
    const stats = await migrateOrgReservations(orgId, true)
    expect(stats.created).toBe(2)

    // _ids preserved → the historic invoice's reservationId resolves.
    const r1: any = await Reservation.findById(subRes1._id).lean()
    expect(r1).toBeTruthy()
    expect(r1.reservationNumber).toMatch(/^RES-\d{4}-\d{5}$/)
    expect(r1.source).toBe('order')
    expect(String(r1.orderId)).toBe(String(order._id))
    expect(String(r1.allocationId)).toBe(String(alloc._id))
    expect(String(r1.productId)).toBe(String(product._id))
    expect(r1.invoicedQuantity).toBe(100)
    expect(r1.dispatchedQuantity).toBe(100)
    expect(r1.status).toBe('active')
    const linked: any = await Invoice.findById(historic._id).lean()
    expect(String(linked.lines[0].orderRef.reservationId)).toBe(String(r1._id))

    const r2: any = await Reservation.findById(subRes2._id).lean()
    expect(r2.status).toBe('active')
    expect(r2.quantity).toBe(200)

    // Hold parity: migrated RES docs produce exactly the embedded totals.
    const migratedHolds = await computeReservationHoldTotals(orgId)
    expect(diffHoldTotals(embeddedHolds, migratedHolds)).toEqual([])

    // Upsert refresh: the old code (still live) mutates the embedded counters → re-run copies them.
    await Order.updateOne(
      { _id: order._id },
      { $set: { 'supplierGroups.0.lines.0.allocations.0.reservations.0.invoicedQuantity': 150 } },
    )
    const stats2 = await migrateOrgReservations(orgId, true)
    expect(stats2.created).toBe(0)
    expect(stats2.refreshed).toBe(2)
    const refreshed: any = await Reservation.findById(subRes1._id).lean()
    expect(refreshed.invoicedQuantity).toBe(150)

    // Strip + full materialisation from RES docs.
    const affected = await stripOrgEmbeddedReservations(orgId, true)
    expect(affected).toBe(1)
    const stripped: any = await Order.findById(order._id).lean()
    expect(stripped.supplierGroups[0].lines[0].allocations[0].reservations).toEqual([])
    await syncReservedQuantities(orgId)
    const sl: any = await StockLevel.findOne({ orgId: org._id, warehouseId: wh._id }).lean()
    expect(sl.reservedQuantity).toBe(400)
  })

  it('normalises closed orders, zero-qty leftovers and product-less lines', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    const supplier = await createTestContact(org._id, { type: 'supplier', companyName: 'Sup' })
    const c1 = await createTestContact(org._id, { companyName: 'A' })
    const c2 = await createTestContact(org._id, { companyName: 'B' })
    const c3 = await createTestContact(org._id, { companyName: 'C' })
    const product = await createTestProduct(org._id, {})
    const wh = await createTestWarehouse(org._id, {})

    // Completed order: open remainder was released back then → shrink to consumed.
    const completed: any = await buildLegacyOrder(org._id, {
      status: 'completed',
      supplierId: supplier._id,
      productId: product._id,
      warehouseId: wh._id,
      orderNumber: 'ORD-2026-70001',
      reservations: [
        { contactId: c1._id, quantity: 300, invoicedQuantity: 120, dispatchedQuantity: 120 }, // → qty 120 fulfilled
        { contactId: c2._id, quantity: 200 },                                                 // → cancelled(released)
        { contactId: c3._id, quantity: 0 },                                                   // legacy /release leftover
      ],
    })
    // Product-less line on a holding order.
    const productless: any = await buildLegacyOrder(org._id, {
      status: 'sent',
      supplierId: supplier._id,
      productId: undefined,
      warehouseId: wh._id,
      orderNumber: 'ORD-2026-70002',
      reservations: [{ contactId: c1._id, quantity: 50 }],
    })

    await migrateOrgReservations(orgId, true)

    const [e1, e2, e3] = completed.supplierGroups[0].lines[0].allocations[0].reservations
    const m1: any = await Reservation.findById(e1._id).lean()
    expect(m1.quantity).toBe(120)
    expect(m1.status).toBe('fulfilled')
    const m2: any = await Reservation.findById(e2._id).lean()
    expect(m2.status).toBe('cancelled')
    expect(m2.cancelReason).toBe('released')
    const m3: any = await Reservation.findById(e3._id).lean()
    expect(m3.status).toBe('cancelled')
    expect(m3.quantity).toBe(0)

    const e4 = productless.supplierGroups[0].lines[0].allocations[0].reservations[0]
    const m4: any = await Reservation.findById(e4._id).lean()
    expect(m4.status).toBe('active')
    expect(m4.productId).toBeFalsy()
  })

  it('fails loudly on duplicated embedded reservation _ids across orders', async () => {
    const org = await createTestOrg()
    const supplier = await createTestContact(org._id, { type: 'supplier', companyName: 'Sup' })
    const c1 = await createTestContact(org._id, { companyName: 'A' })
    const product = await createTestProduct(org._id, {})
    const wh = await createTestWarehouse(org._id, {})

    const dupId = new Types.ObjectId()
    await buildLegacyOrder(org._id, {
      supplierId: supplier._id, productId: product._id, warehouseId: wh._id,
      orderNumber: 'ORD-2026-70003',
      reservations: [{ _id: dupId, contactId: c1._id, quantity: 10 }],
    })
    await buildLegacyOrder(org._id, {
      supplierId: supplier._id, productId: product._id, warehouseId: wh._id,
      orderNumber: 'ORD-2026-70004',
      reservations: [{ _id: dupId, contactId: c1._id, quantity: 20 }],
    })

    const err = await captureRejection(preflightReservationIdUniqueness(String(org._id)))
    expect(err).not.toBeNull()
    expect(String(err!.message)).toContain('Duplicate embedded reservation _id')
  })

  it('copies a legacy ORD display-prefix sentinel onto the ORDER counter key', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    await Sequence.create({ orgId: org._id, prefix: 'ORD', year: 0, lastNumber: 0, displayPrefix: 'POR' } as any)

    const copied = await copyLegacyDisplayOverrides(orgId, true)
    expect(copied.length).toBe(1)
    const target: any = await Sequence.findOne({ orgId: org._id, prefix: 'ORDER', year: 0 }).lean()
    expect(target.displayPrefix).toBe('POR')

    // Idempotent: an existing target override is never overwritten.
    const again = await copyLegacyDisplayOverrides(orgId, true)
    expect(again.length).toBe(0)
  })
})
