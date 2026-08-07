/**
 * Create catalog-NEW products from a delivery's стокова разписка (stokrazp PDF)
 * and book their goods receipt — the follow-up to `receive-stock` for the rows
 * it reported as `✗ unmatched` because the products did not exist yet.
 *
 * Input is an items JSON (written by the operator/Claude from the разписка,
 * which carries the prices the storeOperations xlsx lacks):
 *
 *   {
 *     "receipt": "3000016107",            // стокова разписка number (dedup key)
 *     "date": "2026-07-27",               // delivery date (movement date)
 *     "supplier": "PROJAHN-...",           // optional, recorded in movement notes
 *     "items": [
 *       { "name": "<exact name from разписка>", "qty": 2, "unit": "pcs",
 *         "cost": 8.24,                    // разписка "Цена" → Доставна цена / purchasePrice
 *         "selling": 9.064,                // optional; default = cost × 1.10 (org's observed retail markup)
 *         "tiers": { "Цена 1": 7.49, "Цена 2": 6.24 } }   // разписка "Цена N" → tier "Цена N"
 *     ]
 *   }
 *
 * Products are created to be indistinguishable from seed-products output (SKU
 * continues the org's numeric sequence, category Общи, 10 canonical price-tier
 * slots with tier-name tags) so the NEXT storeAvailability seed run — which
 * matches by exact name — adopts them and overwrites prices/qty with the
 * authoritative export values.
 *
 * The receipt movement uses unitCost = cost (real supplier cost — these are new
 * products, so this SETS their initial avgCost; unlike receive-stock there is no
 * prior avgCost to preserve).
 *
 * Idempotent: products are ensure-created (existing names are kept, warned, and
 * still received — resume-safe after a partial run); the movement carries
 * `stokrazp:<receipt>` in notes — if present, the receipt step is a no-op.
 *
 * Usage:
 *   export LGR_USERNAME=... LGR_PASSWORD=...     # or LGR_TOKEN
 *   bun run scripts/receive-new-products.ts --items <items.json>            # dry-run
 *   bun run scripts/receive-new-products.ts --items <items.json> --execute
 *
 * Options:
 *   --items <path>    (required) items JSON as above
 *   --org <slug>      org slug (default: regal-pz)
 *   --api <url>       API base (default: https://lgrai.app)
 *   --warehouse <c>   warehouse code (default: org default)
 *   --category <name> category for created products (default: Общи)
 *   --execute         create products + book the receipt (default: dry-run)
 */
import { readFileSync } from 'node:fs'

const TIER_NAMES = ['Доставна цена', 'Цена на едро', 'Цена 0', 'Цена 1', 'Цена 2', 'Цена 3', 'Цена 4', 'Цена 5', 'Цена 6', 'Цена 7', 'Цена 8', 'Цена 9', 'Цена 10']
const UNIT_MAP: Record<string, string> = { 'БР': 'pcs', 'БР.': 'pcs', 'М': 'm', 'КГ': 'kg', 'Л': 'l', 'ЧФ': 'pair', 'К-Т': 'set', 'ОП': 'pack' }

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
const categoryName = (args.category as string) || 'Общи'
const execute = !!args.execute

if (!itemsPath) { console.error('Required: --items <items.json>'); process.exit(2) }

interface ItemIn { name: string; qty: number; unit?: string; cost: number; selling?: number; tiers?: Record<string, number> }
interface Input { receipt?: string; date: string; supplier?: string; items: ItemIn[] }

