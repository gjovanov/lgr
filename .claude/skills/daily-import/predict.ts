// predict.ts — read-only: what LGR's stock will look like against the snapshot once a pulled day is booked.
//
// Nets PlusMinus's OWN stock operations of the documents in --dir per article (operations[].type 1 = in, 2 = out, on the
// org's store only; POS receipt lines out), subtracts that from today's (snapshot − LGR) gap, and says which products
// would still differ. It says 0 before the first write, or it names what is wrong before anything is booked.
//
// Blind spots, each covered by another check of the daily import (daily.ts):
//   - a line on БЕЗСКЛАД is dropped, because it moved no stock, so a receipt the importer WOULD book shows no residual
//     (the `scan` phase finds those);
//   - only items of the СТОКИ group are counted (compare's fallback pass covers the others);
//   - an article LGR has no product for is listed as NEW, whatever the reason: a new product, or a name that differs.
//
// Usage: bun predict.ts --org <slug> --dir <day api dir> --snapshot <storeAvailability json> --store "<PlusMinus store>" [--out <tsv>] [--api URL]
// Credentials (env): LGR_USERNAME + LGR_PASSWORD.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { collapseName, matchSnapshot, snapshotRows } from '../../../scripts/lib/snapshot-match.ts'

const a = process.argv.slice(2)
const arg = (k: string) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined }
const orgSlug = arg('org')!, dir = arg('dir')!, snapPath = arg('snapshot')!, store = arg('store')!, outPath = arg('out')
const api = (arg('api') || 'https://lgrai.app').replace(/\/$/, '')
if (!orgSlug || !dir || !snapPath || !store) {
  console.error('usage: predict.ts --org <slug> --dir <day api dir> --snapshot <file> --store "<PlusMinus store>" [--out <tsv>]')
  process.exit(2)
}

let TOKEN = '', ORG_ID = ''
async function http(method: string, path: string, body?: any) {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }
  if (body) headers['content-type'] = 'application/json'
  const r = await fetch(`${api}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}`)
  return j
}
const org = (p: string) => `/api/org/${ORG_ID}${p}`
async function fetchAll(path: string, key: string) {
  const out: any[] = [], seen = new Set<string>()
  const sep = path.includes('?') ? '&' : '?'
  for (let page = 0; page < 2000; page++) {
    const d = await http('GET', org(`${path}${sep}page=${page}&size=1000&sortBy=_id&sortOrder=asc`))
    const items = d[key] || []
    let added = 0
    for (const it of items) { const id = String(it._id); if (!seen.has(id)) { seen.add(id); out.push(it); added++ } }
    if (!items.length || !added || (d.total != null && out.length >= d.total)) break
  }
  return out
}

const login = await http('POST', '/api/auth/login', { orgSlug, username: process.env.LGR_USERNAME, password: process.env.LGR_PASSWORD })
TOKEN = login.token; ORG_ID = login.org?.id || login.user?.orgId
const whs = (await http('GET', org('/warehouse/warehouse?page=0&size=100'))).warehouses || []
const wh = whs.find((w: any) => w.isDefault) || whs[0]
const products = await fetchAll('/warehouse/product', 'products')
const levels = await fetchAll(`/warehouse/stock-level?warehouseId=${wh._id}`, 'stockLevels')
const qtyById = new Map<string, number>()
for (const l of levels) qtyById.set(String(l.productId?._id || l.productId), Number(l.quantity) || 0)
const qtyOf = (p: any) => qtyById.get(String(p._id)) ?? 0

const snap = JSON.parse(readFileSync(snapPath, 'utf8'))
const rows = snapshotRows(snap[Object.keys(snap)[0]])
const m = matchSnapshot(rows, products, qtyOf)

// PlusMinus's own stock effect of each document line, on the org's store only.
const effect = new Map<string, number>(), docsOf = new Map<string, string[]>()
const num = (v: any) => parseFloat(String(v ?? '0').replace(',', '.')) || 0
const add = (item: string, q: number, doc: string) => {
  const k = collapseName(String(item).replace(/^СТОКИ:/, ''))
  effect.set(k, (effect.get(k) ?? 0) + q)
  docsOf.set(k, [...(docsOf.get(k) ?? []), `${doc}:${+q.toFixed(4)}`])
}
let nDocs = 0
for (const f of readdirSync(dir).filter((f) => /^(invoicem|stokrazp|sklrazp|sklisk|storeOperations)_\d+\.json$/.test(f))) {
  const j = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')); nDocs++
  for (const l of j.lines ?? []) {
    if (!l.item || !String(l.item).startsWith('СТОКИ:')) continue
    for (const op of l.operations ?? []) {
      if (op.store !== store) continue
      const q = num(op.quantity)
      if (op.type === '1') add(l.item, q, f.replace('.json', ''))
      else if (op.type === '2') add(l.item, -q, f.replace('.json', ''))
    }
  }
}
for (const f of readdirSync(dir).filter((f) => /^posReceipts_\d+\.json$/.test(f))) {
  for (const r of JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))) {
    nDocs++
    for (const l of r.lines ?? []) if (l.item && String(l.item).startsWith('СТОКИ:') && (!l.store || l.store === store)) add(l.item, -num(l.quantity), `pos${r.header?.docNumber ?? ''}`)
  }
}

const out: string[] = ['sku\tname\tsnapshot\tlgr\tgap\teffect\tresidual\tdocs']
let before = 0, after = 0, touched = 0
const seenKeys = new Set<string>()
for (const l of m.lines) {
  const k = collapseName(String(l.product.name))
  seenKeys.add(k)
  const eff = effect.get(k) ?? 0
  const res = +(l.diff - eff).toFixed(4)
  if (Math.abs(l.diff) > 0.001) before++
  if (Math.abs(res) > 0.001) after++
  if (eff) touched++
  if (Math.abs(l.diff) > 0.001 || Math.abs(res) > 0.001 || eff) out.push([l.product.sku, l.product.name, l.snapshotQty, l.lgrQty, l.diff, +eff.toFixed(4), res, (docsOf.get(k) ?? []).join(' ')].join('\t'))
}
const unmatched = [...effect.keys()].filter((k) => !seenKeys.has(k))
const snapByKey = new Map(rows.map((r) => [collapseName(r.name), r.qty]))
for (const k of unmatched) out.push(['(no LGR product)', k, snapByKey.get(k) ?? '(not in snapshot)', 0, '', +(effect.get(k)!).toFixed(4), '', (docsOf.get(k) ?? []).join(' ')].join('\t'))
if (outPath) writeFileSync(outPath, out.join('\n') + '\n')
console.log(`${orgSlug}: ${nDocs} documents/receipts | products whose stock the documents move: ${touched} (+${unmatched.length} articles LGR has no product for)`)
console.log(`matched-product differences now: ${before} | predicted after booking: ${after}`)
const resid = out.slice(1).filter((r) => { const c = r.split('\t'); return c[6] !== '' && Math.abs(Number(c[6])) > 0.001 })
for (const r of resid.slice(0, 40)) console.log('  RESID', r.split('\t').slice(0, 8).join(' | ').slice(0, 300))
for (const k of unmatched) console.log(`  NEW   "${k}" effect=${+(effect.get(k)!).toFixed(4)} snapshot=${snapByKey.get(k) ?? 'absent'}`)
