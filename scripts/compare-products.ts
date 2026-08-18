/**
 * Reconcile an LGR org's catalog + stock against a PlusMinus `storeAvailability_*.xlsx`
 * snapshot (the "Наличност в текущия обект" export) and report discrepancies in
 * QUANTITY and PRICES — read-only, no writes.
 *
 * The snapshot is PlusMinus's ground truth for one warehouse. For every file row it
 * finds the LGR product by exact (whitespace-tolerant) name and compares:
 *   - quantity   file "Количество"  vs  LGR StockLevel.quantity in the warehouse
 *   - purchase   file "Дост. цена"   vs  LGR product.purchasePrice
 *   - selling    file "Прод. цена"   vs  LGR product.sellingPrice
 *   - wholesale  file "Цена на едро" vs  LGR priceTiers "Цена на едро".finalPrice
 *   - Цена0..7   file "Цена0".."Цена7" vs LGR priceTiers "Цена 0".."Цена 7".finalPrice
 * Tiers are matched by SLOT (index), not label ("Цена0" file ↔ "Цена 0" LGR).
 *
 * Duplicate names in the file (correction/reservation splits) are summed to a net
 * quantity before comparing (prices taken from the largest-|qty| row) — mirrors the
 * opening-stock/seed dedup so split lines don't read as phantom quantity gaps.
 *
 * Output: a terminal summary + capped top-N detail per section, and a full CSV of
 * every discrepancy (default: next to the xlsx, or --out <path>).
 *
 * Usage:
 *   export LGR_USERNAME=... LGR_PASSWORD=...     # or LGR_TOKEN
 *   bun run scripts/compare-products.ts --file <storeAvailability.xlsx>
 *
 * Options:
 *   --file <path>     (required) storeAvailability_*.xlsx (WSL UNC ok)
 *   --org <slug>      org slug (default: regal-pz)
 *   --api <url>       API base (default: https://lgrai.app)
 *   --warehouse <c>   warehouse code or name (default: Pazardzhik / org default)
 *   --qty-tol <n>     quantity tolerance (default: 0.001)
 *   --price-tol <n>   price tolerance in EUR (default: 0.005 = half a cent)
 *   --limit <n>       max detail rows printed per section (default: 40)
 *   --out <path>      CSV report path (default: <xlsx dir>/compare-<org>-<stamp>.csv)
 *   --no-csv          skip writing the CSV
 *   --txt [path]      also persist the human-readable summary (the terminal report)
 *                     to a .txt (default path: --out with .csv→.txt, else next to xlsx)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import ExcelJS from 'exceljs'

const HEADER_ROW = 5
const DATA_START_ROW = 6
const SKIP_NAMES = new Set(['Всичко', 'ОБЩО:', 'Опаковка', 'Име'])
// File columns → LGR tier slots (by index). Cols 4/5 map to purchasePrice/sellingPrice
// scalar fields; cols 6-16 map to priceTiers slots "Цена на едро", "Цена 0".."Цена 9".
// (Extended 2026-08-06: the export carries Цена8/Цена9 in cols 15/16 — previously ignored.)
const TIER_SLOTS = [
  { col: 6, tier: 'Цена на едро' },
  { col: 7, tier: 'Цена 0' },
  { col: 8, tier: 'Цена 1' },
  { col: 9, tier: 'Цена 2' },
  { col: 10, tier: 'Цена 3' },
  { col: 11, tier: 'Цена 4' },
  { col: 12, tier: 'Цена 5' },
  { col: 13, tier: 'Цена 6' },
  { col: 14, tier: 'Цена 7' },
  { col: 15, tier: 'Цена 8' },
  { col: 16, tier: 'Цена 9' },
]

function parseArgs(argv: string[]) {
  const o: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { o[key] = next; i++ } else { o[key] = true }
  }
  return o
}
const args = parseArgs(process.argv.slice(2))
const filePath = args.file as string
const orgSlug = (args.org as string) || 'regal-pz'
const api = ((args.api as string) || 'https://lgrai.app').replace(/\/$/, '')
const warehouseArg = args.warehouse as string | undefined
const qtyTol = args['qty-tol'] !== undefined ? Number(args['qty-tol']) : 0.001
const priceTol = args['price-tol'] !== undefined ? Number(args['price-tol']) : 0.005
const limit = args.limit !== undefined ? Number(args.limit) : 40
const noCsv = !!args['no-csv']
// Date-correction: reverse the effect of movements dated >= this on the warehouse,
// rolling LGR back to the snapshot's day so a stale snapshot compares like-for-like.
const reverseSince = args['reverse-since'] as string | undefined
if (reverseSince && !/^\d{4}-\d{2}-\d{2}$/.test(reverseSince)) { console.error('--reverse-since must be YYYY-MM-DD'); process.exit(2) }

if (!filePath) { console.error('Required: --file <storeAvailability.xlsx>'); process.exit(2) }

// Tee console.log into a buffer so --txt can persist the exact human-readable report.
const txtArg = args.txt
const _logBuf: string[] = []
const _origLog = console.log.bind(console)
console.log = ((...a: any[]) => { _logBuf.push(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')); _origLog(...a) }) as typeof console.log

let TOKEN = process.env.LGR_TOKEN || ''
let ORG_ID = ''

async function http(method: string, path: string, body?: any): Promise<any> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }
  let payload: any
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
  const res = await fetch(`${api}${path}`, { method, headers, body: payload })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`)
  return json
}
const org = (path: string) => `/api/org/${ORG_ID}${path}`

async function login() {
  const username = process.env.LGR_USERNAME
  const password = process.env.LGR_PASSWORD
  if (TOKEN) {
    const me = await http('GET', '/api/auth/me')
    ORG_ID = me.user?.orgId || me.orgId
  } else {
    if (!username || !password) { console.error('Set LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.'); process.exit(2) }
    const res = await http('POST', '/api/auth/login', { orgSlug, username, password })
    TOKEN = res.token
    ORG_ID = res.org?.id || res.user?.orgId
  }
}

const cellNum = (v: any): number => {
  if (v == null) return 0
  if (typeof v === 'object' && 'result' in v) return Number((v as any).result) || 0
  return Number(v) || 0
}
const round4 = (v: number) => +v.toFixed(4)
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('bg')

interface FileRow { name: string; unit: string; qty: number; purchase: number; selling: number; slots: number[] }

async function readSnapshot(fp: string): Promise<{ byName: Map<string, FileRow>; total: number; zeroQty: number; dups: number }> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  const ws = wb.getWorksheet(1)!
  const h1 = String(ws.getRow(HEADER_ROW).getCell(1).text ?? '').trim()
  const h3 = String(ws.getRow(HEADER_ROW).getCell(3).text ?? '').trim()
  if (h1 !== 'Име' || h3 !== 'Количество') {
    console.error(`Unexpected headers at row ${HEADER_ROW}: "${h1}" / "${h3}" (expected "Име" / "Количество"). Not a storeAvailability export? Aborting.`)
    process.exit(1)
  }
  const byName = new Map<string, FileRow>()
  let total = 0, zeroQty = 0, dups = 0
  ws.eachRow((row, rn) => {
    if (rn < DATA_START_ROW) return
    const name = String(row.getCell(1).text ?? '').trim()
    if (!name || SKIP_NAMES.has(name)) return
    const qty = cellNum(row.getCell(3).value)
    const cur: FileRow = {
      name, unit: String(row.getCell(2).text ?? '').trim(), qty,
      purchase: round4(cellNum(row.getCell(4).value)),
      selling: round4(cellNum(row.getCell(5).value)),
      slots: TIER_SLOTS.map(s => round4(cellNum(row.getCell(s.col).value))),
    }
    total++
    if (qty === 0) zeroQty++
    const key = collapse(name)
    const prev = byName.get(key)
    if (prev) {
      dups++
      // sum quantities; keep prices/name from the larger-|qty| row
      const merged: FileRow = Math.abs(qty) >= Math.abs(prev.qty) ? { ...cur } : { ...prev }
      merged.qty = prev.qty + qty
      byName.set(key, merged)
    } else {
      byName.set(key, cur)
    }
  })
  return { byName, total, zeroQty, dups }
}

/**
 * Fetch every page of a list endpoint. Paginates on `_id` ascending: the reseed
 * bulk-inserted thousands of rows with identical `createdAt` (the default sort), so
 * skip/limit over a non-unique key overlaps pages and silently drops records. `_id`
 * is unique + monotonic → stable pagination. Deduped by the row's own id as a belt-
 * and-suspenders guard in case the server ignores the sort override.
 */
