/**
 * Daily cash-register sales import from the legacy (PlusMinus) ERP.
 *
 * Takes a day folder containing a `salesAnalysis_*.xlsx` export (АРТИКУЛИ report,
 * ПЕРИОД: ДНЕС, EUR, net values) and creates ONE cash-sale document (`CSR-...`)
 * for that day with a line per sold product:
 *
 *   - product lines exact-matched by name (unmatched stay free-text)
 *   - net line value from the export; 20% VAT added on top (values are net —
 *     they equal the products' net selling prices)
 *   - issued via POST /invoices type=cash_sale → status "paid", number from the
 *     CASH_SALE counter shown with the org display prefix (set to CSR)
 *
 * Stock: dispatches by default (like a normal cash sale, negatives allowed).
 * Pass --no-stock when the inventory baseline (availability snapshot) already
 * reflects the day's sales.
 *
 * Repeatable: the document carries `reference = salesAnalysis:<date>` — if one
 * already exists for the day, the run is a no-op.
 *
 * Usage:
 *   bun run scripts/import-cash-register-sales.ts --folder <dir> [--no-stock]
 *
 * Options:
 *   --folder <dir>   (required) day folder with salesAnalysis_*.xlsx (WSL UNC ok)
 *   --date <ISO>     document date (default: the folder's basename, e.g. 2026-07-23)
 *   --org <slug>     org slug (default: regal-pz)
 *   --api <url>      API base (default: https://lgrai.app)
 *   --warehouse <c>  warehouse code for matched lines (default: org default)
 *   --no-stock       do NOT dispatch stock for this document
 *   --place <text>   Място на сделката (default: гр.Пазарджик)
 *
 * Credentials (env): LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.
 */
import { readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import ExcelJS from 'exceljs'

const EXCHANGE_RATE_BGN = 1.95583
const VAT_RATE = 20
const GROUP_ROWS = new Set(['СТОКИ', 'УСЛУГИ', 'МАТЕРИАЛИ', 'ПАРТНЬОРИ', 'ПРОДУКЦИЯ', 'Общо'])
const HEADER_ROW = 9 // "Артикул | Количество | Стойност | % Ст-ст | % Кол-во"

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
const noStock = !!args['no-stock']
const place = (args.place as string) || 'гр.Пазарджик'

if (!folder) { console.error('Required: --folder <day dir with salesAnalysis_*.xlsx>'); process.exit(2) }
const dateArg = (args.date as string) || basename(folder.replace(/[\\/]+$/, ''))
if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) { console.error(`--date (or folder name) must be YYYY-MM-DD, got "${dateArg}"`); process.exit(2) }

let TOKEN = process.env.LGR_TOKEN || ''
let ORG_ID = ''
let USER_NAME = ''

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
    USER_NAME = [me.user?.firstName, me.user?.lastName].filter(Boolean).join(' ')
  } else {
    if (!username || !password) { console.error('Set LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.'); process.exit(2) }
    const res = await http('POST', '/api/auth/login', { orgSlug, username, password })
    TOKEN = res.token
    ORG_ID = res.org?.id || res.user?.orgId
    USER_NAME = [res.user?.firstName, res.user?.lastName].filter(Boolean).join(' ')
  }
  console.log(`auth: ${USER_NAME || '?'} → org ${orgSlug} (${ORG_ID})`)
}

const cellNum = (v: any): number => {
  if (v == null) return 0
  if (typeof v === 'object' && 'result' in v) return Number(v.result) || 0
  return Number(v) || 0
}
const round2 = (v: number) => +v.toFixed(2)
const round4 = (v: number) => +v.toFixed(4)

interface Row { name: string; qty: number; value: number }

async function parseSalesAnalysis(fp: string): Promise<{ rows: Row[]; totalQty: number; totalValue: number }> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  const sheet = wb.getWorksheet(1)!
  const header = String(sheet.getRow(HEADER_ROW).getCell(1).text ?? '').trim()
  if (header !== 'Артикул') { console.error(`Unexpected header at row ${HEADER_ROW}: "${header}" (expected "Артикул") — layout drift, aborting.`); process.exit(1) }
  const rows: Row[] = []
  let totalQty = 0, totalValue = 0
  sheet.eachRow((row, rn) => {
    if (rn <= HEADER_ROW) return
    const name = String(row.getCell(1).text ?? '').trim()
    if (!name) return
    const qty = cellNum(row.getCell(2).value)
    const value = cellNum(row.getCell(3).value)
    if (name === 'Общо') { totalQty = qty; totalValue = value; return }
    if (GROUP_ROWS.has(name)) return
    rows.push({ name, qty, value })
  })
  // Guard against layout drift / tree sub-groups double-counting: the item sum must
  // reproduce the "Общо" row.
  const sumV = rows.reduce((s, r) => s + r.value, 0)
  const sumQ = rows.reduce((s, r) => s + r.qty, 0)
  if (Math.abs(sumV - totalValue) > 0.05 || Math.abs(sumQ - totalQty) > 0.05) {
    console.error(`Cross-check FAILED: items sum ${round2(sumV)}/${round2(sumQ)} vs Общо ${totalValue}/${totalQty} — unknown group rows? Aborting.`)
    process.exit(1)
  }
  return { rows, totalQty, totalValue }
}

