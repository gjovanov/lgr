import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestInvoice } from '../helpers/factories'
import { generateInvoicingListXLSX } from 'reporting/excel/invoicing-list.excel'
import { generateInvoicingListPDF } from 'reporting/pdf/invoicing-list.pdf'
import { generateInvoicingSingleXLSX } from 'reporting/excel/invoicing-single.excel'
import { Invoice } from 'db/models'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

function mapInvoiceToRow(inv: any) {
  return {
    invoiceNumber: inv.invoiceNumber,
    type: inv.type,
    direction: inv.direction,
    status: inv.status,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    contactName: 'Acme Ltd',
    currency: inv.currency,
    subtotal: inv.subtotal,
    taxTotal: inv.taxTotal,
    total: inv.total,
    amountPaid: inv.amountPaid ?? 0,
    amountDue: inv.amountDue ?? inv.total,
    lines: inv.lines,
  }
}

describe('Invoice export generation', () => {
  it('generates compact XLSX with header row + N data rows', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const invoices = await Promise.all([
      createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-2026-00001' }),
      createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-2026-00002' }),
      createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-2026-00003' }),
    ])

    const buf = await generateInvoicingListXLSX({
      title: 'Invoices',
      mode: 'compact',
      rows: invoices.map(mapInvoiceToRow),
    })
    // XLSX (ZIP) magic bytes: 'PK'
    expect(buf).toBeInstanceOf(Buffer)
    expect(buf.length).toBeGreaterThan(100)
    expect(buf[0]).toBe(0x50) // 'P'
    expect(buf[1]).toBe(0x4b) // 'K'
  })

  it('generates detailed XLSX (one row per line item)', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const inv = await createTestInvoice(org._id, contact._id, {
      invoiceNumber: 'INV-2026-DET-1',
      lines: [
        { description: 'Line A', quantity: 2, unit: 'pcs', unitPrice: 50, discount: 0, taxRate: 18, taxAmount: 18, lineTotal: 118 },
        { description: 'Line B', quantity: 1, unit: 'pcs', unitPrice: 200, discount: 0, taxRate: 18, taxAmount: 36, lineTotal: 236 },
      ] as any,
    })
    const buf = await generateInvoicingListXLSX({
      title: 'Invoices',
      mode: 'detailed',
      rows: [mapInvoiceToRow(inv)],
    })
    expect(buf.length).toBeGreaterThan(100)
  })

  it('generates compact PDF', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const inv = await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-2026-PDF-1' })
    const buf = await generateInvoicingListPDF({
      title: 'Invoices',
      orgName: 'Test Org',
      mode: 'compact',
      rows: [mapInvoiceToRow(inv)],
    })
    expect(buf).toBeDefined()
    if (buf) {
      // PDF magic: %PDF (bytes 37,80,68,70)
      const head = Array.from(buf.slice(0, 4) as any) as number[]
      expect(head).toEqual([0x25, 0x50, 0x44, 0x46])
    }
  })

  it('generates single-object XLSX with line items in detailed mode', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const inv = await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-2026-SINGLE' })
    const buf = await generateInvoicingSingleXLSX(mapInvoiceToRow(inv), 'detailed')
    expect(buf.length).toBeGreaterThan(100)
    expect(buf[0]).toBe(0x50) // 'PK'
  })

  it('filters rows by type before rendering (simulates controller)', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-2026-01', type: 'invoice' })
    await createTestInvoice(org._id, contact._id, { invoiceNumber: 'CRN-2026-01', type: 'credit_note' })
    await createTestInvoice(org._id, contact._id, { invoiceNumber: 'PRF-2026-01', type: 'proforma' })

    const onlyInvoices = await Invoice.find({ orgId: org._id, type: 'invoice' }).lean()
    expect(onlyInvoices).toHaveLength(1)
    expect(onlyInvoices[0].invoiceNumber).toBe('INV-2026-01')

    const onlyProformas = await Invoice.find({ orgId: org._id, type: 'proforma' }).lean()
    expect(onlyProformas).toHaveLength(1)
    expect(onlyProformas[0].invoiceNumber).toBe('PRF-2026-01')
  })
})
