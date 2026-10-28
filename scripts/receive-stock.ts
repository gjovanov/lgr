/**
 * Import a day's goods RECEIPTS (Доставки) from the legacy PlusMinus ERP into an
 * LGR org as ONE completed receipt StockMovement — the API equivalent of filling
 * /inventory/movements/new and confirming it.
 *
 * Takes a day folder containing a `storeOperations_*.xlsx` export. The same
 * filename can carry different reports depending on the export's operation
 * filter — the header block is validated and anything but `Операция: Доставки`
 * is rejected (e.g. the 2026-07-23 file is a Продажби/sales report).
 *
 * Quantities only: each row's "Име" is exact-matched (then whitespace-tolerantly)
 * to a product and "Количество" becomes the received quantity. Prices are NOT
 * touched — line unitCost is set to the product's current StockLevel.avgCost so
 * the weighted-average recompute in confirmMovement leaves avgCost bit-identical
 * (unitCost=0 would dilute it toward zero). A future extension may adopt the
 * file's Цена column + the with-product-update flow; not built yet.
 *
 * Warehouse: `Склад:` from the file matched by name/code against the org's
 * warehouses ("Всички складове"/blank/no match → org default), `--warehouse`
 * code overrides.
 *
 * Repeatable: the movement's notes carry `storeOperations:<date>` — if a receipt
 * with that marker exists, the run is a no-op. One receipt per day.
 *
 * Usage:
 *   export LGR_USERNAME=... LGR_PASSWORD=...          # or LGR_TOKEN
 *   bun run scripts/receive-stock.ts --folder <day dir>             # dry-run
 *   bun run scripts/receive-stock.ts --folder <day dir> --execute
 *
 * Options:
 *   --folder <dir>    (required) day folder with storeOperations_*.xlsx (WSL UNC ok)
 *   --date <ISO>      effective date (default: folder basename; must match the
 *                     file's Период start unless --date is given explicitly)
 *   --org <slug>      org slug (default: regal-pz)
 *   --api <url>       API base (default: https://lgrai.app)
 *   --warehouse <c>   warehouse code override (skips file/default resolution)
 *   --skip-unmatched  proceed without rows whose product has no catalog match
 *                     (default: unmatched rows abort --execute — silent skips = stock drift)
 *   --execute         actually create + confirm the movement (default: dry-run)
 */
import { readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import ExcelJS from 'exceljs'
import { assertTokenOrg } from './lib/token-org.js'

const HEADER_ROW = 9 // "Име | Мярка | Количество | ..."

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
const folder = args.folder as string
const orgSlug = (args.org as string) || 'regal-pz'
const api = ((args.api as string) || 'https://lgrai.app').replace(/\/$/, '')
const warehouseCode = args.warehouse as string | undefined
const skipUnmatched = !!args['skip-unmatched']
const execute = !!args.execute

if (!folder) { console.error('Required: --folder <day dir with storeOperations_*.xlsx>'); process.exit(2) }
const dateExplicit = typeof args.date === 'string'
const dateArg = (args.date as string) || basename(folder.replace(/[\\/]+$/, ''))
if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) { console.error(`--date (or folder name) must be YYYY-MM-DD, got "${dateArg}"`); process.exit(2) }

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
    assertTokenOrg(me, orgSlug) // a token from a tab switched to another org must not write there
    ORG_ID = me.user?.orgId || me.orgId
  } else {
    if (!username || !password) { console.error('Set LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.'); process.exit(2) }
    const res = await http('POST', '/api/auth/login', { orgSlug, username, password })
    TOKEN = res.token
    ORG_ID = res.org?.id || res.user?.orgId
  }
  console.log(`auth: → org ${orgSlug} (${ORG_ID})`)
}

const cellNum = (v: any): number => {
  if (v == null) return 0
  if (typeof v === 'object' && 'result' in v) return Number(v.result) || 0
  return Number(v) || 0
}
const round2 = (v: number) => +v.toFixed(2)
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('bg')

interface Row { name: string; qty: number }
interface Parsed { rows: Row[]; totalQty: number; sklad: string; operacia: string; periodStart: string; tipDoc: string }

