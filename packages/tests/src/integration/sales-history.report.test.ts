import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestContact,
  createTestInvoice,
  createTestWarehouse,
  createTestUser,
  createTestPOSSession,
  createTestPOSTransaction,
} from '../helpers/factories'
import { migrateTill } from '../helpers/migrate-till'
import { reportById, validateParams } from 'services/biz/report-registry'
import { effectiveMethods, bucketFor } from 'services/biz/reports/sales-history.report'
import type { Types } from 'mongoose'

/**
 * FR-08 (#17) — „История на продажбите".
 *
 * The behaviour that must never regress is the payment-method precedence: regal records
 * its card days as cash sales with an explicit `paymentMethod: 'card'`, and the existing
 * export controller misreports exactly that case as cash.
 */

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

const entry = () => reportById('sales-history')!
const run = (orgId: string, params: Record<string, any> = {}) =>
  entry().handler!({ orgId, params: validateParams(entry(), params), output: 'table' })
/** FR-21 R4: legacy POS rows are read once they are documents, as 0008/0009 make them. */
const runMigrated = async (orgId: string, params: Record<string, any> = {}) => {
  await migrateTill(orgId)
  return run(orgId, params)
}

const DAY = { preset: 'custom', from: '2026-05-10', to: '2026-05-10' }
const at = (iso: string) => new Date(iso)

async function seed() {
  const org = await createTestOrg()
  const orgId = org._id as Types.ObjectId
  const customer = await createTestContact(orgId, { type: 'customer', companyName: 'Customer Ltd' })
  const user = await createTestUser(orgId, { firstName: 'Rosalina', lastName: 'Dodova' })
  const wh = await createTestWarehouse(orgId)
  return { orgId, customer, user, wh }
}

// ── the precedence rule, in isolation ───────────────────────────────────────

describe('effectiveMethods (FR-8.4)', () => {
  it('a cash or card header on an unpaid invoice is not money yet (FR-23): its receipt did not print', () => {
    for (const type of ['invoice', 'debit_note']) {
      expect(effectiveMethods({ type, paymentMethod: 'cash', total: 50, amountPaid: 0 })).toEqual([{ method: 'cash', amount: 0 }])
      expect(effectiveMethods({ type, paymentMethod: 'card', total: 50, amountPaid: 0 })).toEqual([{ method: 'card', amount: 0 }])
    }
    // What is not printed for stays as it was: a credit note's header still counts against the bucket.
    expect(effectiveMethods({ type: 'credit_note', paymentMethod: 'cash', total: 50, amountPaid: 0 })).toEqual([{ method: 'cash', amount: 50 }])
    expect(effectiveMethods({ type: 'invoice', paymentMethod: 'bank_transfer', total: 50, amountPaid: 0 })).toEqual([{ method: 'bank_transfer', amount: 50 }])
  })

  it('prefers payment rows over the header method', () => {
    expect(effectiveMethods({
      type: 'invoice', paymentMethod: 'cash', total: 100,
      payments: [{ method: 'card', amount: 100 }],
    })).toEqual([{ method: 'card', amount: 100 }])
  })

  it('splits tender across methods', () => {
    const out = effectiveMethods({
      type: 'invoice', total: 100,
      payments: [{ method: 'cash', amount: 40 }, { method: 'card', amount: 60 }],
    })
    expect(out).toHaveLength(2)
    expect(out.reduce((s, m) => s + m.amount, 0)).toBe(100)
  })

  it('uses the header method when there are no payment rows', () => {
    expect(effectiveMethods({ type: 'cash_sale', paymentMethod: 'card', total: 50, amountPaid: 50 }))
      .toEqual([{ method: 'card', amount: 50 }])
  })

  it('infers cash only for a paid cash sale with nothing else stated', () => {
    expect(effectiveMethods({ type: 'cash_sale', total: 50, amountPaid: 50 }))
      .toEqual([{ method: 'cash', amount: 50 }])
    expect(effectiveMethods({ type: 'invoice', total: 50, amountPaid: 50 })).toEqual([])
    expect(effectiveMethods({ type: 'cash_sale', total: 50, amountPaid: 0 })).toEqual([])
  })

  it('buckets everything outside cash/card as other', () => {
    expect(bucketFor('cash')).toBe('cash')
    expect(bucketFor('card')).toBe('card')
    expect(bucketFor('bank_transfer')).toBe('other')
    expect(bucketFor('voucher')).toBe('other')
    expect(bucketFor(undefined)).toBe('other')
  })
})

