import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../../setup.js'
import { createTestOrg, createTestContact, createTestInvoice } from '../../helpers/factories.js'
import {
  calculateInvoiceTotals,
  recordPayment,
  sendInvoice,
  checkOverdueInvoices,
} from 'services/biz/invoicing.service'
import { Invoice } from 'db/models'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

// ---------------------------------------------------------------------------
// calculateInvoiceTotals
// ---------------------------------------------------------------------------
describe('calculateInvoiceTotals', () => {
  it('calculates subtotal from line quantities * unitPrices', () => {
    const result = calculateInvoiceTotals([
      { quantity: 2, unitPrice: 500, discount: 0, taxRate: 0 },
      { quantity: 3, unitPrice: 200, discount: 0, taxRate: 0 },
    ])
    expect(result.subtotal).toBe(1600)
  })

  it('applies line discounts correctly', () => {
    const result = calculateInvoiceTotals([
      { quantity: 1, unitPrice: 1000, discount: 10, taxRate: 0 },
    ])
    // discount = 1000 * 10/100 = 100
    expect(result.discountTotal).toBe(100)
    expect(result.total).toBe(900)
  })

  it('calculates tax on taxable amount (after discount)', () => {
    const result = calculateInvoiceTotals([
      { quantity: 1, unitPrice: 1000, discount: 10, taxRate: 18 },
    ])
    // lineTotal = 1000, discount = 100, taxable = 900, tax = 162
    expect(result.taxTotal).toBe(162)
  })

  it('calculates total as subtotal - discountTotal + taxTotal', () => {
    const result = calculateInvoiceTotals([
      { quantity: 2, unitPrice: 500, discount: 20, taxRate: 10 },
    ])
    // subtotal = 1000, discount = 200, taxable = 800, tax = 80
    // total = 1000 - 200 + 80 = 880
    expect(result.subtotal).toBe(1000)
    expect(result.discountTotal).toBe(200)
    expect(result.taxTotal).toBe(80)
    expect(result.total).toBe(880)
  })

  it('handles zero discount', () => {
    const result = calculateInvoiceTotals([
      { quantity: 1, unitPrice: 500, discount: 0, taxRate: 18 },
    ])
    expect(result.discountTotal).toBe(0)
    expect(result.taxTotal).toBe(90) // 500 * 0.18
    expect(result.total).toBe(590)
  })

  it('handles zero tax rate', () => {
    const result = calculateInvoiceTotals([
      { quantity: 4, unitPrice: 250, discount: 5, taxRate: 0 },
    ])
    // subtotal = 1000, discount = 50, tax = 0
    expect(result.taxTotal).toBe(0)
    expect(result.total).toBe(950)
  })

  it('handles mixed tax rates across lines', () => {
    const result = calculateInvoiceTotals([
      { quantity: 1, unitPrice: 1000, discount: 0, taxRate: 18 },
      { quantity: 1, unitPrice: 500, discount: 0, taxRate: 5 },
      { quantity: 1, unitPrice: 200, discount: 0, taxRate: 0 },
    ])
    // line1 tax = 1000 * 0.18 = 180
    // line2 tax = 500 * 0.05 = 25
    // line3 tax = 0
    expect(result.subtotal).toBe(1700)
    expect(result.taxTotal).toBe(205)
    expect(result.total).toBe(1905)
  })

  it('returns zeros for empty lines array', () => {
    const result = calculateInvoiceTotals([])
    expect(result.subtotal).toBe(0)
    expect(result.discountTotal).toBe(0)
    expect(result.taxTotal).toBe(0)
    expect(result.total).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// recordPayment
// ---------------------------------------------------------------------------
describe('recordPayment', () => {
  it('appends payment to invoice.payments array', async () => {
    const org = await createTestOrg({ slug: 'pay-append' })
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id, {
      status: 'sent',
      total: 1000,
      amountPaid: 0,
      amountDue: 1000,
    })

    const updated = await recordPayment(String(invoice._id), {
      date: new Date(),
      amount: 400,
      method: 'bank_transfer',
      reference: 'PAY-001',
    })

    expect(updated.payments).toHaveLength(1)
    expect(updated.payments[0].amount).toBe(400)
    expect(updated.payments[0].method).toBe('bank_transfer')
    expect(updated.payments[0].reference).toBe('PAY-001')
  })

  it('updates amountPaid and amountDue correctly', async () => {
    const org = await createTestOrg({ slug: 'pay-amounts' })
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id, {
      status: 'sent',
      total: 1000,
      amountPaid: 0,
      amountDue: 1000,
    })

    const updated = await recordPayment(String(invoice._id), {
      date: new Date(),
      amount: 600,
      method: 'bank_transfer',
    })

    expect(updated.amountPaid).toBe(600)
    expect(updated.amountDue).toBe(400)
  })

  it('auto-marks invoice as paid when amountDue <= 0.01', async () => {
    const org = await createTestOrg({ slug: 'pay-full' })
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id, {
      status: 'sent',
      total: 500,
      amountPaid: 0,
      amountDue: 500,
    })

    const updated = await recordPayment(String(invoice._id), {
      date: new Date(),
      amount: 500,
      method: 'cash',
    })

    expect(updated.status).toBe('paid')
    expect(updated.paidAt).toBeDefined()
  })

  it('sets status to partially_paid for partial payments', async () => {
    const org = await createTestOrg({ slug: 'pay-partial' })
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id, {
      status: 'sent',
      total: 1000,
      amountPaid: 0,
      amountDue: 1000,
    })

    const updated = await recordPayment(String(invoice._id), {
      date: new Date(),
      amount: 300,
      method: 'card',
    })

    expect(updated.status).toBe('partially_paid')
    expect(updated.amountDue).toBe(700)
  })

  it('rejects overpayment (amount > amountDue)', async () => {
    const org = await createTestOrg({ slug: 'pay-over' })
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id, {
      status: 'sent',
      total: 500,
      amountPaid: 0,
      amountDue: 500,
    })

    await expect(
      recordPayment(String(invoice._id), {
        date: new Date(),
        amount: 600,
        method: 'cash',
      }),
    ).rejects.toThrow('Payment amount exceeds amount due')
  })

  it('rejects payment on paid invoice', async () => {
    const org = await createTestOrg({ slug: 'pay-on-paid' })
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id, {
      status: 'paid',
      total: 500,
      amountPaid: 500,
      amountDue: 0,
    })

    await expect(
      recordPayment(String(invoice._id), {
        date: new Date(),
        amount: 100,
        method: 'cash',
      }),
    ).rejects.toThrow('Cannot record payment on paid invoice')
  })

  it('rejects payment on voided invoice', async () => {
    const org = await createTestOrg({ slug: 'pay-on-voided' })
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id, {
      status: 'voided',
      total: 500,
      amountPaid: 0,
      amountDue: 500,
    })

    await expect(
      recordPayment(String(invoice._id), {
        date: new Date(),
        amount: 100,
        method: 'cash',
      }),
    ).rejects.toThrow('Cannot record payment on voided invoice')
  })

  it('rejects payment on cancelled invoice', async () => {
    const org = await createTestOrg({ slug: 'pay-on-cancelled' })
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id, {
      status: 'cancelled',
      total: 500,
      amountPaid: 0,
      amountDue: 500,
    })

    await expect(
      recordPayment(String(invoice._id), {
        date: new Date(),
        amount: 100,
        method: 'cash',
      }),
    ).rejects.toThrow('Cannot record payment on cancelled invoice')
  })
})