async function parseStoreOperations(fp: string): Promise<Parsed> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  const sheet = wb.getWorksheet(1)!
  const headText = (rn: number) => String(sheet.getRow(rn).getCell(1).text ?? '').trim()

  const sklad = headText(2).replace(/^Склад:\s*/, '')
  const periodRaw = headText(3)
  const operacia = headText(4).replace(/^Операция:\s*/, '')
  const tipDoc = headText(6).replace(/^Тип на док\.:\s*/, '')
  const pm = periodRaw.match(/Период:\s*(\d{2})\.(\d{2})\.(\d{4})/)
  const periodStart = pm ? `${pm[3]}-${pm[2]}-${pm[1]}` : ''

  // The export layout is shared across operation kinds — the Операция header is the
  // only reliable discriminator between receipts and e.g. a Продажби (sales) report.
  if (operacia !== 'Доставки') {
    console.error(`File is "Операция: ${operacia || '?'}" — this skill imports ONLY "Доставки" (goods receipts). Aborting.`)
    // A „Продажби" export is not a dead end any more: it is the day's till takings in a second
    // layout, and the Files app books it as a cash sale (keyed `salesAnalysis:<date>`, so it
    // collides with the АРТИКУЛИ export of the same day rather than doubling it).
    if (operacia === 'Продажби') console.error('  → upload it in the Files app, or use `import-cash-register-sales`: it is a cash-register day, not a delivery.')
    process.exit(1)
  }
  const h = sheet.getRow(HEADER_ROW)
  const h1 = String(h.getCell(1).text ?? '').trim()
  const h3 = String(h.getCell(3).text ?? '').trim()
  if (h1 !== 'Име' || h3 !== 'Количество') {
    console.error(`Unexpected headers at row ${HEADER_ROW}: "${h1}" / "${h3}" (expected "Име" / "Количество") — layout drift, aborting.`)
    process.exit(1)
  }

  const rows: Row[] = []
  let totalQty = 0
  sheet.eachRow((row, rn) => {
    if (rn <= HEADER_ROW) return
    const name = String(row.getCell(1).text ?? '').trim()
    if (!name) return
    const qty = cellNum(row.getCell(3).value)
    if (name === 'Всичко') { totalQty = qty; return }
    rows.push({ name, qty })
  })
  // Any unknown group/summary rows would inflate the item sum past the "Всичко" row.
  const sumQ = rows.reduce((s, r) => s + r.qty, 0)
  if (Math.abs(sumQ - totalQty) > 0.05) {
    console.error(`Cross-check FAILED: items qty sum ${sumQ} vs Всичко ${totalQty} — unknown group rows? Aborting.`)
    process.exit(1)
  }
  return { rows, totalQty, sklad, operacia, periodStart, tipDoc }
}

async function searchProducts(q: string, pages: number): Promise<any[]> {
  const all: any[] = []
  for (let page = 0; page < pages; page++) {
    const d = await http('GET', org(`/warehouse/product?search=${encodeURIComponent(q)}&page=${page}&size=50`))
    const items = d.products || []
    all.push(...items)
    if (!items.length || (page + 1) * 50 >= (d.total ?? 0)) break
  }
  return all
}

/** Exact product match by name (bg-lowercased), then whitespace-tolerant retries —
 *  the catalog keeps the legacy exports' multi-space padding while other exports
 *  may collapse it (and vice versa). */
