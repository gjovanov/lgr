import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestContact,
  createTestInvoice,
  createTestProduct,
  createTestWarehouse,
  createTestStockLevel,
  createTestStockMovement,
} from '../helpers/factories'
import {
  REPORT_REGISTRY,
  listReportsFor,
  reportById,
  canAccessReport,
  canExportReport,
  validateParams,
} from 'services/biz/report-registry'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { Order } from 'db/models'
import type { Types } from 'mongoose'

/**
 * FR-06 (#14) P2 — one integration test per new handler (AC 6), plus the two gates the
 * phase introduced: the SUPTO role restriction and `reports.export`.
 *
 * NOTE: no `.rejects` / `.resolves` anywhere — those matchers deadlock under Bun on Windows
 * when the rejection follows driver I/O (see Known Issues). Rejections are captured by hand.
 */

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

function caller(role: keyof typeof DEFAULT_ROLE_PERMISSIONS) {
  return { role, permissions: DEFAULT_ROLE_PERMISSIONS[role] }
}

async function captureRejection(p: Promise<any>): Promise<any> {
  try {
    await p
    return null
  } catch (e) {
    return e
  }
}

const DAY = 24 * 60 * 60 * 1000
const iso = (d: Date) => d.toISOString().slice(0, 10)
const today = new Date()
const yesterday = new Date(today.getTime() - DAY)
const lastWeek = new Date(today.getTime() - 7 * DAY)

/** A period param the way `validateParams` would have produced it. */
function period(from: Date, to: Date) {
  return { preset: 'custom', from: iso(from), to: iso(to) }
}

// ── Document registers ───────────────────────────────────────────────────────

