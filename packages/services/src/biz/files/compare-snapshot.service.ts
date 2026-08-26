import ExcelJS from 'exceljs'
import { Product, StockLevel, Warehouse } from 'db/models'
import { mkdir, writeFile } from 'fs/promises'
import { join, dirname } from 'path'

/**
 * Files app — the storeAvailability auto-diff. Ports the core of `scripts/compare-products.ts`
 * to run in-process against Mongo (no HTTP), so uploading a `storeAvailability_*.xlsx` can
 * immediately reconcile it against the org's live catalog + stock and dump a CSV/TXT next to it.
 * Byte-compatible CSV rows with the CLI (qty_mismatch / price_mismatch / missing_in_lgr).
 */

const HEADER_ROW = 5
const DATA_START_ROW = 6
const SKIP_NAMES = new Set(['Всичко', 'ОБЩО:', 'Опаковка', 'Име'])
const TIER_SLOTS = [
  { col: 6, tier: 'Цена на едро' }, { col: 7, tier: 'Цена 0' }, { col: 8, tier: 'Цена 1' },
  { col: 9, tier: 'Цена 2' }, { col: 10, tier: 'Цена 3' }, { col: 11, tier: 'Цена 4' },
  { col: 12, tier: 'Цена 5' }, { col: 13, tier: 'Цена 6' }, { col: 14, tier: 'Цена 7' },
  { col: 15, tier: 'Цена 8' }, { col: 16, tier: 'Цена 9' },
]
const cellNum = (v: any): number => { if (v == null) return 0; if (typeof v === 'object' && 'result' in v) return Number((v as any).result) || 0; return Number(v) || 0 }
const round4 = (v: number) => +v.toFixed(4)
const collapse = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('bg')

interface FileRow { name: string; qty: number; purchase: number; selling: number; slots: number[] }

function readSnapshot(buffer: Buffer, ws: ExcelJS.Worksheet) {
  const h1 = String(ws.getRow(HEADER_ROW).getCell(1).text ?? '').trim()
  const h3 = String(ws.getRow(HEADER_ROW).getCell(3).text ?? '').trim()
  if (h1 !== 'Име' || h3 !== 'Количество') throw new Error(`Not a storeAvailability export (headers "${h1}"/"${h3}")`)
  const byName = new Map<string, FileRow>()
  let total = 0
  ws.eachRow((row, rn) => {
    if (rn < DATA_START_ROW) return
    const name = String(row.getCell(1).text ?? '').trim()
    if (!name || SKIP_NAMES.has(name)) return
    const qty = cellNum(row.getCell(3).value)
    const cur: FileRow = { name, qty, purchase: round4(cellNum(row.getCell(4).value)), selling: round4(cellNum(row.getCell(5).value)), slots: TIER_SLOTS.map(s => round4(cellNum(row.getCell(s.col).value))) }
    total++
    const key = collapse(name)
    const prev = byName.get(key)
    if (prev) { const merged = Math.abs(qty) >= Math.abs(prev.qty) ? { ...cur } : { ...prev }; merged.qty = prev.qty + qty; byName.set(key, merged) }
    else byName.set(key, cur)
  })
  return { byName, total }
}

export interface CompareRow { kind: 'qty_mismatch' | 'price_mismatch' | 'missing_in_lgr'; sku: string; name: string; field: string; file: number; lgr: number | ''; diff: number | '' }
export interface CompareResult {
  summary: { matched: number; missingFromLgr: number; qtyMismatches: number; priceMismatches: number; snapshotRows: number }
  rows: CompareRow[]
  csv: string
  txt: string
  warehouse: string
}

