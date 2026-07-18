import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestUser,
  createTestContact,
  createTestProduct,
  createTestInvoice,
  createTestFiscalYear,
  createTestFiscalPeriod,
  createTestJournalEntry,
} from '../helpers/factories'
import {
  createInvoiceWithProductUpdates,
  updateInvoiceWithProductUpdates,
  InvoicePostedError,
} from 'services/biz/invoice-with-update.service'
import { GRValidationError } from 'services/biz/product-update.service'
import { Invoice, Product, StockMovement } from 'db/models'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

/**
 * Purchase-bill-with-product-update — mirror of gr-with-update.flow.test.ts.
 * Exercises the service directly (same path the invoice controller uses).
 *
 * Requires replica set in the test environment (MongoMemoryReplSet in setup.ts).
 */

/** try/catch capture instead of `expect(...).rejects` — on Windows, Bun 1.3.12's
 *  `.rejects` matcher deadlocks when the rejection follows MongoDB driver I/O
 *  (the pending op then dies with MongoClientClosedError at teardown). */
async function captureRejection(p: Promise<any>): Promise<any> {
  try {
    await p
    return null
  } catch (e) {
    return e
  }
}

let seq = 0
function billLine(productId: string, quantity: number, unitPrice: number) {
  const net = quantity * unitPrice
  return {
    productId,
    description: 'Test line',
    quantity,
    unit: 'pcs',
    unitPrice,
    discount: 0,
    taxRate: 20,
    taxAmount: +(net * 0.2).toFixed(2),
    lineTotal: +(net * 1.2).toFixed(2),
  }
}

function billDoc(org: any, user: any, contact: any, lines: any[], overrides: Record<string, any> = {}) {
  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)
  const taxTotal = +(subtotal * 0.2).toFixed(2)
  const total = +(subtotal + taxTotal).toFixed(2)
  const now = new Date()
  seq += 1
  const invoiceNumber = `BILL-TEST-${Date.now()}-${seq}`
  return {
    orgId: String(org._id),
    invoiceNumber,
    type: 'invoice',
    direction: 'incoming',
    status: 'draft',
    contactId: String(contact._id),
    issueDate: now,
    dueDate: now,
    currency: 'EUR',
    exchangeRate: 1,
    lines,
    subtotal,
    taxTotal,
    total,
    totalBase: total,
    amountPaid: 0,
    amountDue: total,
    billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
    statusHistory: [{ status: 'draft', changedAt: now, changedBy: String(user._id), reason: 'created' }],
    numberHistory: [{ number: invoiceNumber, allocatedAt: now, status: 'draft' }],
    createdBy: String(user._id),
    ...overrides,
  }
}

describe('bill-with-update create (positive)', () => {
  it('applies product updates and creates the bill atomically — and never touches stock', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id, { type: 'supplier' } as any)
    const p1 = await createTestProduct(org._id, { sku: 'BILL-A', sellingPrice: 100, purchasePrice: 50 } as any)
    const p2 = await createTestProduct(org._id, { sku: 'BILL-B', sellingPrice: 200, purchasePrice: 100 } as any)

    const doc = billDoc(org, user, contact, [
      billLine(String(p1._id), 10, 55),
      billLine(String(p2._id), 5, 110),
    ])
    const { invoiceId, updatedProductIds } = await createInvoiceWithProductUpdates(doc, [
      { productId: String(p1._id), purchasePrice: 55, priceTiers: [{ name: 'Price 1', percent: 20, finalPrice: 66, manualOverride: false }] },
      { productId: String(p2._id), purchasePrice: 110, sellingPrice: 220 },
    ])

    expect(invoiceId).toBeTruthy()
    expect(updatedProductIds).toHaveLength(2)

    const inv: any = await Invoice.findById(invoiceId).lean()
    expect(inv).toBeTruthy()
    expect(inv.type).toBe('invoice')
    expect(inv.direction).toBe('incoming')
    expect(inv.lines).toHaveLength(2)

    const p1After: any = await Product.findById(p1._id).lean()
    expect(p1After.purchasePrice).toBe(55)
    expect(p1After.priceTiers).toHaveLength(1)
    expect(p1After.priceTiers[0].finalPrice).toBe(66)

    const p2After: any = await Product.findById(p2._id).lean()
    expect(p2After.purchasePrice).toBe(110)
    expect(p2After.sellingPrice).toBe(220)

    // Bills must never create stock movements via this path (/receive does that).
    expect(await StockMovement.countDocuments({ orgId: org._id })).toBe(0)
  })

  it('creates the bill with an empty productUpdates array (no product touched)', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id, { type: 'supplier' } as any)
    const p = await createTestProduct(org._id, { purchasePrice: 50 } as any)

    const doc = billDoc(org, user, contact, [billLine(String(p._id), 1, 60)])
    const { invoiceId, updatedProductIds } = await createInvoiceWithProductUpdates(doc, [])

    expect(invoiceId).toBeTruthy()
    expect(updatedProductIds).toHaveLength(0)
    const pAfter: any = await Product.findById(p._id).lean()
    expect(pAfter.purchasePrice).toBe(50)
  })
})

