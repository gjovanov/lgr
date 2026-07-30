/**
 * Book internal warehouse TRANSFERS-OUT from a PlusMinus "СКЛАДОВА РАЗПИСКА за
 * приемане/предаване на МЦ" (sklrazp_*.pdf) — goods handed from СКЛАД-1 (the LGR
 * warehouse) to another РЕГАЛ store that LGR does not track. Each разписка becomes
 * ONE completed movement that REDUCES the warehouse's stock (destination untracked
 * — "moved out into the unknown", single-WH tenant).
 *
 * Mechanics: `type:'transfer'` movement with `fromWarehouseId` set and NO
 * `toWarehouseId` → `confirmMovement` reduces the source and adds nowhere.
 * `adjustStock` leaves avgCost untouched on any reduction (the weighted-average
 * recompute only runs for positive quantity), so transfers-out never disturb cost;
 * line `unitCost` is set to the product's current avgCost purely for movement
 * valuation. Negative stock is allowed (migration mode).
 *
 * Input is a transfers JSON built by reading the sklrazp PDFs (their table text is
 * column-ordered + splits multi-digit prices across lines, so it can't be parsed
 * deterministically — Claude reads each PDF and transcribes name/qty/value, same
 * pattern as receive-new-products):
 *
 *   {
 *     "transfers": [
 *       { "number": "0000012643", "date": "2026-07-24",
 *         "destination": "СКЛАД - УЛ.М.ВОЙВОДА 12", "total": 1027.91,
 *         "lines": [ { "name": "ВИНТ 6Х120", "qty": 1000, "value": 75.00 }, ... ] }
 *     ]
 *   }
 *
 * Per transfer, Σ line.value is cross-checked against `total` (±0.5) when both are
 * present — a transcription guard (missed/duplicated lines).
 *
 * Idempotent: each movement's notes carry `sklrazp:<number>` — a transfer already
 * booked is skipped. Repeatable.
 *
 * Usage:
 *   export LGR_USERNAME=... LGR_PASSWORD=...     # or LGR_TOKEN
 *   bun run scripts/transfer-stock.ts --items <transfers.json>              # dry-run
 *   bun run scripts/transfer-stock.ts --items <transfers.json> --execute
 *
 * Options:
 *   --items <path>    (required) transfers JSON as above
 *   --org <slug>      org slug (default: regal-pz)
 *   --api <url>       API base (default: https://lgrai.app)
 *   --warehouse <c>   source warehouse code (default: org default = Pazardzhik)
 *   --max-date <ISO>  only process transfers dated <= this (inclusive) — e.g. to
 *                     book only the pre-snapshot backlog
 *   --skip-unmatched  proceed without lines whose product has no catalog match
 *                     (default: unmatched aborts --execute — a skipped transfer-out
 *                     line leaves LGR stock too high)
 *   --execute         create + confirm the movements (default: dry-run)
 */
import { readFileSync } from 'node:fs'

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

if (!itemsPath) { console.error('Required: --items <transfers.json>'); process.exit(2) }

interface LineIn { name: string; qty: number; value?: number }
interface Transfer { number: string; date: string; destination?: string; total?: number; lines: LineIn[] }
interface Input { transfers: Transfer[] }