/** Exact product match by name (bg-lowercased), via the fuzzy search endpoint + client-side filter. */
async function matchProduct(name: string): Promise<{ id: string; unit?: string } | null> {
  // whitespace-collapse so padded exports match a single-spaced (e.g. deduped) LGR record
  const norm = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('bg')
  const lower = norm(name)
  // product list pagination: 0-based `page` + `size`
  for (let page = 0; page < 3; page++) {
    const d = await http('GET', org(`/warehouse/product?search=${encodeURIComponent(name)}&page=${page}&size=50`))
    const items = d.products || []
    const hit = items.find((p: any) => p.isActive !== false && norm(p.name) === lower)
    if (hit) return { id: hit._id || hit.id, unit: hit.unit }
    if (!items.length || (page + 1) * 50 >= (d.total ?? 0)) break
  }
  return null
}

async function main() {
  console.log(`Import cash-register sales | folder: ${folder} | date: ${dateArg}`)
  console.log(`Org: ${orgSlug} | API: ${api} | stock: ${noStock ? 'SKIP' : 'dispatch'}`)
  console.log()

  const files = readdirSync(folder).filter(f => /^salesAnalysis_.*\.xlsx$/i.test(f))
  if (!files.length) { console.error('No salesAnalysis_*.xlsx in folder.'); process.exit(1) }
  if (files.length > 1) console.log(`  ⚠ ${files.length} salesAnalysis files — using ${files[0]}`)
  const { rows, totalValue } = await parseSalesAnalysis(join(folder, files[0]))
  console.log(`Items: ${rows.length} | net total: ${round2(totalValue)} EUR`)

  await login()

  // dedup — one CSR per day
  const reference = `salesAnalysis:${dateArg}`
  const existing = await http('GET', org(`/invoices?type=cash_sale&search=${encodeURIComponent(reference)}&page=0&size=5`))
  const dup = (existing.invoices || []).find((i: any) => i.reference === reference)
  if (dup) { console.log(`Already imported for ${dateArg}: ${dup.invoiceNumber} (${dup.status}) — nothing to do.`); return }

  // warehouse (for matched lines / stock)
  const whs = (await http('GET', org('/warehouse/warehouse'))).warehouses || []
  const wh = warehouseCode ? whs.find((w: any) => w.code === warehouseCode) : (whs.find((w: any) => w.isDefault) || whs[0])
  if (!wh) { console.error('Warehouse not found.'); process.exit(1) }

  // ensure the cash-sale display prefix is CSR (org-global, future allocations)
  try {
    const seqs = (await http('GET', org('/invoicing/sequences'))).sequences || []
    const cs = seqs.find((s: any) => s.prefix === 'CASH_SALE')
    if (cs && cs.displayPrefix !== 'CSR') {
      await http('PUT', org('/invoicing/sequences/CASH_SALE'), { displayPrefix: 'CSR' })
      console.log(`CASH_SALE display prefix: ${cs.displayPrefix} → CSR`)
    }
  } catch (e: any) { console.log(`  ⚠ could not verify/set CSR prefix: ${e.message}`) }

  // build lines (exact product match; unmatched stay free-text)
  let matched = 0
  const lines: any[] = []
  for (const r of rows) {
    const m = await matchProduct(r.name)
    if (m) matched++
    const unitPrice = r.qty !== 0 ? round4(r.value / r.qty) : r.value
    lines.push({
      productId: m?.id, description: r.name, quantity: r.qty,
      unit: m?.unit || 'pcs', unitPrice, discount: 0,
      taxRate: VAT_RATE, taxAmount: round2(r.value * VAT_RATE / 100), lineTotal: round2(r.value),
      warehouseId: m ? wh._id : undefined,
    })
  }
  const unmatched = rows.length - matched
  console.log(`Matched products: ${matched}/${rows.length}${unmatched ? ` | free-text: ${unmatched}` : ''}`)
  if (unmatched) {
    for (const l of lines.filter(l => !l.productId).slice(0, 10)) console.log(`  ✗ unmatched: ${l.description}`)
  }

  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0))
  const taxTotal = round2(subtotal * VAT_RATE / 100)
  const total = round2(subtotal + taxTotal)

  const mvBefore = (await http('GET', org('/warehouse/movement?page=0&size=1'))).total ?? 0
  const res = await http('POST', org('/invoices'), {
    type: 'cash_sale', direction: 'outgoing',
    issueDate: dateArg, currency: 'EUR', exchangeRate: EXCHANGE_RATE_BGN,
    reference,
    lines, subtotal, discountTotal: 0, taxTotal, total,
    totalBase: round2(total * EXCHANGE_RATE_BGN),
    paymentMethod: 'cash',
    preparedBy: USER_NAME || undefined,
    placeOfTransaction: place,
    notes: `Дневни продажби каса — ${dateArg}`,
    tags: ['cash-register-import'],
    skipStockMovement: noStock,
    allowNegativeStock: true,
  })
  const inv = res.invoice
  const mvAfter = (await http('GET', org('/warehouse/movement?page=0&size=1'))).total ?? 0
  console.log(`\n✓ ${inv.invoiceNumber} | ${dateArg} | ${lines.length} lines | net ${subtotal} + VAT ${taxTotal} = ${total} EUR (${round2(total * EXCHANGE_RATE_BGN)} BGN)`)
  console.log(`stock movements: ${mvBefore} → ${mvAfter} (${noStock ? 'skipped by design' : '+' + (mvAfter - mvBefore)})`)
}

await main()
