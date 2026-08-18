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
import { syncOrderForInvoice, syncInternalOrderDerivedState } from 'services/biz/reservation.service'
import { validateStockAvailability } from 'services/biz/invoicing.service'
import {
  createReservation,
  reserveAvailableForInternalOrder,
  completeInternalOrder,
  cancelInternalOrder,
} from 'services/biz/reservation-ops.service'
import { validateReservationLineRefs } from 'invoicing-api/src/controllers/invoice.controller'

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

const USER = () => String(new Types.ObjectId())

async function buildFixture(opts: { quantity?: number; stock?: number } = {}) {
  const org = await createTestOrg()
  const client = await createTestContact(org._id, { companyName: 'Клиент Едно' })
  const product = await createTestProduct(org._id, { name: 'ВИНТ М8Х25 - DIN 933' })
  const wh1 = await createTestWarehouse(org._id, { isDefault: true })
  const deadline = new Date(Date.now() + 7 * 24 * 3600 * 1000)
  if ((opts.stock ?? 500) > 0) {
    await createTestStockLevel(org._id, product._id, wh1._id, {
      quantity: opts.stock ?? 500,
      availableQuantity: opts.stock ?? 500,
      avgCost: 0.1,
    } as any)
  }
  const ordi: any = await InternalOrder.create({
    orgId: org._id,
    orderNumber: 'ORDI-2026-00001',
    status: 'confirmed',
    statusHistory: [{ status: 'confirmed', changedAt: new Date() }],
    contactId: client._id,
    issueDate: new Date(),
    requestedDeliveryDate: deadline,
    priority: 'normal',
    warehouseId: wh1._id,
    currency: 'EUR',
    exchangeRate: 1,
    lines: [
      { productId: product._id, description: product.name, quantity: opts.quantity ?? 300, unit: 'pcs' },
    ],
    createdBy: new Types.ObjectId(),
  } as any)
  return { org, client, product, wh1, ordi, line: ordi.lines[0], deadline }
}

