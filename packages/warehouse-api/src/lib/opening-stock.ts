/**
 * Opening-stock import — set a warehouse's stock levels from a storeAvailability
 * export (Име / Количество / Доставна цена). Matches products by Cyrillic name/SKU
 * and SETS each level (delta via adjustStock), recording one adjustment movement.
 * Idempotent: re-running with the same file is a no-op (deltas become 0).
 */
import ExcelJS from 'exceljs'
import { buildSearchFilter } from 'services/biz/search.utils'
import { adjustStock } from 'services/biz/warehouse.service'
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
  // 1. Exact name match (indexed `nameLower`). Products are seeded from this same
  //    availability export, so the row name equals a product name 1:1. Exact-first
  //    avoids the fuzzy tokenized search below claiming a DIFFERENT row's product
  //    (which made the import oscillate / non-idempotent: ~769 rows on regal-pz).
  const exact: any = await Product.findOne({ orgId, isActive: true, nameLower: name.toLocaleLowerCase('bg') }).lean()
  if (exact) return String(exact._id)
  // 2. Fallback: fuzzy tokenized name/sku search for rows whose name has drifted.
  const f = buildSearchFilter(name, ['name', 'sku'], { lowered: { name: 'nameLower', sku: 'skuLower' } })
  const p: any = await Product.findOne({ orgId, isActive: true, ...f }).lean()
  return p ? String(p._id) : null
}

/**
 * Next stock-movement number = max existing `SM-<year>-NNNNN` + 1 (scan-based,
 * matching movement.controller.ts). NOT the atomic `SM` sequence counter — that
 * counter is unaware of movements created by the scan-based path and collides.
 */
async function nextMovementNumber(orgId: string): Promise<string> {
  const prefix = `SM-${new Date().getFullYear()}-`
  const latest: any = await StockMovement.findOne(
    { orgId, movementNumber: { $regex: `^${prefix}` } },
    { movementNumber: 1 },
  ).sort({ movementNumber: -1 }).lean()
  const n = latest ? parseInt(String(latest.movementNumber).replace(prefix, ''), 10) + 1 : 1
  return `${prefix}${String(n).padStart(5, '0')}`
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
    const totalAmount = movementLines.reduce((s, l) => s + l.totalCost, 0)
    // Retry on the E11000 race: scan-based numbering can collide if another
    // movement is allocated concurrently — recompute the number and re-insert.
    for (let attempt = 0; attempt < 6; attempt++) {
      movementNumber = await nextMovementNumber(orgId)
      try {
        await StockMovement.create({
          orgId, movementNumber, type: 'adjustment', status: 'completed', date: new Date(),
          toWarehouseId: warehouseId, lines: movementLines,
          totalAmount, notes: 'Opening stock import', createdBy: userId,
        } as any)
        break
      } catch (e: any) {
        if (e?.code === 11000 && attempt < 5) continue
        throw e
      }
    }
  }

  return { rows: rows.length, matched, unmatched, adjusted, movementNumber, unmatchedSamples }
}
