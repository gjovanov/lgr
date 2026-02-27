import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestInvoice, createTestProduct } from '../helpers/factories'
import { Invoice } from 'db/models'
import { recordPayment, sendInvoice, checkOverdueInvoices, calculateInvoiceTotals } from 'services/biz/invoicing.service'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('Invoicing Flow', () => {
  it('should send a draft invoice', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id)

    expect(invoice.status).toBe('draft')

    const sent = await sendInvoice(String(invoice._id))
    expect(sent.status).toBe('sent')
    expect(sent.sentAt).toBeDefined()
  })

  it('should record a full payment and mark invoice as paid', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id, { status: 'sent' })

    const paid = await recordPayment(String(invoice._id), {
      date: new Date(),
      amount: invoice.amountDue,
      method: 'bank_transfer',
      reference: 'PAY-001',
    })

    expect(paid.status).toBe('paid')
    expect(paid.amountPaid).toBe(invoice.total)
    expect(paid.amountDue).toBeLessThanOrEqual(0.01)
    expect(paid.paidAt).toBeDefined()
    expect(paid.payments).toHaveLength(1)
  })

  it('should record a partial payment and mark as partially_paid', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id, { status: 'sent' })

    const partialAmount = Math.floor(invoice.amountDue / 2)
    const updated = await recordPayment(String(invoice._id), {
      date: new Date(),
      amount: partialAmount,
      method: 'cash',
    })

    expect(updated.status).toBe('partially_paid')
    expect(updated.amountPaid).toBe(partialAmount)
    expect(updated.amountDue).toBe(invoice.total - partialAmount)
  })

  it('should reject payment exceeding amount due', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id, { status: 'sent' })

    await expect(
      recordPayment(String(invoice._id), {
        date: new Date(),
        amount: invoice.amountDue + 500,
        method: 'bank_transfer',
      }),
    ).rejects.toThrow('Payment amount exceeds amount due')
  })

  it('should mark overdue invoices', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const pastDue = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

    await createTestInvoice(org._id, contact._id, {
      status: 'sent',
      dueDate: pastDue,
    })
    await createTestInvoice(org._id, contact._id, {
      status: 'sent',
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })

    const count = await checkOverdueInvoices(String(org._id))
    expect(count).toBe(1)

    const overdue = await Invoice.findOne({ orgId: org._id, status: 'overdue' })
    expect(overdue).toBeDefined()
    expect(overdue!.dueDate.getTime()).toBeLessThan(Date.now())
  })

  it('should calculate invoice totals with discount and tax', async () => {
    const totals = calculateInvoiceTotals([
      { quantity: 10, unitPrice: 100, discount: 10, taxRate: 18 },
      { quantity: 5, unitPrice: 200, discount: 0, taxRate: 18 },
    ])

    expect(totals.subtotal).toBe(2000) // 10*100 + 5*200
    expect(totals.discountTotal).toBe(100) // 10% of 1000
    expect(totals.taxTotal).toBeCloseTo(342) // 18% of (900 + 1000)
    expect(totals.total).toBeCloseTo(2242) // 2000 - 100 + 342
  })

  it('should persist productId on invoice line items through round-trip', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id, {
      name: 'Widget Pro',
      sellingPrice: 250,
      purchasePrice: 150,
      taxRate: 18,
      unit: 'pcs',
    })

    const invoice = await createTestInvoice(org._id, contact._id, {
      lines: [
        {
          productId: product._id,
          description: 'Widget Pro',
          quantity: 3,
          unit: 'pcs',
          unitPrice: 250,
          discount: 0,
          taxRate: 18,
          taxAmount: 135,
          lineTotal: 885,
        },
      ],
      subtotal: 750,
      discountTotal: 0,
      taxTotal: 135,
      total: 885,
      totalBase: 885,
      amountDue: 885,
    })

    // Retrieve from DB
    const found = await Invoice.findById(invoice._id)
    expect(found).toBeDefined()
    expect(found!.lines).toHaveLength(1)
    expect(String(found!.lines[0].productId)).toBe(String(product._id))
    expect(found!.lines[0].description).toBe('Widget Pro')
    expect(found!.lines[0].unitPrice).toBe(250)
  })
})