async function matchProduct(name: string): Promise<{ id: string; name: string; unit?: string } | null> {
  const lower = name.trim().toLocaleLowerCase('bg')
  const coll = collapse(name)
  const pick = (items: any[], cmp: (p: any) => boolean) => {
    const hit = items.find(cmp)
    return hit ? { id: hit._id || hit.id, name: hit.name, unit: hit.unit } : null
  }
  const byExact = (p: any) => String(p.name ?? '').trim().toLocaleLowerCase('bg') === lower
  const byCollapse = (p: any) => collapse(String(p.name ?? '')) === coll

  const direct = await searchProducts(name, 3)
  const m1 = pick(direct, byExact) || pick(direct, byCollapse)
  if (m1) return m1
  if (coll !== lower) {
    const m2 = pick(await searchProducts(coll, 3), byCollapse)
    if (m2) return m2
  }
  // catalog-side padding: a contains-search for the full name misses, so search by
  // the most selective token and compare with collapsed whitespace
  const token = coll.split(' ').filter(t => t.length >= 4).sort((a, b) => b.length - a.length)[0]
  if (token && token !== coll) {
    const m3 = pick(await searchProducts(token, 5), byCollapse)
    if (m3) return m3
  }
  return null
}

async function stockLevelFor(productId: string, warehouseId: string): Promise<{ qty: number; avgCost: number }> {
  const d = await http('GET', org(`/warehouse/stock-level?productId=${productId}&page=0&size=10`))
  const rows: any[] = d.stockLevels || d.levels || d.data || []
  const r = rows.find((x: any) => String(x.warehouseId?._id || x.warehouseId) === String(warehouseId)) || rows[0]
  return { qty: Number(r?.quantity) || 0, avgCost: Number(r?.avgCost) || 0 }
}

