import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestInvoice, createTestProduct, createTestPaymentOrder, createTestCashOrder, createTestBankAccount } from '../helpers/factories'
import { Invoice, Contact, PaymentOrder, CashOrder } from 'db/models'
import { recordPayment, sendInvoice, checkOverdueInvoices, calculateInvoiceTotals } from 'services/biz/invoicing.service'
import { paginateQuery } from 'services/utils/pagination'

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

describe('Invoicing Pagination', () => {
  it('should paginate invoices', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    for (let i = 0; i < 15; i++) {
      await createTestInvoice(org._id, contact._id, { invoiceNumber: `INV-${String(i).padStart(3, '0')}` })
    }
    const p0 = await paginateQuery(Invoice, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)
    expect(p0.totalPages).toBe(2)

    const p1 = await paginateQuery(Invoice, { orgId: org._id }, { page: '1' })
    expect(p1.items).toHaveLength(5)

    const all = await paginateQuery(Invoice, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate invoices with filter', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    for (let i = 0; i < 8; i++) await createTestInvoice(org._id, contact._id, { status: 'draft' })
    for (let i = 0; i < 4; i++) await createTestInvoice(org._id, contact._id, { status: 'sent' })

    const filtered = await paginateQuery(Invoice, { orgId: org._id, status: 'draft' }, { size: '5' })
    expect(filtered.total).toBe(8)
    expect(filtered.items).toHaveLength(5)
    expect(filtered.totalPages).toBe(2)
  })

  it('should paginate contacts', async () => {
    const org = await createTestOrg()
    for (let i = 0; i < 15; i++) {
      await createTestContact(org._id, { companyName: `Company ${String(i).padStart(2, '0')}` })
    }
    const p0 = await paginateQuery(Contact, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(Contact, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate payment orders', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const bankAccount = await createTestBankAccount(org._id)
    for (let i = 0; i < 15; i++) {
      await createTestPaymentOrder(org._id, contact._id, bankAccount._id, { orderNumber: `PO-${String(i).padStart(3, '0')}` })
    }
    const p0 = await paginateQuery(PaymentOrder, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(PaymentOrder, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate cash orders', async () => {
    const org = await createTestOrg()
    for (let i = 0; i < 15; i++) {
      await createTestCashOrder(org._id, { orderNumber: `CO-${String(i).padStart(3, '0')}` })
    }
    const p0 = await paginateQuery(CashOrder, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(CashOrder, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })
})
