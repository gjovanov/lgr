import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestContact,
  createTestProduct,
  createTestWarehouse,
  createTestStockLevel,
} from '../helpers/factories'
import { Order, Invoice, Reservation, StockLevel } from 'db/models'
import { mongoose } from 'db/connection'
import {
  syncOrderDerivedState,
  syncReservedQuantities,
  activeReservedForAllocation,
  collectOrderStockKeys,
} from 'services/biz/reservation.service'
import { validateStockAvailability } from 'services/biz/invoicing.service'

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

// Windows/Bun: expect().rejects after Mongo I/O can deadlock — capture instead.
async function captureRejection<T>(p: Promise<T>): Promise<Error | null> {
  try {
    await p
    return null
  } catch (e: any) {
    return e
  }
}

/** The user's canonical example: qty 1000 → WH1 700 [C1 300, C2 200], WH2 300 [C3 100].
 * Reservations are first-class RES- documents pointing into the order's allocations. */
async function buildOrderFixture() {
  const org = await createTestOrg()
  const supplier = await createTestContact(org._id, { type: 'supplier', companyName: 'Fastbolt' })
  const c1 = await createTestContact(org._id, { companyName: 'Client One' })
  const c2 = await createTestContact(org._id, { companyName: 'Client Two' })
  const c3 = await createTestContact(org._id, { companyName: 'Client Three' })
  const product = await createTestProduct(org._id, { name: 'ВИНТ М4Х70 - DIN 963' })
  const wh1 = await createTestWarehouse(org._id, { isDefault: true })
  const wh2 = await createTestWarehouse(org._id)

  const order = await Order.create({
    orgId: org._id,
    orderNumber: 'ORDO-2026-00001',
    status: 'sent',
    statusHistory: [{ status: 'sent', changedAt: new Date() }],
    issueDate: new Date(),
    currency: 'EUR',
    exchangeRate: 1,
    supplierGroups: [
      {
        supplierId: supplier._id,
        lines: [
          {
            productId: product._id,
            description: product.name,
            quantity: 1000,
            unit: 'pcs',
            allocations: [
              { warehouseId: wh1._id, quantity: 700 },
              { warehouseId: wh2._id, quantity: 300 },
            ],
          },
        ],
      },
    ],
    createdBy: new Types.ObjectId(),
  } as any)

  const g = (order as any).supplierGroups[0]
  const line = g.lines[0]
  const [alloc1, alloc2] = line.allocations
  const mkRes = (n: number, contactId: any, alloc: any, qty: number) =>
    Reservation.create({
      orgId: org._id,
      reservationNumber: `RES-2026-0000${n}`,
      status: 'active',
      statusHistory: [{ status: 'active', changedAt: new Date() }],
      contactId,
      source: 'order',
      warehouseId: alloc.warehouseId,
      orderId: order._id,
      groupId: g._id,
      lineId: line._id,
      allocationId: alloc._id,
      productId: product._id,
      quantity: qty,
      createdBy: new Types.ObjectId(),
    } as any)
  const res1 = await mkRes(1, c1._id, alloc1, 300)
  const res2 = await mkRes(2, c2._id, alloc1, 200)
  const res3 = await mkRes(3, c3._id, alloc2, 100)

  return { org, supplier, c1, c2, c3, product, wh1, wh2, order, res1, res2, res3 }
}

function groupRefs(order: any) {
  const g = order.supplierGroups[0]
  const line = g.lines[0]
  return {
    groupId: g._id,
    lineId: line._id,
    alloc1: line.allocations[0],
    alloc2: line.allocations[1],
  }
}