describe('document registers (sales-documents / purchase-documents / cash-register)', () => {
  async function seed() {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const customer = await createTestContact(orgId, { companyName: 'Buyer Ltd', type: 'customer' })
    const supplier = await createTestContact(orgId, { companyName: 'Vendor Ltd', type: 'supplier' })

    await createTestInvoice(orgId, customer._id as Types.ObjectId, {
      invoiceNumber: 'INV-1', type: 'invoice', direction: 'outgoing', status: 'paid',
      issueDate: yesterday, subtotal: 100, taxTotal: 20, total: 120, amountPaid: 120, amountDue: 0,
    })
    await createTestInvoice(orgId, customer._id as Types.ObjectId, {
      invoiceNumber: 'CN-1', type: 'credit_note', direction: 'outgoing', status: 'sent',
      issueDate: yesterday, subtotal: -10, taxTotal: -2, total: -12, amountDue: -12,
    })
    await createTestInvoice(orgId, supplier._id as Types.ObjectId, {
      invoiceNumber: 'BILL-1', type: 'invoice', direction: 'incoming', status: 'received',
      issueDate: yesterday, subtotal: 50, taxTotal: 10, total: 60, amountDue: 60,
    })
    await createTestInvoice(orgId, customer._id as Types.ObjectId, {
      invoiceNumber: 'CSR-1', type: 'cash_sale', direction: 'outgoing', status: 'paid',
      issueDate: yesterday, subtotal: 30, taxTotal: 6, total: 36, amountPaid: 36, amountDue: 0,
    })
    // Out of period — every register must exclude it.
    await createTestInvoice(orgId, customer._id as Types.ObjectId, {
      invoiceNumber: 'INV-OLD', type: 'invoice', direction: 'outgoing', status: 'paid',
      issueDate: new Date(today.getTime() - 400 * DAY), subtotal: 999, taxTotal: 0, total: 999,
    })
    // A proforma belongs to no register: it is not a document of record.
    await createTestInvoice(orgId, customer._id as Types.ObjectId, {
      invoiceNumber: 'PRF-1', type: 'proforma', direction: 'outgoing', status: 'sent',
      issueDate: yesterday, subtotal: 77, total: 77,
    })

    return { orgId: String(orgId), customerId: String(customer._id), supplierId: String(supplier._id) }
  }

  const params = () => ({ period: period(lastWeek, today) })

  it('sales-documents returns invoices and notes, never bills, cash sales or proformas', async () => {
    const { orgId } = await seed()
    const res = await reportById('sales-documents')!.handler!({ orgId, params: params(), output: 'table' })
    const numbers = res.rows.map(r => r.number)

    expect(numbers).toContain('INV-1')
    expect(numbers).toContain('CN-1')
    expect(numbers).not.toContain('BILL-1')
    expect(numbers).not.toContain('CSR-1')
    expect(numbers).not.toContain('PRF-1')
    expect(numbers).not.toContain('INV-OLD')

    // Credit notes carry their own sign — the register sums what the documents say.
    expect(res.totals!.total).toBeCloseTo(108, 2)
  })

  // The operator's layout (2026-10-15): в брой · с карта · наложен платеж · по банка · ДДС ·
  // Общо, so the register ends on the total of every document. No Платено / Остатък (2026-10-14).
  it('sales-documents ends on ДДС and Общо, after the four method columns', async () => {
    const { orgId } = await seed()
    const keys = (id: string) => reportById(id)!.handler!({ orgId, params: params(), output: 'table' })
      .then(r => r.columns.map(c => c.key))

    // `cashSale` (#171): the cash sale an invoice was issued for — a text column beside the type,
    // so the money still reads four methods, then ДДС, then Общо last.
    expect(await keys('sales-documents')).toEqual([
      'date', 'number', 'docType', 'cashSale', 'contactName', 'status', 'currency', 'subtotal',
      'paidCash', 'paidCard', 'paidCashOnDelivery', 'bank', 'taxTotal', 'total',
    ])
    for (const id of ['purchase-documents', 'cash-register']) {
      const k = await keys(id)
      expect(k.indexOf('taxTotal')).toBeLessThan(k.indexOf('total'))
      expect(k).toContain('amountPaid')
      expect(k).toContain('amountDue')
      expect(k).toContain('paidBank')
      expect(k).not.toContain('bank')
    }
  })

  it('names Общо as the bottom line of all three registers', async () => {
    const { orgId } = await seed()
    for (const id of ['sales-documents', 'purchase-documents', 'cash-register']) {
      const res = await reportById(id)!.handler!({ orgId, params: params(), output: 'table' })
      expect(res.meta!.grandTotalKey).toBe('total')
    }
  })

  // LGR stores a note as positive magnitudes and carries the sign on its type — the import
  // normalises the printed negatives (map-invoice.ts) and the form never writes any.
  it('takes a credit note off the totals, however it was stored', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const c = await createTestContact(orgId)
    await createTestInvoice(orgId, c._id as Types.ObjectId, {
      invoiceNumber: 'INV-A', status: 'sent', issueDate: yesterday,
      subtotal: 100, taxTotal: 20, total: 120, amountDue: 120, paymentMethod: 'cash',
    } as any)
    await createTestInvoice(orgId, c._id as Types.ObjectId, {
      invoiceNumber: 'CN-A', type: 'credit_note', status: 'sent', issueDate: yesterday,
      subtotal: 10, taxTotal: 2, total: 12, amountDue: 12, paymentMethod: 'cash',
    } as any)

    const res = await reportById('sales-documents')!.handler!({ orgId: String(orgId), params: params(), output: 'table' })
    const note = res.rows.find(r => r.number === 'CN-A')!
    expect(note.total).toBeCloseTo(-12, 2)
    expect(note.subtotal).toBeCloseTo(-10, 2)
    expect(note.taxTotal).toBeCloseTo(-2, 2)
    // The refund comes back out of the column it was paid in.
    expect(note.paidCash).toBeCloseTo(-12, 2)

    const t = res.totals!
    expect(t.total).toBeCloseTo(108, 2)
    expect(t.subtotal).toBeCloseTo(90, 2)
    expect(t.taxTotal).toBeCloseTo(18, 2)
    expect(t.paidCash).toBeCloseTo(108, 2)
  })

  it('purchase-documents returns only incoming bills', async () => {
    const { orgId } = await seed()
    const res = await reportById('purchase-documents')!.handler!({ orgId, params: params(), output: 'table' })
    expect(res.rows.map(r => r.number)).toEqual(['BILL-1'])
    expect(res.rows[0].contactName).toBe('Vendor Ltd')
    expect(res.totals!.total).toBeCloseTo(60, 2)
  })

  it('cash-register returns only cash sales', async () => {
    const { orgId } = await seed()
    const res = await reportById('cash-register')!.handler!({ orgId, params: params(), output: 'table' })
    expect(res.rows.map(r => r.number)).toEqual(['CSR-1'])
    expect(res.totals!.amountPaid).toBeCloseTo(36, 2)
  })

  it('filters by contact and by status', async () => {
    const { orgId, customerId } = await seed()
    const entry = reportById('sales-documents')!

    const byContact = await entry.handler!({
      orgId, params: { ...params(), contactId: customerId }, output: 'table',
    })
    expect(byContact.rows.length).toBe(2)

    const byStatus = await entry.handler!({
      orgId, params: { ...params(), statuses: ['paid'] }, output: 'table',
    })
    expect(byStatus.rows.map(r => r.number)).toEqual(['INV-1'])
  })

  it('is org-scoped', async () => {
    const { orgId } = await seed()
    const other = await createTestOrg({ slug: `other-${Date.now()}` } as any)
    const otherContact = await createTestContact(other._id as Types.ObjectId, { companyName: 'Foreign' })
    await createTestInvoice(other._id as Types.ObjectId, otherContact._id as Types.ObjectId, {
      invoiceNumber: 'FOREIGN-1', issueDate: yesterday, total: 5000,
    })

    const res = await reportById('sales-documents')!.handler!({ orgId, params: params(), output: 'table' })
    expect(res.rows.map(r => r.number)).not.toContain('FOREIGN-1')
  })

  /**
   * The operator's rule (2026-10-15): the sales register splits each document's TOTAL, and
   * whatever was not paid in cash, by card or cash on delivery is „По банка". The four columns
   * therefore always add up to Общо.
   */
  describe('sales register: the four columns split each total', () => {
    async function run(orgId: Types.ObjectId) {
      const res = await reportById('sales-documents')!.handler!({
        orgId: String(orgId), params: params(), output: 'table',
      })
      return { res, by: new Map(res.rows.map(r => [r.number, r])) }
    }

    function expectPartition(r: Record<string, any>) {
      expect(r.paidCash + r.paidCard + r.paidCashOnDelivery + r.bank).toBeCloseTo(r.total, 2)
    }

    // The report that came back: invoices paid by transfer showed no sums at all.
    it('shows an open bank-transfer invoice under По банка with its whole total', async () => {
      const org = await createTestOrg()
      const orgId = org._id as Types.ObjectId
      const c = await createTestContact(orgId)
      await createTestInvoice(orgId, c._id as Types.ObjectId, {
        invoiceNumber: 'INV-OPEN', status: 'sent', issueDate: yesterday,
        total: 200, amountPaid: 0, amountDue: 200, paymentMethod: 'bank_transfer',
      } as any)
      // No method at all is not a counter sale either.
      await createTestInvoice(orgId, c._id as Types.ObjectId, {
        invoiceNumber: 'INV-NONE', status: 'sent', issueDate: yesterday,
        total: 30, amountPaid: 0, amountDue: 30,
      } as any)

      const { res, by } = await run(orgId)
      expect(by.get('INV-OPEN')!.bank).toBeCloseTo(200, 2)
      expect(by.get('INV-NONE')!.bank).toBeCloseTo(30, 2)
      expect(res.totals!.bank).toBeCloseTo(230, 2)
      expect(res.totals!.total).toBeCloseTo(230, 2)
    })

    it('puts a card or cash-on-delivery invoice in its column even before its payment is recorded', async () => {
      const org = await createTestOrg()
      const orgId = org._id as Types.ObjectId
      const c = await createTestContact(orgId)
      // Only cash is settled on issue (cash-settlement.service.ts): these stay open.
      await createTestInvoice(orgId, c._id as Types.ObjectId, {
        invoiceNumber: 'INV-CARD', status: 'sent', issueDate: yesterday,
        total: 80, amountPaid: 0, amountDue: 80, paymentMethod: 'card',
      } as any)
      await createTestInvoice(orgId, c._id as Types.ObjectId, {
        invoiceNumber: 'INV-COD', status: 'sent', issueDate: yesterday,
        total: 50, amountPaid: 0, amountDue: 50, paymentMethod: 'cash_on_delivery',
      } as any)

      const { by } = await run(orgId)
      expect(by.get('INV-CARD')!.paidCard).toBeCloseTo(80, 2)
      expect(by.get('INV-CARD')!.bank).toBe(0)
      expect(by.get('INV-COD')!.paidCashOnDelivery).toBeCloseTo(50, 2)
      expect(by.get('INV-COD')!.bank).toBe(0)
    })

    it('follows recorded tender first, and the document\'s own method for what is still open', async () => {
      const org = await createTestOrg()
      const orgId = org._id as Types.ObjectId
      const c = await createTestContact(orgId)
      // A cash invoice as it is issued: settled in cash on the spot.
      await createTestInvoice(orgId, c._id as Types.ObjectId, {
        invoiceNumber: 'INV-CASH', status: 'paid', issueDate: yesterday, total: 120, amountPaid: 120, amountDue: 0,
        paymentMethod: 'cash', payments: [{ method: 'cash', amount: 120, date: yesterday, origin: 'cash_on_issue' }],
      } as any)
      // Split tender feeds two columns.
      await createTestInvoice(orgId, c._id as Types.ObjectId, {
        invoiceNumber: 'INV-SPLIT', status: 'paid', issueDate: yesterday, total: 100, amountPaid: 100, amountDue: 0,
        payments: [
          { method: 'card', amount: 60, date: yesterday },
          { method: 'bank_transfer', amount: 40, date: yesterday },
        ],
      } as any)
      // A bank invoice part-paid in cash at the counter: the cash is cash, the rest is still by bank.
      await createTestInvoice(orgId, c._id as Types.ObjectId, {
        invoiceNumber: 'INV-PART', status: 'partially_paid', issueDate: yesterday, total: 100, amountPaid: 30, amountDue: 70,
        paymentMethod: 'bank_transfer', payments: [{ method: 'cash', amount: 30, date: yesterday }],
      } as any)
      // Anything that is not a counter method is by bank — `other` included.
      await createTestInvoice(orgId, c._id as Types.ObjectId, {
        invoiceNumber: 'INV-OTHER', status: 'paid', issueDate: yesterday, total: 70, amountPaid: 70, amountDue: 0,
        payments: [{ method: 'other', amount: 70, date: yesterday }],
      } as any)

      const { res, by } = await run(orgId)
      expect(by.get('INV-CASH')!.paidCash).toBeCloseTo(120, 2)
      expect(by.get('INV-SPLIT')!.paidCard).toBeCloseTo(60, 2)
      expect(by.get('INV-SPLIT')!.bank).toBeCloseTo(40, 2)
      expect(by.get('INV-PART')!.paidCash).toBeCloseTo(30, 2)
      expect(by.get('INV-PART')!.bank).toBeCloseTo(70, 2)
      expect(by.get('INV-OTHER')!.bank).toBeCloseTo(70, 2)
      for (const r of res.rows) expectPartition(r)

      // The sales register has no unattributed remainder to explain.
      expect(res.meta!.unattributedPaid).toBeUndefined()
    })

    it('never splits more than the total, even when more was paid', async () => {
      const org = await createTestOrg()
      const orgId = org._id as Types.ObjectId
      const c = await createTestContact(orgId)
      // Until FR-22.7, POST /invoices/:id/payments did not refuse an overpayment, so such
      // documents exist.
      await createTestInvoice(orgId, c._id as Types.ObjectId, {
        invoiceNumber: 'INV-OVER', status: 'paid', issueDate: yesterday, total: 100, amountPaid: 150, amountDue: -50,
        paymentMethod: 'bank_transfer', payments: [{ method: 'cash', amount: 150, date: yesterday }],
      } as any)

      const { by } = await run(orgId)
      const r = by.get('INV-OVER')!
      expect(r.paidCash).toBeCloseTo(100, 2)
      expect(r.bank).toBe(0)
      expectPartition(r)
    })

    it('closes every column on a total, and the four add up to Общо', async () => {
      const org = await createTestOrg()
      const orgId = org._id as Types.ObjectId
      const c = await createTestContact(orgId)
      const docs: [string, number, string | undefined][] = [
        ['D-1', 120.1, 'cash'], ['D-2', 33.33, 'card'], ['D-3', 19.99, 'cash_on_delivery'],
        ['D-4', 1234.56, 'bank_transfer'], ['D-5', 0.07, undefined], ['D-6', 66.67, 'card'],
      ]
      for (const [invoiceNumber, total, paymentMethod] of docs) {
        await createTestInvoice(orgId, c._id as Types.ObjectId, {
          invoiceNumber, status: 'sent', issueDate: yesterday, total, amountPaid: 0, amountDue: total, paymentMethod,
        } as any)
      }

      const { res } = await run(orgId)
      const t = res.totals!
      expect(t.paidCash).toBeCloseTo(120.1, 2)
      expect(t.paidCard).toBeCloseTo(100, 2)
      expect(t.paidCashOnDelivery).toBeCloseTo(19.99, 2)
      expect(t.bank).toBeCloseTo(1234.63, 2)
      // Exact to the cent: „По банка" absorbs the rounding.
      expect(+(t.paidCash + t.paidCard + t.paidCashOnDelivery + t.bank).toFixed(2)).toBe(t.total)
    })
  })

  /** #127 — the purchase register and the cash register split what was PAID, and say so. */
  describe('purchase / cash registers: the paid-by-method split', () => {
    it('leaves an unpaid bill out of every method column, Остатък shows it', async () => {
      const org = await createTestOrg()
      const orgId = org._id as Types.ObjectId
      const s = await createTestContact(orgId, { companyName: 'Vendor Ltd', type: 'supplier' })
      await createTestInvoice(orgId, s._id as Types.ObjectId, {
        invoiceNumber: 'BILL-OPEN', direction: 'incoming', status: 'received', issueDate: yesterday,
        total: 200, amountPaid: 0, amountDue: 200, paymentMethod: 'bank_transfer',
      } as any)
      await createTestInvoice(orgId, s._id as Types.ObjectId, {
        invoiceNumber: 'BILL-PAID', direction: 'incoming', status: 'paid', issueDate: yesterday,
        total: 50, amountPaid: 50, amountDue: 0, payments: [{ method: 'bank_transfer', amount: 50, date: yesterday }],
      } as any)

      const res = await reportById('purchase-documents')!.handler!({
        orgId: String(orgId), params: params(), output: 'table',
      })
      const t = res.totals!
      expect(t.paidBank).toBeCloseTo(50, 2)
      expect(t.amountDue).toBeCloseTo(200, 2)
      expect(t.paidCash + t.paidCard + t.paidBank + t.paidCashOnDelivery).toBeCloseTo(t.amountPaid, 2)
      expect(res.meta!.unattributedPaid).toBe(0)
    })

    it('counts tender under an unmapped method apart instead of dropping it', async () => {
      const org = await createTestOrg()
      const orgId = org._id as Types.ObjectId
      const s = await createTestContact(orgId, { type: 'supplier' })
      await createTestInvoice(orgId, s._id as Types.ObjectId, {
        invoiceNumber: 'BILL-OTHER', direction: 'incoming', status: 'paid', issueDate: yesterday,
        total: 70, amountPaid: 70, amountDue: 0, payments: [{ method: 'other', amount: 70, date: yesterday }],
      } as any)

      const res = await reportById('purchase-documents')!.handler!({
        orgId: String(orgId), params: params(), output: 'table',
      })
      const t = res.totals!
      expect(t.paidCash + t.paidCard + t.paidBank + t.paidCashOnDelivery).toBe(0)
      expect(res.meta!.unattributedPaid).toBeCloseTo(70, 2)
      expect(t.paidCash + t.paidCard + t.paidBank + t.paidCashOnDelivery + res.meta!.unattributedPaid)
        .toBeCloseTo(t.amountPaid, 2)
    })

    it('infers cash for a paid cash sale recorded without payment rows', async () => {
      const org = await createTestOrg()
      const orgId = org._id as Types.ObjectId
      const c = await createTestContact(orgId)
      await createTestInvoice(orgId, c._id as Types.ObjectId, {
        invoiceNumber: 'CSR-9', type: 'cash_sale', issueDate: yesterday,
        total: 36, amountPaid: 36, amountDue: 0,
      } as any)

      const res = await reportById('cash-register')!.handler!({
        orgId: String(orgId), params: params(), output: 'table',
      })
      expect(res.rows[0].paidCash).toBeCloseTo(36, 2)
      expect(res.totals!.paidCash).toBeCloseTo(36, 2)
    })

  })

  it('never leaks the raw payment fields into the rows, whichever split ran', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const c = await createTestContact(orgId)
    const payments = [{ method: 'cash', amount: 10, date: yesterday }]
    await createTestInvoice(orgId, c._id as Types.ObjectId, {
      invoiceNumber: 'INV-X', issueDate: yesterday, total: 10, amountPaid: 10, paymentMethod: 'cash', payments,
    } as any)
    await createTestInvoice(orgId, c._id as Types.ObjectId, {
      invoiceNumber: 'BILL-X', direction: 'incoming', issueDate: yesterday, total: 10, amountPaid: 10,
      paymentMethod: 'cash', payments,
    } as any)

    for (const id of ['sales-documents', 'purchase-documents']) {
      const res = await reportById(id)!.handler!({ orgId: String(orgId), params: params(), output: 'table' })
      expect(res.rows).toHaveLength(1)
      expect(res.rows[0]).not.toHaveProperty('payments')
      expect(res.rows[0]).not.toHaveProperty('paymentMethod')
    }
  })

  it('flags mixed currencies instead of summing across them', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const c = await createTestContact(orgId)
    await createTestInvoice(orgId, c._id as Types.ObjectId, { invoiceNumber: 'A', currency: 'EUR', issueDate: yesterday, total: 10 })
    await createTestInvoice(orgId, c._id as Types.ObjectId, { invoiceNumber: 'B', currency: 'BGN', issueDate: yesterday, total: 20 })

    const res = await reportById('sales-documents')!.handler!({ orgId: String(orgId), params: params(), output: 'table' })
    expect(res.meta!.mixedCurrency).toBe(true)
    expect(res.meta!.currency).toBeUndefined()
  })
})