// ── the report ──────────────────────────────────────────────────────────────

describe('sales-history — document rows', () => {
  it('includes cash and card sales and excludes bank transfers by default', async () => {
    const s = await seed()
    const base = { issueDate: at('2026-05-10'), direction: 'outgoing', status: 'paid', amountPaid: 100, total: 100 }
    await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, { ...base, type: 'cash_sale', invoiceNumber: 'CS-1' })
    await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, { ...base, type: 'invoice', paymentMethod: 'card', invoiceNumber: 'INV-1' })
    await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, { ...base, type: 'invoice', paymentMethod: 'bank_transfer', invoiceNumber: 'INV-2' })

    const res = await run(String(s.orgId), { period: DAY })
    expect(res.rows.map(r => r.number).sort()).toEqual(['CS-1', 'INV-1'])
  })

  it('adds bank transfers when includeNonRegister is on', async () => {
    const s = await seed()
    await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
      issueDate: at('2026-05-10'), type: 'invoice', direction: 'outgoing', status: 'paid',
      paymentMethod: 'bank_transfer', total: 100, amountPaid: 100, invoiceNumber: 'INV-2',
    })
    const res = await run(String(s.orgId), { period: DAY, includeNonRegister: true })
    expect(res.rows.map(r => r.number)).toEqual(['INV-2'])
    expect(res.meta!.summary[0].other).toBe(100)
  })

  it('puts a card-marked CASH SALE in the card bucket, not cash', async () => {
    // The regression this report exists to fix — the export controller gets this wrong.
    const s = await seed()
    await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
      issueDate: at('2026-05-10'), type: 'cash_sale', direction: 'outgoing', status: 'paid',
      paymentMethod: 'card', total: 80, amountPaid: 80, invoiceNumber: 'CS-CARD',
    })
    const res = await run(String(s.orgId), { period: DAY })
    const summary = res.meta!.summary[0]
    expect(summary.card).toBe(80)
    expect(summary.cash).toBe(0)
  })

  it('excludes drafts, voided and cancelled documents', async () => {
    const s = await seed()
    for (const status of ['draft', 'voided', 'cancelled', 'converted']) {
      await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
        issueDate: at('2026-05-10'), type: 'cash_sale', direction: 'outgoing',
        status, total: 10, amountPaid: 10, invoiceNumber: `X-${status}`,
      })
    }
    const res = await run(String(s.orgId), { period: DAY })
    expect(res.rows).toHaveLength(0)
  })

  it('renders credit notes as negative rows that net the summary', async () => {
    const s = await seed()
    await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
      issueDate: at('2026-05-10'), type: 'cash_sale', direction: 'outgoing', status: 'paid',
      total: 100, amountPaid: 100, invoiceNumber: 'CS-1',
    })
    await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
      issueDate: at('2026-05-10'), type: 'credit_note', direction: 'outgoing', status: 'paid',
      paymentMethod: 'cash', total: 30, amountPaid: 30, invoiceNumber: 'CN-1',
    })
    const res = await run(String(s.orgId), { period: DAY })
    const cn = res.rows.find(r => r.number === 'CN-1')!
    expect(cn.total).toBe(-30)
    expect(res.meta!.summary[0].cash).toBe(70)
    expect(res.meta!.creditNoteCount).toBe(1)
  })

  it('blanks the time on imported day-aggregate rows and counts them', async () => {
    const s = await seed()
    await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
      issueDate: at('2026-05-10'), type: 'cash_sale', direction: 'outgoing', status: 'paid',
      total: 500, amountPaid: 500, invoiceNumber: 'CSR-1', tags: ['cash-register-import'],
    })
    const res = await run(String(s.orgId), { period: DAY })
    expect(res.rows[0].time).toBe('')
    expect(res.meta!.rowsWithoutTime).toBe(1)
  })

  it('fills the invoice-number column only for real invoices', async () => {
    const s = await seed()
    await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
      issueDate: at('2026-05-10'), type: 'cash_sale', direction: 'outgoing', status: 'paid',
      total: 10, amountPaid: 10, invoiceNumber: 'CS-1',
    })
    await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
      issueDate: at('2026-05-10'), type: 'invoice', direction: 'outgoing', status: 'paid',
      paymentMethod: 'cash', total: 20, amountPaid: 20, invoiceNumber: 'INV-1',
    })
    const res = await run(String(s.orgId), { period: DAY })
    expect(res.rows.find(r => r.number === 'CS-1')!.invoiceNumber).toBe('')
    expect(res.rows.find(r => r.number === 'INV-1')!.invoiceNumber).toBe('INV-1')
  })

  it('resolves the user name', async () => {
    const s = await seed()
    await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
      issueDate: at('2026-05-10'), type: 'cash_sale', direction: 'outgoing', status: 'paid',
      total: 10, amountPaid: 10, createdBy: s.user._id,
    })
    const res = await run(String(s.orgId), { period: DAY })
    expect(res.rows[0].userName).toBe('Rosalina Dodova')
    expect(res.rows[0].contactName).toBe('Customer Ltd')
  })
})

