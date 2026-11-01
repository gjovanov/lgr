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
 *   --zero-lgr-only      ALSO bring LGR products that hold stock but have NO counterpart in the
 *                       snapshot down to zero (own tagged batch, `<marker>:lgr-only`). See below.
 *   --execute            actually book + confirm (default: dry-run, prints the plan only)
 *
 * `--zero-lgr-only` (added 2026-11-01 for regal-pz, where it is a real class): PlusMinus can remove
 * an item outright — a clean-up of a bogus opening balance, a merge — and its stock goes with it
 * without any document (regal-pz: over a hundred seeded items, gone from BOTH the mobile API
 * snapshot and the GUI "Наличност" report). LGR keeps what it was seeded with. Only products whose
 * name has no twin in the snapshot even after dropping a `<label>:` prefix and quote marks and
 * folding Latin/Cyrillic look-alikes are touched (those twins are a naming artifact, not a gap), and
 * the flag refuses a snapshot that holds under 80 % of LGR's product count — a partial export would
 * otherwise zero the catalogue. The batch has its own marker so it can be reversed on its own.
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
const ZERO_LGR_ONLY = !!args['zero-lgr-only']
if (!snapPath) { console.error('Required: --snapshot <path to storeAvailability_*.json>'); process.exit(2) }
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error('Required: --date YYYY-MM-DD (use the snapshot\'s own date)'); process.exit(2) }
const MARKER = `snapshot-reconcile:${date}`

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('bg')
const round2 = (v: number) => +v.toFixed(2)
/** Latin look-alikes of Cyrillic letters (PlusMinus and LGR spell the same article with either). */
const CYR2LAT: Record<string, string> = { 'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'х': 'x', 'у': 'y' }
/** Loosest name key: no `<label>:` prefix, no quote marks, homoglyphs folded. Used ONLY to decide "has a twin", never to match. */
const loose = (s: string) => [...collapse(s.replace(/^[^:]+:/, '').replace(/["']/g, ''))].map(c => CYR2LAT[c] ?? c).join('')

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

  // ── --zero-lgr-only: stock LGR still holds for a product PlusMinus no longer has ──
  const zeroDown: any[] = [] // LGR positive -> lower to 0
  const zeroUp: any[] = []   // LGR negative -> raise to 0
  if (ZERO_LGR_ONLY) {
    if (byName.size < 0.8 * products.length) {
      console.error(`--zero-lgr-only refused: the snapshot holds ${byName.size} names against ${products.length} LGR products (under 80 %) — it looks partial, and zeroing against it would wipe the catalogue.`)
      process.exit(2)
    }
    // loose key -> the snapshot's exact keys that fold to it
    const looseToExact = new Map<string, string[]>()
    for (const key of byName.keys()) { const lk = loose(key); looseToExact.set(lk, [...(looseToExact.get(lk) ?? []), key]) }
    let namingTwins = 0
    for (const p of products) {
      const pid = String(p._id || p.id)
      const q = qtyById.get(pid) ?? 0
      if (Math.abs(q) <= 0.001) continue
      const name = String(p.name || '')
      if (byName.has(collapse(name))) continue   // matched product: handled by the batches above
      // A snapshot row that differs only by a prefix / quote marks / Latin-vs-Cyrillic look-alikes.
      //  - another LGR product already carries that row's EXACT name → this one is a DUPLICATE FORK
      //    (LGR created the same article a second time), its stock is surplus → fall through, zero it;
      //  - nobody does → this IS the article under a different spelling: a naming artifact for a
      //    person to settle (rename / merge), never zeroed.
      const twins = looseToExact.get(loose(name))
      if (twins?.length && !twins.some(k => prodByName.has(k))) { namingTwins++; continue }
      const unitCost = Number(p.avgCost) || Number(p.purchasePrice) || 0
      const entry = { productId: pid, sku: p.sku, name: p.name, quantity: round2(Math.abs(q)), unitCost, totalCost: round2(Math.abs(q) * unitCost), _before: q, _snapshot: 0 }
      if (q > 0) zeroDown.push(entry); else zeroUp.push(entry)
    }
    if (namingTwins) console.log(`--zero-lgr-only: ${namingTwins} product(s) with stock left alone — the article exists in the snapshot under a different spelling and no other LGR product holds it (rename/merge by hand)`)
  }

  console.log(`no-match (skipped — not matched to any LGR product by exact name): ${noMatch}`)
  console.log(`\nINCREASE batch (LGR too low): ${increase.length} lines, Σqty ${round2(increase.reduce((s, l) => s + l.quantity, 0))}, Σcost ${round2(increase.reduce((s, l) => s + l.totalCost, 0))}`)
  for (const l of increase) console.log(`  + ${l.sku}  "${l.name}"  ${l._before} -> ${l._snapshot}  (+${l.quantity}) @${l.unitCost}`)
  console.log(`\nDECREASE batch (LGR too high): ${decrease.length} lines, Σqty ${round2(decrease.reduce((s, l) => s + l.quantity, 0))}, Σcost ${round2(decrease.reduce((s, l) => s + l.totalCost, 0))}`)
  for (const l of decrease) console.log(`  - ${l.sku}  "${l.name}"  ${l._before} -> ${l._snapshot}  (-${l.quantity}) @${l.unitCost}`)
  if (ZERO_LGR_ONLY) {
    console.log(`\nZERO-OUT (LGR holds stock for a product PlusMinus no longer has): lower ${zeroDown.length} (Σqty ${round2(zeroDown.reduce((s, l) => s + l.quantity, 0))}, Σcost ${round2(zeroDown.reduce((s, l) => s + l.totalCost, 0))}), raise ${zeroUp.length} (Σqty ${round2(zeroUp.reduce((s, l) => s + l.quantity, 0))})`)
    for (const l of [...zeroDown, ...zeroUp]) console.log(`  0 ${l.sku}  "${l.name}"  ${l._before} -> 0 @${l.unitCost}`)
  }

  if (!EXECUTE) { console.log('\nDry-run only. Re-run with --execute to book + confirm the movements.'); return }
  if (!increase.length && !decrease.length && !zeroDown.length && !zeroUp.length) { console.log('\nNothing to book.'); return }

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
  // own tagged batches, so the zero-out can be reversed without touching the matched true-up
  if (zeroDown.length) {
    const created = await http('POST', org('/warehouse/movement'), {
      type: 'adjustment', date, fromWarehouseId: wh._id,
      totalAmount: round2(zeroDown.reduce((s, l) => s + l.totalCost, 0)),
      notes: `Снапшот реконсилиация ${date} — артикулът вече не съществува в PlusMinus (${MARKER}:lgr-only)`,
      lines: zeroDown.map(strip),
      allowNegativeStock: true,
    })
    const mv = created.stockMovement || created.movement || created
    await http('POST', org(`/warehouse/movement/${mv._id || mv.id}/confirm`))
    console.log(`✓ ZERO-OUT (lower) adjustment ${mv.movementNumber} confirmed (${zeroDown.length} lines)`)
  }
  if (zeroUp.length) {
    const created = await http('POST', org('/warehouse/movement'), {
      type: 'adjustment', date, toWarehouseId: wh._id,
      totalAmount: round2(zeroUp.reduce((s, l) => s + l.totalCost, 0)),
      notes: `Снапшот реконсилиация ${date} — артикулът вече не съществува в PlusMinus (${MARKER}:lgr-only)`,
      lines: zeroUp.map(strip),
    })
    const mv = created.stockMovement || created.movement || created
    await http('POST', org(`/warehouse/movement/${mv._id || mv.id}/confirm`))
    console.log(`✓ ZERO-OUT (raise) adjustment ${mv.movementNumber} confirmed (${zeroUp.length} lines)`)
  }
}
main().catch(e => { console.error('FAILED', e); process.exit(1) })
