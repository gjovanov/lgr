/**
 * Create products for compare-products "MISSING from LGR" rows as price-0, zero-stock
 * catalog entries — the standing follow-up after a daily reconciliation dump.
 *
 * Why: a snapshot row with qty 0 that has no LGR product is pure nomenclature (the item
 * exists in PlusMinus but holds no stock). Creating it with zero prices/stock clears the
 * MISSING noise from every subsequent compare; when a later receipt (stokrazp) delivers
 * the product, receive-new-products matches it and fills real cost/tier prices.
 * Rows with qty > 0 are created too (zero stock) but WARNED about loudly — their quantity
 * must arrive via a real document (receipt backfill), never be invented here.
 *
 * Usage:
 *   bun run scripts/create-missing-products.ts --csv <compare-*.csv> [--execute]
 *
 * Options:
 *   --csv <path>   (required) a compare-products CSV dump (reads the missing_in_lgr rows)
 *   --org <slug>   org slug (default: regal-pz)
 *   --api <url>    API base (default: https://lgrai.app)
 *   --execute      create the products (default: dry-run)
 *
 * Credentials (env): LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.
 * SKU: POST /warehouse/product requires an explicit sku — allocated as max(REGALPZ-NNNNN)+1.
 */
import { readFileSync } from 'node:fs'

function parseArgs(argv: string[]) {
  const o: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; if (!a.startsWith('--')) continue
    const key = a.slice(2), next = argv[i + 1]
    if (next && !next.startsWith('--')) { o[key] = next; i++ } else { o[key] = true }
  }
  return o
}
const args = parseArgs(process.argv.slice(2))
const csvPath = args.csv as string
const orgSlug = (args.org as string) || 'regal-pz'
const api = ((args.api as string) || 'https://lgrai.app').replace(/\/$/, '')
const execute = !!args.execute
if (!csvPath) { console.error('Required: --csv <compare-*.csv>'); process.exit(2) }

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
const org = (p: string) => `/api/org/${ORG_ID}${p}`
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('bg')
// kg-sold classes in this catalog (electrodes, wire, rod, sheet, nylon, explicit КГ)
const kgHint = (n: string) => /\bКГ\b|ТЕЛ\b|ПРЪТ|ЛИСТ|НАЙЛОН|ЕЛЕКТР/i.test(n)

async function main() {
  // missing_in_lgr,,"NAME",quantity,<snapQty>,,
  const rows: { name: string; qty: number }[] = []
  for (const ln of readFileSync(csvPath, 'utf8').split('\n')) {
    const m = ln.match(/^missing_in_lgr,,"(.+?)",quantity,(-?[\d.]*),/)
    if (m) rows.push({ name: m[1], qty: Number(m[2]) || 0 })
  }
  console.log(`Create MISSING products | ${rows.length} rows from ${csvPath} | ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)
  if (!rows.length) { console.log('Nothing to do.'); return }

  const login = await http('POST', '/api/auth/login', { orgSlug, username: process.env.LGR_USERNAME, password: process.env.LGR_PASSWORD })
  TOKEN = login.token; ORG_ID = login.org?.id || login.user?.orgId

  const cats = (await http('GET', org(`/warehouse/product-category?search=${encodeURIComponent('Общи')}&page=0&size=10`))).productCategories || []
  const cat = cats.find((c: any) => String(c.name).trim() === 'Общи')

  // next SKU = max(REGALPZ-NNNNN)+1 — probe the highest by sorting a broad page on sku desc,
  // with a robust fallback over the last created products
  let maxN = 0
  const probe = await http('GET', org('/warehouse/product?page=0&size=50&sortBy=createdAt&sortOrder=desc'))
  for (const p of probe.products || []) { const m = String(p.sku || '').match(/^REGALPZ-(\d{5,})$/); if (m) maxN = Math.max(maxN, Number(m[1])) }
  if (!maxN) { console.error('Could not derive max SKU from latest products — aborting.'); process.exit(1) }

  let created = 0, skipped = 0
  for (const r of rows) {
    // skip if it exists now (active, exact collapsed name)
    const found = (await http('GET', org(`/warehouse/product?search=${encodeURIComponent(r.name)}&page=0&size=50`))).products || []
    if (found.find((p: any) => p.isActive !== false && collapse(String(p.name ?? '')) === collapse(r.name))) {
      console.log(`= exists "${r.name}" — skip`); skipped++; continue
    }
    const sku = `REGALPZ-${String(++maxN).padStart(5, '0')}`
    const unit = kgHint(r.name) ? 'kg' : 'pcs'
    const warn = r.qty > 0 ? `  ⚠ snapshot qty ${r.qty} — product created with ZERO stock; the quantity must arrive via a real receipt` : ''
    console.log(`${execute ? '+' : '·'} ${sku} [${unit}] "${r.name}" price 0, stock 0${warn}`)
    if (!execute) continue
    await http('POST', org('/warehouse/product'), {
      sku, name: r.name, category: 'Общи', ...(cat ? { categoryId: cat._id || cat.id } : {}),
      type: 'goods', unit, purchasePrice: 0, sellingPrice: 0, priceTiers: [],
    })
    created++
  }
  console.log(`\n${execute ? 'Created' : 'Would create'}: ${execute ? created : rows.length - skipped} | skipped(existing): ${skipped}`)
  if (!execute) console.log('Dry-run — re-run with --execute.')
}
await main()