export async function compareSnapshot(
  orgId: string,
  buffer: Buffer,
  opts: { warehouseCode?: string; qtyTol?: number; priceTol?: number } = {},
): Promise<CompareResult> {
  const qtyTol = opts.qtyTol ?? 0.001
  const priceTol = opts.priceTol ?? 0.005
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as any)
  const ws = wb.getWorksheet(1)!
  const { byName, total: snapshotRows } = readSnapshot(buffer, ws)

  const whs = await Warehouse.find({ orgId }).lean()
  const wh = (opts.warehouseCode ? whs.find((w: any) => w.code === opts.warehouseCode) : whs.find((w: any) => (w as any).isDefault)) || whs[0]
  const products = await Product.find({ orgId }).select('name sku purchasePrice sellingPrice priceTiers isActive').lean()
  const levels = wh ? await StockLevel.find({ orgId, warehouseId: (wh as any)._id }).select('productId quantity').lean() : []
  const qtyByProduct = new Map<string, number>(levels.map((l: any) => [String(l.productId), Number(l.quantity) || 0]))
  // collapse(name) → product (prefer active; first-wins otherwise)
  const byLgrName = new Map<string, any>()
  for (const p of products) { const k = collapse((p as any).name); const ex = byLgrName.get(k); if (!ex || (ex.isActive === false && (p as any).isActive !== false)) byLgrName.set(k, p) }

  const rows: CompareRow[] = []
  let matched = 0, missingFromLgr = 0, qtyMismatches = 0, priceMismatches = 0
  for (const [key, fr] of byName) {
    const p: any = byLgrName.get(key)
    if (!p) { missingFromLgr++; rows.push({ kind: 'missing_in_lgr', sku: '', name: fr.name, field: 'quantity', file: fr.qty, lgr: '', diff: '' }); continue }
    matched++
    const lgrQty = qtyByProduct.get(String(p._id)) || 0
    if (Math.abs(fr.qty - lgrQty) > qtyTol) { qtyMismatches++; rows.push({ kind: 'qty_mismatch', sku: p.sku, name: String(p.name).trim(), field: 'quantity', file: fr.qty, lgr: lgrQty, diff: round4(fr.qty - lgrQty) }) }
    const tierPrice = (tier: string): number => { const t = (p.priceTiers || []).find((x: any) => x.name === tier); return t ? round4(Number(t.finalPrice) || 0) : 0 }
    const cmp = (field: string, file: number, lgr: number) => { if (file === 0 && lgr === 0) return; if (Math.abs(file - lgr) > priceTol) { priceMismatches++; rows.push({ kind: 'price_mismatch', sku: p.sku, name: String(p.name).trim(), field, file, lgr, diff: round4(file - lgr) }) } }
    cmp('Дост.цена', fr.purchase, round4(Number(p.purchasePrice) || 0))
    cmp('Прод.цена', fr.selling, round4(Number(p.sellingPrice) || 0))
    TIER_SLOTS.forEach((s, i) => cmp(s.tier, fr.slots[i], tierPrice(s.tier)))
  }

  const summary = { matched, missingFromLgr, qtyMismatches, priceMismatches, snapshotRows }
  const esc = (s: any) => `"${String(s).replace(/"/g, '""')}"`
  const csv = [
    'kind,sku,name,field,file,lgr,diff',
    ...rows.map(r => `${r.kind},${r.sku},${esc(r.name)},${r.field === 'quantity' ? 'quantity' : esc(r.field)},${r.file},${r.lgr},${r.diff}`),
  ].join('\n')
  const txt = [
    `storeAvailability compare — warehouse ${wh ? (wh as any).name : '?'}`,
    `  snapshot rows        : ${snapshotRows}`,
    `  matched in LGR       : ${matched}`,
    `  MISSING from LGR     : ${missingFromLgr}`,
    `Quantity mismatches    : ${qtyMismatches}  (tol ${qtyTol})`,
    `Price mismatches       : ${priceMismatches}  (tol ${priceTol})`,
  ].join('\n')

  return { summary, rows, csv, txt, warehouse: wh ? (wh as any).name : '' }
}

/** Run the compare for an uploaded snapshot and dump compare-<stamp>.{csv,txt} beside it. */
export async function runAndDumpCompare(orgId: string, snapshotPath: string, buffer: Buffer, stamp: string): Promise<CompareResult> {
  const res = await compareSnapshot(orgId, buffer)
  const dir = dirname(snapshotPath)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `compare-${stamp}.csv`), res.csv, 'utf8')
  await writeFile(join(dir, `compare-${stamp}.txt`), res.txt, 'utf8')
  return res
}