async function main() {
  console.log(`Receive stock (Доставки) | folder: ${folder} | date: ${dateArg}`)
  console.log(`Org: ${orgSlug} | API: ${api} | mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}`)
  console.log()

  const files = readdirSync(folder).filter(f => /^storeOperations_.*\.xlsx$/i.test(f))
  if (!files.length) { console.error('No storeOperations_*.xlsx in folder.'); process.exit(1) }
  if (files.length > 1) console.log(`  ⚠ ${files.length} storeOperations files — using ${files[0]}`)
  const parsed = await parseStoreOperations(join(folder, files[0]))
  console.log(`Header: Операция=${parsed.operacia} | Склад="${parsed.sklad}" | Период от ${parsed.periodStart} | Тип на док.=${parsed.tipDoc}`)
  console.log(`Items: ${parsed.rows.length} | total qty: ${parsed.totalQty}`)

  // wrong-day protection: executing a stale file double-counts against the snapshot baseline
  if (parsed.periodStart && parsed.periodStart !== dateArg && !dateExplicit) {
    console.error(`Period start ${parsed.periodStart} ≠ folder date ${dateArg} — wrong file in folder? Pass --date explicitly to override. Aborting.`)
    process.exit(1)
  }

  await login()

  // dedup — one receipt per day, marker in movement notes (movements have no reference field)
  const marker = `storeOperations:${dateArg}`
  for (const q of [marker, 'storeOperations']) {
    const d = await http('GET', org(`/warehouse/movement?type=receipt&search=${encodeURIComponent(q)}&page=0&size=50`))
    const dup = (d.stockMovements || []).find((m: any) => String(m.notes || '').includes(marker))
    if (dup) { console.log(`Already imported for ${dateArg}: ${dup.movementNumber || dup.number} (${dup.status}) — nothing to do.`); return }
  }

  // warehouse: --warehouse code > file's Склад by name/code > org default
  const whs = (await http('GET', org('/warehouse/warehouse?page=0&size=100'))).warehouses || []
  if (!whs.length) { console.error('Org has no warehouses.'); process.exit(1) }
  const dflt = whs.find((w: any) => w.isDefault) || whs[0]
  let wh = warehouseCode ? whs.find((w: any) => w.code === warehouseCode) : undefined
  if (warehouseCode && !wh) { console.error(`Warehouse code "${warehouseCode}" not found.`); process.exit(1) }
  if (!wh) {
    const sk = collapse(parsed.sklad)
    if (!sk || sk === collapse('Всички складове')) {
      wh = dflt
    } else {
      // "ОБЕКТИ:СКЛАД - 1" is a PlusMinus hierarchy path — try the full value and the leaf
      const leaf = collapse(parsed.sklad.split(':').pop() || '')
      wh = whs.find((w: any) => [sk, leaf].includes(collapse(String(w.name || ''))) || [sk, leaf].includes(collapse(String(w.code || ''))))
      if (!wh) {
        console.log(`  ⚠ no LGR warehouse matches "${parsed.sklad}" — using default`)
        wh = dflt
      }
    }
  }
  console.log(`Warehouse: ${wh.name} (${wh.code})`)

  // match products + current levels (unitCost := current avgCost keeps avgCost invariant)
  const lines: any[] = []
  const unmatched: Row[] = []
  console.log()
  for (const r of parsed.rows) {
    const m = await matchProduct(r.name)
    if (!m) { unmatched.push(r); console.log(`  ✗ unmatched: "${r.name}" (qty ${r.qty})`); continue }
    const lv = await stockLevelFor(m.id, wh._id)
    lines.push({ productId: m.id, quantity: r.qty, unitCost: lv.avgCost, totalCost: round2(r.qty * lv.avgCost) })
    console.log(`  + ${(m.name as string).replace(/\s+/g, ' ').padEnd(45).slice(0, 45)} qty ${String(r.qty).padStart(6)}  stock ${lv.qty} → ${lv.qty + r.qty}  (avgCost ${lv.avgCost})`)
  }
  console.log(`\nMatched: ${lines.length}/${parsed.rows.length}${unmatched.length ? ` | unmatched: ${unmatched.length}` : ''}`)

  if (unmatched.length && !skipUnmatched) {
    console.log('Unmatched rows would be silently missing from stock — seed/fix the products first,')
    console.log('or re-run with --skip-unmatched to import the matched subset only.')
    if (execute) { console.error('Aborting (no writes).'); process.exit(1) }
  }
  if (!lines.length) { console.error('Nothing to import.'); process.exit(1) }

  const totalAmount = round2(lines.reduce((s, l) => s + l.totalCost, 0))
  const sumQty = lines.reduce((s, l) => s + l.quantity, 0)
  console.log(`Planned: ONE receipt movement | ${lines.length} lines | Σqty ${sumQty} | → ${wh.name} | notes marker "${marker}"`)

  if (!execute) {
    console.log('\nDry-run complete — no writes. Re-run with --execute to create + confirm the movement.')
    return
  }

  const mvBefore = (await http('GET', org('/warehouse/movement?page=0&size=1'))).total ?? 0
  const probe = lines[0] // for the post-confirm stock delta check
  const before = await stockLevelFor(probe.productId, wh._id)

  const created = await http('POST', org('/warehouse/movement'), {
    type: 'receipt',
    date: dateArg,
    toWarehouseId: wh._id,
    totalAmount,
    notes: `Доставки — ${dateArg} (${marker})`,
    lines,
  })
  const mv = created.stockMovement || created.movement || created
  const mvId = mv._id || mv.id
  console.log(`\ncreated ${mv.movementNumber} (draft) — confirming ...`)
  await http('POST', org(`/warehouse/movement/${mvId}/confirm`))

  const after = await http('GET', org(`/warehouse/movement/${mvId}`))
  const done = after.stockMovement || after.movement || after
  const mvAfter = (await http('GET', org('/warehouse/movement?page=0&size=1'))).total ?? 0
  const lvAfter = await stockLevelFor(probe.productId, wh._id)
  const deltaOk = Math.abs(lvAfter.qty - before.qty - probe.quantity) < 0.001
  const costOk = Math.abs(lvAfter.avgCost - before.avgCost) < 0.0001

  console.log(`\n✓ ${done.movementNumber} | ${dateArg} | ${lines.length} lines | Σqty ${sumQty} | ${wh.name} | status ${done.status}`)
  console.log(`stock movements: ${mvBefore} → ${mvAfter} (+${mvAfter - mvBefore})`)
  console.log(`spot-check first line: qty ${before.qty} → ${lvAfter.qty} (${deltaOk ? 'OK' : 'MISMATCH!'}) | avgCost ${before.avgCost} → ${lvAfter.avgCost} (${costOk ? 'unchanged' : 'CHANGED!'})`)
  if (done.status !== 'completed' || !deltaOk || !costOk) process.exit(1)
}

await main()