// ── Ledgers ──────────────────────────────────────────────────────────────────

describe('contact-ledger handler', () => {
  it('returns the counterparty\'s document lines and requires a contact', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const contact = await createTestContact(orgId, { companyName: 'Buyer Ltd' })
    const product = await createTestProduct(orgId, { name: 'Bolt' })

    await createTestInvoice(orgId, contact._id as Types.ObjectId, {
      invoiceNumber: 'INV-L1', status: 'paid', issueDate: yesterday,
      lines: [{
        productId: product._id, description: 'Bolt', quantity: 3, unit: 'pcs',
        unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 6, lineTotal: 36,
      }] as any,
    })

    const entry = reportById('contact-ledger')!
    const res = await entry.handler!({
      orgId: String(orgId),
      params: { contactId: String(contact._id), period: period(lastWeek, today) },
      output: 'table',
    })

    expect(res.rows.length).toBeGreaterThan(0)
    expect(res.rows[0].documentNumber).toBe('INV-L1')
    expect(res.rows[0].quantity).toBe(3)
    expect(res.meta!.ledgerSummary).toBeDefined()

    // Without a contact it is not a ledger — the handler refuses rather than dumping the org.
    const err = await captureRejection(entry.handler!({ orgId: String(orgId), params: {}, output: 'table' }))
    expect(err).toBeTruthy()
    expect(String(err.message)).toContain('contact')
  })
})

