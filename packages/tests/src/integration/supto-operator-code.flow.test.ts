import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import type { Elysia } from 'elysia'
import ExcelJS from 'exceljs'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices } from '../helpers/till-world'
import { exportSummarizedSales, suptoPeriod } from 'services/biz/supto-export.service'
import { generateTable181 } from 'reporting/excel/supto.excel'

/**
 * #323 — SUPTO 18.1's „Код на оператор" was empty on every row (`supto.excel.ts`: both branches of
 * the ternary were ''). The till's rows now carry the operator: stored on the document, else named by
 * its УНП; a back-office cash sale names its author's code; an imported day names none.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = tillApp()
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  forgetDevices()
  await clearCollections()
}, 30_000)

const today = () => new Date().toISOString().slice(0, 10)

/** Column F („Operator Code") of 18.1, keyed by column B (the number). */
async function operatorColumn(buffer: Buffer): Promise<Record<string, string>> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as any)
  const out: Record<string, string> = {}
  wb.worksheets[0].eachRow((row, i) => {
    if (i === 1) return
    out[String(row.getCell(2).value)] = String(row.getCell(6).value ?? '')
  })
  return out
}

describe('SUPTO 18.1 — the operator code (#323)', () => {
  it('names the operator of a fiscal till sale, a text-receipt till sale and a back-office sale; not of an imported day', async () => {
    const w = await tillWorld(app)
    const fiscal = await w.sell(1)
    expect(fiscal.status).toBe(200)
    expect(fiscal.json.transaction.unpNumber).toMatch(/^ED123456-0001-\d{7}$/)
    const text = await w.sell(1, { nonFiscal: true })
    expect(text.status).toBe(200)
    // The clerk (operator 0002) has no session: a sessionless back-office cash sale.
    const backOffice = await w.backOfficeSale(1)
    expect(backOffice.status).toBe(200)
    const imported = await w.backOfficeSale(1, { reference: 'salesAnalysis:2026-10-26', skipStockMovement: true })
    expect(imported.status).toBe(200)

    const { transactions, cashSales } = await exportSummarizedSales({ orgId: w.orgId, ...suptoPeriod('2026-10-01', today()) })
    const byNumber = Object.fromEntries(transactions.map((t: any) => [t.transactionNumber, t.operatorCode]))
    expect(byNumber[fiscal.json.transaction.transactionNumber]).toBe('0001')
    expect(byNumber[text.json.transaction.transactionNumber]).toBe('0001') // no УНП: the stored code

    const column = await operatorColumn(await generateTable181(transactions, cashSales))
    expect(column[fiscal.json.transaction.transactionNumber]).toBe('0001')
    expect(column[text.json.transaction.transactionNumber]).toBe('0001')
    expect(column[backOffice.json.invoice.invoiceNumber]).toBe('0002')
    expect(column[imported.json.invoice.invoiceNumber]).toBe('')
  })

  it('the operator filter keeps that operator\'s rows, at the till and in the back office', async () => {
    const w = await tillWorld(app, { device: false })
    const till = await w.sell(1, { nonFiscal: true })
    const backOffice = await w.backOfficeSale(1)
    expect([till.status, backOffice.status]).toEqual([200, 200])

    const mine = await exportSummarizedSales({ orgId: w.orgId, ...suptoPeriod('2026-10-01', today()), operatorCode: '0001' })
    expect(mine.transactions.map((t: any) => t.transactionNumber)).toEqual([till.json.transaction.transactionNumber])
    expect(mine.cashSales).toHaveLength(0)

    const clerks = await exportSummarizedSales({ orgId: w.orgId, ...suptoPeriod('2026-10-01', today()), operatorCode: '0002' })
    expect(clerks.transactions).toHaveLength(0)
    expect(clerks.cashSales.map((d: any) => d.invoiceNumber)).toEqual([backOffice.json.invoice.invoiceNumber])
  })
})
