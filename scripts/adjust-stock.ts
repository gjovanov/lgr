/**
 * Book stock WRITE-OFFS from a PlusMinus "ИСКАНЕ За отпускане на материали"
 * (sklisk_*.pdf) — materials issued internally (consumed / damaged / lost). Each
 * искане becomes ONE completed `adjustment` movement that REDUCES the warehouse
 * quantity by each line's `Кол` (there is no destination — the stock leaves).
 *
 * Mechanics: `type:'adjustment'` movement with `fromWarehouseId` set and NO
 * `toWarehouseId` → `confirmMovement` reduces the source and adds nowhere.
 * `adjustStock` leaves avgCost untouched on any reduction (the weighted-average
 * recompute only runs for positive quantity), so a write-off never disturbs cost;
 * line `unitCost` is set to the product's current avgCost for movement valuation.
 * Negative resulting stock is allowed (migration mode).
 *
 * Input is an adjustments JSON built by reading the sklisk PDFs (their table text
 * is column-ordered + splits multi-digit prices across lines, so it can't be parsed
 * deterministically — Claude reads each PDF and transcribes name/qty/value, same
 * pattern as transfer-stock / receive-new-products):
 *
 *   {
 *     "adjustments": [
 *       { "number": "0000000130", "date": "2026-07-31", "reason": "изписване на материали",
 *         "total": 44.92,
 *         "lines": [ { "name": "ТИКСО - ПРОЗР.", "qty": 12, "value": 12.00 }, ... ] }
 *     ]
 *   }
 *
 * Per doc, Σ line.value is cross-checked against `total` (±0.5) when present.
 * Idempotent: each movement's notes carry `sklisk:<number>`.
 *
 * Usage:
 *   export LGR_USERNAME=... LGR_PASSWORD=...     # or LGR_TOKEN
 *   bun run scripts/adjust-stock.ts --items <adjustments.json>              # dry-run
 *   bun run scripts/adjust-stock.ts --items <adjustments.json> --execute
 *
 * Options:
 *   --items <path>    (required) adjustments JSON as above
 *   --org <slug>      org slug (default: regal-pz)
 *   --api <url>       API base (default: https://lgrai.app)
 *   --warehouse <c>   warehouse code (default: org default = Пазарджик)
 *   --max-date <ISO>  only process docs dated <= this (inclusive)
 *   --skip-unmatched  proceed without lines whose product has no catalog match
 *                     (default: unmatched aborts --execute — a skipped write-off
 *                     line leaves LGR stock too high)
 *   --execute         create + confirm the movements (default: dry-run)
 */
import { readFileSync } from 'node:fs'
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
const itemsPath = args.items as string
const orgSlug = (args.org as string) || 'regal-pz'
const api = ((args.api as string) || 'https://lgrai.app').replace(/\/$/, '')
const warehouseCode = args.warehouse as string | undefined
const maxDate = args['max-date'] as string | undefined
const skipUnmatched = !!args['skip-unmatched']
const execute = !!args.execute

if (!itemsPath) { console.error('Required: --items <adjustments.json>'); process.exit(2) }

interface LineIn { name: string; qty: number; value?: number }
interface Adjustment { number: string; date: string; reason?: string; total?: number; lines: LineIn[] }
interface Input { adjustments: Adjustment[] }

const input: Input = JSON.parse(readFileSync(itemsPath, 'utf8'))
if (!Array.isArray(input.adjustments) || !input.adjustments.length) { console.error('adjustments JSON has no adjustments.'); process.exit(2) }
for (const [i, t] of input.adjustments.entries()) {
  if (!t.number) { console.error(`adjustment[${i}]: missing number`); process.exit(2) }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date || '')) { console.error(`adjustment[${i}] ${t.number}: date must be YYYY-MM-DD, got "${t.date}"`); process.exit(2) }
  if (!Array.isArray(t.lines) || !t.lines.length) { console.error(`adjustment[${i}] ${t.number}: no lines`); process.exit(2) }
  for (const [j, l] of t.lines.entries()) {
    if (!l.name?.trim()) { console.error(`adjustment ${t.number} line[${j}]: missing name`); process.exit(2) }
    if (!(l.qty > 0)) { console.error(`adjustment ${t.number} line[${j}] "${l.name}": qty must be > 0 (a write-off reduces by Кол)`); process.exit(2) }
  }
}

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

