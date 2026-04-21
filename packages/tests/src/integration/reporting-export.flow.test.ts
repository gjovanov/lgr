import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestInvoice, createTestUser } from '../helpers/factories'
import { generateInvoicingListXLSX } from 'reporting/excel/invoicing-list.excel'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

/**
 * Phase 6 — Reporting → Export endpoint covers three kinds:
 *   outgoing:      invoice + credit_note + debit_note (direction=outgoing)
 *   incoming:      bills (type=invoice, direction=incoming)
 *   cash_register: cash_sale
 * The generator is the same; the controller just picks different filters.
 * Empty result sets produce a header-only workbook (200), not 404.
 */
describe('Reporting export — kind-specific filters', () => {
  it('generator emits a non-empty workbook for each kind', async () => {
    const rows = [
      { invoiceNumber: 'INV-2026-00001', type: 'invoice', direction: 'outgoing', status: 'sent', issueDate: new Date(), dueDate: new Date(), contactName: 'A', currency: 'EUR', subtotal: 100, taxTotal: 20, total: 120, amountPaid: 0, amountDue: 120, paymentsByMethod: {}, lines: [] },
      { invoiceNumber: 'CRN-2026-00001', type: 'credit_note', direction: 'outgoing', status: 'sent', issueDate: new Date(), dueDate: new Date(), contactName: 'A', currency: 'EUR', subtotal: -20, taxTotal: -4, total: -24, amountPaid: 0, amountDue: 0, paymentsByMethod: {}, lines: [] },
    ]
    const buf = await generateInvoicingListXLSX({ title: 'Outgoing Documents', mode: 'compact', rows })
    expect(buf.length).toBeGreaterThan(1000)
  })

  it('empty-result workbook is still non-empty (header row + totals row — never 404)', async () => {
    const buf = await generateInvoicingListXLSX({ title: 'Outgoing Documents', mode: 'compact', rows: [] })
    // XLSX is a ZIP — minimum valid file is still several hundred bytes with headers.
    expect(buf.length).toBeGreaterThan(100)
    // PK magic bytes
    expect(buf[0]).toBe(0x50)
    expect(buf[1]).toBe(0x4b)
  })
})

/**
 * Controller path: directly exercise buildFilter equivalent via Invoice.find()
 * to mirror the kind dispatch. Confirms the filter shape matches each kind.
 */