describe('sales-history — POS rows', () => {
  async function withPos() {
    const s = await seed()
    const session = await createTestPOSSession(s.orgId, s.wh._id as Types.ObjectId, s.user._id as Types.ObjectId)
    return { ...s, session }
  }

  it('includes completed transactions with their real time and register', async () => {
    const s = await withPos()
    await createTestPOSTransaction(s.orgId, s.session._id as Types.ObjectId, s.user._id as Types.ObjectId, {
      status: 'completed', total: 42, createdAt: at('2026-05-10T14:32:05'),
      payments: [{ method: 'cash', amount: 42 }], fiscalDeviceNumber: 'DT123456',
      transactionNumber: 'TXN-9',
    })
    const res = await runMigrated(String(s.orgId), { period: DAY })
    const row = res.rows.find(r => r.number === 'TXN-9')!
    expect(row.rowType).toBe('pos')
    expect(row.register).toBe('DT123456')
    expect(row.time).not.toBe('')
    expect(res.meta!.summary[0].cash).toBe(42)
  })

  it('renders storno and returns as negatives', async () => {
    const s = await withPos()
    await createTestPOSTransaction(s.orgId, s.session._id as Types.ObjectId, s.user._id as Types.ObjectId, {
      status: 'completed', type: 'sale', total: 50, createdAt: at('2026-05-10T10:00:00'),
      payments: [{ method: 'cash', amount: 50 }], transactionNumber: 'TXN-S',
    })
    await createTestPOSTransaction(s.orgId, s.session._id as Types.ObjectId, s.user._id as Types.ObjectId, {
      status: 'completed', type: 'storno', total: 50, createdAt: at('2026-05-10T10:05:00'),
      payments: [{ method: 'cash', amount: 50 }], transactionNumber: 'TXN-Z',
    })
    const res = await runMigrated(String(s.orgId), { period: DAY })
    expect(res.rows.find(r => r.number === 'TXN-Z')!.total).toBe(-50)
    // A sale and its storno net to nothing.
    expect(res.meta!.summary[0].cash).toBe(0)
  })

  // FR-21.1 (B-1): the storno route leaves the original `cancelled` and adds a `completed` storno.
  // Skipping the cancelled sale AND subtracting the storno took the sale out twice.
  it('counts a stornoed sale, and its storno takes it back: the day nets to nothing', async () => {
    const s = await withPos()
    const sale = await createTestPOSTransaction(s.orgId, s.session._id as Types.ObjectId, s.user._id as Types.ObjectId, {
      status: 'cancelled', type: 'sale', total: 50, createdAt: at('2026-05-10T10:00:00'),
      payments: [{ method: 'cash', amount: 50 }], transactionNumber: 'TXN-S',
    })
    await createTestPOSTransaction(s.orgId, s.session._id as Types.ObjectId, s.user._id as Types.ObjectId, {
      status: 'completed', type: 'storno', total: 50, createdAt: at('2026-05-10T10:05:00'),
      payments: [{ method: 'cash', amount: 50 }], transactionNumber: 'TXN-Z',
      originalTransactionId: sale._id as Types.ObjectId,
    })
    const res = await runMigrated(String(s.orgId), { period: DAY })
    expect(res.rows.map(r => r.number).sort()).toEqual(['TXN-S', 'TXN-Z'])
    expect(res.rows.find(r => r.number === 'TXN-S')!.total).toBe(50)
    expect(res.meta!.summary[0].total).toBe(0)
    expect(res.meta!.summary[0].cash).toBe(0)
  })

  it('leaves out a storno whose receipt failed: it reversed nothing (#145)', async () => {
    const s = await withPos()
    await createTestPOSTransaction(s.orgId, s.session._id as Types.ObjectId, s.user._id as Types.ObjectId, {
      status: 'completed', type: 'sale', total: 50, createdAt: at('2026-05-10T10:00:00'),
      payments: [{ method: 'cash', amount: 50 }], transactionNumber: 'TXN-S',
    })
    await createTestPOSTransaction(s.orgId, s.session._id as Types.ObjectId, s.user._id as Types.ObjectId, {
      status: 'cancelled', type: 'storno', total: 50, createdAt: at('2026-05-10T10:05:00'),
      payments: [{ method: 'cash', amount: 50 }], transactionNumber: 'TXN-Z',
    })
    const res = await runMigrated(String(s.orgId), { period: DAY })
    expect(res.rows.map(r => r.number)).toEqual(['TXN-S'])
    expect(res.meta!.summary[0].cash).toBe(50)
  })

  it('counts the cash the drawer kept, not the cash tendered', async () => {
    const s = await withPos()
    await createTestPOSTransaction(s.orgId, s.session._id as Types.ObjectId, s.user._id as Types.ObjectId, {
      status: 'completed', total: 37.2, createdAt: at('2026-05-10T10:00:00'),
      payments: [{ method: 'cash', amount: 50 }], changeDue: 12.8,
    })
    const sum = (await runMigrated(String(s.orgId), { period: DAY })).meta!.summary[0]
    expect(sum.cash).toBe(37.2)
    expect(sum.total).toBe(37.2)
  })

  it('reports a POS row in its session\'s currency (B-3: the row has none of its own)', async () => {
    const s = await seed()
    const session = await createTestPOSSession(s.orgId, s.wh._id as Types.ObjectId, s.user._id as Types.ObjectId, { currency: 'BGN' })
    await createTestPOSTransaction(s.orgId, session._id as Types.ObjectId, s.user._id as Types.ObjectId, {
      status: 'completed', total: 20, createdAt: at('2026-05-10T10:00:00'),
      payments: [{ method: 'cash', amount: 20 }],
    })
    const res = await runMigrated(String(s.orgId), { period: DAY })
    expect(res.rows[0].currency).toBe('BGN')
    expect(res.meta!.summary.map(x => x.currency)).toEqual(['BGN'])
  })

  it('honours the source filter', async () => {
    const s = await withPos()
    await createTestPOSTransaction(s.orgId, s.session._id as Types.ObjectId, s.user._id as Types.ObjectId, {
      status: 'completed', total: 50, createdAt: at('2026-05-10T10:00:00'),
      payments: [{ method: 'cash', amount: 50 }], transactionNumber: 'TXN-1',
    })
    await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
      issueDate: at('2026-05-10'), type: 'cash_sale', direction: 'outgoing', status: 'paid',
      total: 10, amountPaid: 10, invoiceNumber: 'CS-1',
    })

    expect((await runMigrated(String(s.orgId), { period: DAY, source: 'pos' })).rows.map(r => r.number)).toEqual(['TXN-1'])
    expect((await runMigrated(String(s.orgId), { period: DAY, source: 'documents' })).rows.map(r => r.number)).toEqual(['CS-1'])
    expect((await runMigrated(String(s.orgId), { period: DAY, source: 'all' })).rows).toHaveLength(2)
  })

  it('drills a cash sale into its own page, an invoice into the invoice form (FR-21.3)', async () => {
    const s = await seed()
    await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
      issueDate: at('2026-05-10'), type: 'cash_sale', direction: 'outgoing', status: 'paid',
      total: 10, amountPaid: 10, invoiceNumber: 'CS-7',
    })
    await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
      issueDate: at('2026-05-10'), type: 'invoice', direction: 'outgoing', status: 'paid',
      total: 10, amountPaid: 10, paymentMethod: 'cash', invoiceNumber: 'INV-7',
    })
    await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
      issueDate: at('2026-05-10'), type: 'cash_storno', direction: 'outgoing', status: 'paid',
      total: 4, amountPaid: 4, invoiceNumber: 'CS-8',
    })
    const res = await runMigrated(String(s.orgId), { period: DAY })
    const href = (n: string) => entry().drilldown!(res.rows.find(r => r.number === n)!)
    expect(href('CS-7')).toMatch(/^\/invoicing\/cash-sales\/[0-9a-f]{24}\/edit$/)
    expect(href('INV-7')).toMatch(/^\/invoicing\/invoices\/[0-9a-f]{24}\/edit$/)
    // A storno reads as a storno on the journal's page; the cash-sale form would show a sale.
    expect(href('CS-8')).toMatch(/^\/invoicing\/cash-sales\/[0-9a-f]{24}\/view$/)
  })

  it('a till sale reads paid, as every cash-register document does — not the POS row\'s completed', async () => {
    const s = await withPos()
    await createTestPOSTransaction(s.orgId, s.session._id as Types.ObjectId, s.user._id as Types.ObjectId, {
      status: 'completed', total: 42, createdAt: at('2026-05-10T14:32:05'),
      payments: [{ method: 'cash', amount: 42 }], transactionNumber: 'TXN-PAID',
    })
    const res = await runMigrated(String(s.orgId), { period: DAY })
    const row = res.rows.find(r => r.number === 'TXN-PAID')!
    expect(row.rowType).toBe('pos')
    expect(row.status).toBe('paid')
    expect(res.columns.find(c => c.key === 'status')!.type).toBe('status')
  })
})

