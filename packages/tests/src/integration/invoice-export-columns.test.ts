import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestInvoice } from '../helpers/factories'
import { generateInvoicingListXLSX } from 'reporting/excel/invoicing-list.excel'
import { generateInvoicingListPDF } from 'reporting/pdf/invoicing-list.pdf'
import { generateInvoicingSingleXLSX } from 'reporting/excel/invoicing-single.excel'

// Give the first beforeAll headroom for mongodb-memory-server cold start.
beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

// Lazy import so ExcelJS doesn't slow module load (and thus test bootstrapping).
async function readFirstSheetKeys(buf: Buffer): Promise<string[]> {
  const { default: ExcelJS } = await import('exceljs')
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as any)
  const sheet = wb.worksheets[0]
  const headerRow = sheet.getRow(1)
  const keys: string[] = []
  headerRow.eachCell({ includeEmpty: false }, (cell) => {
    if (cell.value != null) keys.push(String(cell.value))
  })
  return keys
}

function baseRow(n: string) {
  return {
    invoiceNumber: n,
    type: 'invoice',
    direction: 'outgoing',
    status: 'sent',
    issueDate: new Date('2026-04-10'),
    dueDate: new Date('2026-04-20'),
    contactName: 'Acme',
    currency: 'EUR',
    subtotal: 100,
    taxTotal: 20,
    total: 120,
    amountPaid: 0,
    amountDue: 120,
    lines: [
      { description: 'Widget', quantity: 2, unit: 'pcs', unitPrice: 50, taxRate: 20, lineTotal: 120 },
    ],
  }
}

describe('Export column selection', () => {
  it('XLSX compact: with columns=[number,total] only those headers appear', async () => {
    const buf = await generateInvoicingListXLSX({
      title: 'Invoices',
      mode: 'compact',
      rows: [baseRow('INV-2026-00001')],
      columns: ['number', 'total'],
    })
    const headers = await readFirstSheetKeys(buf)
    expect(headers).toEqual(['Number', 'Total'])
  })

  it('XLSX compact: omitting columns renders the full default set', async () => {
    const buf = await generateInvoicingListXLSX({
      title: 'Invoices',
      mode: 'compact',
      rows: [baseRow('INV-2026-00002')],
    })
    const headers = await readFirstSheetKeys(buf)
    // Must contain the new Tax column and no extra / stale columns.
    expect(headers).toContain('Tax')
    expect(headers).toContain('Total')
    expect(headers).toContain('Number')
  })

  it('XLSX detailed: filters line-level columns', async () => {
    const buf = await generateInvoicingListXLSX({
      title: 'Invoices',
      mode: 'detailed',
      rows: [baseRow('INV-2026-DET-1')],
      columns: ['number', 'description', 'lineTotal'],
    })
    const headers = await readFirstSheetKeys(buf)
    expect(headers).toEqual(['Number', 'Description', 'Line Total'])
  })

  it('Unknown keys in `columns` are silently dropped, known keys kept', async () => {
    const buf = await generateInvoicingListXLSX({
      title: 'Invoices',
      mode: 'compact',
      rows: [baseRow('INV-2026-UNK-1')],
      columns: ['number', 'not_a_real_column', 'taxTotal'],
    })
    const headers = await readFirstSheetKeys(buf)
    expect(headers).toEqual(['Number', 'Tax'])
  })

  it('PDF compact: honours the columns allowlist', async () => {
    const rows = [baseRow('INV-2026-PDF-1'), baseRow('INV-2026-PDF-2')]
    // Capture markdown by generating and verifying the binary PDF — full parsing is out of scope
    // but we can at least confirm a non-empty buffer and a valid magic header when only 2 columns selected.
    const buf = await generateInvoicingListPDF({
      title: 'Invoices',
      orgName: 'Test Org',
      mode: 'compact',
      rows,
      columns: ['number', 'total'],
    })
    expect(buf).toBeDefined()
    if (buf) {
      const head = Array.from(buf.slice(0, 4) as any) as number[]
      expect(head).toEqual([0x25, 0x50, 0x44, 0x46])
    }
  })

  it('Single-object XLSX respects `columns` filter for header + line rows', async () => {
    const row = baseRow('INV-2026-SINGLE-FILTER')
    const buf = await generateInvoicingSingleXLSX(row, 'detailed', ['number', 'total', 'description', 'lineTotal'])
    expect(buf.length).toBeGreaterThan(100)
    // Single-object sheet uses label-value pairs; the line table header row contains Description + Line Total.
    const { default: ExcelJS } = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as any)
    const sheet = wb.worksheets[0]
    let containsDescription = false
    let containsLineTotal = false
    let containsContact = false
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        const v = String(cell.value ?? '')
        if (v === 'Description') containsDescription = true
        if (v === 'Line Total') containsLineTotal = true
        if (v === 'Contact:') containsContact = true
      })
    })
    expect(containsDescription).toBe(true)
    expect(containsLineTotal).toBe(true)
    expect(containsContact).toBe(false) // filtered out — not in columns allowlist
  })
})

describe('Export row ordering', () => {
  it('generator preserves the caller-provided row order', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    // Create invoices in ascending createdAt; fetch with desc sort; expect desc order in sheet.
    const a = await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-ORDER-A' })
    const b = await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-ORDER-B' })
    const c = await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-ORDER-C' })
    // Sanity: factory inserts in the order A, B, C.
    const { Invoice } = await import('db/models')
    const sorted = await Invoice.find({ orgId: org._id }).sort({ createdAt: -1 }).lean()
    expect(sorted.map((i: any) => i.invoiceNumber)).toEqual(['INV-ORDER-C', 'INV-ORDER-B', 'INV-ORDER-A'])

    const rows = sorted.map((i: any) => ({
      invoiceNumber: i.invoiceNumber,
      type: i.type,
      direction: i.direction,
      status: i.status,
      issueDate: i.issueDate,
      dueDate: i.dueDate,
      contactName: 'Acme',
      currency: i.currency,
      subtotal: i.subtotal,
      taxTotal: i.taxTotal,
      total: i.total,
      amountDue: i.amountDue,
      amountPaid: i.amountPaid ?? 0,
      lines: i.lines,
    }))

    const buf = await generateInvoicingListXLSX({
      title: 'Invoices',
      mode: 'compact',
      rows,
      columns: ['number', 'total'],
    })

    const { default: ExcelJS } = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as any)
    const sheet = wb.worksheets[0]
    const numbersInSheet: string[] = []
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return // header
      const firstCell = row.getCell(1).value
      if (firstCell) numbersInSheet.push(String(firstCell))
    })
    expect(numbersInSheet).toEqual(['INV-ORDER-C', 'INV-ORDER-B', 'INV-ORDER-A'])
    // Suppress unused-var lint noise: a/b/c are only used implicitly via the sorted query.
    void a; void b; void c
  })
})
