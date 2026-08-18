import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestUser,
  createTestWarehouse,
  createTestProduct,
  createTestContact,
} from '../helpers/factories'
import { createDraftInvoice, convertDraftInvoice, splitAcrossAllocations, type DraftResult } from 'invoicing-api/src/lib/bill-import'
import { Order, Invoice, Reservation, StockLevel, SupplierProductAlias, normalizeAlias } from 'db/models'
import { config } from 'config'
import { mongoose } from 'db/connection'

const { Types } = mongoose

beforeAll(async () => {
  await setupTestDB()
  // Keep the AI matching rung offline-deterministic: point the ocr-server URL at a
  // closed port so aiMatchLines fails fast and returns all-null.
  ;(config.ocr as any).serverUrl = 'http://127.0.0.1:9'
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const ORG_EIK = '112500982'
const SUPPLIER_EIK = '204777001'
const SUPPLIER_WORDING = 'Senkschraube DIN 963 M4x70 A2'

function billDraft(lines: any[]): DraftResult {
  const net = lines.reduce((s, l) => s + l.total, 0)
  return {
    extraction: {
      document_number: '77001234',
      issue_date: '2026-07-25',
      currency: 'EUR',
      exchange_rate: 1,
      supplier: { name: 'Fastbolt GmbH', company_id: SUPPLIER_EIK },
      customer: { name: 'РЕГАЛ ООД', company_id: ORG_EIK },
      line_items: lines,
      net_total: +net.toFixed(2),
      vat_total: +(net * 0.2).toFixed(2),
      gross_total: +(net * 1.2).toFixed(2),
    },
    validation: { status: 'valid', checks: [] },
    model: 'test',
    engine: 'test',
  }
}

async function buildFixture() {
  const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
  const user = await createTestUser(org._id)
  const wh1 = await createTestWarehouse(org._id, { isDefault: true })
  const wh2 = await createTestWarehouse(org._id)
  const supplier = await createTestContact(org._id, { type: 'supplier', companyName: 'Fastbolt GmbH', taxId: SUPPLIER_EIK } as any)
  const client = await createTestContact(org._id, { companyName: 'Клиент Едно' })
  const product = await createTestProduct(org._id, { name: 'ВИНТ М4Х70 - DIN 963' } as any)

  const order: any = await Order.create({
    orgId: org._id,
    orderNumber: 'ORD-2026-00001',
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
            sku: product.sku,
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

  // Client reservation on the WH1 allocation (first-class RES- document).
  const g = order.supplierGroups[0]
  const line = g.lines[0]
  const reservation = await Reservation.create({
    orgId: org._id,
    reservationNumber: 'RES-2026-00001',
    status: 'active',
    statusHistory: [{ status: 'active', changedAt: new Date() }],
    contactId: client._id,
    source: 'order',
    warehouseId: wh1._id,
    orderId: order._id,
    groupId: g._id,
    lineId: line._id,
    allocationId: line.allocations[0]._id,
    productId: product._id,
    quantity: 300,
    createdBy: new Types.ObjectId(),
  } as any)

  return { org, user, wh1, wh2, supplier, client, product, order, reservation }
}

describe('ORD-aware purchase invoice import', () => {
  it('splitAcrossAllocations fills capacity in order, overflow → fallback WH', () => {
    const line = {
      allocations: [
        { _id: 'a1', warehouseId: 'w1', quantity: 700, receivedQuantity: 0 },
        { _id: 'a2', warehouseId: 'w2', quantity: 300, receivedQuantity: 100 },
      ],
    }
    expect(splitAcrossAllocations(line, 1000, 'wDef')).toEqual([
      { warehouseId: 'w1', allocationId: 'a1', quantity: 700 },
      { warehouseId: 'w2', allocationId: 'a2', quantity: 200 },
      { warehouseId: 'wDef', quantity: 100 },
    ])
    expect(splitAcrossAllocations(line, 400, 'wDef')).toEqual([
      { warehouseId: 'w1', allocationId: 'a1', quantity: 400 },
    ])
  })

  it('alias match + allocation split + receipt sync + reservation holds', async () => {
    const fx = await buildFixture()

    // Learned mapping from a previous delivery: supplier wording → our product.
    await SupplierProductAlias.create({
      orgId: fx.org._id,
      supplierId: fx.supplier._id,
      aliasText: SUPPLIER_WORDING,
      aliasNormalized: normalizeAlias(SUPPLIER_WORDING),
      productId: fx.product._id,
      source: 'user',
      hits: 0,
      lastUsedAt: new Date(),
    } as any)

    const draft = billDraft([
      { description: SUPPLIER_WORDING, quantity: 1000, unit: 'Stk', unit_price: 0.05, vat_rate: 20, total: 50 },
    ])
    const { invoice, direction, orderGroupMatched, perLine } = await createDraftInvoice(
      String(fx.org._id), String(fx.user._id), draft, String(fx.wh1._id), 'batch-1', '', { orderId: String(fx.order._id) },
    )

    expect(direction).toBe('incoming')
    expect(orderGroupMatched).toBe(true)
    expect(perLine[0].matchedBy).toBe('alias')
    expect(String((invoice as any).orderId)).toBe(String(fx.order._id))

    // 1000 split across the order's allocations: 700 → WH1, 300 → WH2.
    const stored: any = await Invoice.findById(invoice.id || invoice._id).lean()
    expect(stored.lines.length).toBe(2)
    expect(stored.lines[0].quantity).toBe(700)
    expect(String(stored.lines[0].warehouseId)).toBe(String(fx.wh1._id))
    expect(stored.lines[0].orderRef?.allocationId).toBeDefined()
    expect(stored.lines[1].quantity).toBe(300)
    expect(String(stored.lines[1].warehouseId)).toBe(String(fx.wh2._id))
    // Catalog name shown, supplier wording preserved for learning/audit.
    expect(stored.lines[0].description).toBe('ВИНТ М4Х70 - DIN 963')
    expect(stored.lines[0].sourceText).toBe(SUPPLIER_WORDING)
    // Line totals still sum to the document's net line total.
    expect(+(stored.lines[0].lineTotal + stored.lines[1].lineTotal).toFixed(2)).toBe(50)
    expect(stored.tags).toContain('ord:ORD-2026-00001')

    // Convert → received: stock receipt + order receipt booking + holds.
    const res = await convertDraftInvoice(String(fx.org._id), String(stored._id), String(fx.user._id))
    expect(res.ok).toBe(true)

    const syncedOrder: any = await Order.findById(fx.order._id).lean()
    expect(syncedOrder.status).toBe('received')
    const line = syncedOrder.supplierGroups[0].lines[0]
    expect(line.receivedQuantity).toBe(1000)
    expect(line.allocations[0].receivedQuantity).toBe(700)
    expect(line.allocations[1].receivedQuantity).toBe(300)

    const sl1: any = await StockLevel.findOne({ orgId: fx.org._id, warehouseId: fx.wh1._id }).lean()
    expect(sl1.quantity).toBe(700)
    expect(sl1.reservedQuantity).toBe(300) // client reservation activated by the receipt
    expect(sl1.availableQuantity).toBe(400)
    const sl2: any = await StockLevel.findOne({ orgId: fx.org._id, warehouseId: fx.wh2._id }).lean()
    expect(sl2.quantity).toBe(300)
    expect(sl2.reservedQuantity).toBe(0)

    // Alias hit counter bumped.
    const alias: any = await SupplierProductAlias.findOne({ orgId: fx.org._id }).lean()
    expect(alias.hits).toBeGreaterThanOrEqual(1)
  })

  it('learns an alias from a review-step fix and reuses it on the next import', async () => {
    const fx = await buildFixture()
    const wording = 'Screw DIN963 4x70mm stainless'

    const draft = billDraft([
      { description: wording, quantity: 100, unit: 'Stk', unit_price: 0.05, vat_rate: 20, total: 5 },
    ])
    const first = await createDraftInvoice(
      String(fx.org._id), String(fx.user._id), draft, String(fx.wh1._id), 'batch-2', '', { orderId: String(fx.order._id) },
    )
    // No alias, no exact match, AI offline → free-text line.
    expect(first.perLine[0].matched).toBe(false)

    // The user fixes the line in the review UI (sets the product; sourceText survives).
    await Invoice.updateOne(
      { _id: first.invoice.id || first.invoice._id },
      { $set: { 'lines.0.productId': fx.product._id, 'lines.0.warehouseId': fx.wh1._id } },
    )
    const conv = await convertDraftInvoice(String(fx.org._id), String(first.invoice.id || first.invoice._id), String(fx.user._id))
    expect(conv.ok).toBe(true)

    // The fix was learned…
    const alias: any = await SupplierProductAlias.findOne({ orgId: fx.org._id, aliasNormalized: normalizeAlias(wording) }).lean()
    expect(alias).toBeTruthy()
    expect(String(alias.productId)).toBe(String(fx.product._id))

    // …and the next import of the same wording matches via the alias.
    const second = await createDraftInvoice(
      String(fx.org._id), String(fx.user._id), billDraft([
        { description: wording, quantity: 50, unit: 'Stk', unit_price: 0.05, vat_rate: 20, total: 2.5 },
      ]), String(fx.wh1._id), 'batch-3', '', { orderId: String(fx.order._id) },
    )
    expect(second.perLine[0].matched).toBe(true)
    expect(second.perLine[0].matchedBy).toBe('alias')
  })

  it('without a matching supplier group the draft stays unlinked and is tagged', async () => {
    const fx = await buildFixture()
    const otherSupplier = await createTestContact(fx.org._id, { type: 'supplier', companyName: 'Reyer GmbH', taxId: '131222333' } as any)

    const draft: DraftResult = {
      ...billDraft([{ description: 'Something', quantity: 1, unit: 'pcs', unit_price: 1, vat_rate: 20, total: 1 }]),
    }
    draft.extraction.supplier = { name: 'Reyer GmbH', company_id: '131222333' }

    const res = await createDraftInvoice(
      String(fx.org._id), String(fx.user._id), draft, String(fx.wh1._id), 'batch-4', '', { orderId: String(fx.order._id) },
    )
    expect(res.orderGroupMatched).toBe(false)
    const stored: any = await Invoice.findById(res.invoice.id || res.invoice._id).lean()
    expect(stored.orderId).toBeFalsy()
    expect(stored.tags).toContain('ord-unmatched')
    expect(String(otherSupplier._id)).toBeTruthy()
  })
})