async function fetchAll(path: string, key: string, idOf: (x: any) => string, pageSize = 1000): Promise<any[]> {
  const seen = new Set<string>()
  const out: any[] = []
  const sep = path.includes('?') ? '&' : '?'
  let page = 0, total = Infinity, emptyStreak = 0
  while (out.length < total) {
    const d = await http('GET', org(`${path}${sep}page=${page}&size=${pageSize}&sortBy=_id&sortOrder=asc`))
    const items = d[key] || []
    if (d.total != null) total = d.total
    if (!items.length) break
    let added = 0
    for (const it of items) { const id = idOf(it); if (!seen.has(id)) { seen.add(id); out.push(it); added++ } }
    if (added === 0) { if (++emptyStreak >= 2) break } else emptyStreak = 0
    page++
    if (page > 2000) break // safety
  }
  return out
}

const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 4, useGrouping: false })

async function main() {
  console.log(`Compare products vs snapshot | file: ${basename(filePath)}`)
  console.log(`Org: ${orgSlug} | API: ${api}`)
  await login()

  // warehouse
  const whs = (await http('GET', org('/warehouse/warehouse?page=0&size=100'))).warehouses || []
  if (!whs.length) { console.error('Org has no warehouses.'); process.exit(1) }
  const norm = (s: string) => collapse(s)
  let wh = warehouseArg
    ? whs.find((w: any) => w.code === warehouseArg || norm(w.name) === norm(warehouseArg) || norm(w.code) === norm(warehouseArg))
    : (whs.find((w: any) => norm(w.name) === 'pazardzhik' || w.code === 'pz') || whs.find((w: any) => w.isDefault) || whs[0])
  if (!wh) { console.error(`Warehouse "${warehouseArg}" not found.`); process.exit(1) }
  console.log(`Warehouse: ${wh.name} (${wh.code})`)

  // snapshot
  const { byName, total, zeroQty, dups } = await readSnapshot(filePath)
  console.log(`Snapshot rows: ${total} (unique names ${byName.size}${dups ? `, ${dups} dup-name rows summed` : ''}${zeroQty ? `, ${zeroQty} zero-qty` : ''})`)

  // LGR catalog + stock (bulk)
  console.log('Fetching LGR products + stock levels ...')
  const idOf = (x: any) => String(x._id || x.id)
  const products = await fetchAll('/warehouse/product', 'products', idOf)
  const levels = await fetchAll(`/warehouse/stock-level?warehouseId=${wh._id}`, 'stockLevels', idOf)
  console.log(`  LGR: ${products.length} products, ${levels.length} stock levels in ${wh.code}`)
  const qtyById = new Map<string, number>()
  for (const l of levels) qtyById.set(String(l.productId?._id || l.productId), Number(l.quantity) || 0)

  // Date-correction: undo movements dated >= reverseSince on this warehouse, so LGR
  // reads as of the snapshot's day. A movement that LEFT the warehouse (fromWarehouse
  // = wh) is added back; one that ENTERED (toWarehouse = wh) is subtracted.
  if (reverseSince) {
    const heads = await fetchAll(`/warehouse/movement?dateFrom=${reverseSince}`, 'stockMovements', idOf)
    let reversed = 0
    for (const h of heads) {
      const full = await http('GET', org(`/warehouse/movement/${h._id || h.id}`))
      const m = full.stockMovement || full.movement || full
      const from = String(m.fromWarehouseId?._id || m.fromWarehouseId || '')
      const to = String(m.toWarehouseId?._id || m.toWarehouseId || '')
      const sign = from === String(wh._id) ? +1 : (to === String(wh._id) ? -1 : 0)
      if (!sign) continue
      for (const line of m.lines || []) {
        const pid = String(line.productId?._id || line.productId)
        qtyById.set(pid, (qtyById.get(pid) ?? 0) + sign * (Number(line.quantity) || 0))
      }
      reversed++
    }
    console.log(`  reversed ${reversed} movement(s) dated >= ${reverseSince} → LGR rolled back to the snapshot day`)
  }

  const prodByName = new Map<string, any>()
  let lgrDupNames = 0
  for (const p of products) {
    const k = collapse(String(p.name || ''))
    if (prodByName.has(k)) lgrDupNames++
    else prodByName.set(k, p)
  }

  const tierFinal = (p: any, tierName: string): number => {
    const t = (p.priceTiers || []).find((x: any) => x.name === tierName)
    return t ? Number(t.finalPrice) || 0 : 0
  }

  // compare
  const missingInLgr: FileRow[] = []
  const qtyDiffs: Array<{ name: string; sku: string; file: number; lgr: number; diff: number }> = []
  const priceDiffs: Array<{ name: string; sku: string; field: string; file: number; lgr: number }> = []
  const matchedNames = new Set<string>()

  for (const [key, f] of byName) {
    const p = prodByName.get(key)
    if (!p) { missingInLgr.push(f); continue }
    matchedNames.add(key)
    const pid = String(p._id || p.id)
    const lgrQty = qtyById.get(pid) ?? 0
    if (Math.abs(f.qty - lgrQty) > qtyTol) qtyDiffs.push({ name: f.name, sku: p.sku, file: f.qty, lgr: lgrQty, diff: round4(f.qty - lgrQty) })

    const checks: Array<{ field: string; file: number; lgr: number }> = [
      { field: 'Дост.цена', file: f.purchase, lgr: round4(Number(p.purchasePrice) || 0) },
      { field: 'Прод.цена', file: f.selling, lgr: round4(Number(p.sellingPrice) || 0) },
      ...TIER_SLOTS.map((s, i) => ({ field: s.tier, file: f.slots[i], lgr: round4(tierFinal(p, s.tier)) })),
    ]
    for (const c of checks) if (Math.abs(c.file - c.lgr) > priceTol) priceDiffs.push({ name: f.name, sku: p.sku, ...c })
  }

  // LGR products not present in the snapshot (by name)
  let lgrNotInFile = 0
  for (const k of prodByName.keys()) if (!byName.has(k)) lgrNotInFile++

  qtyDiffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
  priceDiffs.sort((a, b) => Math.abs(b.file - b.lgr) - Math.abs(a.file - a.lgr))

  // ── report ──
  const productsWithPriceDiff = new Set(priceDiffs.map(d => d.sku)).size
  console.log(`\n════════ DISCREPANCY REPORT ════════`)
  console.log(`Snapshot unique products : ${byName.size}`)
  console.log(`  matched in LGR         : ${matchedNames.size}`)
  console.log(`  MISSING from LGR       : ${missingInLgr.length}`)
  console.log(`Quantity mismatches      : ${qtyDiffs.length}  (tol ${qtyTol})`)
  console.log(`Price mismatches         : ${priceDiffs.length} across ${productsWithPriceDiff} products  (tol ${priceTol})`)
  console.log(`LGR products not in file : ${lgrNotInFile}  (expected: zero-stock / delisted at ${wh.code})`)
  if (lgrDupNames) console.log(`⚠ LGR duplicate-name products: ${lgrDupNames} (only first kept for matching)`)

  if (missingInLgr.length) {
    console.log(`\n── MISSING from LGR (in snapshot, no catalog match) — top ${Math.min(limit, missingInLgr.length)} of ${missingInLgr.length} ──`)
    for (const m of missingInLgr.slice(0, limit)) console.log(`  "${m.name}"  qty ${fmt(m.qty)}  cost ${fmt(m.purchase)}`)
  }
  if (qtyDiffs.length) {
    console.log(`\n── QUANTITY mismatches (file → LGR) — top ${Math.min(limit, qtyDiffs.length)} of ${qtyDiffs.length}, by |diff| ──`)
    for (const d of qtyDiffs.slice(0, limit)) console.log(`  ${d.sku}  "${d.name.replace(/\s+/g, ' ').slice(0, 44).padEnd(44)}"  file ${fmt(d.file).padStart(9)}  LGR ${fmt(d.lgr).padStart(9)}  Δ ${fmt(d.diff)}`)
  }
  if (priceDiffs.length) {
    console.log(`\n── PRICE mismatches (file → LGR) — top ${Math.min(limit, priceDiffs.length)} of ${priceDiffs.length}, by |diff| ──`)
    for (const d of priceDiffs.slice(0, limit)) console.log(`  ${d.sku}  "${d.name.replace(/\s+/g, ' ').slice(0, 34).padEnd(34)}"  ${d.field.padEnd(12)}  file ${fmt(d.file).padStart(9)}  LGR ${fmt(d.lgr).padStart(9)}`)
  }

  // ── CSV ──
  if (!noCsv) {
    const stamp = basename(filePath).replace(/[^0-9]/g, '').slice(0, 14) || 'report'
    const out = (args.out as string) || join(dirname(filePath), `compare-${orgSlug}-${stamp}.csv`)
    const esc = (s: any) => `"${String(s).replace(/"/g, '""')}"`
    const lines = ['type,sku,name,field,file,lgr,diff']
    for (const m of missingInLgr) lines.push(['missing_in_lgr', '', esc(m.name), 'quantity', m.qty, '', ''].join(','))
    for (const d of qtyDiffs) lines.push(['qty_mismatch', d.sku, esc(d.name), 'quantity', d.file, d.lgr, d.diff].join(','))
    for (const d of priceDiffs) lines.push(['price_mismatch', d.sku, esc(d.name), esc(d.field), d.file, d.lgr, round4(d.file - d.lgr)].join(','))
    writeFileSync(out, lines.join('\n'), 'utf8')
    console.log(`\nFull discrepancy CSV (${lines.length - 1} rows) → ${out}`)
  }

  // ── TXT (human-readable report) ──
  if (txtArg) {
    const stamp = basename(filePath).replace(/[^0-9]/g, '').slice(0, 14) || 'report'
    let txtOut: string
    if (typeof txtArg === 'string') txtOut = txtArg
    else if (typeof args.out === 'string') { txtOut = (args.out as string).replace(/\.csv$/i, '.txt'); if (txtOut === args.out) txtOut += '.txt' }
    else txtOut = join(dirname(filePath), `compare-${orgSlug}-${stamp}.txt`)
    writeFileSync(txtOut, _logBuf.join('\n') + '\n', 'utf8')
    _origLog(`Readable report TXT → ${txtOut}`)
  }
}

await main()