describe('bill-with-update create (negative / rollback)', () => {
  it('rejects a productUpdate for a product not in any bill line — bill not created', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id, { type: 'supplier' } as any)
    const pInLine = await createTestProduct(org._id)
    const pRogue = await createTestProduct(org._id, { sku: 'ROGUE-BILL' } as any)

    const doc = billDoc(org, user, contact, [billLine(String(pInLine._id), 1, 10)])
    const err = await captureRejection(createInvoiceWithProductUpdates(doc, [
      { productId: String(pRogue._id), purchasePrice: 999 },
    ]))
    expect(err).toBeInstanceOf(GRValidationError)
    expect(String(err?.message)).toMatch(/not in any invoice line/i)

    expect(await Invoice.countDocuments({ orgId: org._id })).toBe(0)
  })

  it('rolls back the whole transaction when the update fails inside it (cross-org product)', async () => {
    const orgA = await createTestOrg({ slug: 'bill-upd-a' })
    const orgB = await createTestOrg({ slug: 'bill-upd-b' })
    const user = await createTestUser(orgA._id)
    const contact = await createTestContact(orgA._id, { type: 'supplier' } as any)
    const pB = await createTestProduct(orgB._id, { purchasePrice: 40 } as any)

    // The foreign product IS in a bill line, so the pre-transaction membership check passes;
    // the in-transaction org-scoped existence check then fails → full rollback.
    const doc = billDoc(orgA, user, contact, [billLine(String(pB._id), 1, 45)])
    const err = await captureRejection(createInvoiceWithProductUpdates(doc, [
      { productId: String(pB._id), purchasePrice: 45 },
    ]))
    expect(err).toBeInstanceOf(GRValidationError)

    expect(await Invoice.countDocuments({ orgId: orgA._id })).toBe(0)
    const pBAfter: any = await Product.findById(pB._id).lean()
    expect(pBAfter.purchasePrice).toBe(40)
  })

  it('rejects >10 priceTiers — bill not created, product unchanged', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id, { type: 'supplier' } as any)
    const p = await createTestProduct(org._id, { purchasePrice: 50 } as any)

    const elevenTiers = Array.from({ length: 11 }, (_, i) => ({ name: `T${i}`, percent: 0, finalPrice: 100, manualOverride: false }))
    const doc = billDoc(org, user, contact, [billLine(String(p._id), 1, 55)])
    const err = await captureRejection(createInvoiceWithProductUpdates(doc, [
      { productId: String(p._id), priceTiers: elevenTiers },
    ]))
    expect(err).toBeInstanceOf(GRValidationError)

    expect(await Invoice.countDocuments({ orgId: org._id })).toBe(0)
    const pAfter: any = await Product.findById(p._id).lean()
    expect(pAfter.purchasePrice).toBe(50)
    expect((pAfter.priceTiers || []).length).toBe(0)
  })
})

describe('bill-with-update update (draft + received)', () => {
  it('updates a draft bill and its products atomically', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id, { type: 'supplier' } as any)
    const p = await createTestProduct(org._id, { purchasePrice: 50, sellingPrice: 100 } as any)

    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'incoming',
      status: 'draft',
      lines: [billLine(String(p._id), 2, 55)] as any,
    } as any)

    const { updatedProductIds } = await updateInvoiceWithProductUpdates({
      orgId: String(org._id),
      invoiceId: String(invoice._id),
      update: { notes: 'edited with product update', lines: [billLine(String(p._id), 3, 58)] },
      productUpdates: [{ productId: String(p._id), purchasePrice: 58 }],
    })

    expect(updatedProductIds).toEqual([String(p._id)])
    const invAfter: any = await Invoice.findById(invoice._id).lean()
    expect(invAfter.notes).toBe('edited with product update')
    expect(invAfter.lines[0].quantity).toBe(3)
    const pAfter: any = await Product.findById(p._id).lean()
    expect(pAfter.purchasePrice).toBe(58)
  })

  it('updates a received bill (no posted journal entry) — edit-always parity', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id, { type: 'supplier' } as any)
    const p = await createTestProduct(org._id, { purchasePrice: 50 } as any)

    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'incoming',
      status: 'received',
      lines: [billLine(String(p._id), 1, 60)] as any,
    } as any)

    const { updatedProductIds } = await updateInvoiceWithProductUpdates({
      orgId: String(org._id),
      invoiceId: String(invoice._id),
      update: { notes: 'received edit' },
      productUpdates: [{ productId: String(p._id), purchasePrice: 60 }],
    })

    expect(updatedProductIds).toHaveLength(1)
    const pAfter: any = await Product.findById(p._id).lean()
    expect(pAfter.purchasePrice).toBe(60)
  })

  it('refuses to touch a bill referenced by a posted journal entry (InvoicePostedError)', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id, { type: 'supplier' } as any)
    const p = await createTestProduct(org._id, { purchasePrice: 50 } as any)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'incoming',
      status: 'received',
      lines: [billLine(String(p._id), 1, 70)] as any,
    } as any)
    await createTestJournalEntry(org._id, fp._id, user._id, {
      sourceModule: 'invoicing',
      sourceId: invoice._id,
      status: 'posted',
    } as any)

    const err = await captureRejection(updateInvoiceWithProductUpdates({
      orgId: String(org._id),
      invoiceId: String(invoice._id),
      update: { notes: 'should not apply' },
      productUpdates: [{ productId: String(p._id), purchasePrice: 999 }],
    }))
    expect(err).toBeInstanceOf(InvoicePostedError)

    const invAfter: any = await Invoice.findById(invoice._id).lean()
    expect(invAfter.notes).not.toBe('should not apply')
    const pAfter: any = await Product.findById(p._id).lean()
    expect(pAfter.purchasePrice).toBe(50)
  })
})