const input: Input = JSON.parse(readFileSync(itemsPath, 'utf8'))
if (!Array.isArray(input.transfers) || !input.transfers.length) { console.error('transfers JSON has no transfers.'); process.exit(2) }
for (const [i, t] of input.transfers.entries()) {
  if (!t.number) { console.error(`transfer[${i}]: missing number`); process.exit(2) }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date || '')) { console.error(`transfer[${i}] ${t.number}: date must be YYYY-MM-DD, got "${t.date}"`); process.exit(2) }
  if (!Array.isArray(t.lines) || !t.lines.length) { console.error(`transfer[${i}] ${t.number}: no lines`); process.exit(2) }
  for (const [j, l] of t.lines.entries()) {
    if (!l.name?.trim()) { console.error(`transfer ${t.number} line[${j}]: missing name`); process.exit(2) }
    if (!(l.qty > 0)) { console.error(`transfer ${t.number} line[${j}] "${l.name}": qty must be > 0`); process.exit(2) }
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
  const byExact = (p: any) => String(p.name ?? '').trim().toLocaleLowerCase('bg') === lower
  const byCollapse = (p: any) => collapse(String(p.name ?? '')) === coll
  const direct = await searchProducts(name, 3)
  const m1 = direct.find(byExact) || direct.find(byCollapse)
  if (m1) return m1
  if (coll !== lower) {
    const m2 = (await searchProducts(coll, 3)).find(byCollapse)
    if (m2) return m2
  }
  const token = coll.split(' ').filter(t => t.length >= 4).sort((a, b) => b.length - a.length)[0]
  if (token && token !== coll) {
    const m3 = (await searchProducts(token, 5)).find(byCollapse)
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
  let transfers = input.transfers.slice().sort((a, b) => a.date.localeCompare(b.date))
  if (maxDate) {
    const before = transfers.length
    transfers = transfers.filter(t => t.date <= maxDate)
    console.log(`Filtered to date <= ${maxDate}: ${transfers.length}/${before} transfers`)
  }
  console.log(`Transfer stock OUT | ${transfers.length} разписки | Org: ${orgSlug} | API: ${api} | mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)
  if (!transfers.length) { console.log('Nothing to do.'); return }

  await login()

  const whs = (await http('GET', org('/warehouse/warehouse?page=0&size=100'))).warehouses || []
  if (!whs.length) { console.error('Org has no warehouses.'); process.exit(1) }
  const wh = warehouseCode ? whs.find((w: any) => w.code === warehouseCode) : (whs.find((w: any) => w.isDefault) || whs[0])
  if (!wh) { console.error(`Warehouse code "${warehouseCode}" not found.`); process.exit(1) }
  console.log(`Source warehouse: ${wh.name} (${wh.code})\n`)

  let totalUnmatched = 0, booked = 0, skipped = 0
  const mvBefore = (await http('GET', org('/warehouse/movement?page=0&size=1'))).total ?? 0

  for (const t of transfers) {
    // dedup by notes marker
    const marker = `sklrazp:${t.number}`
    const dedup = await http('GET', org(`/warehouse/movement?type=transfer&search=${encodeURIComponent(marker)}&page=0&size=50`))
    const dup = (dedup.stockMovements || []).find((m: any) => String(m.notes || '').includes(marker))
    if (dup) { console.log(`= ${t.number} (${t.date}) already booked: ${dup.movementNumber || dup.number} — skip`); skipped++; continue }

    // Σvalue cross-check
    if (t.total != null && t.lines.every(l => l.value != null)) {
      const sum = t.lines.reduce((s, l) => s + (l.value || 0), 0)
      if (Math.abs(sum - t.total) > 0.5) { console.error(`✗ ${t.number}: Σvalue ${round2(sum)} ≠ total ${t.total} — transcription error? Aborting this transfer.`); continue }
    }

    // match products + build lines (unitCost = current avgCost; avgCost unaffected by a reduction anyway)
    const lines: any[] = []
    const unmatched: LineIn[] = []
    for (const l of t.lines) {
      const p = await matchProduct(l.name)
      if (!p) { unmatched.push(l); continue }
      const lv = await stockLevelFor(p._id || p.id, wh._id)
      lines.push({ productId: p._id || p.id, quantity: l.qty, unitCost: lv.avgCost, totalCost: round2(l.qty * lv.avgCost), _name: p.name, _before: lv.qty })
    }
    totalUnmatched += unmatched.length
    const label = `${t.number} (${t.date}) → ${t.destination || '?'}: ${lines.length}/${t.lines.length} matched, Σqty ${lines.reduce((s, l) => s + l.quantity, 0)}`
    if (unmatched.length) {
      console.log(`⚠ ${label} | UNMATCHED ${unmatched.length}: ${unmatched.slice(0, 6).map(u => `"${u.name}"`).join(', ')}${unmatched.length > 6 ? ' …' : ''}`)
      if (!skipUnmatched) { console.log(`   (unmatched lines would leave stock too high — pass --skip-unmatched to proceed with the matched subset)`); if (execute) { console.error('   Aborting this transfer (no writes).'); continue } }
    } else {
      console.log(`  ${label}`)
    }
    if (!lines.length) continue

    if (!execute) { booked++; continue }

    const totalAmount = round2(lines.reduce((s, l) => s + l.totalCost, 0))
    const created = await http('POST', org('/warehouse/movement'), {
      type: 'transfer',
      date: t.date,
      fromWarehouseId: wh._id,
      totalAmount,
      notes: `Предаване към ${t.destination || 'друг склад'} — ${t.date} (${marker})`,
      lines: lines.map(({ _name, _before, ...l }) => l),
    })
    const mv = created.stockMovement || created.movement || created
    const mvId = mv._id || mv.id
    await http('POST', org(`/warehouse/movement/${mvId}/confirm`))
    // spot-check first line dropped by qty
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