async function createLinkedBill(fx: any, opts: { status?: string; qty1?: number; qty2?: number } = {}) {
  const { groupId, lineId, alloc1, alloc2 } = groupRefs(fx.order)
  const lines: any[] = []
  if ((opts.qty1 ?? 700) > 0) {
    lines.push({
      productId: fx.product._id,
      description: fx.product.name,
      quantity: opts.qty1 ?? 700,
      unit: 'pcs',
      unitPrice: 0.05,
      discount: 0,
      taxRate: 20,
      taxAmount: 0,
      lineTotal: 0,
      warehouseId: fx.wh1._id,
      orderRef: { groupId, lineId, allocationId: alloc1._id },
    })
  }
  if ((opts.qty2 ?? 300) > 0) {
    lines.push({
      productId: fx.product._id,
      description: fx.product.name,
      quantity: opts.qty2 ?? 300,
      unit: 'pcs',
      unitPrice: 0.05,
      discount: 0,
      taxRate: 20,
      taxAmount: 0,
      lineTotal: 0,
      warehouseId: fx.wh2._id,
      orderRef: { groupId, lineId, allocationId: alloc2._id },
    })
  }
  return Invoice.create({
    orgId: fx.org._id,
    invoiceNumber: `BILL-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'invoice',
    direction: 'incoming',
    status: opts.status || 'received',
    contactId: fx.supplier._id,
    issueDate: new Date(),
    dueDate: new Date(),
    currency: 'EUR',
    exchangeRate: 1,
    lines,
    subtotal: 0,
    taxTotal: 0,
    total: 0,
    totalBase: 0,
    amountDue: 0,
    billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
    orderId: fx.order._id,
    orderGroupId: groupId,
    createdBy: new Types.ObjectId(),
  } as any)
}

async function createConversionInvoice(fx: any, reservation: any, alloc: any, qty: number, status = 'draft') {
  const { groupId, lineId } = groupRefs(fx.order)
  return Invoice.create({
    orgId: fx.org._id,
    invoiceNumber: `DRF-INV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'invoice',
    direction: 'outgoing',
    status,
    contactId: reservation.contactId,
    issueDate: new Date(),
    dueDate: new Date(),
    currency: 'EUR',
    exchangeRate: 1,
    lines: [
      {
        productId: fx.product._id,
        description: fx.product.name,
        quantity: qty,
        unit: 'pcs',
        unitPrice: 0.1,
        discount: 0,
        taxRate: 20,
        taxAmount: 0,
        lineTotal: 0,
        warehouseId: alloc.warehouseId,
        orderRef: { groupId, lineId, allocationId: alloc._id, reservationId: reservation._id },
      },
    ],
    subtotal: 0,
    taxTotal: 0,
    total: 0,
    totalBase: 0,
    amountDue: 0,
    billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
    orderId: fx.order._id,
    createdBy: new Types.ObjectId(),
  } as any)
}