describe('product-ledger handler', () => {
  it('returns movements with the running balance and requires a product', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const wh = await createTestWarehouse(orgId)
    const product = await createTestProduct(orgId, { sku: 'BOLT-1', name: 'Bolt' })

    await createTestStockMovement(orgId, {
      movementNumber: 'SM-IN', type: 'receipt', status: 'completed', date: lastWeek,
      toWarehouseId: wh._id,
      lines: [{ productId: product._id, quantity: 10, unitCost: 2, totalCost: 20 }] as any,
    })
    await createTestStockMovement(orgId, {
      movementNumber: 'SM-OUT', type: 'dispatch', status: 'completed', date: yesterday,
      fromWarehouseId: wh._id,
      lines: [{ productId: product._id, quantity: 4, unitCost: 2, totalCost: 8 }] as any,
    })

    const entry = reportById('product-ledger')!
    const res = await entry.handler!({
      orgId: String(orgId),
      params: { productId: String(product._id), period: period(new Date(today.getTime() - 30 * DAY), today) },
      output: 'table',
    })

    expect(res.rows.length).toBe(2)
    const refs = res.rows.map(r => r.documentRef)
    expect(refs).toContain('SM-IN')
    expect(refs).toContain('SM-OUT')
    expect(res.meta!.ledgerSummary).toBeDefined()

    const err = await captureRejection(entry.handler!({ orgId: String(orgId), params: {}, output: 'table' }))
    expect(err).toBeTruthy()
    expect(String(err.message)).toContain('product')
  })
})

