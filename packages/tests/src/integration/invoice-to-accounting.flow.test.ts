import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { Account, FiscalYear, FiscalPeriod, JournalEntry, Invoice } from 'db/models'
import {
  createTestOrg,
  createTestUser,
  createTestContact,
  createTestInvoice,
  createTestAccount,
  createTestFiscalYear,
  createTestFiscalPeriod,
} from '../helpers/factories'
import { sendInvoice, recordPayment, checkOverdueInvoices, calculateInvoiceTotals } from 'services/biz/invoicing.service'
import { postJournalEntry } from 'services/biz/accounting.service'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

async function setupInvoiceAccounting() {
  const org = await createTestOrg()
  const user = await createTestUser(org._id)
  const contact = await createTestContact(org._id)
  const fy = await createTestFiscalYear(org._id)
  const period = await createTestFiscalPeriod(org._id, fy._id)

  const arAccount = await createTestAccount(org._id, {
    code: '1200',
    name: 'Accounts Receivable',
    type: 'asset',
    subType: 'current_asset',
    balance: 0,
  })
  const cashAccount = await createTestAccount(org._id, {
    code: '1000',
    name: 'Cash',
    type: 'asset',
    subType: 'current_asset',
    balance: 0,
  })
  const revenueAccount = await createTestAccount(org._id, {
    code: '4000',
    name: 'Sales Revenue',
    type: 'revenue',
    subType: 'operating_revenue',
    balance: 0,
  })
  const taxAccount = await createTestAccount(org._id, {
    code: '2100',
    name: 'VAT Payable',
    type: 'liability',
    subType: 'current_liability',
    balance: 0,
  })

  return { org, user, contact, fy, period, arAccount, cashAccount, revenueAccount, taxAccount }
}