const input: Input = JSON.parse(readFileSync(itemsPath, 'utf8'))
if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '')) { console.error(`items JSON "date" must be YYYY-MM-DD, got "${input.date}"`); process.exit(2) }
if (!Array.isArray(input.items) || !input.items.length) { console.error('items JSON has no items.'); process.exit(2) }
for (const [i, it] of input.items.entries()) {
  if (!it.name?.trim()) { console.error(`item[${i}]: missing name`); process.exit(2) }
  if (!(it.qty > 0)) { console.error(`item[${i}] "${it.name}": qty must be > 0`); process.exit(2) }
  if (!(it.cost >= 0)) { console.error(`item[${i}] "${it.name}": cost must be >= 0`); process.exit(2) }
  for (const k of Object.keys(it.tiers || {})) {
    if (!TIER_NAMES.includes(k) || k === 'Доставна цена') { console.error(`item[${i}] "${it.name}": unknown tier "${k}" (allowed: ${TIER_NAMES.slice(1).join(', ')})`); process.exit(2) }
  }
}
const marker = input.receipt ? `stokrazp:${input.receipt}` : `new-products:${input.date}`

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
const round4 = (v: number) => +v.toFixed(4)
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('bg')
const normalizeUnit = (u?: string) => {
  const raw = (u || '').trim()
  if (!raw) return 'pcs'
  return UNIT_MAP[raw.toUpperCase()] || raw
}

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

/** Same matcher as receive-stock: exact bg-lowercased, then whitespace-tolerant. */
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

/** Mirror of seed-products buildTiers: 10 canonical slots, percent vs cost,
 *  manualOverride + tier-name tag on non-zero sale tiers. */
function buildTiers(cost: number, tiers: Record<string, number> | undefined) {
  return TIER_NAMES.map((name) => {
    const price = name === 'Доставна цена' ? cost : (tiers?.[name] ?? 0)
    return {
      name,
      percent: cost > 0 && price > 0 ? +(((price - cost) / cost) * 100).toFixed(1) : 0,
      finalPrice: price,
      manualOverride: price > 0,
      contactIds: [],
      tags: price > 0 && name !== 'Доставна цена' ? [name] : [],
    }
  })
}

/** Reprice an EXISTING product's tiers from a разписка: set Доставна цена = cost and
 *  overlay the provided sale tiers, but PRESERVE any existing slots the разписка does
 *  not carry (e.g. Цена на едро / Цена 0/6/7 set by a prior storeAvailability seed) —
 *  so a receipt updates the delivered prices without wiping snapshot-set ones. */
function repriceTiers(existing: any[] | undefined, cost: number, tiers: Record<string, number> | undefined) {
  const slots = (existing && existing.length ? existing.map((t: any) => ({ ...t })) : buildTiers(0, {}))
  const setSlot = (name: string, price: number) => {
    const t = slots.find((x: any) => x.name === name); if (!t) return
    t.finalPrice = price
    t.percent = cost > 0 && price > 0 ? +(((price - cost) / cost) * 100).toFixed(1) : 0
    t.manualOverride = price > 0
    t.tags = price > 0 && name !== 'Доставна цена' ? [name] : (t.tags || [])
    t.contactIds = t.contactIds || []
  }
  setSlot('Доставна цена', cost)
  for (const [name, price] of Object.entries(tiers || {})) setSlot(name, Number(price) || 0)
  return slots
}

/** Next SKU continuing the org's numeric sequence (max <PREFIX>-NNNNN + 1). */
async function nextSkuBase(): Promise<{ prefix: string; next: number; pad: number }> {
  const d = await http('GET', org('/warehouse/product?page=0&size=10&sortBy=sku&sortOrder=desc'))
  for (const p of d.products || []) {
    const m = String(p.sku || '').match(/^(.*)-(\d+)$/)
    if (m) return { prefix: m[1], next: parseInt(m[2], 10) + 1, pad: m[2].length }
  }
  const prefix = orgSlug.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'SKU'
  return { prefix, next: 1, pad: 5 }
}

async function stockLevelFor(productId: string, warehouseId: string): Promise<{ qty: number; avgCost: number } | null> {
  const d = await http('GET', org(`/warehouse/stock-level?productId=${productId}&page=0&size=10`))
  const rows: any[] = d.stockLevels || d.levels || d.data || []
  const r = rows.find((x: any) => String(x.warehouseId?._id || x.warehouseId) === String(warehouseId)) || rows[0]
  return r ? { qty: Number(r.quantity) || 0, avgCost: Number(r.avgCost) || 0 } : null
}

