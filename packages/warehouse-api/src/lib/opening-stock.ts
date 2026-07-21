/**
 * Opening-stock import — set a warehouse's stock levels from a storeAvailability
 * export (Име / Количество / Доставна цена). Matches products by Cyrillic name/SKU
 * and SETS each level (delta via adjustStock), recording one adjustment movement.
 * Idempotent: re-running with the same file is a no-op (deltas become 0).
 */
import ExcelJS from 'exceljs'
import { buildSearchFilter } from 'services/biz/search.utils'
import { adjustStock } from 'services/biz/warehouse.service'
import { getNextNumber } from 'services/biz/sequence.service'
import { Product, StockLevel, StockMovement } from 'db/models'

const DATA_START = 6
const SKIP = new Set(['Всичко', 'ОБЩО:', 'Опаковка'])
const clean = (v: unknown) => String(v ?? '').trim()
const cellNum = (v: any): number => {
  if (v == null) return 0
  if (typeof v === 'object' && 'result' in v) return Number(v.result) || 0
  return Number(v) || 0
}

export interface OpeningRow { name: string; quantity: number; cost: number }

export async function parseOpeningStock(buf: Buffer): Promise<OpeningRow[]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as any)
  const sheet = wb.getWorksheet(1)!
  const rows: OpeningRow[] = []
  sheet.eachRow((row, rn) => {
    if (rn < DATA_START) return
    const name = clean(row.getCell(1).text)
    if (!name || SKIP.has(name)) return
    rows.push({ name, quantity: cellNum(row.getCell(3).value), cost: cellNum(row.getCell(4).value) })
  })
  return rows
}

async function matchProductId(orgId: string, name: string): Promise<string | null> {
  const f = buildSearchFilter(name, ['name', 'sku'], { lowered: { name: 'nameLower', sku: 'skuLower' } })
  const p: any = await Product.findOne({ orgId, isActive: true, ...f }).lean()
  return p ? String(p._id) : null
}

export interface OpeningResult {
  rows: number
  matched: number
  unmatched: number
  adjusted: number
  movementNumber?: string
  unmatchedSamples: string[]
}

export async function applyOpeningStock(
  orgId: string,
  warehouseId: string,
  rows: OpeningRow[],
  userId: string,
  onProgress: (i: number) => Promise<void>,
): Promise<OpeningResult> {
  let matched = 0, unmatched = 0, adjusted = 0
  const unmatchedSamples: string[] = []
  const movementLines: any[] = []

  for (let i = 0; i < rows.length; i++) {
    if (i % 50 === 0) await onProgress(i)
    const row = rows[i]
    const pid = await matchProductId(orgId, row.name)
    if (!pid) {
      unmatched++
      if (unmatchedSamples.length < 20) unmatchedSamples.push(row.name)
      continue
    }
    matched++
    const sl: any = await StockLevel.findOne({ orgId, productId: pid, warehouseId }).lean()
    const delta = row.quantity - (sl?.quantity ?? 0)
    if (delta !== 0) {
      await adjustStock(orgId, pid, warehouseId, delta, row.cost)
      adjusted++
      movementLines.push({ productId: pid, quantity: delta, unitCost: row.cost, totalCost: +(delta * row.cost).toFixed(2) })
    }
  }

  let movementNumber: string | undefined
  if (movementLines.length) {
    movementNumber = await getNextNumber(orgId, 'SM', 5)
    await StockMovement.create({
      orgId, movementNumber, type: 'adjustment', status: 'completed', date: new Date(),
      toWarehouseId: warehouseId, lines: movementLines,
      totalAmount: movementLines.reduce((s, l) => s + l.totalCost, 0),
      notes: 'Opening stock import', createdBy: userId,
    } as any)
  }

  return { rows: rows.length, matched, unmatched, adjusted, movementNumber, unmatchedSamples }
}
