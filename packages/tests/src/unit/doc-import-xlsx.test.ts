import { describe, it, expect } from 'bun:test'
import ExcelJS from 'exceljs'
import {
  parseSalesAnalysis,
  parseStoreOperations,
  parseSpreadsheet,
  XlsxParseError,
} from 'services/biz/doc-import/xlsx'

/** Build a salesAnalysis-shaped workbook: 8 title rows, headers on row 9, then items. */
async function salesAnalysisBook(
  items: Array<[string, number, number]>,
  total?: [number, number],
  headerCell = 'Артикул',
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  ws.getRow(1).getCell(1).value = 'АРТИКУЛИ'
  ws.getRow(2).getCell(1).value = 'Валута: Евро'
  ws.getRow(5).getCell(1).value = 'Фирма: РЕГАЛ ООД'
  ws.getRow(9).getCell(1).value = headerCell
  ws.getRow(9).getCell(2).value = 'Количество'
  ws.getRow(9).getCell(3).value = 'Стойност'
  let r = 10
  for (const [name, qty, value] of items) {
    ws.getRow(r).getCell(1).value = name
    ws.getRow(r).getCell(2).value = qty
    ws.getRow(r).getCell(3).value = value
    r++
  }
  ws.getRow(r).getCell(1).value = 'СТОКИ' // a group sub-total row that must be skipped
  ws.getRow(r).getCell(2).value = 999
  ws.getRow(r).getCell(3).value = 999
  r++
  const [tq, tv] = total ?? [
    items.reduce((s, i) => s + i[1], 0),
    items.reduce((s, i) => s + i[2], 0),
  ]
  ws.getRow(r).getCell(1).value = 'Общо'
  ws.getRow(r).getCell(2).value = tq
  ws.getRow(r).getCell(3).value = tv
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** Build a storeOperations-shaped workbook. */
async function storeOperationsBook(
  items: Array<[string, string, number, number, number]>,
  opts: { operation?: string; warehouse?: string; period?: string; total?: number } = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  ws.getRow(2).getCell(1).value = `Склад: ${opts.warehouse ?? 'ОБЕКТИ:СКЛАД - 1'}`
  ws.getRow(3).getCell(1).value = `Период: ${opts.period ?? '24.07.2026 - 24.07.2026'}`
  ws.getRow(4).getCell(1).value = `Операция: ${opts.operation ?? 'Доставки'}`
  ws.getRow(9).getCell(1).value = 'Име'
  ws.getRow(9).getCell(2).value = 'Мярка'
  ws.getRow(9).getCell(3).value = 'Количество'
  ws.getRow(9).getCell(4).value = 'Цена'
  ws.getRow(9).getCell(5).value = 'Стойност'
  let r = 10
  for (const [name, unit, qty, price, value] of items) {
    const row = ws.getRow(r)
    row.getCell(1).value = name
    row.getCell(2).value = unit
    row.getCell(3).value = qty
    row.getCell(4).value = price
    row.getCell(5).value = value
    r++
  }
  ws.getRow(r).getCell(1).value = 'Всичко'
  ws.getRow(r).getCell(3).value = opts.total ?? items.reduce((s, i) => s + i[2], 0)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

async function captureError(fn: () => Promise<unknown>): Promise<Error | null> {
  // try/catch rather than `.rejects` — that matcher deadlocks on Windows under Bun 1.3.12.
  try {
    await fn()
    return null
  } catch (e: any) {
    return e
  }
}

describe('salesAnalysis parser', () => {
  it('reads items, skips group rows, and reports the printed total', async () => {
    const buf = await salesAnalysisBook([['Гайка М8', 10, 4.5], ['Болт М6', 3, 1.5]])
    const res = await parseSalesAnalysis(buf)
    expect(res.rows).toHaveLength(2)
    expect(res.rows.map(r => r.name)).toEqual(['Гайка М8', 'Болт М6'])
    expect(res.totalValue).toBeCloseTo(6, 5)
    expect(res.totalQty).toBeCloseTo(13, 5)
  })

  it('aborts when the header row is not an АРТИКУЛИ export', async () => {
    const buf = await salesAnalysisBook([['X', 1, 1]], undefined, 'Име')
    const err = await captureError(() => parseSalesAnalysis(buf))
    expect(err).toBeInstanceOf(XlsxParseError)
    expect(err!.message).toContain('not a salesAnalysis export')
  })

  it('aborts when the item sum contradicts Общо (tree sub-groups double-counting)', async () => {
    const buf = await salesAnalysisBook([['Гайка М8', 10, 4.5]], [10, 9])
    const err = await captureError(() => parseSalesAnalysis(buf))
    expect(err).toBeInstanceOf(XlsxParseError)
    expect(err!.message).toContain('Cross-check failed')
  })
})

describe('storeOperations parser', () => {
  it('reads a Доставки export with its warehouse and period', async () => {
    const buf = await storeOperationsBook([['Гайка М8', 'БР', 100, 0.2, 20]])
    const res = await parseStoreOperations(buf)
    expect(res.operation).toBe('Доставки')
    expect(res.warehouse).toBe('ОБЕКТИ:СКЛАД - 1')
    expect(res.periodStart).toBe('2026-07-24')
    expect(res.rows[0]).toMatchObject({ name: 'Гайка М8', unit: 'БР', qty: 100, price: 0.2 })
  })

  it('refuses any operation other than Доставки', async () => {
    // The same filename carries a sales report when a different PlusMinus filter was used.
    const buf = await storeOperationsBook([['X', 'БР', 1, 1, 1]], { operation: 'Продажби' })
    const err = await captureError(() => parseStoreOperations(buf))
    expect(err).toBeInstanceOf(XlsxParseError)
    expect(err!.message).toContain('Продажби')
  })

  it('aborts when the item sum contradicts Всичко', async () => {
    const buf = await storeOperationsBook([['X', 'БР', 100, 1, 100]], { total: 90 })
    const err = await captureError(() => parseStoreOperations(buf))
    expect(err).toBeInstanceOf(XlsxParseError)
    expect(err!.message).toContain('Cross-check failed')
  })
})

describe('spreadsheet sniffing', () => {
  it('tells the two exports apart by their header row', async () => {
    const sales = await parseSpreadsheet(await salesAnalysisBook([['Гайка М8', 1, 1]]))
    expect(sales.kind).toBe('salesAnalysis')
    expect(sales.text).toContain('Артикул')

    const ops = await parseSpreadsheet(await storeOperationsBook([['Гайка М8', 'БР', 1, 1, 1]]))
    expect(ops.kind).toBe('storeOperations')
    expect(ops.text).toContain('Операция: Доставки')
  })

  it('rejects an unrelated workbook with a message naming both expected layouts', async () => {
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('Sheet1').getRow(9).getCell(1).value = 'Something else'
    const buf = Buffer.from(await wb.xlsx.writeBuffer())
    const err = await captureError(() => parseSpreadsheet(buf))
    expect(err).toBeInstanceOf(XlsxParseError)
    expect(err!.message).toContain('salesAnalysis')
    expect(err!.message).toContain('storeOperations')
  })
})