// ── Stock ────────────────────────────────────────────────────────────────────

describe('stock-levels handler', () => {
  async function seed() {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const wh1 = await createTestWarehouse(orgId, { name: 'Main' })
    const wh2 = await createTestWarehouse(orgId, { name: 'Depot' })
    const bolt = await createTestProduct(orgId, { sku: 'BOLT-1', name: 'Bolt', minStockLevel: 50 })
    const nut = await createTestProduct(orgId, { sku: 'NUT-1', name: 'Nut', minStockLevel: 0 })

    await createTestStockLevel(orgId, bolt._id as Types.ObjectId, wh1._id as Types.ObjectId, { quantity: 10, avgCost: 2, availableQuantity: 8, reservedQuantity: 2 })
    await createTestStockLevel(orgId, bolt._id as Types.ObjectId, wh2._id as Types.ObjectId, { quantity: 15, avgCost: 2, availableQuantity: 15 })
    await createTestStockLevel(orgId, nut._id as Types.ObjectId, wh1._id as Types.ObjectId, { quantity: 500, avgCost: 1, availableQuantity: 500 })

    return { orgId: String(orgId), wh1: String(wh1._id) }
  }

  it('reports one row per warehouse by default', async () => {
    const { orgId } = await seed()
    const res = await reportById('stock-levels')!.handler!({ orgId, params: {}, output: 'table' })
    expect(res.rows.length).toBe(3)
    expect(res.rows.some(r => r.warehouseName === 'Depot')).toBe(true)
  })

  it('rolls up per product when asked', async () => {
    const { orgId } = await seed()
    const res = await reportById('stock-levels')!.handler!({ orgId, params: { groupBy: 'product' }, output: 'table' })
    const bolt = res.rows.find(r => r.sku === 'BOLT-1')!
    expect(res.rows.length).toBe(2)
    expect(bolt.quantity).toBe(25)
    // No single warehouse answer when rolled up — blank, not invented.
    expect(bolt.warehouseName).toBe('')
  })

  it('below-minimum only compares against the product threshold, skipping products without one', async () => {
    const { orgId } = await seed()
    const res = await reportById('stock-levels')!.handler!({
      orgId, params: { groupBy: 'product', belowMin: true }, output: 'table',
    })

    // Bolt: 25 on hand vs a minimum of 50 → short by 25. Nut has no threshold at all.
    expect(res.rows.map(r => r.sku)).toEqual(['BOLT-1'])
    expect(res.rows[0].shortfall).toBe(25)
    expect(res.totals!.shortfall).toBe(25)
  })

  it('scopes to a warehouse', async () => {
    const { orgId, wh1 } = await seed()
    const res = await reportById('stock-levels')!.handler!({ orgId, params: { warehouseId: wh1 }, output: 'table' })
    expect(res.rows.every(r => r.warehouseName === 'Main')).toBe(true)
  })
})

