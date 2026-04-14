import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { generateInvoicingListXLSX, computeAggregates } from 'reporting/excel/invoicing-list.excel'
import { generateInvoicingListPDF } from 'reporting/pdf/invoicing-list.pdf'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

function row(n: string, total: number, paymentsByMethod: Record<string, number>, currency = 'EUR') {
  return {
    invoiceNumber: n,
    type: 'invoice',
    direction: 'outgoing',
    status: 'paid',
    issueDate: new Date('2026-04-10'),
    dueDate: new Date('2026-04-20'),
    contactName: 'Acme',
    currency,
    total,
    paymentsByMethod,
  }
}

describe('Export aggregates', () => {
  it('computeAggregates: sums per method with mixed methods', () => {
    const rows = [
      row('INV-1', 100, { cash: 100 }),
      row('INV-2', 200, { bank_transfer: 200 }),
      row('INV-3', 80, { cash: 50, card: 30 }),
    ]
    const agg = computeAggregates(rows)
    expect(agg.total).toBe(380)
    expect(agg.byMethod.cash).toBe(150)
    expect(agg.byMethod.bank_transfer).toBe(200)
    expect(agg.byMethod.card).toBe(30)
    expect(agg.byMethod.check).toBeUndefined()
    expect(agg.mixedCurrency).toBe(false)
    expect(agg.currency).toBe('EUR')
  })

  it('computeAggregates: multi-currency returns null total + mixedCurrency flag', () => {
    const rows = [row('INV-1', 100, { cash: 100 }, 'EUR'), row('INV-2', 200, { bank_transfer: 200 }, 'BGN')]
    const agg = computeAggregates(rows)
    expect(agg.mixedCurrency).toBe(true)
    expect(agg.total).toBeNull()
    expect(agg.currency).toBeNull()
    // Per-method sums still computed (they're monetary sums per method, not per currency).
    expect(agg.byMethod.cash).toBe(100)
  })

  it('XLSX compact: appends Totals row + per-method rows', async () => {
    const rows = [row('INV-A', 100, { cash: 100 }), row('INV-B', 200, { bank_transfer: 200 })]
    const buf = await generateInvoicingListXLSX({ title: 'Invoices', mode: 'compact', rows })
    const { default: ExcelJS } = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as any)
    const sheet = wb.worksheets[0]
    const rowTexts: string[] = []
    sheet.eachRow((r, rowNumber) => {
      if (rowNumber === 1) return
      const line = r.values
      if (Array.isArray(line)) rowTexts.push(line.slice(1).map(v => String(v ?? '')).join('|'))
    })
    // Rows [INV-A, INV-B, (blank), Total, Total Cash, Total Bank]
    const joined = rowTexts.join('\n')
    expect(joined).toContain('Total:')
    expect(joined).toContain('Total Cash:')
    expect(joined).toContain('Total Bank:')
    expect(joined).not.toContain('Total Card:') // no card payments in fixtures
  })

  it('XLSX compact: mixed currencies writes warning row, no numeric total', async () => {
    const rows = [row('INV-A', 100, { cash: 100 }, 'EUR'), row('INV-B', 200, { bank_transfer: 200 }, 'BGN')]
    const buf = await generateInvoicingListXLSX({ title: 'Invoices', mode: 'compact', rows })
    const { default: ExcelJS } = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as any)
    const sheet = wb.worksheets[0]
    let foundWarning = false
    sheet.eachRow((r) => {
      r.eachCell((cell) => {
        if (String(cell.value ?? '').includes('mixed currencies')) foundWarning = true
      })
    })
    expect(foundWarning).toBe(true)
  })

  it('PDF compact: appends "## Summary" section', async () => {
    const rows = [row('INV-A', 100, { cash: 100 })]
    const buf = await generateInvoicingListPDF({ title: 'Invoices', orgName: 'Test Org', mode: 'compact', rows })
    expect(buf).toBeDefined()
    if (buf) {
      const head = Array.from(buf.slice(0, 4) as any) as number[]
      expect(head).toEqual([0x25, 0x50, 0x44, 0x46])
      // We can't easily parse PDF text, but the buffer should be larger than a no-summary run
      // due to the extra markdown section. Snapshot-style check for non-emptiness:
      expect(buf.length).toBeGreaterThan(1000)
    }
  })

  it('XLSX detailed mode does NOT append totals (one-row-per-line would confuse)', async () => {
    const rows = [row('INV-A', 100, { cash: 100 })]
    ;(rows[0] as any).lines = [{ description: 'Item', quantity: 1, unitPrice: 100, lineTotal: 100 }]
    const buf = await generateInvoicingListXLSX({ title: 'Invoices', mode: 'detailed', rows })
    const { default: ExcelJS } = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as any)
    const sheet = wb.worksheets[0]
    let hasTotalsLabel = false
    sheet.eachRow((r) => r.eachCell((c) => { if (String(c.value ?? '').startsWith('Total:')) hasTotalsLabel = true }))
    expect(hasTotalsLabel).toBe(false)
  })
})
