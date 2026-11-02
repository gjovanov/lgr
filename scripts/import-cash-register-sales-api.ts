/**
 * Daily cash-register sales import, direct from PlusMinus's own `/mobile` API — the sibling of
 * `scripts/import-cash-register-sales.ts` (which reads the `salesAnalysis_*.xlsx` GUI export). Same
 * target shape, same "one CSR per day" contract, same idempotency key (`salesAnalysis:<date>`, so a
 * day can arrive either way and is booked once) — only the SOURCE differs. Two kinds of folder, told
 * apart by their file names:
 *
 *   storeOperations_*.json   regal-sf: one file per till ticket (`header.doc === "СР"`), aggregated by
 *                            `services/biz/doc-import/map-plusminus-till.ts#aggregateTillDay`
 *   posReceipts_<YYYYMMDD>.json   regal-pz: the POS module's receipts, one file per day holding the raw
 *                            array `posDocuments … "receipts"` returned (written by `pull-api.ts
 *                            --families posReceipts`), aggregated by
 *                            `services/biz/doc-import/map-plusminus-pos.ts#aggregatePosDay`
 *
 * A folder may hold more than one day (the pullers pull a date RANGE) — every distinct day present
 * gets its own CSR, skipped individually if already imported. A folder holding both kinds is refused.
 *
 * Usage:
 *   bun run scripts/import-cash-register-sales-api.ts --dir <dir> [--date YYYY-MM-DD] [--no-stock]
 *
 * Options:
 *   --dir <dir>      (required) folder with storeOperations_*.json or posReceipts_*.json (WSL UNC ok)
 *   --date <ISO>     process only this day (default: every distinct day found)
 *   --org <slug>     org slug (default: regal-sf)
 *   --api <url>      API base (default: https://lgrai.app)
 *   --warehouse <c>  warehouse code for matched lines (default: org default)
 *   --no-stock       do NOT dispatch stock for these documents
 *   --dry-run        do everything except the POST: dedupe check, aggregation, product matching,
 *                    then print what WOULD be created (day, lines, qty, net/VAT/total)
 *   --no-prepared-by leave "prepared by" empty instead of the signed-in account's name (use it
 *                    when the account is a throwaway, so its name does not land in the document)
 *   --place <text>   Място на сделката (default: гр.София for regal-sf, гр.Пазарджик for regal-pz)
 *
 * Credentials (env): LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertTokenOrg } from './lib/token-org.js'
import { aggregateTillDay, type TillAggregate, type TillRow } from '../packages/services/src/biz/doc-import/map-plusminus-till.js'
import { aggregatePosDay, posReceiptDay, type PosReceipt } from '../packages/services/src/biz/doc-import/map-plusminus-pos.js'
import type { PlusMinusDocument } from '../packages/services/src/biz/doc-import/map-plusminus-invoice.js'

/** One day of till input, whichever folder kind it came from. */
interface DayInput { label: string; aggregate: () => TillAggregate }

const VAT_RATE = 20
const EXCHANGE_RATE_BGN = 1.95583

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
const dir = args.dir as string
const onlyDate = args.date as string | undefined
const orgSlug = (args.org as string) || 'regal-sf'
const api = ((args.api as string) || 'https://lgrai.app').replace(/\/$/, '')
const warehouseCode = args.warehouse as string | undefined
const noStock = !!args['no-stock']
const dryRun = !!args['dry-run']
const noPreparedBy = !!args['no-prepared-by']
const place = (args.place as string) || (orgSlug === 'regal-sf' ? 'гр.София' : orgSlug === 'regal-pz' ? 'гр.Пазарджик' : undefined)

if (!dir) { console.error('Required: --dir <dir with storeOperations_*.json or posReceipts_*.json>. See header for options.'); process.exit(2) }
if (!place) { console.error(`--place is required for org "${orgSlug}" (no built-in default for it).`); process.exit(2) }

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
  if (TOKEN) {
    const me = await http('GET', '/api/auth/me')
    assertTokenOrg(me, orgSlug) // a token from a tab switched to another org must not write there
    ORG_ID = me.user?.orgId || me.orgId
    USER_NAME = [me.user?.firstName, me.user?.lastName].filter(Boolean).join(' ')
  } else {
    const username = process.env.LGR_USERNAME
    const password = process.env.LGR_PASSWORD
    if (!username || !password) { console.error('Set LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.'); process.exit(2) }
    const res = await http('POST', '/api/auth/login', { orgSlug, username, password })
    TOKEN = res.token
    ORG_ID = res.org?.id || res.user?.orgId
    USER_NAME = [res.user?.firstName, res.user?.lastName].filter(Boolean).join(' ')
  }
  console.log(`auth: ${USER_NAME || '?'} → org ${orgSlug} (${ORG_ID})`)
}