describe('stock-movements handler', () => {
  async function seed() {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const wh = await createTestWarehouse(orgId, { name: 'Main' })
    const bolt = await createTestProduct(orgId, { sku: 'BOLT-1', name: 'Bolt' })
    const nut = await createTestProduct(orgId, { sku: 'NUT-1', name: 'Nut' })

    await createTestStockMovement(orgId, {
      movementNumber: 'SM-1', type: 'receipt', status: 'completed', date: yesterday, toWarehouseId: wh._id,
      lines: [
        { productId: bolt._id, quantity: 10, unitCost: 2, totalCost: 20 },
        { productId: nut._id, quantity: 5, unitCost: 1, totalCost: 5 },
      ] as any,
    })
    await createTestStockMovement(orgId, {
      movementNumber: 'SM-2', type: 'transfer', status: 'completed', date: yesterday, fromWarehouseId: wh._id,
      lines: [{ productId: bolt._id, quantity: 3, unitCost: 2, totalCost: 6 }] as any,
    })
    // A draft moved nothing and is excluded unless explicitly requested.
    await createTestStockMovement(orgId, {
      movementNumber: 'SM-DRAFT', type: 'receipt', status: 'draft', date: yesterday, toWarehouseId: wh._id,
      lines: [{ productId: bolt._id, quantity: 999, unitCost: 1, totalCost: 999 }] as any,
    })

    return { orgId: String(orgId), boltId: String(bolt._id) }
  }

  const params = () => ({ period: period(lastWeek, today) })

  it('returns one row per line and excludes drafts by default', async () => {
    const { orgId } = await seed()
    const res = await reportById('stock-movements')!.handler!({ orgId, params: params(), output: 'table' })

    expect(res.rows.length).toBe(3)
    expect(res.rows.map(r => r.movementNumber)).not.toContain('SM-DRAFT')
    expect(res.totals!.quantity).toBe(18)
  })

  it('includes transfers and adjustments — unlike the warehouse-operations report', async () => {
    const { orgId } = await seed()
    const res = await reportById('stock-movements')!.handler!({ orgId, params: params(), output: 'table' })
    expect(res.rows.some(r => r.type === 'transfer')).toBe(true)
  })

  it('filters by product and by type', async () => {
    const { orgId, boltId } = await seed()
    const entry = reportById('stock-movements')!

    const byProduct = await entry.handler!({ orgId, params: { ...params(), productId: boltId }, output: 'table' })
    expect(byProduct.rows.every(r => r.sku === 'BOLT-1')).toBe(true)
    expect(byProduct.rows.length).toBe(2)

    const byType = await entry.handler!({ orgId, params: { ...params(), types: ['receipt'] }, output: 'table' })
    expect(byType.rows.every(r => r.type === 'receipt')).toBe(true)
  })

  it('groups by document on request', async () => {
    const { orgId } = await seed()
    const res = await reportById('stock-movements')!.handler!({
      orgId, params: { ...params(), groupBy: 'document' }, output: 'table',
    })

    expect(res.rows.length).toBe(2)
    const sm1 = res.rows.find(r => r.movementNumber === 'SM-1')!
    expect(sm1.lineCount).toBe(2)
    expect(sm1.quantity).toBe(15)
    expect(res.columns.some(c => c.key === 'lineCount')).toBe(true)
  })
})

