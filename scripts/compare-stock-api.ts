/**
 * Quantity-only reconciliation of LGR's stock against a PlusMinus `/mobile`-API-pulled
 * `storeAvailability_*.json` snapshot (`pull-plusminus-api`'s output) — the JSON sibling of
 * `compare-products.ts` (which reads the GUI's `storeAvailability_*.xlsx` export). Read-only.
 *
 * Scoped to QUANTITY only, deliberately: the JSON's price fields (averagePrice/retailPrice/
 * wholesalePrice/price0) don't map cleanly onto `compare-products.ts`'s XLSX-column tier slots,
 * and guessing that mapping risked silently-wrong price comparisons. See memory `lgr-regal-sf-org`.
 *
 * ⚠ A naive exact-name match overstates both "missing in LGR" and "LGR not in snapshot" by a lot
 * (proven on regal-sf 2026-10-31: 46 + 41 "gaps" that were really 38 PERFECT quantity matches once
 * normalized — the snapshot key carries a "СТОКИ:"/"УСЛУГИ:"/kit-label PREFIX before a colon, and
 * literal inch/quote marks (`"`, `'`), that LGR's own `product.name` does not). This script runs a
 * SECOND pass over the two leftover tails with that normalization applied, and reports the
 * genuinely-unexplained remainder separately from the naming artifact. The PRIMARY match (the
 * number that drives `qtyDiffs`) stays exact-name-only on purpose — aggressive normalization is
 * only safe as a fallback for names that didn't match, never as the primary key (risk of folding
 * two real, different products together).
 *
 * Usage:
 *   bun run scripts/compare-stock-api.ts --org regal-sf --snapshot <path/to/storeAvailability_*.json>
 *   bun run scripts/compare-stock-api.ts --org regal-sf --dir <pull dir>   # auto-picks the newest storeAvailability_*.json in it
 *
 * Options:
 *   --org <slug>        org slug (default: regal-sf)
 *   --api <url>         API base (default: https://lgrai.app)
 *   --snapshot <path>   exact storeAvailability_*.json to compare against
 *   --dir <path>        folder to search for storeAvailability_*.json (picks the lexicographically-last filename = latest date)
 *   --warehouse <code>  warehouse code (default: org default)
 *
 * Credentials (env): LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { assertTokenOrg } from './lib/token-org.js'

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
const orgSlug = (args.org as string) || 'regal-sf'
const api = ((args.api as string) || 'https://lgrai.app').replace(/\/$/, '')
const warehouseCode = args.warehouse as string | undefined
let snapPath = args.snapshot as string | undefined
if (!snapPath) {
  const dir = args.dir as string | undefined
  if (!dir) { console.error('Required: --snapshot <file> or --dir <folder containing storeAvailability_*.json>'); process.exit(2) }
  const hits = readdirSync(dir).filter(f => /^storeAvailability_\d+\.json$/i.test(f)).sort()
  if (!hits.length) { console.error(`No storeAvailability_*.json in ${dir}`); process.exit(1) }
  snapPath = `${dir}/${hits[hits.length - 1]}`
}

let TOKEN = process.env.LGR_TOKEN || ''
let ORG_ID = ''
async function http(method: string, path: string, body?: any): Promise<any> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }
  let payload: any
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
  const res = await fetch(`${api}${path}`, { method, headers, body: payload })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`)
  return json
}
const org = (p: string) => `/api/org/${ORG_ID}${p}`

async function login() {
  if (TOKEN) {
    const me = await http('GET', '/api/auth/me')
    assertTokenOrg(me, orgSlug)
    ORG_ID = me.user?.orgId || me.orgId
  } else {
    const username = process.env.LGR_USERNAME
    const password = process.env.LGR_PASSWORD
    if (!username || !password) { console.error('Set LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.'); process.exit(2) }
    const res = await http('POST', '/api/auth/login', { orgSlug, username, password })
    TOKEN = res.token
    ORG_ID = res.org?.id || res.user?.orgId
  }
  console.log('auth: org', orgSlug, `(${ORG_ID})`)
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('bg')
/** Strip a "<label>:" prefix (СТОКИ:/УСЛУГИ:/a kit-component label) and inch/quote marks. Fallback-only. */
const aggr = (s: string) => collapse(s.replace(/^[^:]+:/, '').replace(/["']/g, ''))

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
    if (page > 2000) break
  }
  return out
}

interface SnapRow { name: string; qty: number }

async function main() {
  await login()

  const whs = (await http('GET', org('/warehouse/warehouse?page=0&size=100'))).warehouses || []
  const wh = warehouseCode ? whs.find((w: any) => w.code === warehouseCode) : (whs.find((w: any) => w.isDefault) || whs[0])
  if (!wh) { console.error('Warehouse not found.'); process.exit(1) }
  console.log('warehouse:', wh.name, wh.code, wh._id, '| snapshot:', snapPath)

  const snap = JSON.parse(readFileSync(snapPath!, 'utf8'))
  const whKey = Object.keys(snap)[0]
  const rows = snap[whKey]

  const byName = new Map<string, SnapRow>()
  let dups = 0, zeroQty = 0
  for (const k of Object.keys(rows)) {
    const name = k.replace(/^СТОКИ:/, '')
    const key = collapse(name)
    const qty = parseFloat((rows[k] as any).quantity ?? '0') || 0
    if (qty === 0) zeroQty++
    if (byName.has(key)) { byName.get(key)!.qty += qty; dups++ } else byName.set(key, { name, qty })
  }
  console.log(`snapshot: ${Object.keys(rows).length} rows, ${byName.size} unique names, ${dups} dup-name rows summed, ${zeroQty} zero-qty`)

  console.log('fetching LGR products + stock levels...')
  const idOf = (x: any) => String(x._id || x.id)
  const products = await fetchAll('/warehouse/product', 'products', idOf)
  const levels = await fetchAll(`/warehouse/stock-level?warehouseId=${wh._id}`, 'stockLevels', idOf)
  console.log(`LGR: ${products.length} products, ${levels.length} stock levels in ${wh.code}`)

  const qtyById = new Map<string, number>()
  for (const l of levels) qtyById.set(String(l.productId?._id || l.productId), Number(l.quantity) || 0)
  const prodByName = new Map<string, any>()
  for (const p of products) prodByName.set(collapse(String(p.name || '')), p)

  const missingInLgr: SnapRow[] = []
  const qtyDiffs: Array<{ name: string; sku: string; file: number; lgr: number; diff: number }> = []
  const matched = new Set<string>()
  for (const [key, row] of byName) {
    const p = prodByName.get(key)
    if (!p) { missingInLgr.push(row); continue }
    matched.add(key)
    const lgrQty = qtyById.get(String(p._id || p.id)) ?? 0
    if (Math.abs(row.qty - lgrQty) > 0.001) qtyDiffs.push({ name: row.name, sku: p.sku, file: row.qty, lgr: lgrQty, diff: Math.round((row.qty - lgrQty) * 10000) / 10000 })
  }
  const lgrOnly: Array<{ name: string; sku: string; qty: number }> = []
  for (const [k, p] of prodByName) if (!byName.has(k)) lgrOnly.push({ name: p.name, sku: p.sku, qty: qtyById.get(String(p._id || p.id)) ?? 0 })

  qtyDiffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))

  console.log(`\nMatched (exact name): ${matched.size} | missing in LGR: ${missingInLgr.length} | LGR not in snapshot: ${lgrOnly.length}`)
  console.log(`Qty diffs on matched products (tol 0.001): ${qtyDiffs.length}`)
  for (const d of qtyDiffs.slice(0, 60)) console.log(`  ${d.sku ?? '?'}  "${d.name}"  file=${d.file}  lgr=${d.lgr}  diff=${d.diff}`)

  // second pass: reconcile the two tails via the aggressive normalization (see header).
  const lgrOnlyByAggr = new Map<string, typeof lgrOnly[number]>()
  for (const r of lgrOnly) lgrOnlyByAggr.set(aggr(r.name), r)
  let reconciled = 0
  const reconciledDiffs: string[] = []
  const stillMissing: SnapRow[] = []
  const stillLgrOnlyKeys = new Set(lgrOnly.map(r => aggr(r.name)))
  for (const r of missingInLgr) {
    const hit = lgrOnlyByAggr.get(aggr(r.name))
    if (hit) {
      stillLgrOnlyKeys.delete(aggr(r.name))
      if (Math.abs(hit.qty - r.qty) <= 0.01) reconciled++
      else reconciledDiffs.push(`"${r.name}" snapshot=${r.qty} vs LGR "${hit.name}" (${hit.sku})=${hit.qty}`)
    } else stillMissing.push(r)
  }
  const stillLgrOnly = [...stillLgrOnlyKeys].map(k => lgrOnlyByAggr.get(k)!)

  console.log(`\nAfter prefix/quote-mark reconciliation (fallback pass, not a primary match):`)
  console.log(`  ${reconciled} confirmed same stock under a different-looking name (not a real gap)`)
  if (reconciledDiffs.length) { console.log(`  ${reconciledDiffs.length} same item, DIFFERENT qty — investigate:`); for (const s of reconciledDiffs) console.log('    ~', s) }
  console.log(`  truly missing in LGR: ${stillMissing.filter(r => r.qty !== 0).length} nonzero (+${stillMissing.filter(r => r.qty === 0).length} zero-qty)`)
  for (const r of stillMissing.filter(r => r.qty !== 0).sort((a, b) => Math.abs(b.qty) - Math.abs(a.qty)).slice(0, 20)) console.log(`    "${r.name}" qty=${r.qty}`)
  console.log(`  truly LGR-only: ${stillLgrOnly.filter(r => r.qty !== 0).length} nonzero (+${stillLgrOnly.filter(r => r.qty === 0).length} zero-qty)`)
  for (const r of stillLgrOnly.filter(r => r.qty !== 0).sort((a, b) => Math.abs(b.qty) - Math.abs(a.qty)).slice(0, 20)) console.log(`    ${r.sku} "${r.name}" qty=${r.qty}`)
}
main().catch(e => { console.error('FAILED', e); process.exit(1) })
