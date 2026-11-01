/**
 * Books the quantity corrections `compare-stock-api.ts` finds on MATCHED products (same name in
 * both systems, different quantity) — two `adjustment` movements (one increase batch via
 * `toWarehouseId`, one decrease batch via `fromWarehouseId`), bringing LGR's stock level to match
 * PlusMinus's own current snapshot exactly. PlusMinus is the arbiter throughout this migration
 * (see memory `lgr-till-overlap-backlog`) — once every document is confirmed imported
 * (`import-sales-invoices-api.ts` / `import-cash-register-sales-api.ts` / `receive-stock-api.ts`
 * all report nothing outstanding), a residual quantity gap on an EXISTING, matched product has no
 * further document to find; it is corrected directly, never guessed into a fabricated document.
 *
 * Deliberately NOT in scope here: "missing in LGR" (a snapshot row with no LGR product at all —
 * creating one needs a cost/category decision this script has no basis for) and "LGR not in
 * snapshot" (the opposite tail) — both are `compare-stock-api.ts`'s to report, a person's to act
 * on. Also note that script's second-pass naming reconciliation: a lot of what LOOKS like those
 * two tails is really the SAME product under a naming artifact, not a real gap — don't create or
 * delete products from either tail without checking that pass's output first.
 *
 * Each booked movement is tagged `snapshot-reconcile:<date>` in its notes, so it is auditable and
 * reversible (search stock movements for the marker) rather than blending into ordinary receipts.
 *
 * Usage:
 *   bun run scripts/true-up-stock-api.ts --org regal-sf --snapshot <path> --date 2026-10-31          # preview
 *   bun run scripts/true-up-stock-api.ts --org regal-sf --snapshot <path> --date 2026-10-31 --execute # book + confirm
 *
 * Options:
 *   --org <slug>        org slug (default: regal-sf)
 *   --api <url>         API base (default: https://lgrai.app)
 *   --snapshot <path>   exact storeAvailability_*.json to true up against (required)
 *   --date <ISO>        date to stamp the correction movements with (required — use the snapshot's own date)
 *   --warehouse <code>  warehouse code (default: org default)
 *   --execute            actually book + confirm (default: dry-run, prints the plan only)
 *
 * Credentials (env): LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.
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
const orgSlug = (args.org as string) || 'regal-sf'
const api = ((args.api as string) || 'https://lgrai.app').replace(/\/$/, '')
const warehouseCode = args.warehouse as string | undefined
const snapPath = args.snapshot as string | undefined
const date = args.date as string | undefined
const EXECUTE = !!args.execute
if (!snapPath) { console.error('Required: --snapshot <path to storeAvailability_*.json>'); process.exit(2) }
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error('Required: --date YYYY-MM-DD (use the snapshot\'s own date)'); process.exit(2) }
const MARKER = `snapshot-reconcile:${date}`

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('bg')
const round2 = (v: number) => +v.toFixed(2)

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
  console.log('auth: org', orgSlug, `(${ORG_ID})`, '| mode:', EXECUTE ? 'EXECUTE' : 'DRY-RUN (preview only)')
}

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

async function main() {
  await login()

  const whs = (await http('GET', org('/warehouse/warehouse?page=0&size=100'))).warehouses || []
  const wh = warehouseCode ? whs.find((w: any) => w.code === warehouseCode) : (whs.find((w: any) => w.isDefault) || whs[0])
  if (!wh) { console.error('Warehouse not found.'); process.exit(1) }
  console.log('warehouse:', wh.name, wh.code, wh._id)

  const snap = JSON.parse(readFileSync(snapPath!, 'utf8'))
  const whKey = Object.keys(snap)[0]
  const rows = snap[whKey]
  const byName = new Map<string, { name: string; qty: number }>()
  for (const k of Object.keys(rows)) {
    const name = k.replace(/^СТОКИ:/, '')
    const key = collapse(name)
    const qty = parseFloat((rows[k] as any).quantity ?? '0') || 0
    if (byName.has(key)) byName.get(key)!.qty += qty
    else byName.set(key, { name, qty })
  }

  console.log('fetching LGR products + stock levels...')
  const idOf = (x: any) => String(x._id || x.id)
  const products = await fetchAll('/warehouse/product', 'products', idOf)
  const levels = await fetchAll(`/warehouse/stock-level?warehouseId=${wh._id}`, 'stockLevels', idOf)
  const qtyById = new Map<string, number>()
  for (const l of levels) qtyById.set(String(l.productId?._id || l.productId), Number(l.quantity) || 0)
  const prodByName = new Map<string, any>()
  for (const p of products) prodByName.set(collapse(String(p.name || '')), p)
  console.log(`LGR: ${products.length} products, ${levels.length} stock levels | snapshot rows: ${byName.size}`)

  let noMatch = 0
  const increase: any[] = []
  const decrease: any[] = []
  for (const [key, row] of byName) {
    const p = prodByName.get(key)
    if (!p) { noMatch++; continue } // new-product territory — not this script's job, see header
    const pid = String(p._id || p.id)
    const lgrQty = qtyById.get(pid) ?? 0
    const diff = row.qty - lgrQty // >0: LGR too low, need increase. <0: LGR too high, need decrease.
    if (Math.abs(diff) <= 0.001) continue
    const unitCost = Number(p.avgCost) || Number(p.purchasePrice) || 0
    const entry = { productId: pid, sku: p.sku, name: p.name, quantity: round2(Math.abs(diff)), unitCost, totalCost: round2(Math.abs(diff) * unitCost), _before: lgrQty, _snapshot: row.qty }
    if (diff > 0) increase.push(entry); else decrease.push(entry)
  }

  console.log(`no-match (skipped — not matched to any LGR product by exact name): ${noMatch}`)
  console.log(`\nINCREASE batch (LGR too low): ${increase.length} lines, Σqty ${round2(increase.reduce((s, l) => s + l.quantity, 0))}, Σcost ${round2(increase.reduce((s, l) => s + l.totalCost, 0))}`)
  for (const l of increase) console.log(`  + ${l.sku}  "${l.name}"  ${l._before} -> ${l._snapshot}  (+${l.quantity})`)
  console.log(`\nDECREASE batch (LGR too high): ${decrease.length} lines, Σqty ${round2(decrease.reduce((s, l) => s + l.quantity, 0))}, Σcost ${round2(decrease.reduce((s, l) => s + l.totalCost, 0))}`)
  for (const l of decrease) console.log(`  - ${l.sku}  "${l.name}"  ${l._before} -> ${l._snapshot}  (-${l.quantity})`)

  if (!EXECUTE) { console.log('\nDry-run only. Re-run with --execute to book + confirm both movements.'); return }
  if (!increase.length && !decrease.length) { console.log('\nNothing to book.'); return }

  const strip = (l: any) => ({ productId: l.productId, quantity: l.quantity, unitCost: l.unitCost, totalCost: l.totalCost })

  if (increase.length) {
    const created = await http('POST', org('/warehouse/movement'), {
      type: 'adjustment', date, toWarehouseId: wh._id,
      totalAmount: round2(increase.reduce((s, l) => s + l.totalCost, 0)),
      notes: `Снапшот реконсилиация ${date} — PlusMinus по-висок (${MARKER})`,
      lines: increase.map(strip),
    })
    const mv = created.stockMovement || created.movement || created
    await http('POST', org(`/warehouse/movement/${mv._id || mv.id}/confirm`))
    console.log(`\n✓ INCREASE adjustment ${mv.movementNumber} confirmed (${increase.length} lines)`)
  }
  if (decrease.length) {
    const created = await http('POST', org('/warehouse/movement'), {
      type: 'adjustment', date, fromWarehouseId: wh._id,
      totalAmount: round2(decrease.reduce((s, l) => s + l.totalCost, 0)),
      notes: `Снапшот реконсилиация ${date} — PlusMinus по-нисък (${MARKER})`,
      lines: decrease.map(strip),
      allowNegativeStock: true,
    })
    const mv = created.stockMovement || created.movement || created
    await http('POST', org(`/warehouse/movement/${mv._id || mv.id}/confirm`))
    console.log(`✓ DECREASE adjustment ${mv.movementNumber} confirmed (${decrease.length} lines)`)
  }
}
main().catch(e => { console.error('FAILED', e); process.exit(1) })
