import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestContact,
  createTestProduct,
  createTestInvoice,
} from '../helpers/factories'
import { aggregateCashSales } from 'invoicing-api/src/controllers/invoice-export.controller'
import { generateCashAggXLSX, sectionTotals } from 'reporting/excel/cash-agg.excel'
import { buildCashAggHtml } from 'reporting/pdf/cash-agg.pdf'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

// FR-03 (#10): the aggregated cash-register export — one row per product, VAT reconciles
// with the per-document figures to the cent.
describe('Aggregated cash-register export (FR-03)', () => {
  function line(productId: any, description: string, quantity: number, unitPrice: number, taxRate = 20) {
    const net = quantity * unitPrice
    const taxAmount = +(net * taxRate / 100).toFixed(2)
    return {
      productId, description, quantity, unit: 'pcs', unitPrice,
      discount: 0, taxRate, taxAmount, lineTotal: +(net + taxAmount).toFixed(2),
    }
  }

  it('groups by product across documents, resolves SKU, and reconciles the sums', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const bolt = await createTestProduct(org._id, { name: 'Болт М8х25 ZN', sku: 'BOLT-M8X25' })
    const nut = await createTestProduct(org._id, { name: 'Гайка М8 ZN', sku: 'NUT-M8' })

    // Two cash sales selling the same bolt at different prices + one nut line +
    // one productId-less legacy line.
    await createTestInvoice(org._id, contact._id, {
      type: 'cash_sale', direction: 'outgoing', status: 'paid', invoiceNumber: 'CS-AGG-1', currency: 'BGN',
      lines: [line(bolt._id, 'Болт М8х25 ZN', 10, 0.10), line(nut._id, 'Гайка М8 ZN', 4, 0.05)],
    })
    await createTestInvoice(org._id, contact._id, {
      type: 'cash_sale', direction: 'outgoing', status: 'paid', invoiceNumber: 'CS-AGG-2', currency: 'BGN',
      lines: [line(bolt._id, 'Болт М8х25 ZN', 5, 0.12), line(undefined, 'Стара услуга', 1, 3)],
    })
    // A draft-status doc excluded by the filter must not contribute.
    await createTestInvoice(org._id, contact._id, {
      type: 'cash_sale', direction: 'outgoing', status: 'draft', invoiceNumber: 'CS-AGG-3', currency: 'BGN',
      lines: [line(bolt._id, 'Болт М8х25 ZN', 100, 0.10)],
    })

    const { sections, docCount } = await aggregateCashSales({
      orgId: org._id, type: 'cash_sale', status: { $in: ['paid', 'completed'] },
    })
    expect(docCount).toBe(2)
    expect(sections).toHaveLength(1)
    expect(sections[0].currency).toBe('BGN')

    const rows = sections[0].rows
    expect(rows).toHaveLength(3) // bolt, nut, legacy text line

    const boltRow = rows.find(r => r.sku === 'BOLT-M8X25')!
    expect(boltRow.productName).toBe('Болт М8х25 ZN')
    expect(boltRow.totalQuantity).toBe(15)          // 10 + 5
    expect(boltRow.netTotal).toBe(1.6)              // 1.00 + 0.60
    expect(boltRow.taxTotal).toBe(0.32)             // 0.20 + 0.12
    expect(boltRow.grossTotal).toBe(1.92)
    expect(boltRow.avgUnitPrice).toBe(0.11)         // 1.60 / 15 → weighted

    const legacy = rows.find(r => r.productName === 'Стара услуга')!
    expect(legacy.sku).toBe('')
    expect(legacy.grossTotal).toBe(3.6)

    // Section totals equal the sum of the two documents' totals to the cent.
    const totals = sectionTotals(rows)
    expect(totals.grossTotal).toBe(1.92 + 0.24 + 3.6)
    expect(totals.netTotal + totals.taxTotal).toBeCloseTo(totals.grossTotal, 2)
  })

  it('splits mixed currencies into separate sections instead of summing them', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const p = await createTestProduct(org._id, { sku: `AGG-${Date.now()}` })

    await createTestInvoice(org._id, contact._id, {
      type: 'cash_sale', status: 'paid', invoiceNumber: 'CS-BGN', currency: 'BGN',
      lines: [line(p._id, 'X', 1, 10)],
    })
    await createTestInvoice(org._id, contact._id, {
      type: 'cash_sale', status: 'paid', invoiceNumber: 'CS-EUR', currency: 'EUR',
      lines: [line(p._id, 'X', 2, 10)],
    })

    const { sections } = await aggregateCashSales({ orgId: org._id, type: 'cash_sale' })
    expect(sections.map(s => s.currency).sort()).toEqual(['BGN', 'EUR'])
    expect(sections.find(s => s.currency === 'BGN')!.rows[0].totalQuantity).toBe(1)
    expect(sections.find(s => s.currency === 'EUR')!.rows[0].totalQuantity).toBe(2)
  })

  it('generators produce output (xlsx buffer, html with names + totals) incl. empty state', async () => {
    const sections = [{
      currency: 'BGN',
      rows: [{
        productName: 'Болт М8х25 ZN', sku: 'BOLT-M8X25', unit: 'pcs',
        totalQuantity: 15, avgUnitPrice: 0.11, netTotal: 1.6, taxTotal: 0.32, grossTotal: 1.92,
      }],
    }]
    const buffer = await generateCashAggXLSX({ title: 'Cash Sales — by product', sections, locale: 'bg' })
    expect(buffer.length).toBeGreaterThan(1000)

    const { html } = buildCashAggHtml({
      title: 'Касови продажби — по продукт', sections, locale: 'bg', orgName: 'РЕГАЛ',
      period: { from: '2026-08-01', to: '2026-08-21' },
    })
    expect(html).toContain('Болт М8х25 ZN')
    expect(html).toContain('BOLT-M8X25')
    expect(html).toContain('1,92') // bg money format
    expect(html).toContain('РЕГАЛ')

    const empty = buildCashAggHtml({ title: 'x', sections: [], locale: 'en', orgName: 'Org' })
    expect(empty.html).toContain('(no lines)')

    // Column subset respected.
    const { html: narrow } = buildCashAggHtml({
      title: 'x', sections, locale: 'en', orgName: 'Org', columns: ['productName', 'grossTotal'],
    })
    expect(narrow).toContain('Болт М8х25 ZN')
    expect(narrow).not.toContain('BOLT-M8X25')
  })
})
