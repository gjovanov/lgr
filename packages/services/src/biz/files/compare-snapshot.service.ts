import ExcelJS from 'exceljs'
import { Product, StockLevel, Warehouse, DocFile, Org } from 'db/models'
import { mkdir, writeFile } from 'fs/promises'
import { join, dirname, basename } from 'path'

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

/** PlusMinus export prefix behind each document type — what the numbering runs on. */
const SEQ_PREFIX: Record<string, string> = {
  invoice: 'invoicem', goods_receipt: 'stokrazp', correction: 'stokrazp',
  transfer_note: 'sklrazp', issue_note: 'sklisk',
}

/**
 * Numbering continuity for the day, per document family.
 *
 * A hole is a document PlusMinus issued that never reached LGR — the quietest way for a day to go
 * wrong, because nothing about the documents that DID arrive looks unusual. Uncommitted ones are
 * called out separately: present, but not booked yet.
 */
async function sequenceReport(orgId: string, docDate: string): Promise<{ lines: string[]; skips: number }> {
  const docs: any[] = await DocFile.find({ orgId, docDate, isActive: true }).select('docType docNumber status').lean()
  const groups = new Map<string, any[]>()
  for (const d of docs) {
    const prefix = SEQ_PREFIX[d.docType]
    if (!prefix) continue
    ;(groups.get(prefix) ?? groups.set(prefix, []).get(prefix)!).push(d)
  }
  const lines: string[] = []
  let skips = 0
  for (const prefix of ['invoicem', 'stokrazp', 'sklrazp', 'sklisk']) {
    const g = groups.get(prefix)
    if (!g?.length) continue
    const nums = g.map(d => ({ n: parseInt(String(d.docNumber).replace(/[^0-9]/g, ''), 10), d })).filter(x => Number.isFinite(x.n)).sort((a, b) => a.n - b.n)
    if (!nums.length) continue
    const lo = nums[0].n, hi = nums[nums.length - 1].n
    const present = new Set(nums.map(x => x.n))
    const holes: number[] = []
    for (let n = lo; n <= hi; n++) if (!present.has(n)) holes.push(n)
    skips += holes.length
    const pending = nums.filter(x => x.d.status !== 'committed' && x.d.status !== 'superseded').length
    const state = holes.length
      ? `⚠ ${holes.length} MISSING: ${holes.slice(0, 12).join(', ')}${holes.length > 12 ? ' …' : ''}`
      : pending ? `✓ contiguous, ${pending} not booked yet` : '✓ contiguous & imported'
    lines.push(`  ${prefix.padEnd(11)} ${String(nums.length).padStart(2)} docs  [${lo}–${hi}]   ${state}`)
  }
  if (!lines.length) lines.push('  (no numbered documents stored for this date)')
  else if (!skips) lines.push('  → no numbering skips detected')
  return { lines, skips }
}

/**
 * A price that landed in the neighbouring slot.
 *
 * When a разписка's columns shift by one, the value is not wrong — it is in the wrong tier. That
 * reads as two unrelated price mismatches unless you notice the snapshot's value for tier X sitting
 * in LGR's tier Y, which is what this looks for.
 */
function slotShifts(perProduct: Map<string, { name: string; file: Map<string, number>; lgr: Map<string, number> }>): string[] {
  const out: string[] = []
  for (const [sku, p] of perProduct) {
    for (const [field, fileVal] of p.file) {
      if (!(fileVal > 0) || Math.abs((p.lgr.get(field) ?? 0) - fileVal) < 0.005) continue
      for (const [otherField, lgrVal] of p.lgr) {
        if (otherField === field || !(lgrVal > 0)) continue
        if (Math.abs(lgrVal - fileVal) < 0.005) {
          out.push(`  ${sku} tier_slot_shift LGR ${otherField}=${lgrVal} matches snapshot ${field} — value in the wrong slot  "${p.name}"`)
          break
        }
      }
    }
  }
  return out
}

/** Display-only whitespace squeeze — the key builder lowercases, this must not. */
const collapseSpaces = (s: string) => String(s).replace(/\s+/g, ' ').trim()

