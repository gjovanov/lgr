import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestInvoice } from '../helpers/factories'
import { generateInvoicingListXLSX } from 'reporting/excel/invoicing-list.excel'
import { generateInvoicingListPDF } from 'reporting/pdf/invoicing-list.pdf'
import { generateInvoicingSingleXLSX } from 'reporting/excel/invoicing-single.excel'
import { buildInvoiceHtml, HEADER_NOTE_MAX } from 'reporting/pdf/invoice.pdf'
import { Invoice } from 'db/models'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

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

  it('generates detailed PDF with multiple invoices + line items', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const inv1 = await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-2026-PDF-MULTI-1' })
    const inv2 = await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-2026-PDF-MULTI-2' })
    const buf = await generateInvoicingListPDF({
      title: 'Invoices',
      orgName: 'Test Org',
      mode: 'detailed',
      rows: [mapInvoiceToRow(inv1), mapInvoiceToRow(inv2)],
    })
    expect(buf).toBeDefined()
    if (buf) {
      const head = Array.from(buf.slice(0, 4) as any) as number[]
      expect(head).toEqual([0x25, 0x50, 0x44, 0x46])
      expect(buf.length).toBeGreaterThan(500)
    }
  })

  it('PDF generator handles empty row list without throwing', async () => {
    const buf = await generateInvoicingListPDF({
      title: 'Invoices',
      orgName: 'Test Org',
      mode: 'compact',
      rows: [],
    })
    expect(buf).toBeDefined()
  })

  it('generates single-object XLSX with line items in detailed mode', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const inv = await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-2026-SINGLE' })
    const buf = await generateInvoicingSingleXLSX(mapInvoiceToRow(inv), 'detailed')
    expect(buf.length).toBeGreaterThan(100)
    expect(buf[0]).toBe(0x50) // 'PK'
  })

  it('single-object XLSX: the amounts are stated once, under the line table', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const inv = await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-2026-SINGLE2' })
    const buf = await generateInvoicingSingleXLSX(mapInvoiceToRow(inv), 'detailed', undefined, 'en')

    const { default: ExcelJS } = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as any)
    const sheet = wb.worksheets[0]

    // Column A carries the field labels; the totals belong to the block under the table, so
    // the field block must not repeat them (the sheet used to print "Total:" twice).
    const fieldLabels: string[] = []
    sheet.eachRow(row => {
      const v = row.getCell(1).value
      if (typeof v === 'string' && v.endsWith(':')) fieldLabels.push(v)
    })
    expect(fieldLabels).toContain('Number:')
    expect(fieldLabels).not.toContain('Total:')

    // Title centred over the sheet; the sheet's own gridlines stay on so the cells around the
    // document still read as a grid.
    expect(sheet.getCell('A1').alignment?.horizontal).toBe('center')
    expect(sheet.views?.[0]?.showGridLines).toBe(true)
    // Whole quantities carry the point-less format: `#,##0.###` would print "1." — and "1,"
    // wherever the comma is the decimal separator.
    const qty = (sheet.getRows(1, sheet.rowCount) ?? [])
      .map(r => r.getCell(3))
      .find(c => typeof c.value === 'number' && Number.isInteger(c.value))
    expect(qty?.numFmt).toBe('#,##0')
  })

  it('single-object XLSX: no notes block — the sheet is the document, not its commentary', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const inv = await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-2026-NONOTES' })
    const row = { ...mapInvoiceToRow(inv), notes: 'Словом : двадесет и едно евро' }
    const buf = await generateInvoicingSingleXLSX(row as any, 'detailed', undefined, 'en')

    const { default: ExcelJS } = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as any)
    let text = ''
    wb.worksheets[0].eachRow(r => { text += (r.values as any[]).slice(1).join('|') + '\n' })
    expect(text).not.toContain('Словом')
    expect(text).not.toContain('Notes')
  })

  it('printNote is stored on the document and reprints with it', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const inv = await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-2026-NOTE' })

    // What the export route does when the caller types a note into the print dialog.
    await Invoice.updateOne({ _id: inv._id, orgId: org._id }, { $set: { printNote: 'Доставка до обект №4' } })
    const reloaded = await Invoice.findById(inv._id).lean()
    expect((reloaded as any).printNote).toBe('Доставка до обект №4')

    // A later print that supplies no note falls back to the stored one.
    const html = buildInvoiceHtml(reloaded as any, { name: 'Test Org' } as any, {} as any, undefined, {
      locale: 'bg',
      headerNote: (reloaded as any).printNote,
    }).html
    expect(html).toContain('Доставка до обект №4')
  })

  it('printNote longer than the form will render is rejected by the model', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const inv = await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-2026-NOTE2' })
    const doc = await Invoice.findById(inv._id)
    ;(doc as any).printNote = 'x'.repeat(HEADER_NOTE_MAX + 1)
    let failed = false
    try { await doc!.save() } catch { failed = true }
    expect(failed).toBe(true)
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