describe('Reporting export — filter dispatch (positive)', () => {
  it('outgoing kind selects invoice + credit_note + debit_note where direction=outgoing', async () => {
    const { Invoice } = await import('db/models')
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const common = { orgId: org._id, contactId: contact._id, createdBy: user._id, issueDate: new Date('2026-04-10'), dueDate: new Date('2026-04-20'), currency: 'EUR', exchangeRate: 1, lines: [], subtotal: 100, taxTotal: 0, total: 100, totalBase: 100, amountPaid: 0, amountDue: 100, billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' }, status: 'sent' }
    await Invoice.create({ ...common, invoiceNumber: 'INV-2026-00001', type: 'invoice',     direction: 'outgoing' } as any)
    await Invoice.create({ ...common, invoiceNumber: 'CRN-2026-00001', type: 'credit_note', direction: 'outgoing' } as any)
    await Invoice.create({ ...common, invoiceNumber: 'DBN-2026-00001', type: 'debit_note',  direction: 'outgoing' } as any)
    await Invoice.create({ ...common, invoiceNumber: 'BILL-2026-00001', type: 'invoice',    direction: 'incoming' } as any)
    await Invoice.create({ ...common, invoiceNumber: 'CS-2026-00001',   type: 'cash_sale',  direction: 'outgoing' } as any)

    const docs = await Invoice.find({ orgId: org._id, type: { $in: ['invoice', 'credit_note', 'debit_note'] }, direction: 'outgoing' }).lean()
    expect(docs.map(d => d.invoiceNumber).sort()).toEqual(['CRN-2026-00001', 'DBN-2026-00001', 'INV-2026-00001'])
  })

  it('incoming kind selects bills only (type=invoice, direction=incoming)', async () => {
    const { Invoice } = await import('db/models')
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const common = { orgId: org._id, contactId: contact._id, createdBy: user._id, issueDate: new Date('2026-04-10'), dueDate: new Date('2026-04-20'), currency: 'EUR', exchangeRate: 1, lines: [], subtotal: 100, taxTotal: 0, total: 100, totalBase: 100, amountPaid: 0, amountDue: 100, billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' }, status: 'received' }
    await Invoice.create({ ...common, invoiceNumber: 'BILL-2026-00001', type: 'invoice', direction: 'incoming' } as any)
    await Invoice.create({ ...common, invoiceNumber: 'BILL-2026-00002', type: 'invoice', direction: 'incoming' } as any)
    await Invoice.create({ ...common, invoiceNumber: 'INV-2026-00001',  type: 'invoice', direction: 'outgoing', status: 'sent' } as any)

    const docs = await Invoice.find({ orgId: org._id, type: 'invoice', direction: 'incoming' }).lean()
    expect(docs).toHaveLength(2)
    expect(docs.every(d => d.invoiceNumber.startsWith('BILL-'))).toBe(true)
  })

  it('cash_register kind selects only cash_sale docs', async () => {
    const { Invoice } = await import('db/models')
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const common = { orgId: org._id, contactId: contact._id, createdBy: user._id, issueDate: new Date('2026-04-10'), dueDate: new Date('2026-04-20'), currency: 'EUR', exchangeRate: 1, lines: [], subtotal: 100, taxTotal: 0, total: 100, totalBase: 100, amountPaid: 0, amountDue: 0, billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' }, status: 'paid' }
    await Invoice.create({ ...common, invoiceNumber: 'CS-2026-00001', type: 'cash_sale', direction: 'outgoing' } as any)
    await Invoice.create({ ...common, invoiceNumber: 'CS-2026-00002', type: 'cash_sale', direction: 'outgoing' } as any)
    await Invoice.create({ ...common, invoiceNumber: 'INV-2026-00001', type: 'invoice', direction: 'outgoing', status: 'sent', amountDue: 100 } as any)

    const docs = await Invoice.find({ orgId: org._id, type: 'cash_sale' }).lean()
    expect(docs).toHaveLength(2)
  })

  it('date range narrows results (positive)', async () => {
    const { Invoice } = await import('db/models')
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const mkInv = (num: string, iso: string) => Invoice.create({
      orgId: org._id, invoiceNumber: num, type: 'invoice', direction: 'outgoing', status: 'sent',
      contactId: contact._id, issueDate: new Date(iso), dueDate: new Date(iso),
      currency: 'EUR', exchangeRate: 1, lines: [],
      subtotal: 100, taxTotal: 0, total: 100, totalBase: 100, amountPaid: 0, amountDue: 100,
      billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
      createdBy: user._id,
    } as any)

    await mkInv('INV-2026-00001', '2026-01-15')
    await mkInv('INV-2026-00002', '2026-02-10')
    await mkInv('INV-2026-00003', '2026-03-05')

    const docs = await Invoice.find({
      orgId: org._id,
      type: { $in: ['invoice', 'credit_note', 'debit_note'] },
      direction: 'outgoing',
      issueDate: { $gte: new Date('2026-02-01'), $lte: new Date('2026-02-28') },
    }).lean()
    expect(docs).toHaveLength(1)
    expect(docs[0].invoiceNumber).toBe('INV-2026-00002')
  })
})

describe('Reporting export — negative scenarios', () => {
  it('empty date range returns zero docs → empty workbook rows, still a valid xlsx', async () => {
    const { Invoice } = await import('db/models')
    const org = await createTestOrg()
    const docs = await Invoice.find({ orgId: org._id, type: { $in: ['invoice', 'credit_note', 'debit_note'] }, direction: 'outgoing' }).lean()
    expect(docs).toHaveLength(0)
    const buf = await generateInvoicingListXLSX({ title: 'Outgoing Documents', mode: 'compact', rows: [] })
    expect(buf[0]).toBe(0x50) // still a valid PK/ZIP workbook
    expect(buf[1]).toBe(0x4b)
  })

  it('cross-org filter isolation — org B sees none of org A docs', async () => {
    const { Invoice } = await import('db/models')
    const orgA = await createTestOrg({ slug: 'rep-exp-a' })
    const orgB = await createTestOrg({ slug: 'rep-exp-b' })
    const user = await createTestUser(orgA._id)
    const contact = await createTestContact(orgA._id)
    await Invoice.create({ orgId: orgA._id, invoiceNumber: 'INV-2026-00001', type: 'invoice', direction: 'outgoing', status: 'sent', contactId: contact._id, issueDate: new Date(), dueDate: new Date(), currency: 'EUR', exchangeRate: 1, lines: [], subtotal: 100, taxTotal: 0, total: 100, totalBase: 100, amountPaid: 0, amountDue: 100, billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' }, createdBy: user._id } as any)

    const docsB = await Invoice.find({ orgId: orgB._id, type: { $in: ['invoice', 'credit_note', 'debit_note'] }, direction: 'outgoing' }).lean()
    expect(docsB).toHaveLength(0)
  })
})