const round2 = (v: number) => +v.toFixed(2)
const round4 = (v: number) => +v.toFixed(4)

/** Exact product match by name (bg-lowercased) — identical to import-cash-register-sales.ts. */
async function matchProduct(name: string): Promise<{ id: string; unit?: string } | null> {
  const norm = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('bg')
  const lower = norm(name)
  for (let page = 0; page < 3; page++) {
    const d = await http('GET', org(`/warehouse/product?search=${encodeURIComponent(name)}&page=${page}&size=50`))
    const items = d.products || []
    const hit = items.find((p: any) => p.isActive !== false && norm(p.name) === lower)
    if (hit) return { id: hit._id || hit.id, unit: hit.unit }
    if (!items.length || (page + 1) * 50 >= (d.total ?? 0)) break
  }
  return null
}

async function importDay(date: string, day: DayInput, wh: any) {
  console.log(`\n── ${date}: ${day.label} ──`)

  const reference = `salesAnalysis:${date}`
  const existing = await http('GET', org(`/invoices?type=cash_sale&search=${encodeURIComponent(reference)}&page=0&size=5`))
  const dup = (existing.invoices || []).find((i: any) => i.reference === reference)
  if (dup) { console.log(`Already imported: ${dup.invoiceNumber} (${dup.status}) — nothing to do.`); return }

  let agg: TillAggregate
  try {
    agg = day.aggregate()
  } catch (e: any) {
    console.error(`  ✗ ${e.message}`)
    return
  }
  console.log(`Items: ${agg.rows.length} | net total: ${agg.totalValueNet} EUR | gross paid: ${agg.totalValueGross} EUR`)
  if (!agg.rows.length) { console.log('No sale lines (nothing sold, or everything netted to zero) — nothing to book.'); return }

  let matched = 0
  const lines: any[] = []
  for (const r of agg.rows as TillRow[]) {
    const m = await matchProduct(r.name)
    if (m) matched++
    const unitPrice = r.qty !== 0 ? round4(r.value / r.qty) : r.value
    const taxAmount = round2(r.value * VAT_RATE / 100)
    lines.push({
      productId: m?.id, description: r.name, quantity: r.qty,
      unit: m?.unit || 'pcs', unitPrice, discount: 0,
      // lineTotal is GROSS, as on every document the UI creates (FR-21.5) and as import-cash-register-sales.ts
      // writes it. This script used to send the NET value here, so regal-sf's API-imported days differ from its
      // xlsx-imported ones (and from every regal-pz day).
      taxRate: VAT_RATE, taxAmount, lineTotal: round2(r.value + taxAmount),
      warehouseId: m ? wh._id : undefined,
    })
  }
  const unmatched = agg.rows.length - matched
  console.log(`Matched products: ${matched}/${agg.rows.length}${unmatched ? ` | free-text: ${unmatched}` : ''}`)
  if (unmatched) for (const l of lines.filter(l => !l.productId).slice(0, 10)) console.log(`  ✗ unmatched: ${l.description}`)

  // The net, from the aggregate's own values: the lines carry gross.
  const subtotal = round2(agg.rows.reduce((s, r) => s + r.value, 0))
  const taxTotal = round2(subtotal * VAT_RATE / 100)
  const total = round2(subtotal + taxTotal)

  if (dryRun) {
    const qty = +lines.reduce((s, l) => s + l.quantity, 0).toFixed(3)
    console.log(`DRY RUN, nothing posted | ${date} | ${lines.length} lines | qty ${qty} | net ${subtotal} + VAT ${taxTotal} = ${total} EUR | stock: ${noStock ? 'skip' : 'dispatch'}`)
    return
  }

  const mvBefore = (await http('GET', org('/warehouse/movement?page=0&size=1'))).total ?? 0
  const res = await http('POST', org('/invoices'), {
    type: 'cash_sale', direction: 'outgoing',
    issueDate: date, currency: 'EUR', exchangeRate: EXCHANGE_RATE_BGN,
    reference,
    lines, subtotal, discountTotal: 0, taxTotal, total,
    totalBase: round2(total * EXCHANGE_RATE_BGN),
    paymentMethod: 'cash',
    preparedBy: noPreparedBy ? undefined : (USER_NAME || undefined),
    placeOfTransaction: place,
    notes: `Дневни продажби каса — ${date}`,
    tags: ['cash-register-import'],
    skipStockMovement: noStock,
    allowNegativeStock: true,
  })
  const inv = res.invoice
  const mvAfter = (await http('GET', org('/warehouse/movement?page=0&size=1'))).total ?? 0
  console.log(`✓ ${inv.invoiceNumber} | ${date} | ${lines.length} lines | net ${subtotal} + VAT ${taxTotal} = ${total} EUR`)
  console.log(`stock movements: ${mvBefore} → ${mvAfter} (${noStock ? 'skipped by design' : '+' + (mvAfter - mvBefore)})`)
}

