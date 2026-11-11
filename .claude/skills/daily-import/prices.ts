// prices.ts — read-only: an org's prices before and after a booking run, and what changed between the two.
//
//   bun prices.ts snap <org> <out.json>                       every product's prices, tiers, quantity and average cost
//   bun prices.ts diff <pre.json> <post.json> [--list <tsv>] <receipt run log> [<log> ...]
//
// `diff` holds a run to one rule: every price that changed must be named by a `~ REPRICE <sku>` line of the run's own
// logs, and every new product by a `+ created <sku>` line. It prints:
//   UNEXPLAINED <sku> …        a price changed that no log names: something else wrote it, find out what
//   NEW not in logs <sku> …    a product appeared that the run did not create
//   PROTECTED changed <sku> …  a purchase price or a cost tier changed: an import never writes those for a product that
//                              existed (the delivery price of a receipt is its unit cost, not the product's)
//   META changed <sku> …       name, active flag, category or tags changed (the tags step runs after this by design)
// and ends on one line the daily import reads: `price-diff: changed N | unexplained N | protected N | created N | meta N`.
// `--list` writes the per-product changes (sku, name, each field old→new) for the report.
//
// Credentials for `snap` (env): LGR_USERNAME + LGR_PASSWORD. `--api URL` overrides https://lgrai.app.
import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const mode = argv.shift()
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return undefined
  const [, value] = argv.splice(i, 2)
  return value
}
const api = (flag('api') || 'https://lgrai.app').replace(/\/$/, '')

/** The tiers an import must leave alone on a product that already existed. */
const PROTECTED = ['purchase', 'Доставна', 'Цена на едро', 'Цена 0 ']

async function snap(orgSlug: string, out: string) {
  const r = await fetch(`${api}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgSlug, username: process.env.LGR_USERNAME, password: process.env.LGR_PASSWORD }),
  })
  const login: any = await r.json().catch(() => ({}))
  if (!r.ok || !login.token) throw new Error(`login → ${r.status}`)
  const orgId = login.org?.id || login.user?.orgId
  const get = async (p: string) => {
    const x = await fetch(`${api}/api/org/${orgId}${p}`, { headers: { authorization: `Bearer ${login.token}` } })
    if (!x.ok) throw new Error(`${p.split('?')[0]} → ${x.status}`)
    return x.json() as any
  }
  const every = async (p: string, key: string) => {
    const rows: any[] = []
    const seen = new Set<string>()
    for (let page = 0; page < 2000; page++) {
      const d = await get(`${p}${p.includes('?') ? '&' : '?'}page=${page}&size=1000&sortBy=_id&sortOrder=asc`)
      const items = d[key] || []
      let added = 0
      for (const x of items) if (!seen.has(String(x._id))) { seen.add(String(x._id)); rows.push(x); added++ }
      if (!items.length || !added || (d.total != null && rows.length >= d.total)) break
    }
    return rows
  }
  const whs = (await get('/warehouse/warehouse?page=0&size=100')).warehouses || []
  const wh = whs.find((w: any) => w.isDefault) || whs[0]
  const products = await every('/warehouse/product', 'products')
  const levels = await every(`/warehouse/stock-level?warehouseId=${wh._id}`, 'stockLevels')
  const stock = new Map(levels.map((l: any) => [String(l.productId?._id || l.productId), { qty: Number(l.quantity) || 0, avgCost: l.avgCost }]))
  const res: Record<string, any> = {}
  for (const p of products) {
    res[p.sku] = {
      id: p._id, name: p.name, isActive: p.isActive, purchasePrice: p.purchasePrice, sellingPrice: p.sellingPrice,
      tiers: Object.fromEntries((p.priceTiers || []).map((t: any) => [t.name, t.finalPrice])),
      category: p.category, tags: p.tags, ...(stock.get(String(p._id)) ?? { qty: 0 }),
    }
  }
  // A session that is shown less than everything would make this snapshot, and the diff after it, lie.
  const blind = products.length > 0 && !products.some((p: any) => p.purchasePrice !== undefined)
  if (blind) throw new Error('no product carries a purchase price: this session does not see cost figures, so its snapshot proves nothing')
  writeFileSync(out, JSON.stringify(res))
  console.log(orgSlug, 'products', products.length, 'levels', levels.length)
}

function diff(pre: string, post: string, logs: string[], list: string | undefined) {
  const A = JSON.parse(readFileSync(pre, 'utf8'))
  const B = JSON.parse(readFileSync(post, 'utf8'))
  const named = new Set<string>()
  const created = new Set<string>()
  for (const f of logs) for (const l of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const r = /~ REPRICE (\S+)/.exec(l); if (r) named.add(r[1])
    const c = /\+ created (\S+)/.exec(l); if (c) created.add(c[1])
  }
  let changed = 0, unexplained = 0, protectedChanged = 0, meta = 0
  const fields: Record<string, number> = {}
  const rows: string[] = []
  for (const sku of Object.keys(B).sort()) {
    const a = A[sku], b = B[sku]
    if (!a) { if (!created.has(sku)) { unexplained++; console.log('  NEW not in logs', sku, b.name) } continue }
    const f: string[] = []
    if (a.sellingPrice !== b.sellingPrice) f.push(`selling ${a.sellingPrice}→${b.sellingPrice}`)
    if (a.purchasePrice !== b.purchasePrice) f.push(`purchase ${a.purchasePrice}→${b.purchasePrice}`)
    for (const t of new Set([...Object.keys(a.tiers ?? {}), ...Object.keys(b.tiers ?? {})])) if (a.tiers?.[t] !== b.tiers?.[t]) f.push(`${t} ${a.tiers?.[t]}→${b.tiers?.[t]}`)
    const what = ['name', 'isActive', 'category'].filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])).concat(JSON.stringify(a.tags) !== JSON.stringify(b.tags) ? ['tags'] : [])
    if (what.length) { meta++; console.log('  META changed', sku, what.join(','), a.name) }
    if (!f.length) continue
    changed++
    rows.push(`${sku}\t${b.name}\t${f.join('; ')}`)
    for (const x of f) { const k = x.split(' ')[0] === 'Цена' ? x.split(' ').slice(0, 2).join(' ') : x.split(' ')[0]; fields[k] = (fields[k] ?? 0) + 1 }
    if (!named.has(sku)) { unexplained++; console.log('  UNEXPLAINED', sku, a.name, f.join('; ')) }
    if (f.some(x => PROTECTED.some(p => x.startsWith(p)))) { protectedChanged++; console.log('  PROTECTED changed', sku, a.name, f.join('; ')) }
  }
  if (list) writeFileSync(list, rows.join('\n') + (rows.length ? '\n' : ''))
  console.log(`fields: ${Object.entries(fields).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'} | named by the logs: ${named.size} repriced, ${created.size} created`)
  console.log(`price-diff: changed ${changed} | unexplained ${unexplained} | protected ${protectedChanged} | created ${Object.keys(B).filter(s => !A[s]).length} | meta ${meta}`)
}

if (mode === 'snap' && argv.length === 2) await snap(argv[0], argv[1])
else if (mode === 'diff' && argv.length >= 2) { const list = flag('list'); diff(argv[0], argv[1], argv.slice(2), list) }
else { console.error('usage: prices.ts snap <org> <out.json> | prices.ts diff <pre.json> <post.json> [--list <tsv>] <receipt run log> ...'); process.exit(2) }