describe('sales-history — summary', () => {
  it('reconciles: cash + card + other equals the value column', async () => {
    const s = await seed()
    await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
      issueDate: at('2026-05-10'), type: 'invoice', direction: 'outgoing', status: 'paid',
      total: 100, amountPaid: 100, invoiceNumber: 'SPLIT',
      // `payments[].date` is required by the Invoice schema.
      payments: [{ method: 'cash', amount: 40, date: at('2026-05-10') }, { method: 'card', amount: 60, date: at('2026-05-10') }],
    })
    const res = await run(String(s.orgId), { period: DAY })
    const sum = res.meta!.summary[0]
    expect(sum.cash).toBe(40)
    expect(sum.card).toBe(60)
    expect(sum.cash + sum.card + sum.other).toBeCloseTo(sum.total, 2)
    expect(sum.total).toBeCloseTo(res.rows.reduce((a, r) => a + r.total, 0), 2)
    // Split tender renders as one row with a joined label.
    expect(res.rows[0].paymentLabel).toBe('cash + card')
  })

  it('reports zero lines for cash and card so an unchecked bucket is visible', async () => {
    const s = await seed()
    await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
      issueDate: at('2026-05-10'), type: 'cash_sale', direction: 'outgoing', status: 'paid',
      total: 10, amountPaid: 10,
    })
    const sum = (await run(String(s.orgId), { period: DAY })).meta!.summary[0]
    expect(sum.card).toBe(0)
    expect(sum.cash).toBe(10)
  })

  it('sections mixed currencies instead of summing them', async () => {
    const s = await seed()
    await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
      issueDate: at('2026-05-10'), type: 'cash_sale', direction: 'outgoing', status: 'paid',
      total: 10, amountPaid: 10, currency: 'EUR',
    })
    await createTestInvoice(s.orgId, s.customer._id as Types.ObjectId, {
      issueDate: at('2026-05-10'), type: 'cash_sale', direction: 'outgoing', status: 'paid',
      total: 20, amountPaid: 20, currency: 'BGN',
    })
    const res = await run(String(s.orgId), { period: DAY })
    expect(res.meta!.mixedCurrency).toBe(true)
    expect(res.meta!.summary).toHaveLength(2)
    // No cross-currency grand total.
    expect(res.totals).toBeUndefined()
  })

  it('is org-scoped', async () => {
    const s = await seed()
    const other = await seed()
    await createTestInvoice(other.orgId, other.customer._id as Types.ObjectId, {
      issueDate: at('2026-05-10'), type: 'cash_sale', direction: 'outgoing', status: 'paid',
      total: 999, amountPaid: 999,
    })
    expect((await run(String(s.orgId), { period: DAY })).rows).toHaveLength(0)
  })

  it('rejects an unknown payment method', () => {
    let err: any
    try { validateParams(entry(), { paymentMethods: ['bitcoin'] }) } catch (e) { err = e }
    expect(err?.message).toMatch(/invalid value/)
  })
})