export async function compareSnapshot(
  orgId: string,
  buffer: Buffer,
  opts: { warehouseCode?: string; qtyTol?: number; priceTol?: number; fileName?: string; docDate?: string } = {},
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
  const zeroQty = [...byName.values()].filter((v: any) => !Number(v.qty)).length
  // Every price column both sides carry, per product — what the slot-shift check reads.
  const perProduct = new Map<string, { name: string; file: Map<string, number>; lgr: Map<string, number> }>()
  let matched = 0, missingFromLgr = 0, qtyMismatches = 0, priceMismatches = 0
  for (const [key, fr] of byName) {
    const p: any = byLgrName.get(key)
    if (!p) { missingFromLgr++; rows.push({ kind: 'missing_in_lgr', sku: '', name: fr.name, field: 'quantity', file: fr.qty, lgr: '', diff: '' }); continue }
    matched++
    const lgrQty = qtyByProduct.get(String(p._id)) || 0
    if (Math.abs(fr.qty - lgrQty) > qtyTol) { qtyMismatches++; rows.push({ kind: 'qty_mismatch', sku: p.sku, name: String(p.name).trim(), field: 'quantity', file: fr.qty, lgr: lgrQty, diff: round4(fr.qty - lgrQty) }) }
    const tierPrice = (tier: string): number => { const t = (p.priceTiers || []).find((x: any) => x.name === tier); return t ? round4(Number(t.finalPrice) || 0) : 0 }
    const slots = perProduct.set(p.sku, perProduct.get(p.sku) ?? { name: String(p.name).trim(), file: new Map(), lgr: new Map() }).get(p.sku)!
    const cmp = (field: string, file: number, lgr: number) => {
      slots.file.set(field, file); slots.lgr.set(field, lgr)
      if (file === 0 && lgr === 0) return
      if (Math.abs(file - lgr) > priceTol) { priceMismatches++; rows.push({ kind: 'price_mismatch', sku: p.sku, name: String(p.name).trim(), field, file, lgr, diff: round4(file - lgr) }) }
    }
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
  // ── the report ────────────────────────────────────────────────────────────────────────────
  const org: any = await Org.findOne({ _id: orgId }).select('slug').lean()
  const seq = opts.docDate ? await sequenceReport(orgId, opts.docDate) : { lines: ['  (no date given)'], skips: 0 }
  const shifts = slotShifts(perProduct)
  const qtyRows = rows.filter(r => r.kind === 'qty_mismatch').sort((a, b) => Math.abs(Number(b.diff)) - Math.abs(Number(a.diff)))
  const priceRows = rows.filter(r => r.kind === 'price_mismatch').sort((a, b) => Math.abs(Number(b.diff)) - Math.abs(Number(a.diff)))
  const missRows = rows.filter(r => r.kind === 'missing_in_lgr')
  const pad = (s: any, n: number) => String(s).padEnd(n)
  const num = (v: any, n = 9) => String(v).padStart(n)
  const nm = (s: string) => `"${collapseSpaces(s).slice(0, 34).padEnd(34)}"`
  const productsTouched = new Set(priceRows.map(r => r.sku)).size

  const txt = [
    `Compare products vs snapshot | file: ${opts.fileName || '(uploaded)'}`,
    `Org: ${org?.slug || orgId} | Files app (in-process)`,
    `Warehouse: ${wh ? (wh as any).name : '?'}${wh && (wh as any).code ? ` (${(wh as any).code})` : ''}`,
    `Snapshot rows: ${snapshotRows} (unique names ${byName.size}, ${snapshotRows - byName.size} dup-name rows summed, ${zeroQty} zero-qty)`,
    `  LGR: ${products.length} products, ${levels.length} stock levels in ${wh ? (wh as any).code || (wh as any).name : '?'}`,
    '',
    '════════ DISCREPANCY REPORT ════════',
    `Snapshot unique products : ${byName.size}`,
    `  matched in LGR         : ${matched}`,
    `  MISSING from LGR       : ${missingFromLgr}`,
    `Quantity mismatches      : ${qtyMismatches}  (tol ${qtyTol})`,
    `Price mismatches         : ${priceMismatches} across ${productsTouched} products  (tol ${priceTol})`,
    `Sequence/numbering skips : ${seq.skips}`,
    `Line items to review     : ${shifts.length}`,
    `LGR products not in file : ${Math.max(0, products.length - matched)}  (expected: zero-stock / delisted here)`,
    ...(missRows.length ? ['', `── MISSING from LGR (in snapshot, no catalog match) — all ${missRows.length} ──`,
      ...missRows.map(r => `  ${nm(r.name)}  qty ${r.file}`)] : []),
    ...(qtyRows.length ? ['', `── QUANTITY mismatches (file → LGR) — all ${qtyRows.length}, by |diff| ──`,
      ...qtyRows.map(r => `  ${pad(r.sku, 14)} ${nm(r.name)}  file ${num(r.file)}  LGR ${num(r.lgr)}  Δ ${num(r.diff)}`)] : []),
    ...(priceRows.length ? ['', `── PRICE mismatches (file → LGR) — all ${priceRows.length}, by |diff| ──`,
      ...priceRows.map(r => `  ${pad(r.sku, 14)} ${nm(r.name)}  ${pad(r.field, 13)} file ${num(r.file)}  LGR ${num(r.lgr)}`)] : []),
    '',
    `── DOCUMENT SEQUENCE / NUMBERING (${opts.docDate || '?'}) ──`,
    ...seq.lines,
    '',
    `── LINE ITEMS TO REVIEW (possible OCR) — ${shifts.length} ──`,
    ...(shifts.length ? shifts : ['  → none flagged']),
  ].join('\n')

  return { summary, rows, csv, txt, warehouse: wh ? (wh as any).name : '' }
}

/** Run the compare for an uploaded snapshot and dump compare-<stamp>.{csv,txt} beside it. */
export async function runAndDumpCompare(orgId: string, snapshotPath: string, buffer: Buffer, stamp: string): Promise<CompareResult> {
  const dir = dirname(snapshotPath)
  // The layout gives both for free: the file sits in its own date folder.
  const res = await compareSnapshot(orgId, buffer, { fileName: basename(snapshotPath), docDate: basename(dir) })
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `compare-${stamp}.csv`), res.csv, 'utf8')
  await writeFile(join(dir, `compare-${stamp}.txt`), res.txt, 'utf8')
  return res
}