async function createConversionInvoice(fx: any, res: any, qty: number, status = 'draft') {
  return Invoice.create({
    orgId: fx.org._id,
    invoiceNumber: `DRF-INV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'invoice',
    direction: 'outgoing',
    status,
    contactId: fx.client._id,
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
        unitPrice: 0.2,
        discount: 0,
        taxRate: 20,
        taxAmount: 0,
        lineTotal: 0,
        warehouseId: res.warehouseId,
        orderRef: {
          reservationId: res._id,
          internalOrderId: fx.ordi._id,
          internalOrderLineId: fx.line._id,
        },
      },
    ],
    subtotal: 0,
    taxTotal: 0,
    total: 0,
    totalBase: 0,
    amountDue: 0,
    billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
    internalOrderId: fx.ordi._id,
    createdBy: new Types.ObjectId(),
  } as any)
}

describe('Internal order (ORDI) flow', () => {
  it('reserve-available creates stock-source reservations capped by availability', async () => {
    const fx = await buildFixture({ quantity: 300, stock: 500 })
    const { created, short } = await reserveAvailableForInternalOrder(String(fx.org._id), USER(), String(fx.ordi._id))
    expect(created.length).toBe(1)
    expect(created[0].source).toBe('stock')
    expect(created[0].quantity).toBe(300)
    expect(created[0].reservationNumber).toMatch(/^RES-\d{4}-\d{5}$/)
    expect(short).toEqual([])

    const sl: any = await StockLevel.findOne({ orgId: fx.org._id, warehouseId: fx.wh1._id }).lean()
    expect(sl.reservedQuantity).toBe(300)
    expect(sl.availableQuantity).toBe(200)
    const ordi: any = await InternalOrder.findById(fx.ordi._id).lean()
    expect(ordi.lines[0].reservedQuantity).toBe(300)

    // A second, bigger ORDI can only reserve the remaining 200.
    const ordi2: any = await InternalOrder.create({
      orgId: fx.org._id,
      orderNumber: 'ORDI-2026-00002',
      status: 'confirmed',
      statusHistory: [{ status: 'confirmed', changedAt: new Date() }],
      contactId: fx.client._id,
      issueDate: new Date(),
      requestedDeliveryDate: new Date(Date.now() + 3 * 24 * 3600 * 1000),
      currency: 'EUR',
      exchangeRate: 1,
      lines: [{ productId: fx.product._id, description: 'x', quantity: 400, unit: 'pcs' }],
      createdBy: new Types.ObjectId(),
    } as any)
    const second = await reserveAvailableForInternalOrder(String(fx.org._id), USER(), String(ordi2._id))
    expect(second.created.length).toBe(1)
    expect(second.created[0].quantity).toBe(200)
    expect(second.short).toEqual([{ lineId: String(ordi2.lines[0]._id), productId: String(fx.product._id), missing: 200 }])
  })

  it('stock-source hold blocks others; own lines share ONE exemption budget per reservation', async () => {
    const fx = await buildFixture({ quantity: 300, stock: 500 })
    const { created } = await reserveAvailableForInternalOrder(String(fx.org._id), USER(), String(fx.ordi._id))
    const res = created[0]

    // Third party: 300 > 200 free → blocked; 200 → fine.
    const blocked = await captureRejection(validateStockAvailability(String(fx.org._id), [
      { productId: String(fx.product._id), warehouseId: String(fx.wh1._id), quantity: 300 },
    ]))
    expect(String(blocked?.message)).toContain('Insufficient stock')
    const ok = await captureRejection(validateStockAvailability(String(fx.org._id), [
      { productId: String(fx.product._id), warehouseId: String(fx.wh1._id), quantity: 200 },
    ]))
    expect(ok).toBeNull()

    // The reservation's own dispatch is exempt up to its open quantity…
    const exempt = await captureRejection(validateStockAvailability(String(fx.org._id), [
      { productId: String(fx.product._id), warehouseId: String(fx.wh1._id), quantity: 300, orderRef: { reservationId: String(res._id) } } as any,
    ]))
    expect(exempt).toBeNull()

    // …but two lines on the SAME reservation share one budget: the second competes for
    // free stock (needs 300, only 200 free) → blocked.
    const doubleDip = await captureRejection(validateStockAvailability(String(fx.org._id), [
      { productId: String(fx.product._id), warehouseId: String(fx.wh1._id), quantity: 300, orderRef: { reservationId: String(res._id) } } as any,
      { productId: String(fx.product._id), warehouseId: String(fx.wh1._id), quantity: 300, orderRef: { reservationId: String(res._id) } } as any,
    ]))
    expect(String(doubleDip?.message)).toContain('Insufficient stock')
  })

  it('conversion + dispatch drive delivered status; void reopens', async () => {
    const fx = await buildFixture({ quantity: 300, stock: 500 })
    const { created } = await reserveAvailableForInternalOrder(String(fx.org._id), USER(), String(fx.ordi._id))
    const res = created[0]

    // Draft conversion: invoiced, not delivered; hold intact.
    const inv = await createConversionInvoice(fx, res, 300, 'draft')
    await syncOrderForInvoice(String(fx.org._id), inv)
    let r: any = await Reservation.findById(res._id).lean()
    expect(r.invoicedQuantity).toBe(300)
    let ordi: any = await InternalOrder.findById(fx.ordi._id).lean()
    expect(ordi.lines[0].invoicedQuantity).toBe(300)
    expect(ordi.status).toBe('confirmed')

    // Send: dispatch drops stock, hold follows, ORDI → delivered, RES → fulfilled.
    await Invoice.updateOne({ _id: inv._id }, { status: 'sent' })
    await StockLevel.updateOne({ orgId: fx.org._id, warehouseId: fx.wh1._id }, { $inc: { quantity: -300 } })
    await syncOrderForInvoice(String(fx.org._id), await Invoice.findById(inv._id).lean())
    r = await Reservation.findById(res._id).lean()
    expect(r.dispatchedQuantity).toBe(300)
    expect(r.status).toBe('fulfilled')
    ordi = await InternalOrder.findById(fx.ordi._id).lean()
    expect(ordi.lines[0].deliveredQuantity).toBe(300)
    expect(ordi.status).toBe('delivered')
    let sl: any = await StockLevel.findOne({ orgId: fx.org._id, warehouseId: fx.wh1._id }).lean()
    expect(sl.reservedQuantity).toBe(0)
    expect(sl.availableQuantity).toBe(200)

    // Void: stock returns, counters reopen, ORDI back to confirmed, hold re-materialises.
    await Invoice.updateOne({ _id: inv._id }, { status: 'voided' })
    await StockLevel.updateOne({ orgId: fx.org._id, warehouseId: fx.wh1._id }, { $inc: { quantity: 300 } })
    await syncOrderForInvoice(String(fx.org._id), await Invoice.findById(inv._id).lean())
    r = await Reservation.findById(res._id).lean()
    expect(r.invoicedQuantity).toBe(0)
    expect(r.dispatchedQuantity).toBe(0)
    expect(r.status).toBe('active')
    ordi = await InternalOrder.findById(fx.ordi._id).lean()
    expect(ordi.status).toBe('confirmed')
    sl = await StockLevel.findOne({ orgId: fx.org._id, warehouseId: fx.wh1._id }).lean()
    expect(sl.reservedQuantity).toBe(300)
  })

  it('void AFTER complete does not resurrect the hold', async () => {
    const fx = await buildFixture({ quantity: 300, stock: 500 })
    const { created } = await reserveAvailableForInternalOrder(String(fx.org._id), USER(), String(fx.ordi._id))
    const res = created[0]
    const inv = await createConversionInvoice(fx, res, 300, 'sent')
    await StockLevel.updateOne({ orgId: fx.org._id, warehouseId: fx.wh1._id }, { $inc: { quantity: -300 } })
    await syncOrderForInvoice(String(fx.org._id), await Invoice.findById(inv._id).lean())
    await completeInternalOrder(String(fx.org._id), USER(), String(fx.ordi._id))
    let ordi: any = await InternalOrder.findById(fx.ordi._id).lean()
    expect(ordi.status).toBe('completed')

    // Void the delivery after the ORDI is closed: the reservation must NOT reactivate.
    await Invoice.updateOne({ _id: inv._id }, { status: 'voided' })
    await StockLevel.updateOne({ orgId: fx.org._id, warehouseId: fx.wh1._id }, { $inc: { quantity: 300 } })
    await syncOrderForInvoice(String(fx.org._id), await Invoice.findById(inv._id).lean())
    const r: any = await Reservation.findById(res._id).lean()
    expect(r.status).toBe('cancelled')
    expect(r.cancelReason).toBe('released')
    const sl: any = await StockLevel.findOne({ orgId: fx.org._id, warehouseId: fx.wh1._id }).lean()
    expect(sl.reservedQuantity).toBe(0)
    expect(sl.availableQuantity).toBe(sl.quantity)
    ordi = await InternalOrder.findById(fx.ordi._id).lean()
    expect(ordi.status).toBe('completed')
  })

  it('complete releases open reservation remainders', async () => {
    const fx = await buildFixture({ quantity: 300, stock: 500 })
    const { created } = await reserveAvailableForInternalOrder(String(fx.org._id), USER(), String(fx.ordi._id))
    await completeInternalOrder(String(fx.org._id), USER(), String(fx.ordi._id))
    const r: any = await Reservation.findById(created[0]._id).lean()
    expect(r.status).toBe('cancelled')
    expect(r.cancelReason).toBe('released')
    const sl: any = await StockLevel.findOne({ orgId: fx.org._id, warehouseId: fx.wh1._id }).lean()
    expect(sl.reservedQuantity).toBe(0)
  })

  it('cancel cascades reservations; blocked while live invoices exist', async () => {
    const fx = await buildFixture({ quantity: 300, stock: 500 })
    const { created } = await reserveAvailableForInternalOrder(String(fx.org._id), USER(), String(fx.ordi._id))
    const inv = await createConversionInvoice(fx, created[0], 100, 'draft')
    await syncOrderForInvoice(String(fx.org._id), inv)

    const blocked = await captureRejection(cancelInternalOrder(String(fx.org._id), USER(), String(fx.ordi._id)))
    expect((blocked as any)?.statusCode).toBe(409)

    await Invoice.deleteOne({ _id: inv._id })
    await syncOrderForInvoice(String(fx.org._id), inv)
    await cancelInternalOrder(String(fx.org._id), USER(), String(fx.ordi._id))
    const r: any = await Reservation.findById(created[0]._id).lean()
    expect(r.status).toBe('cancelled')
    expect(r.cancelReason).toBe('internal_order_cancelled')
    const ordi: any = await InternalOrder.findById(fx.ordi._id).lean()
    expect(ordi.status).toBe('cancelled')
    const sl: any = await StockLevel.findOne({ orgId: fx.org._id, warehouseId: fx.wh1._id }).lean()
    expect(sl.reservedQuantity).toBe(0)
  })

  it('createReservation validates availability, allocation capacity and line demand', async () => {
    const fx = await buildFixture({ quantity: 300, stock: 100 })

    // Stock-source: 300 > 100 available → 422.
    const insufficient = await captureRejection(createReservation(String(fx.org._id), USER(), {
      source: 'stock',
      productId: String(fx.product._id),
      quantity: 300,
      internalOrderId: String(fx.ordi._id),
      internalOrderLineId: String(fx.line._id),
      warehouseId: String(fx.wh1._id),
    }))
    expect((insufficient as any)?.statusCode).toBe(422)
    expect(String(insufficient?.message)).toContain('Insufficient available stock')

    // Order-source: allocation of 100, reserve 80 OK, +30 more → 422 (free 20).
    const supplier = await createTestContact(fx.org._id, { type: 'supplier', companyName: 'Sup' })
    const order: any = await Order.create({
      orgId: fx.org._id,
      orderNumber: 'ORDO-2026-00009',
      status: 'draft',
      statusHistory: [{ status: 'draft', changedAt: new Date() }],
      issueDate: new Date(),
      currency: 'EUR',
      exchangeRate: 1,
      supplierGroups: [{
        supplierId: supplier._id,
        lines: [{ productId: fx.product._id, description: 'x', quantity: 100, unit: 'pcs', allocations: [{ warehouseId: fx.wh1._id, quantity: 100 }] }],
      }],
      createdBy: new Types.ObjectId(),
    } as any)
    const g = order.supplierGroups[0]
    const supply = {
      source: 'order' as const,
      productId: String(fx.product._id),
      orderId: String(order._id),
      groupId: String(g._id),
      lineId: String(g.lines[0]._id),
      allocationId: String(g.lines[0].allocations[0]._id),
      internalOrderId: String(fx.ordi._id),
      internalOrderLineId: String(fx.line._id),
    }
    const first = await createReservation(String(fx.org._id), USER(), { ...supply, quantity: 80 })
    expect(first.source).toBe('order')
    expect(String(first.warehouseId)).toBe(String(fx.wh1._id))
    // Draft-ORDO reservation records intent but holds nothing yet.
    const sl: any = await StockLevel.findOne({ orgId: fx.org._id, warehouseId: fx.wh1._id }).lean()
    expect(sl.reservedQuantity).toBe(0)

    const overAlloc = await captureRejection(createReservation(String(fx.org._id), USER(), { ...supply, quantity: 30 }))
    expect((overAlloc as any)?.statusCode).toBe(422)
    expect(String(overAlloc?.message)).toContain('free')

    // Line demand: 80 reserved of 300 → open 220; asking 250 → 422.
    const overDemand = await captureRejection(createReservation(String(fx.org._id), USER(), {
      source: 'stock',
      productId: String(fx.product._id),
      quantity: 250,
      internalOrderId: String(fx.ordi._id),
      internalOrderLineId: String(fx.line._id),
      warehouseId: String(fx.wh1._id),
    }))
    expect((overDemand as any)?.statusCode).toBe(422)
    expect(String(overDemand?.message)).toContain('open demand')

    // Contact mismatch guard.
    const other = await createTestContact(fx.org._id, { companyName: 'Друг' })
    const mismatch = await captureRejection(createReservation(String(fx.org._id), USER(), {
      source: 'stock',
      productId: String(fx.product._id),
      quantity: 10,
      contactId: String(other._id),
      internalOrderId: String(fx.ordi._id),
      internalOrderLineId: String(fx.line._id),
      warehouseId: String(fx.wh1._id),
    }))
    expect((mismatch as any)?.statusCode).toBe(422)
  })

  it('validateReservationLineRefs: bills rejected, over-invoicing capped, sales types only', async () => {
    const fx = await buildFixture({ quantity: 300, stock: 500 })
    const { created } = await reserveAvailableForInternalOrder(String(fx.org._id), USER(), String(fx.ordi._id))
    const res = created[0]
    const orgId = String(fx.org._id)
    const line = (qty: number) => ({ quantity: qty, orderRef: { reservationId: String(res._id) } })

    // Bills must never reference reservations.
    expect(await validateReservationLineRefs(orgId, { type: 'invoice', direction: 'incoming', lines: [line(10)] }))
      .toContain('Purchase documents')
    // Only sales invoices consume reservations.
    expect(await validateReservationLineRefs(orgId, { type: 'cash_sale', direction: 'outgoing', lines: [line(10)] }))
      .toContain('Only sales invoices')
    expect(await validateReservationLineRefs(orgId, { type: 'credit_note', direction: 'outgoing', lines: [line(10)] }))
      .toContain('Only sales invoices')

    // Within the reserved quantity → fine.
    expect(await validateReservationLineRefs(orgId, { type: 'invoice', direction: 'outgoing', lines: [line(300)] })).toBeNull()
    // Above it → capped.
    const over = await validateReservationLineRefs(orgId, { type: 'invoice', direction: 'outgoing', lines: [line(301)] })
    expect(over).toContain('exceeds reserved')

    // Existing live invoices count toward the cap.
    const inv = await createConversionInvoice(fx, res, 200, 'draft')
    const combined = await validateReservationLineRefs(orgId, { type: 'invoice', direction: 'outgoing', lines: [line(150)] })
    expect(combined).toContain('exceeds reserved')
    expect(await validateReservationLineRefs(orgId, { type: 'invoice', direction: 'outgoing', lines: [line(100)] })).toBeNull()
    // Editing that same invoice excludes its own previous version from the sum.
    expect(await validateReservationLineRefs(orgId, { type: 'invoice', direction: 'outgoing', lines: [line(300)] }, String(inv._id))).toBeNull()
  })
})