async function main() {
  console.log(`Import cash-register sales (direct API) | dir: ${dir}`)
  console.log(`Org: ${orgSlug} | API: ${api} | stock: ${noStock ? 'SKIP' : 'dispatch'}${dryRun ? ' | DRY RUN' : ''}`)

  const names = readdirSync(dir)
  const opFiles = names.filter(f => /^storeOperations_\d+\.json$/i.test(f))
  const posFiles = names.filter(f => /^posReceipts_\d{8}\.json$/i.test(f))
  if (opFiles.length && posFiles.length) { console.error('Both storeOperations_*.json and posReceipts_*.json in dir: keep one kind per folder.'); process.exit(1) }
  if (!opFiles.length && !posFiles.length) { console.error('No storeOperations_*.json or posReceipts_*.json in dir.'); process.exit(1) }

  const days = new Map<string, DayInput>()
  if (posFiles.length) {
    // regal-pz: each file is the raw array posDocuments returned for a range, bucketed by close day; trust the receipts, not the file name
    const byDay = new Map<string, PosReceipt[]>()
    for (const f of posFiles) {
      const receipts = JSON.parse(readFileSync(join(dir, f), 'utf8')) as PosReceipt[]
      if (!Array.isArray(receipts)) { console.error(`${f}: expected an array of receipts.`); process.exit(1) }
      for (const r of receipts) {
        const iso = posReceiptDay(r)
        if (!iso) { console.error(`${f}: receipt ${r.header?.docNumber ?? '?'} has no closedOn, so it is not a finished sale. Refusing the folder.`); process.exit(1) }
        const arr = byDay.get(iso) ?? []
        arr.push(r)
        byDay.set(iso, arr)
      }
    }
    for (const [iso, rs] of byDay) {
      if (onlyDate && iso !== onlyDate) continue
      days.set(iso, { label: `${rs.length} POS entr${rs.length === 1 ? 'y' : 'ies'} (receipts and invoice payments)`, aggregate: () => aggregatePosDay(rs, iso) })
    }
  } else {
    // regal-sf: one storeOperations document per till ticket
    const byDate = new Map<string, PlusMinusDocument[]>()
    let notSale = 0
    for (const f of opFiles) {
      const doc: PlusMinusDocument = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      const date = doc.header?.docDate
      if (!date) { console.log(`  ⚠ ${f}: no header.docDate — skipped`); continue }
      if (doc.header?.doc && doc.header.doc !== 'СР') { notSale++; continue } // e.g. a "СТ" delivery pulled into the same folder
      const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
      if (onlyDate && iso !== onlyDate) continue
      const arr = byDate.get(iso) ?? []
      arr.push(doc)
      byDate.set(iso, arr)
    }
    if (notSale) console.log(`  (${notSale} non-sale document(s) in this folder, not a till sale — skipped)`)
    for (const [iso, docs] of byDate) days.set(iso, { label: `${docs.length} till transaction(s)`, aggregate: () => aggregateTillDay(docs) })
  }
  if (!days.size) { console.error(onlyDate ? `No till records for ${onlyDate}.` : 'No till records found.'); process.exit(1) }

  await login()

  const whs = (await http('GET', org('/warehouse/warehouse'))).warehouses || []
  const wh = warehouseCode ? whs.find((w: any) => w.code === warehouseCode) : (whs.find((w: any) => w.isDefault) || whs[0])
  if (!wh) { console.error('Warehouse not found.'); process.exit(1) }

  for (const [date, day] of [...days.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    await importDay(date, day, wh)
  }
}

await main()