const round2 = (v: number) => +v.toFixed(2)
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('bg')
// Cyrillic→Latin homoglyph fold (see transfer-stock.ts) — unambiguous fallback for spec letters
// stored as Cyrillic look-alikes (DIN 7504 К/Р/…) vs Latin, so a wrong-alphabet name still matches.
const CYR2LAT: Record<string, string> = { 'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'х': 'x', 'у': 'y', 'ѕ': 's', 'і': 'i', 'ј': 'j', 'ԁ': 'd', 'ԛ': 'q', 'ѡ': 'w' }
const fold = (s: string) => collapse(s).split('').map(c => CYR2LAT[c] ?? c).join('')

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

/** Exact bg-lowercased name, then whitespace-tolerant retries (catalog padding). */
async function matchProduct(name: string): Promise<any | null> {
  const lower = name.trim().toLocaleLowerCase('bg')
  const coll = collapse(name)
  const fld = fold(name)
  const byExact = (p: any) => String(p.name ?? '').trim().toLocaleLowerCase('bg') === lower
  const byCollapse = (p: any) => collapse(String(p.name ?? '')) === coll
  const byFold = (p: any) => p.isActive !== false && fold(String(p.name ?? '')) === fld
  const foldMatch = (cands: any[]): any | null => {
    if (cands.find(byExact) || cands.find(byCollapse)) return null
    const uniq = [...new Map(cands.filter(byFold).map(p => [String(p._id || p.id), p])).values()]
    if (uniq.length === 1) { console.log(`   ↪ homoglyph-matched "${name.replace(/\s+/g, ' ')}" → ${uniq[0].sku} "${String(uniq[0].name).trim()}"`); return uniq[0] }
    if (uniq.length > 1) console.log(`   ⚠ ambiguous homoglyph for "${name.replace(/\s+/g, ' ')}" (${uniq.length}) — NOT auto-matched`)
    return null
  }
  const direct = await searchProducts(name, 3)
  const m1 = direct.find(byExact) || direct.find(byCollapse) || foldMatch(direct)
  if (m1) return m1
  if (coll !== lower) {
    const c2 = await searchProducts(coll, 3)
    const m2 = c2.find(byCollapse) || foldMatch(c2)
    if (m2) return m2
  }
  const token = coll.split(' ').filter(t => t.length >= 4).sort((a, b) => b.length - a.length)[0]
  if (token && token !== coll) {
    const c3 = await searchProducts(token, 5)
    const m3 = c3.find(byCollapse) || foldMatch(c3)
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
  let docs = input.adjustments.slice().sort((a, b) => a.date.localeCompare(b.date))
  if (maxDate) {
    const before = docs.length
    docs = docs.filter(t => t.date <= maxDate)
    console.log(`Filtered to date <= ${maxDate}: ${docs.length}/${before} docs`)
  }
  console.log(`Adjust stock (write-off / изписване) | ${docs.length} искания | Org: ${orgSlug} | API: ${api} | mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)
  if (!docs.length) { console.log('Nothing to do.'); return }

  await login()

  const whs = (await http('GET', org('/warehouse/warehouse?page=0&size=100'))).warehouses || []
  if (!whs.length) { console.error('Org has no warehouses.'); process.exit(1) }
  const wh = warehouseCode ? whs.find((w: any) => w.code === warehouseCode) : (whs.find((w: any) => w.isDefault) || whs[0])
  if (!wh) { console.error(`Warehouse code "${warehouseCode}" not found.`); process.exit(1) }
  console.log(`Warehouse: ${wh.name} (${wh.code})\n`)

  let totalUnmatched = 0, booked = 0, skipped = 0
  const mvBefore = (await http('GET', org('/warehouse/movement?page=0&size=1'))).total ?? 0

  for (const t of docs) {
    const marker = `sklisk:${t.number}`
    const dedup = await http('GET', org(`/warehouse/movement?type=adjustment&search=${encodeURIComponent(marker)}&page=0&size=50`))
    const dup = (dedup.stockMovements || []).find((m: any) => String(m.notes || '').includes(marker))
    if (dup) { console.log(`= ${t.number} (${t.date}) already booked: ${dup.movementNumber || dup.number} — skip`); skipped++; continue }

    if (t.total != null && t.lines.every(l => l.value != null)) {
      const sum = t.lines.reduce((s, l) => s + (l.value || 0), 0)
      if (Math.abs(sum - t.total) > 0.5) { console.error(`✗ ${t.number}: Σvalue ${round2(sum)} ≠ total ${t.total} — transcription error? Aborting this doc.`); continue }
    }

    const lines: any[] = []
    const unmatched: LineIn[] = []
    for (const l of t.lines) {
      const p = await matchProduct(l.name)
      if (!p) { unmatched.push(l); continue }
      const lv = await stockLevelFor(p._id || p.id, wh._id)
      lines.push({ productId: p._id || p.id, quantity: l.qty, unitCost: lv.avgCost, totalCost: round2(l.qty * lv.avgCost), _name: p.name, _before: lv.qty })
    }
    totalUnmatched += unmatched.length
    const label = `${t.number} (${t.date})${t.reason ? ` [${t.reason}]` : ''}: ${lines.length}/${t.lines.length} matched, Σqty -${lines.reduce((s, l) => s + l.quantity, 0)}`
    if (unmatched.length) {
      console.log(`⚠ ${label} | UNMATCHED ${unmatched.length} — these write-off lines will NOT be booked (stock stays too high):`)
      for (const u of unmatched) console.log(`     ✗ qty ${String(u.qty).padStart(7)}  "${u.name}"`)
      if (!skipUnmatched) { console.log(`   (pass --skip-unmatched to proceed with the matched subset)`); if (execute) { console.error('   Aborting this doc (no writes).'); continue } }
    } else {
      console.log(`  ${label}`)
    }
    if (!lines.length) continue

    if (!execute) { booked++; continue }

    const totalAmount = round2(lines.reduce((s, l) => s + l.totalCost, 0))
    const created = await http('POST', org('/warehouse/movement'), {
      type: 'adjustment',
      date: t.date,
      fromWarehouseId: wh._id,
      totalAmount,
      notes: `Изписване на материали${t.reason ? ` (${t.reason})` : ''} — ${t.date} (${marker})`,
      lines: lines.map(({ _name, _before, ...l }) => l),
    })
    const mv = created.stockMovement || created.movement || created
    const mvId = mv._id || mv.id
    await http('POST', org(`/warehouse/movement/${mvId}/confirm`))
    const after = await stockLevelFor(lines[0].productId, wh._id)
    const ok = Math.abs(after.qty - (lines[0]._before - lines[0].quantity)) < 0.001
    console.log(`  ✓ ${mv.movementNumber} confirmed | first "${String(lines[0]._name).replace(/\s+/g, ' ').slice(0, 34)}" ${lines[0]._before} → ${after.qty} ${ok ? 'OK' : 'MISMATCH!'}`)
    booked++
  }

  const mvAfter = (await http('GET', org('/warehouse/movement?page=0&size=1'))).total ?? 0
  console.log(`\n${execute ? 'Booked' : 'Would book'}: ${booked} | skipped(dup): ${skipped} | unmatched lines: ${totalUnmatched}`)
  if (execute) console.log(`stock movements: ${mvBefore} → ${mvAfter} (+${mvAfter - mvBefore})`)
  else console.log('Dry-run — no writes. Re-run with --execute.')
}

await main()