describe('Invoice to Accounting Flow', () => {
  it('should create invoice, send, record full payment, post journal entry, verify balances', async () => {
    const { org, user, contact, period, arAccount, cashAccount, revenueAccount, taxAccount } =
      await setupInvoiceAccounting()

    // Create a draft invoice: 1000 subtotal + 180 tax = 1180 total
    const invoice = await createTestInvoice(org._id, contact._id, {
      createdBy: user._id,
    })
    expect(invoice.status).toBe('draft')
    expect(invoice.total).toBe(1180)
    expect(invoice.amountDue).toBe(1180)

    // Send the invoice
    const sent = await sendInvoice(String(invoice._id))
    expect(sent.status).toBe('sent')
    expect(sent.sentAt).toBeDefined()

    // Record full payment
    const paid = await recordPayment(String(invoice._id), {
      date: new Date(),
      amount: 1180,
      method: 'bank_transfer',
      reference: 'PAY-001',
    })
    expect(paid.status).toBe('paid')
    expect(paid.amountPaid).toBe(1180)
    expect(paid.amountDue).toBeCloseTo(0, 2)
    expect(paid.paidAt).toBeDefined()

    // Create journal entry for the payment: debit Cash, credit AR
    const je = await JournalEntry.create({
      orgId: org._id,
      entryNumber: 'JE-PAY-001',
      date: new Date(),
      fiscalPeriodId: period._id,
      description: 'Payment received for invoice',
      type: 'standard',
      status: 'draft',
      lines: [
        { accountId: cashAccount._id, debit: 1180, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 1180, baseCredit: 0 },
        { accountId: arAccount._id, debit: 0, credit: 1180, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 1180 },
      ],
      totalDebit: 1180,
      totalCredit: 1180,
      createdBy: user._id,
    })

    // Post the journal entry
    const posted = await postJournalEntry(String(je._id), String(user._id))
    expect(posted.status).toBe('posted')
    expect(posted.postedAt).toBeDefined()

    // Verify account balances
    const updatedCash = await Account.findById(cashAccount._id)
    const updatedAR = await Account.findById(arAccount._id)
    expect(updatedCash!.balance).toBe(1180) // Asset: debit increases
    expect(updatedAR!.balance).toBe(-1180) // Asset: credit decreases (offset by prior AR debit)
  })

  it('should handle multiple partial payments on a single invoice', async () => {
    const { org, user, contact } = await setupInvoiceAccounting()

    const invoice = await createTestInvoice(org._id, contact._id, {
      createdBy: user._id,
      subtotal: 3000,
      taxTotal: 540,
      total: 3540,
      totalBase: 3540,
      amountDue: 3540,
      lines: [
        {
          description: 'Consulting Services',
          quantity: 3,
          unit: 'hours',
          unitPrice: 1000,
          discount: 0,
          taxRate: 18,
          taxAmount: 540,
          lineTotal: 3540,
        },
      ],
    })

    const sent = await sendInvoice(String(invoice._id))
    expect(sent.status).toBe('sent')

    // First partial payment: 1000
    const after1 = await recordPayment(String(invoice._id), {
      date: new Date(),
      amount: 1000,
      method: 'bank_transfer',
      reference: 'PAY-P1',
    })
    expect(after1.status).toBe('partially_paid')
    expect(after1.amountPaid).toBe(1000)
    expect(after1.amountDue).toBe(2540)

    // Second partial payment: 1540
    const after2 = await recordPayment(String(invoice._id), {
      date: new Date(),
      amount: 1540,
      method: 'cash',
      reference: 'PAY-P2',
    })
    expect(after2.status).toBe('partially_paid')
    expect(after2.amountPaid).toBe(2540)
    expect(after2.amountDue).toBe(1000)

    // Final payment: 1000
    const after3 = await recordPayment(String(invoice._id), {
      date: new Date(),
      amount: 1000,
      method: 'bank_transfer',
      reference: 'PAY-P3',
    })
    expect(after3.status).toBe('paid')
    expect(after3.amountPaid).toBe(3540)
    expect(after3.amountDue).toBeCloseTo(0, 2)
    expect(after3.payments).toHaveLength(3)
  })

  it('should create multiple invoices for the same contact and verify totals per invoice', async () => {
    const { org, user, contact } = await setupInvoiceAccounting()

    const inv1 = await createTestInvoice(org._id, contact._id, {
      invoiceNumber: 'INV-MULTI-001',
      createdBy: user._id,
      subtotal: 500,
      taxTotal: 90,
      total: 590,
      totalBase: 590,
      amountDue: 590,
      lines: [{ description: 'Service A', quantity: 1, unit: 'pcs', unitPrice: 500, discount: 0, taxRate: 18, taxAmount: 90, lineTotal: 590 }],
    })

    const inv2 = await createTestInvoice(org._id, contact._id, {
      invoiceNumber: 'INV-MULTI-002',
      createdBy: user._id,
      subtotal: 2000,
      taxTotal: 360,
      total: 2360,
      totalBase: 2360,
      amountDue: 2360,
      lines: [{ description: 'Service B', quantity: 2, unit: 'pcs', unitPrice: 1000, discount: 0, taxRate: 18, taxAmount: 360, lineTotal: 2360 }],
    })

    const inv3 = await createTestInvoice(org._id, contact._id, {
      invoiceNumber: 'INV-MULTI-003',
      createdBy: user._id,
      subtotal: 750,
      taxTotal: 135,
      total: 885,
      totalBase: 885,
      amountDue: 885,
      lines: [{ description: 'Service C', quantity: 3, unit: 'hours', unitPrice: 250, discount: 0, taxRate: 18, taxAmount: 135, lineTotal: 885 }],
    })

    // Verify each invoice has correct independent totals
    const allInvoices = await Invoice.find({ orgId: org._id, contactId: contact._id }).sort({ invoiceNumber: 1 })
    expect(allInvoices).toHaveLength(3)

    expect(allInvoices[0].total).toBe(590)
    expect(allInvoices[0].amountDue).toBe(590)
    expect(allInvoices[1].total).toBe(2360)
    expect(allInvoices[1].amountDue).toBe(2360)
    expect(allInvoices[2].total).toBe(885)
    expect(allInvoices[2].amountDue).toBe(885)

    // Pay one invoice partially and verify others remain untouched
    await sendInvoice(String(inv1._id))
    await recordPayment(String(inv1._id), { date: new Date(), amount: 200, method: 'cash' })

    const refreshed1 = await Invoice.findById(inv1._id)
    const refreshed2 = await Invoice.findById(inv2._id)
    const refreshed3 = await Invoice.findById(inv3._id)

    expect(refreshed1!.amountPaid).toBe(200)
    expect(refreshed1!.amountDue).toBe(390)
    expect(refreshed2!.amountPaid).toBe(0)
    expect(refreshed2!.amountDue).toBe(2360)
    expect(refreshed3!.amountPaid).toBe(0)
    expect(refreshed3!.amountDue).toBe(885)
  })

  it('should calculate invoice totals with mixed tax rates', async () => {
    const lines = [
      { quantity: 10, unitPrice: 100, discount: 0, taxRate: 18 },  // 1000 subtotal, 180 tax
      { quantity: 5, unitPrice: 200, discount: 10, taxRate: 5 },   // 1000 subtotal, 100 discount, 45 tax
      { quantity: 20, unitPrice: 50, discount: 0, taxRate: 0 },    // 1000 subtotal, 0 tax
    ]

    const result = calculateInvoiceTotals(lines)

    // Line 1: qty=10, price=100 => lineTotal=1000, discount=0, taxable=1000, tax=180
    // Line 2: qty=5, price=200 => lineTotal=1000, discount=100 (10%), taxable=900, tax=45
    // Line 3: qty=20, price=50 => lineTotal=1000, discount=0, taxable=1000, tax=0
    expect(result.subtotal).toBe(3000)
    expect(result.discountTotal).toBe(100)
    expect(result.taxTotal).toBe(225)
    expect(result.total).toBe(3125) // 3000 - 100 + 225
  })

  it('should reduce outstanding balance with a credit note', async () => {
    const { org, user, contact } = await setupInvoiceAccounting()

    // Original invoice: 2000 + 360 tax = 2360
    const invoice = await createTestInvoice(org._id, contact._id, {
      invoiceNumber: 'INV-CR-001',
      createdBy: user._id,
      subtotal: 2000,
      taxTotal: 360,
      total: 2360,
      totalBase: 2360,
      amountDue: 2360,
      lines: [{ description: 'Product X', quantity: 4, unit: 'pcs', unitPrice: 500, discount: 0, taxRate: 18, taxAmount: 360, lineTotal: 2360 }],
    })

    await sendInvoice(String(invoice._id))

    // Credit note for partial return: 1 unit = 500 + 90 tax = 590
    const creditNote = await createTestInvoice(org._id, contact._id, {
      invoiceNumber: 'CN-001',
      type: 'credit_note',
      createdBy: user._id,
      subtotal: 500,
      taxTotal: 90,
      total: 590,
      totalBase: 590,
      amountDue: 590,
      relatedInvoiceId: invoice._id,
      lines: [{ description: 'Product X (return)', quantity: 1, unit: 'pcs', unitPrice: 500, discount: 0, taxRate: 18, taxAmount: 90, lineTotal: 590 }],
    })

    expect(creditNote.type).toBe('credit_note')
    expect(creditNote.relatedInvoiceId!.toString()).toBe(String(invoice._id))

    // Apply credit note as a payment on the original invoice
    const afterCredit = await recordPayment(String(invoice._id), {
      date: new Date(),
      amount: 590,
      method: 'other',
      reference: `Credit note ${creditNote.invoiceNumber}`,
    })

    expect(afterCredit.amountPaid).toBe(590)
    expect(afterCredit.amountDue).toBe(1770) // 2360 - 590
    expect(afterCredit.status).toBe('partially_paid')
  })

  it('should transition draft -> sent -> partially_paid -> paid with journal entries at each payment', async () => {
    const { org, user, contact, period, arAccount, cashAccount, revenueAccount } =
      await setupInvoiceAccounting()

    // Invoice for 2000 (no tax for simplicity)
    const invoice = await createTestInvoice(org._id, contact._id, {
      createdBy: user._id,
      subtotal: 2000,
      taxTotal: 0,
      total: 2000,
      totalBase: 2000,
      amountDue: 2000,
      lines: [{ description: 'Flat fee', quantity: 1, unit: 'pcs', unitPrice: 2000, discount: 0, taxRate: 0, taxAmount: 0, lineTotal: 2000 }],
    })
    expect(invoice.status).toBe('draft')

    // Send
    const sent = await sendInvoice(String(invoice._id))
    expect(sent.status).toBe('sent')

    // First payment: 800 -> partially_paid
    const after1 = await recordPayment(String(invoice._id), {
      date: new Date(),
      amount: 800,
      method: 'bank_transfer',
      reference: 'PAY-CYCLE-1',
    })
    expect(after1.status).toBe('partially_paid')

    // Journal entry for first payment: debit Cash 800, credit AR 800
    const je1 = await JournalEntry.create({
      orgId: org._id,
      entryNumber: 'JE-CYCLE-001',
      date: new Date(),
      fiscalPeriodId: period._id,
      description: 'Payment 1 for invoice',
      type: 'standard',
      status: 'draft',
      lines: [
        { accountId: cashAccount._id, debit: 800, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 800, baseCredit: 0 },
        { accountId: arAccount._id, debit: 0, credit: 800, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 800 },
      ],
      totalDebit: 800,
      totalCredit: 800,
      createdBy: user._id,
    })
    await postJournalEntry(String(je1._id), String(user._id))

    // Second payment: 1200 -> paid
    const after2 = await recordPayment(String(invoice._id), {
      date: new Date(),
      amount: 1200,
      method: 'bank_transfer',
      reference: 'PAY-CYCLE-2',
    })
    expect(after2.status).toBe('paid')
    expect(after2.paidAt).toBeDefined()

    // Journal entry for second payment
    const je2 = await JournalEntry.create({
      orgId: org._id,
      entryNumber: 'JE-CYCLE-002',
      date: new Date(),
      fiscalPeriodId: period._id,
      description: 'Payment 2 for invoice',
      type: 'standard',
      status: 'draft',
      lines: [
        { accountId: cashAccount._id, debit: 1200, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 1200, baseCredit: 0 },
        { accountId: arAccount._id, debit: 0, credit: 1200, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 1200 },
      ],
      totalDebit: 1200,
      totalCredit: 1200,
      createdBy: user._id,
    })
    await postJournalEntry(String(je2._id), String(user._id))

    // Verify cumulative account balances
    const finalCash = await Account.findById(cashAccount._id)
    const finalAR = await Account.findById(arAccount._id)
    expect(finalCash!.balance).toBe(2000) // 800 + 1200
    expect(finalAR!.balance).toBe(-2000) // credited 800 + 1200
  })

  it('should mark invoices as overdue after past-due date', async () => {
    const { org, user, contact } = await setupInvoiceAccounting()

    // Invoice with due date in the past
    const pastDue = new Date()
    pastDue.setDate(pastDue.getDate() - 10)

    const invoice = await createTestInvoice(org._id, contact._id, {
      invoiceNumber: 'INV-OVERDUE-001',
      createdBy: user._id,
      dueDate: pastDue,
    })

    // Must be sent before it can go overdue
    await sendInvoice(String(invoice._id))

    // Also create a non-overdue invoice (due in the future)
    const futureInvoice = await createTestInvoice(org._id, contact._id, {
      invoiceNumber: 'INV-FUTURE-001',
      createdBy: user._id,
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })
    await sendInvoice(String(futureInvoice._id))

    const count = await checkOverdueInvoices(String(org._id))
    expect(count).toBe(1)

    const overdueInv = await Invoice.findById(invoice._id)
    expect(overdueInv!.status).toBe('overdue')

    const futureInv = await Invoice.findById(futureInvoice._id)
    expect(futureInv!.status).toBe('sent')
  })

  it('should handle multi-currency invoice with exchange rate applied to base amounts', async () => {
    const { org, user, contact, period, arAccount, cashAccount } =
      await setupInvoiceAccounting()

    const exchangeRate = 1.1 // 1 USD = 1.1 EUR (base currency is EUR)
    const subtotalUSD = 1000
    const taxUSD = 180
    const totalUSD = 1180
    const totalBase = totalUSD * exchangeRate // 1298 EUR

    const invoice = await createTestInvoice(org._id, contact._id, {
      invoiceNumber: 'INV-USD-001',
      createdBy: user._id,
      currency: 'USD',
      exchangeRate,
      subtotal: subtotalUSD,
      taxTotal: taxUSD,
      total: totalUSD,
      totalBase,
      amountDue: totalUSD,
      lines: [
        {
          description: 'International Service',
          quantity: 1,
          unit: 'pcs',
          unitPrice: subtotalUSD,
          discount: 0,
          taxRate: 18,
          taxAmount: taxUSD,
          lineTotal: totalUSD,
        },
      ],
    })

    expect(invoice.currency).toBe('USD')
    expect(invoice.exchangeRate).toBe(1.1)
    expect(invoice.totalBase).toBe(1298)

    // Send and pay in full
    await sendInvoice(String(invoice._id))
    const paid = await recordPayment(String(invoice._id), {
      date: new Date(),
      amount: totalUSD,
      method: 'bank_transfer',
      reference: 'PAY-USD-001',
    })
    expect(paid.status).toBe('paid')

    // Journal entry uses base currency (EUR) amounts
    const je = await JournalEntry.create({
      orgId: org._id,
      entryNumber: 'JE-USD-001',
      date: new Date(),
      fiscalPeriodId: period._id,
      description: 'USD invoice payment',
      type: 'standard',
      status: 'draft',
      lines: [
        { accountId: cashAccount._id, debit: totalBase, credit: 0, currency: 'USD', exchangeRate, baseDebit: totalBase, baseCredit: 0 },
        { accountId: arAccount._id, debit: 0, credit: totalBase, currency: 'USD', exchangeRate, baseDebit: 0, baseCredit: totalBase },
      ],
      totalDebit: totalBase,
      totalCredit: totalBase,
      createdBy: user._id,
    })

    const posted = await postJournalEntry(String(je._id), String(user._id))
    expect(posted.status).toBe('posted')

    // Verify balances are in base currency (EUR)
    const finalCash = await Account.findById(cashAccount._id)
    const finalAR = await Account.findById(arAccount._id)
    expect(finalCash!.balance).toBe(1298) // 1180 * 1.1
    expect(finalAR!.balance).toBe(-1298)
  })
})