describe('Order reservations flow', () => {
  it('holds nothing before receipt; books receipt + activates holds after', async () => {
    const fx = await buildOrderFixture()

    // Before any receipt: sync leaves no holds.
    await syncOrderDerivedState(String(fx.org._id), String(fx.order._id))
    let levels = await StockLevel.find({ orgId: fx.org._id }).lean()
    expect(levels.every((l: any) => (l.reservedQuantity || 0) === 0)).toBe(true)

    // Goods arrive: stock levels exist (receipt movement side-effect) + received bill linked.
    await createTestStockLevel(fx.org._id, fx.product._id, fx.wh1._id, { quantity: 700, availableQuantity: 700, avgCost: 0.05 } as any)
    await createTestStockLevel(fx.org._id, fx.product._id, fx.wh2._id, { quantity: 300, availableQuantity: 300, avgCost: 0.05 } as any)
    await createLinkedBill(fx)

    const synced: any = await syncOrderDerivedState(String(fx.org._id), String(fx.order._id))
    expect(synced.status).toBe('received')
    const line = synced.supplierGroups[0].lines[0]
    expect(line.receivedQuantity).toBe(1000)
    expect(line.allocations[0].receivedQuantity).toBe(700)
    expect(line.allocations[1].receivedQuantity).toBe(300)

    // WH1: 300 + 200 reserved of 700 received → hold 500, available 200.
    const sl1: any = await StockLevel.findOne({ orgId: fx.org._id, warehouseId: fx.wh1._id })
    expect(sl1.reservedQuantity).toBe(500)
    expect(sl1.availableQuantity).toBe(200)
    // WH2: 100 reserved of 300 → hold 100, available 200.
    const sl2: any = await StockLevel.findOne({ orgId: fx.org._id, warehouseId: fx.wh2._id })
    expect(sl2.reservedQuantity).toBe(100)
    expect(sl2.availableQuantity).toBe(200)
  })

  it('partial receipt caps the hold at the physically received quantity', async () => {
    const fx = await buildOrderFixture()
    await createTestStockLevel(fx.org._id, fx.product._id, fx.wh1._id, { quantity: 400, availableQuantity: 400, avgCost: 0.05 } as any)
    await createLinkedBill(fx, { qty1: 400, qty2: 0 })

    const synced: any = await syncOrderDerivedState(String(fx.org._id), String(fx.order._id))
    expect(synced.status).toBe('partially_received')
    // Open reservations 500 but only 400 received → hold 400, nothing sellable.
    const sl1: any = await StockLevel.findOne({ orgId: fx.org._id, warehouseId: fx.wh1._id })
    expect(sl1.reservedQuantity).toBe(400)
    expect(sl1.availableQuantity).toBe(0)
  })

  it('blocks selling reserved stock to others; reserved client lines are exempt', async () => {
    const fx = await buildOrderFixture()
    await createTestStockLevel(fx.org._id, fx.product._id, fx.wh1._id, { quantity: 700, availableQuantity: 700, avgCost: 0.05 } as any)
    await createLinkedBill(fx, { qty2: 0 })
    await syncOrderDerivedState(String(fx.org._id), String(fx.order._id))

    // A third party asking for 300 @ WH1 exceeds the 200 sellable → rejected.
    const err = await captureRejection(validateStockAvailability(String(fx.org._id), [
      { productId: String(fx.product._id), warehouseId: String(fx.wh1._id), quantity: 300 },
    ]))
    expect(err).not.toBeNull()
    expect(String(err!.message)).toContain('Insufficient stock')

    // 200 (the free remainder) is fine.
    const ok = await captureRejection(validateStockAvailability(String(fx.org._id), [
      { productId: String(fx.product._id), warehouseId: String(fx.wh1._id), quantity: 200 },
    ]))
    expect(ok).toBeNull()

    // The reserved client's own dispatch (line tagged with its reservationId) is exempt.
    const exempt = await captureRejection(validateStockAvailability(String(fx.org._id), [
      {
        productId: String(fx.product._id),
        warehouseId: String(fx.wh1._id),
        quantity: 300,
        orderRef: { reservationId: String(fx.res1._id) },
      } as any,
    ]))
    expect(exempt).toBeNull()
  })

  it('conversion consumes open-to-convert; dispatch releases the hold in step with stock', async () => {
    const fx = await buildOrderFixture()
    await createTestStockLevel(fx.org._id, fx.product._id, fx.wh1._id, { quantity: 700, availableQuantity: 700, avgCost: 0.05 } as any)
    await createLinkedBill(fx, { qty2: 0 })
    await syncOrderDerivedState(String(fx.org._id), String(fx.order._id))

    const { alloc1 } = groupRefs(fx.order)

    // Draft conversion invoice: reservation is invoiced but still holds (goods not shipped).
    const draft = await createConversionInvoice(fx, fx.res1, alloc1, 300, 'draft')
    await syncOrderDerivedState(String(fx.org._id), String(fx.order._id))
    let r: any = await Reservation.findById(fx.res1._id).lean()
    expect(r.invoicedQuantity).toBe(300)
    expect(r.dispatchedQuantity).toBe(0)
    expect(r.invoiceIds.map(String)).toContain(String(draft._id))
    let sl1: any = await StockLevel.findOne({ orgId: fx.org._id, warehouseId: fx.wh1._id })
    expect(sl1.reservedQuantity).toBe(500) // hold unchanged until dispatch
    expect(sl1.availableQuantity).toBe(200)

    // Send: physical stock drops 300 (dispatch movement) and the hold follows.
    await Invoice.updateOne({ _id: draft._id }, { status: 'sent' })
    await StockLevel.updateOne({ _id: sl1._id }, { $inc: { quantity: -300 } })
    await syncOrderDerivedState(String(fx.org._id), String(fx.order._id))
    r = await Reservation.findById(fx.res1._id).lean()
    expect(r.dispatchedQuantity).toBe(300)
    expect(r.status).toBe('fulfilled')
    sl1 = await StockLevel.findOne({ orgId: fx.org._id, warehouseId: fx.wh1._id })
    expect(sl1.quantity).toBe(400)
    expect(sl1.reservedQuantity).toBe(200) // only C2's 200 still held
    expect(sl1.availableQuantity).toBe(200)

    // Deleting a (different) draft re-opens the reservation it consumed.
    const draft2 = await createConversionInvoice(fx, fx.res2, alloc1, 200, 'draft')
    await syncOrderDerivedState(String(fx.org._id), String(fx.order._id))
    let r2: any = await Reservation.findById(fx.res2._id).lean()
    expect(r2.invoicedQuantity).toBe(200)
    await Invoice.deleteOne({ _id: draft2._id })
    await syncOrderDerivedState(String(fx.org._id), String(fx.order._id))
    r2 = await Reservation.findById(fx.res2._id).lean()
    expect(r2.invoicedQuantity).toBe(0)
  })

  it('voided invoices stop counting; completed/cancelled orders release all holds', async () => {
    const fx = await buildOrderFixture()
    await createTestStockLevel(fx.org._id, fx.product._id, fx.wh1._id, { quantity: 700, availableQuantity: 700, avgCost: 0.05 } as any)
    await createLinkedBill(fx, { qty2: 0 })
    await syncOrderDerivedState(String(fx.org._id), String(fx.order._id))

    const { alloc1 } = groupRefs(fx.order)
    const inv = await createConversionInvoice(fx, fx.res1, alloc1, 300, 'sent')
    await syncOrderDerivedState(String(fx.org._id), String(fx.order._id))
    let r: any = await Reservation.findById(fx.res1._id).lean()
    expect(r.dispatchedQuantity).toBe(300)
    expect(r.status).toBe('fulfilled')

    await Invoice.updateOne({ _id: inv._id }, { status: 'voided' })
    const synced: any = await syncOrderDerivedState(String(fx.org._id), String(fx.order._id))
    r = await Reservation.findById(fx.res1._id).lean()
    expect(r.invoicedQuantity).toBe(0)
    expect(r.dispatchedQuantity).toBe(0)
    expect(r.status).toBe('active') // demand still live → hold reactivates

    // Completing the order releases every remaining hold.
    await Order.updateOne({ _id: fx.order._id }, { status: 'completed' })
    await syncReservedQuantities(String(fx.org._id), collectOrderStockKeys(synced))
    const sl1: any = await StockLevel.findOne({ orgId: fx.org._id, warehouseId: fx.wh1._id })
    expect(sl1.reservedQuantity).toBe(0)
    expect(sl1.availableQuantity).toBe(sl1.quantity)
  })

  it('full recompute zeroes stale holds no open order backs anymore', async () => {
    const fx = await buildOrderFixture()
    const sl = await createTestStockLevel(fx.org._id, fx.product._id, fx.wh1._id, {
      quantity: 500,
      reservedQuantity: 123,
      availableQuantity: 377,
    } as any)
    await Order.updateOne({ _id: fx.order._id }, { status: 'cancelled' })

    await syncReservedQuantities(String(fx.org._id))
    const after: any = await StockLevel.findById(sl._id)
    expect(after.reservedQuantity).toBe(0)
    expect(after.availableQuantity).toBe(500)
  })

  it('activeReservedForAllocation math', () => {
    // Nothing received → no hold.
    expect(activeReservedForAllocation({ receivedQuantity: 0 }, [{ quantity: 300 }])).toBe(0)
    // Fully received → full open hold.
    expect(activeReservedForAllocation({ receivedQuantity: 700 }, [{ quantity: 300 }, { quantity: 200 }])).toBe(500)
    // Partial receipt caps.
    expect(activeReservedForAllocation({ receivedQuantity: 400 }, [{ quantity: 300 }, { quantity: 200 }])).toBe(400)
    // Dispatch shrinks both the open hold and the physical cap.
    expect(activeReservedForAllocation({ receivedQuantity: 700 }, [{ quantity: 300, dispatchedQuantity: 300 }, { quantity: 200 }])).toBe(200)
    // A cancelled reservation holds nothing, but its dispatched goods still ate the receipt.
    expect(activeReservedForAllocation({ receivedQuantity: 700 }, [
      { quantity: 300, dispatchedQuantity: 200, status: 'cancelled' },
      { quantity: 200 },
    ])).toBe(200)
  })
})