// ── Purchasing ───────────────────────────────────────────────────────────────

describe('order-sheet handler', () => {
  async function seed() {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const supplier = await createTestContact(orgId, { companyName: 'Vendor Ltd', type: 'supplier' })
    const product = await createTestProduct(orgId, { sku: 'BOLT-1', name: 'Bolt' })

    await Order.create({
      orgId,
      orderNumber: 'ORDO-1',
      status: 'partially_received',
      issueDate: yesterday,
      currency: 'EUR',
      exchangeRate: 1,
      supplierGroups: [{
        supplierId: supplier._id,
        lines: [
          { productId: product._id, description: 'Bolt', sku: 'BOLT-1', quantity: 100, unit: 'pcs', expectedUnitPrice: 2, receivedQuantity: 40 },
          { productId: product._id, description: 'Bolt short', sku: 'BOLT-2', quantity: 10, unit: 'pcs', expectedUnitPrice: 3, receivedQuantity: 10 },
        ],
      }],
      createdBy: org._id,
    } as any)

    // Cancelled orders are noise in "what is still coming".
    await Order.create({
      orgId,
      orderNumber: 'ORDO-CANCELLED',
      status: 'cancelled',
      issueDate: yesterday,
      currency: 'EUR',
      exchangeRate: 1,
      supplierGroups: [{
        supplierId: supplier._id,
        lines: [{ productId: product._id, description: 'Bolt', quantity: 999, unit: 'pcs', expectedUnitPrice: 1, receivedQuantity: 0 }],
      }],
      createdBy: org._id,
    } as any)

    return { orgId: String(orgId), supplierId: String(supplier._id) }
  }

  const params = () => ({ period: period(lastWeek, today) })

  it('reports ordered / received / outstanding per line and hides cancelled orders', async () => {
    const { orgId } = await seed()
    const res = await reportById('order-sheet')!.handler!({ orgId, params: params(), output: 'table' })

    expect(res.rows.map(r => r.orderNumber)).not.toContain('ORDO-CANCELLED')
    expect(res.rows.length).toBe(2)

    const open = res.rows.find(r => r.sku === 'BOLT-1')!
    expect(open.ordered).toBe(100)
    expect(open.received).toBe(40)
    expect(open.outstanding).toBe(60)
    expect(open.value).toBeCloseTo(200, 2)
    expect(open.supplierName).toBe('Vendor Ltd')

    expect(res.totals!.outstanding).toBe(60)
  })

  it('narrows to what is still outstanding', async () => {
    const { orgId } = await seed()
    const res = await reportById('order-sheet')!.handler!({
      orgId, params: { ...params(), onlyOutstanding: true }, output: 'table',
    })
    expect(res.rows.map(r => r.sku)).toEqual(['BOLT-1'])
  })

  it('filters by supplier', async () => {
    const { orgId, supplierId } = await seed()
    const res = await reportById('order-sheet')!.handler!({
      orgId, params: { ...params(), contactId: supplierId }, output: 'table',
    })
    expect(res.rows.length).toBe(2)
  })
})