// ---------------------------------------------------------------------------
// sendInvoice
// ---------------------------------------------------------------------------
describe('sendInvoice', () => {
  it('changes status from draft to sent', async () => {
    const org = await createTestOrg({ slug: 'send-draft' })
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id, { status: 'draft' })

    const updated = await sendInvoice(String(invoice._id))
    expect(updated.status).toBe('sent')
  })

  it('sets sentAt timestamp', async () => {
    const org = await createTestOrg({ slug: 'send-timestamp' })
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id, { status: 'draft' })

    const before = new Date()
    const updated = await sendInvoice(String(invoice._id))
    const after = new Date()

    expect(updated.sentAt).toBeDefined()
    expect(updated.sentAt!.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(updated.sentAt!.getTime()).toBeLessThanOrEqual(after.getTime())
  })

  it('rejects sending non-draft invoice', async () => {
    const org = await createTestOrg({ slug: 'send-non-draft' })
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id, { status: 'sent' })

    await expect(sendInvoice(String(invoice._id))).rejects.toThrow(
      'Only draft invoices can be sent',
    )
  })
})

// ---------------------------------------------------------------------------
// checkOverdueInvoices
// ---------------------------------------------------------------------------
describe('checkOverdueInvoices', () => {
  const pastDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 7 days ago
  const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days ahead

  it('marks past-due sent invoices as overdue', async () => {
    const org = await createTestOrg({ slug: 'overdue-sent' })
    const contact = await createTestContact(org._id)
    await createTestInvoice(org._id, contact._id, {
      status: 'sent',
      dueDate: pastDate,
    })

    const count = await checkOverdueInvoices(String(org._id))
    expect(count).toBe(1)

    const invoices = await Invoice.find({ orgId: org._id })
    expect(invoices[0].status).toBe('overdue')
  })

  it('marks past-due partially_paid invoices as overdue', async () => {
    const org = await createTestOrg({ slug: 'overdue-partial' })
    const contact = await createTestContact(org._id)
    await createTestInvoice(org._id, contact._id, {
      status: 'partially_paid',
      dueDate: pastDate,
      amountPaid: 200,
      amountDue: 800,
    })

    const count = await checkOverdueInvoices(String(org._id))
    expect(count).toBe(1)

    const invoices = await Invoice.find({ orgId: org._id })
    expect(invoices[0].status).toBe('overdue')
  })

  it('skips paid invoices', async () => {
    const org = await createTestOrg({ slug: 'overdue-skip-paid' })
    const contact = await createTestContact(org._id)
    await createTestInvoice(org._id, contact._id, {
      status: 'paid',
      dueDate: pastDate,
      amountPaid: 1000,
      amountDue: 0,
    })

    const count = await checkOverdueInvoices(String(org._id))
    expect(count).toBe(0)
  })

  it('skips invoices with future due dates', async () => {
    const org = await createTestOrg({ slug: 'overdue-skip-future' })
    const contact = await createTestContact(org._id)
    await createTestInvoice(org._id, contact._id, {
      status: 'sent',
      dueDate: futureDate,
    })

    const count = await checkOverdueInvoices(String(org._id))
    expect(count).toBe(0)
  })

  it('returns modifiedCount', async () => {
    const org = await createTestOrg({ slug: 'overdue-count' })
    const contact = await createTestContact(org._id)

    // 2 overdue-eligible invoices
    await createTestInvoice(org._id, contact._id, {
      invoiceNumber: `INV-OD-1`,
      status: 'sent',
      dueDate: pastDate,
    })
    await createTestInvoice(org._id, contact._id, {
      invoiceNumber: `INV-OD-2`,
      status: 'partially_paid',
      dueDate: pastDate,
      amountPaid: 100,
      amountDue: 900,
    })

    // 1 not eligible (paid)
    await createTestInvoice(org._id, contact._id, {
      invoiceNumber: `INV-OD-3`,
      status: 'paid',
      dueDate: pastDate,
      amountPaid: 1000,
      amountDue: 0,
    })

    // 1 not eligible (future due date)
    await createTestInvoice(org._id, contact._id, {
      invoiceNumber: `INV-OD-4`,
      status: 'sent',
      dueDate: futureDate,
    })

    const count = await checkOverdueInvoices(String(org._id))
    expect(count).toBe(2)
  })
})
