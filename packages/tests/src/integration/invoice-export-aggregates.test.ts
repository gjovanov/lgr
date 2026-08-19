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

  it('computeAggregates: sums each money column, not just the document total', () => {
    const rows = [
      { ...row('INV-1', 120, { cash: 120 }), subtotal: 100, taxTotal: 20, amountPaid: 120, amountDue: 0 },
      { ...row('INV-2', 60, {}), subtotal: 50, taxTotal: 10, amountPaid: 0, amountDue: 60 },
    ]
    const agg = computeAggregates(rows)
    expect(agg.columns.subtotal).toBe(150)
    expect(agg.columns.taxTotal).toBe(30)
    expect(agg.columns.total).toBe(180)
    expect(agg.columns.amountPaid).toBe(120)
    expect(agg.columns.amountDue).toBe(60)
  })

  it('XLSX compact: the closing row carries a sum under every money column', async () => {
    const rows = [
      { ...row('INV-A', 120, { cash: 120 }), subtotal: 100, taxTotal: 20, amountPaid: 120, amountDue: 0 },
      { ...row('INV-B', 60, {}), subtotal: 50, taxTotal: 10, amountPaid: 0, amountDue: 60 },
    ]
    const columns = ['number', 'issueDate', 'contactName', 'subtotal', 'taxTotal', 'total', 'amountPaid', 'amountDue']
    const buf = await generateInvoicingListXLSX({ title: 'Invoices', mode: 'compact', rows, columns })
    const { default: ExcelJS } = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as any)
    const sheet = wb.worksheets[0]

    const header = (sheet.getRow(1).values as any[]).slice(1).map(v => String(v ?? ''))
    expect(header).toContain('Subtotal')
    expect(header).toContain('Tax')
    expect(header).toContain('Total')

    let grand: any[] | undefined
    sheet.eachRow((r) => {
      const values = (r.values as any[]).slice(1)
      if (values.some(v => String(v ?? '') === 'Total:')) grand = values
    })
    expect(grand).toBeDefined()
    // Each sum sits under its own column, so the row reads across like the source table.
    expect(grand![columns.indexOf('subtotal')]).toBe(150)
    expect(grand![columns.indexOf('taxTotal')]).toBe(30)
    expect(grand![columns.indexOf('total')]).toBe(180)
    expect(grand![columns.indexOf('amountPaid')]).toBe(120)
    expect(grand![columns.indexOf('amountDue')]).toBe(60)
    // The label goes in the first non-money column, never under an amount header.
    expect(grand![0]).toBe('Total:')
  })

  it('PDF compact: the table closes with a per-column totals row', async () => {
    const { buildListHtml } = await import('reporting/pdf/invoicing-list.pdf')
    const rows = [
      { ...row('INV-A', 120, { cash: 120 }), subtotal: 100, taxTotal: 20 },
      { ...row('INV-B', 60, {}), subtotal: 50, taxTotal: 10 },
    ]
    const { html } = buildListHtml({
      title: 'Invoices', orgName: 'Test Org', mode: 'compact', rows,
      columns: ['number', 'contactName', 'subtotal', 'taxTotal', 'total'],
    })
    const grand = html.slice(html.indexOf('grand-row'), html.indexOf('</tr>', html.indexOf('grand-row')))
    expect(grand).toContain('Total:')
    expect(grand).toContain('150.00')
    expect(grand).toContain('30.00')
    expect(grand).toContain('180.00')
    // The row closes the table itself, so the block underneath must not repeat the grand total.
    expect(html.split('Total:').length - 1).toBe(1)
  })

  it('PDF: a bordered summary box states subtotal / tax / total, as on the invoice form', async () => {
    const { buildListHtml } = await import('reporting/pdf/invoicing-list.pdf')
    const rows = [
      { ...row('INV-A', 120, { cash: 120 }), subtotal: 100, taxTotal: 20 },
      { ...row('INV-B', 60, {}), subtotal: 50, taxTotal: 10 },
    ]
    for (const mode of ['compact', 'detailed'] as const) {
      const { html } = buildListHtml({ title: 'Invoices', orgName: 'Test Org', mode, rows })
      const box = html.slice(html.indexOf('totals-box'), html.indexOf('</table>', html.indexOf('totals-box')))
      expect(box).toContain('Subtotal')
      expect(box).toContain('150.00 EUR')
      expect(box).toContain('Tax Total')
      expect(box).toContain('30.00 EUR')
      expect(box).toContain('<tr class="grand"><td class="tk">Total</td>')
      expect(box).toContain('180.00 EUR')
    }
  })

  it('PDF: the box splits by payment method, in order, above the overall total', async () => {
    const { buildListHtml } = await import('reporting/pdf/invoicing-list.pdf')
    const rows = [
      { ...row('INV-A', 120, { cash: 120 }), subtotal: 100, taxTotal: 20 },
      { ...row('INV-B', 60, { card: 60 }), subtotal: 50, taxTotal: 10 },
      { ...row('INV-C', 240, { bank_transfer: 200, check: 40 }), subtotal: 200, taxTotal: 40 },
    ]
    const { html } = buildListHtml({ title: 'Invoices', orgName: 'Test Org', mode: 'compact', rows })
    const box = html.slice(html.indexOf('totals-box'), html.indexOf('</table>', html.indexOf('totals-box')))

    const labels = ['Cash', 'Card', 'Bank']
    const positions = labels.map(l => box.indexOf(`>${l}<`))
    expect(positions.every(p => p > -1)).toBe(true)
    // Stated in the report's own order, and all of them before the closing total.
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(Math.max(...positions)).toBeLessThan(box.indexOf('class="grand"'))
    expect(box).toContain('120.00 EUR')
    expect(box).toContain('60.00 EUR')
    expect(box).toContain('200.00 EUR')
    // A method outside the reported three is listed only because it was actually used.
    expect(box).toContain('Check')
    expect(box).toContain('40.00 EUR')
  })

  it('PDF: the reported methods print even when nothing was settled that way', async () => {
    const { buildListHtml } = await import('reporting/pdf/invoicing-list.pdf')
    const rows = [{ ...row('INV-A', 120, { cash: 120 }), subtotal: 100, taxTotal: 20 }]
    const { html } = buildListHtml({ title: 'Invoices', orgName: 'Test Org', mode: 'compact', rows })
    const box = html.slice(html.indexOf('totals-box'), html.indexOf('</table>', html.indexOf('totals-box')))
    // A zero is itself the answer to "how much came in by card?".
    expect(box).toContain('>Card<')
    expect(box).toContain('>Bank<')
    expect(box).toContain('0.00 EUR')
    // Unused methods beyond those three stay out of the box.
    expect(box).not.toContain('Check')
  })

  it('PDF: the report prints the letterhead logo above the title', async () => {
    const { buildListHtml } = await import('reporting/pdf/invoicing-list.pdf')
    const rows = [{ ...row('INV-A', 120, { cash: 120 }), subtotal: 100, taxTotal: 20 }]
    const bundled = buildListHtml({ title: 'Invoices', orgName: 'Test Org', mode: 'compact', rows })
    expect(bundled.html).toContain('<div class="logo-bar"><img class="org-logo" src="data:image/png;base64,')
    expect(bundled.html.indexOf('logo-bar')).toBeLessThan(bundled.html.indexOf('doc-title'))

    const own = buildListHtml({
      title: 'Invoices', orgName: 'Test Org', mode: 'compact', rows,
      logo: 'https://cdn.example.com/acme.png',
    })
    expect(own.html).toContain('<img class="org-logo" src="https://cdn.example.com/acme.png"')
  })

  it('PDF: mixed currencies print the warning instead of a summary box', async () => {
    const { buildListHtml } = await import('reporting/pdf/invoicing-list.pdf')
    const rows = [
      { ...row('INV-A', 120, { cash: 120 }, 'EUR'), subtotal: 100, taxTotal: 20 },
      { ...row('INV-B', 60, {}, 'BGN'), subtotal: 50, taxTotal: 10 },
    ]
    const { html } = buildListHtml({ title: 'Invoices', orgName: 'Test Org', mode: 'compact', rows })
    expect(html).not.toContain('totals-box')
    expect(html).toContain('mixed-note')
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