async function main() {
  console.log(`Receive NEW products | items: ${itemsPath}`)
  console.log(`Org: ${orgSlug} | API: ${api} | date: ${input.date} | marker: ${marker} | mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}`)
  if (input.supplier) console.log(`Supplier: ${input.supplier}`)
  console.log()

  await login()

  // warehouse
  const whs = (await http('GET', org('/warehouse/warehouse?page=0&size=100'))).warehouses || []
  if (!whs.length) { console.error('Org has no warehouses.'); process.exit(1) }
  const wh = warehouseCode ? whs.find((w: any) => w.code === warehouseCode) : (whs.find((w: any) => w.isDefault) || whs[0])
  if (!wh) { console.error(`Warehouse code "${warehouseCode}" not found.`); process.exit(1) }
  console.log(`Warehouse: ${wh.name} (${wh.code})`)

  // receipt-step dedup — the quantity movement is booked ONCE (idempotent), but prices
  // are (re)applied on EVERY run, so re-running the fixed skill refreshes an
  // already-received delivery's prices without double-receiving.
  const dedup = await http('GET', org(`/warehouse/movement?type=receipt&search=${encodeURIComponent(marker)}&page=0&size=50`))
  const dupMv = (dedup.stockMovements || []).find((m: any) => String(m.notes || '').includes(marker))
  if (dupMv) console.log(`Quantity already booked (${dupMv.movementNumber || dupMv.number}) — will REFRESH PRICES only, no re-receive.`)

  // category
  const cats = (await http('GET', org(`/warehouse/product-category?search=${encodeURIComponent(categoryName)}&page=0&size=10`))).productCategories || []
  const cat = cats.find((c: any) => c.name === categoryName)
  if (!cat) { console.error(`Category "${categoryName}" not found — create it first or pass --category.`); process.exit(1) }

  // plan: which items need creation
  const plan: Array<{ it: ItemIn; existing: any | null; selling: number; unit: string }> = []
  for (const it of input.items) {
    const existing = await matchProduct(it.name)
    const selling = it.selling != null ? round4(it.selling) : round4(it.cost * 1.1)
    plan.push({ it, existing, selling, unit: normalizeUnit(it.unit) })
  }

  const { prefix, next, pad } = await nextSkuBase()
  let skuCursor = next
  console.log()
  for (const p of plan) {
    if (p.existing) {
      const tierStr = Object.entries(p.it.tiers || {}).map(([k, v]) => `${k}=${v}`).join(' | ')
      console.log(`  ~ REPRICE ${p.existing.sku}  "${p.it.name}"  purchase→${p.it.cost}${p.it.selling != null ? ` selling→${p.selling}` : ''}${tierStr ? ` | ${tierStr}` : ''}${dupMv ? '' : `  + receive qty ${p.it.qty}`}`)
    } else {
      const sku = `${prefix}-${String(skuCursor++).padStart(pad, '0')}`
      const tierStr = TIER_NAMES.filter(n => n === 'Доставна цена' || (p.it.tiers?.[n] ?? 0) > 0)
        .map(n => `${n}=${n === 'Доставна цена' ? p.it.cost : p.it.tiers![n]}`).join(' | ')
      console.log(`  + CREATE ${sku}  "${p.it.name}"  qty ${p.it.qty} ${p.unit}`)
      console.log(`    cost ${p.it.cost} | selling ${p.selling}${p.it.selling == null ? ' (derived cost×1.10 — next availability seed overwrites)' : ''} | ${tierStr}`)
    }
  }
  const totalQty = plan.reduce((s, p) => s + p.it.qty, 0)
  const totalAmount = round2(plan.reduce((s, p) => s + p.it.qty * p.it.cost, 0))
  console.log(`\nPlanned: ${plan.filter(p => !p.existing).length} to create, ${plan.filter(p => p.existing).length} to reprice${dupMv ? '' : ' + receive'} | ${plan.length} lines | Σqty ${totalQty} | Σcost ${totalAmount} | → ${wh.name}`)

  if (!execute) {
    console.log('\nDry-run complete — no writes. Re-run with --execute.')
    return
  }

  // 1) ensure + reprice products — BOTH quantity (via the movement below) and PRICES
  // (purchase / selling / tiers) are corrected for existing AND new products. Existing
  // products get a product PUT; new ones are created with prices. Runs every time.
  const lines: any[] = []
  let created = 0, repriced = 0
  for (const p of plan) {
    let prod = p.existing
    if (!prod) {
      const res = await http('POST', org('/warehouse/product'), {
        sku: `${prefix}-${String(next + created).padStart(pad, '0')}`,
        name: p.it.name, category: cat.name, categoryId: cat._id || cat.id,
        type: 'goods', unit: p.unit, purchasePrice: p.it.cost, sellingPrice: p.selling,
        currency: 'BGN', taxRate: 20, trackInventory: true, isActive: true,
        priceTiers: buildTiers(p.it.cost, p.it.tiers),
      })
      prod = res.product
      created++
      console.log(`  + created ${prod.sku} "${String(prod.name).replace(/\s+/g, ' ').slice(0, 40)}"  purchase=${p.it.cost}`)
    } else {
      const body: Record<string, any> = { purchasePrice: p.it.cost, priceTiers: repriceTiers(prod.priceTiers, p.it.cost, p.it.tiers) }
      if (p.it.selling != null) body.sellingPrice = p.selling
      await http('PUT', org(`/warehouse/product/${prod._id || prod.id}`), body)
      repriced++
      console.log(`  ~ repriced ${prod.sku} "${String(prod.name).replace(/\s+/g, ' ').slice(0, 40)}"  purchase=${p.it.cost}${p.it.selling != null ? ` selling=${p.selling}` : ''}`)
    }
    lines.push({ productId: prod._id || prod.id, quantity: p.it.qty, unitCost: p.it.cost, totalCost: round2(p.it.qty * p.it.cost), _name: prod.name, _existing: !!p.existing })
  }
  console.log(`Products: ${created} created, ${repriced} repriced.`)

  // 2) receipt movement — booked ONCE (idempotent quantity). On a re-run of an
  // already-received delivery, prices are refreshed above and we stop here.
  if (dupMv) {
    console.log(`\n✓ Prices refreshed for ${plan.length} products. Quantity was already received (${dupMv.movementNumber || dupMv.number}) — no new movement.`)
    return
  }
  const mvBefore = (await http('GET', org('/warehouse/movement?page=0&size=1'))).total ?? 0
  const createdMv = await http('POST', org('/warehouse/movement'), {
    type: 'receipt', date: input.date, toWarehouseId: wh._id, totalAmount,
    notes: `Доставки — ${input.date}${input.supplier ? ` — ${input.supplier}` : ''} (${marker})`,
    lines: lines.map(({ _name, _existing, ...l }) => l),
  })
  const mv = createdMv.stockMovement || createdMv.movement || createdMv
  const mvId = mv._id || mv.id
  console.log(`\ncreated ${mv.movementNumber} (draft) — confirming ...`)
  await http('POST', org(`/warehouse/movement/${mvId}/confirm`))

  const after = await http('GET', org(`/warehouse/movement/${mvId}`))
  const done = after.stockMovement || after.movement || after
  const mvAfter = (await http('GET', org('/warehouse/movement?page=0&size=1'))).total ?? 0
  console.log(`\n✓ ${done.movementNumber} | ${input.date} | ${lines.length} lines | Σqty ${totalQty} | ${wh.name} | status ${done.status}`)
  console.log(`stock movements: ${mvBefore} → ${mvAfter} (+${mvAfter - mvBefore})`)

  // verify each line's stock level rose by qty (spot-check)
  let ok = true
  for (const [i, l] of lines.entries()) {
    const lv = await stockLevelFor(l.productId, wh._id)
    if (!plan[i].existing && (!lv || Math.abs(lv.qty - l.quantity) > 0.001)) ok = false
    console.log(`  ${lv ? '✓' : '✗'} "${String(l._name).replace(/\s+/g, ' ').slice(0, 34)}": qty=${lv?.qty} avgCost=${lv?.avgCost}`)
  }
  if (done.status !== 'completed' || !ok) process.exit(1)
}

await main()