// ── The P2 gates ─────────────────────────────────────────────────────────────

describe('SUPTO catalog entries (FR-6.7 roles restriction)', () => {
  const suptoIds = REPORT_REGISTRY.filter(e => e.id.startsWith('supto-')).map(e => e.id)

  it('registers all nine tables', () => {
    expect(suptoIds.length).toBe(9)
    expect(suptoIds).toContain('supto-18-1')
    expect(suptoIds).toContain('supto-18-9')
  })

  it('shows them to an admin and an nra_auditor', () => {
    for (const role of ['admin', 'nra_auditor'] as const) {
      const ids = listReportsFor(caller(role)).map(r => r.id)
      for (const id of suptoIds) expect(ids, `${role} cannot see ${id}`).toContain(id)
    }
  })

  it('hides them from a manager, who holds every module permission', () => {
    // This is exactly why `roles` exists on top of `permission`.
    const ids = listReportsFor(caller('manager')).map(r => r.id)
    for (const id of suptoIds) expect(ids).not.toContain(id)
    expect(canAccessReport(reportById('supto-18-1')!, caller('manager'))).toBe(false)
  })

  it('offers XLSX only, with no generic handler', () => {
    for (const id of suptoIds) {
      const e = reportById(id)!
      expect(e.outputs).toEqual(['xlsx'])
      expect(e.view).toBe('custom')
      expect(e.handler).toBeUndefined()
    }
  })

  it('gives 18.9 no period — it is a snapshot', () => {
    expect(reportById('supto-18-9')!.params).toEqual([])
    expect(reportById('supto-18-1')!.params.length).toBe(1)
  })
})

describe('reports.export gate (FR-6.2)', () => {
  const entry = () => reportById('sales-documents')!

  it('lets a role with reports.export download', () => {
    expect(canExportReport(entry(), caller('accountant'))).toBe(true)
    expect(canExportReport(entry(), caller('admin'))).toBe(true)
  })

  it('lets a read-only member run but not download', () => {
    const member = caller('member')
    expect(canAccessReport(entry(), member)).toBe(true)
    expect(canExportReport(entry(), member)).toBe(false)
  })

  it('never lets reports.export alone reveal a report the caller cannot access', () => {
    const outsider = { role: 'member', permissions: ['reports.read', 'reports.export'] }
    expect(canAccessReport(entry(), outsider)).toBe(false)
    expect(canExportReport(entry(), outsider)).toBe(false)
  })

  it('keeps the NRA auditor able to export — the whole point of the role', () => {
    expect(canExportReport(reportById('supto-18-1')!, caller('nra_auditor'))).toBe(true)
  })
})

describe('P2 catalog completeness (issue #14)', () => {
  it('registers every report the issue lists', () => {
    const ids = REPORT_REGISTRY.map(e => e.id)
    for (const id of [
      'sales-documents', 'purchase-documents', 'cash-register',
      'aging', 'contact-ledger',
      'inventory-valuation', 'stock-levels', 'stock-movements', 'product-ledger',
      'order-sheet',
      ...Array.from({ length: 9 }, (_, i) => `supto-18-${i + 1}`),
    ]) {
      expect(ids, `missing registry entry: ${id}`).toContain(id)
    }
  })

  it('validates the new params and drops anything undeclared', () => {
    const out = validateParams(reportById('stock-levels')!, {
      belowMin: 'true', groupBy: 'product', evil: 'DROP TABLE',
    })
    expect(out).toEqual({ belowMin: true, groupBy: 'product', includeZero: false })
  })

  it('rejects an out-of-range status value rather than silently ignoring it', () => {
    let threw = false
    try {
      validateParams(reportById('order-sheet')!, { statuses: ['not_a_status'] })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})
