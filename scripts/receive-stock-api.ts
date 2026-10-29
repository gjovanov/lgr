/**
 * Daily goods-receipt import, direct from PlusMinus's own `/mobile` API — the regal-pz/regal-sf
 * sibling of `receive-new-products.ts` (which takes one hand-written items file per receipt).
 * Reads a folder of `stokrazp_<N>.json` pulls (`services/biz/doc-import/map-plusminus-stokrazp.ts`
 * #mapStokrazpDoc), and books BOTH halves a document can carry:
 *
 *   - positive lines ("receiptItems")   → spawns `receive-new-products.ts` with a generated
 *                                          items file. Reuses its product create/reprice +
 *                                          receipt-movement logic verbatim — not re-implemented
 *                                          here. Marker `stokrazp:<N>` (its own default).
 *   - negative lines ("adjustmentLines") → booked directly below as a `type:'adjustment'`
 *                                          movement (fromWarehouseId set, no toWarehouseId —
 *                                          same mechanics as `adjust-stock.ts`), marker
 *                                          `stokrazp:<N>` — NOT `sklisk:`, because this is the
 *                                          other half of THIS receipt, not a write-off document.
 *
 * Both halves of one document share one marker on purpose (see map-plusminus-stokrazp.ts's header
 * comment for the real regal-pz "2000 КОРЕКЦИЯ" and regal-sf whole-document-return cases this
 * covers).
 *
 * Usage:
 *   bun run scripts/receive-stock-api.ts --dir <dir with stokrazp_*.json>            # dry-run
 *   bun run scripts/receive-stock-api.ts --dir <dir> --execute
 *
 * Options:
 *   --dir <dir>        (required) folder with stokrazp_<number>.json (WSL UNC ok)
 *   --org <slug>       org slug (default: regal-pz)
 *   --api <url>        API base (default: https://lgrai.app)
 *   --warehouse <c>    warehouse code (default: org default)
 *   --only <nums>      comma-separated document numbers to limit the run to
 *   --execute          actually book (default: dry-run, no writes)
 *
 * Credentials (env): LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD — inherited by the
 * receive-new-products.ts subprocess too.
 */
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertTokenOrg } from './lib/token-org.js'
import { mapStokrazpDoc } from '../packages/services/src/biz/doc-import/map-plusminus-stokrazp.js'
import type { PlusMinusDocument } from '../packages/services/src/biz/doc-import/map-plusminus-invoice.js'

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
const orgSlug = (args.org as string) || 'regal-pz'
const api = ((args.api as string) || 'https://lgrai.app').replace(/\/$/, '')
const warehouseCode = args.warehouse as string | undefined
const only = args.only ? new Set(String(args.only).split(',').map(s => s.trim())) : null
const execute = !!args.execute

if (!dir) { console.error('Required: --dir <dir with stokrazp_*.json>. See header for options.'); process.exit(2) }

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
  console.log(`auth: → org ${orgSlug} (${ORG_ID})`)
}

const round2 = (v: number) => +v.toFixed(2)
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('bg')
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

/** Same matcher as transfer-stock.ts: exact bg-lowercased, collapse, homoglyph fold (unambiguous only). */
async function matchProduct(name: string): Promise<any | null> {
  const lower = name.trim().toLocaleLowerCase('bg')
  const coll = collapse(name)
  const fld = fold(name)
  const byExact = (p: any) => String(p.name ?? '').trim().toLocaleLowerCase('bg') === lower
  const byCollapse = (p: any) => collapse(String(p.name ?? '')) === coll
  const byFold = (p: any) => p.isActive !== false && fold(String(p.name ?? '')) === fld
  const foldMatch = (cands: any[]): any | null => {
    if (cands.find(byExact) || cands.find(byCollapse)) return null
    const hits = cands.filter(byFold)
    const uniq = [...new Map(hits.map(p => [String(p._id || p.id), p])).values()]
    return uniq.length === 1 ? uniq[0] : null
  }
  const direct = await searchProducts(name, 3)
  const m1 = direct.find(byExact) || direct.find(byCollapse) || foldMatch(direct)
  if (m1) return m1
  if (coll !== lower) {
    const c2 = await searchProducts(coll, 3)
    const m2 = c2.find(byCollapse) || foldMatch(c2)
    if (m2) return m2
  }
  return null
}

async function stockLevelFor(productId: string, warehouseId: string): Promise<{ qty: number; avgCost: number }> {
  const d = await http('GET', org(`/warehouse/stock-level?productId=${productId}&page=0&size=10`))
  const rows: any[] = d.stockLevels || d.levels || d.data || []
  const r = rows.find((x: any) => String(x.warehouseId?._id || x.warehouseId) === String(warehouseId)) || rows[0]
  return { qty: Number(r?.quantity) || 0, avgCost: Number(r?.avgCost) || 0 }
}

/** Books the negative-line half directly (receive-new-products.ts only knows positive receipts). */
async function bookAdjustment(docNumber: string, date: string, lines: { name: string; qty: number; value: number }[], wh: any): Promise<void> {
  const marker = `stokrazp:${docNumber}`
  const dedup = await http('GET', org(`/warehouse/movement?type=adjustment&search=${encodeURIComponent(marker)}&page=0&size=50`))
  const dup = (dedup.stockMovements || []).find((m: any) => String(m.notes || '').includes(marker))
  if (dup) { console.log(`    = adjustment already booked: ${dup.movementNumber || dup.number} — skip`); return }

  const built: any[] = []
  const unmatched: string[] = []
  for (const l of lines) {
    const p = await matchProduct(l.name)
    if (!p) { unmatched.push(l.name); continue }
    const lv = await stockLevelFor(p._id || p.id, wh._id)
    built.push({ productId: p._id || p.id, quantity: l.qty, unitCost: lv.avgCost, totalCost: round2(l.qty * lv.avgCost), _name: p.name, _before: lv.qty })
  }
  if (unmatched.length) {
    console.log(`    ⚠ UNMATCHED ${unmatched.length} adjustment line(s) — NOT booked (stock stays too HIGH for these): ${unmatched.join('; ')}`)
  }
  if (!built.length) return

  if (!execute) {
    console.log(`    would book adjustment: ${built.length} line(s), Σqty ${built.reduce((s, l) => s + l.quantity, 0)}`)
    return
  }
  const totalAmount = round2(built.reduce((s, l) => s + l.totalCost, 0))
  const created = await http('POST', org('/warehouse/movement'), {
    type: 'adjustment', date, fromWarehouseId: wh._id, totalAmount,
    notes: `Корекция от стокова разписка — ${date} (${marker})`,
    lines: built.map(({ _name, _before, ...l }) => l),
  })
  const mv = created.stockMovement || created.movement || created
  await http('POST', org(`/warehouse/movement/${mv._id || mv.id}/confirm`))
  console.log(`    ✓ adjustment ${mv.movementNumber} confirmed | ${built.length} line(s), Σqty ${built.reduce((s, l) => s + l.quantity, 0)}`)
}

async function bookReceipt(docNumber: string, date: string, partner: string | undefined, items: any[]): Promise<void> {
  const tmpFile = join(tmpdir(), `stokrazp-${docNumber}-${process.pid}.json`)
  writeFileSync(tmpFile, JSON.stringify({ receipt: docNumber, date, supplier: partner, items }))
  try {
    const cliArgs = ['run', 'scripts/receive-new-products.ts', '--items', tmpFile, '--org', orgSlug, '--api', api]
    if (warehouseCode) cliArgs.push('--warehouse', warehouseCode)
    if (execute) cliArgs.push('--execute')
    const proc = Bun.spawn(['bun', ...cliArgs], { cwd: join(import.meta.dir, '..'), env: process.env, stdout: 'pipe', stderr: 'pipe' })
    const out = await new Response(proc.stdout).text()
    const err = await new Response(proc.stderr).text()
    const code = await proc.exited
    for (const line of out.trim().split('\n')) console.log(`    ${line}`)
    if (code !== 0) console.log(`    ✗ receive-new-products.ts exited ${code}: ${err.slice(0, 300)}`)
  } finally {
    try { unlinkSync(tmpFile) } catch { /* best effort */ }
  }
}

async function main() {
  console.log(`Receive stock (direct API) | dir: ${dir}`)
  console.log(`Org: ${orgSlug} | API: ${api} | mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)

  const files = readdirSync(dir).filter(f => /^stokrazp_\d+\.json$/i.test(f)).sort()
  if (!files.length) { console.error('No stokrazp_*.json in dir.'); process.exit(1) }

  await login()
  const whs = (await http('GET', org('/warehouse/warehouse?page=0&size=100'))).warehouses || []
  const wh = warehouseCode ? whs.find((w: any) => w.code === warehouseCode) : (whs.find((w: any) => w.isDefault) || whs[0])
  if (!wh) { console.error('Warehouse not found.'); process.exit(1) }
  console.log(`Warehouse: ${wh.name} (${wh.code})\n`)

  let ok = 0, failed = 0
  for (const f of files) {
    const doc: PlusMinusDocument = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    const docNumber = String((doc.header as any)?.docNumber || '')
    if (only && !only.has(docNumber)) continue
    try {
      const m = mapStokrazpDoc(doc)
      console.log(`── ${m.docNumber} (${m.date})${m.partner ? ` — ${m.partner}` : ''}: ${m.receiptItems.length} receipt line(s), ${m.adjustmentLines.length} adjustment line(s) ──`)
      if (m.receiptItems.length) await bookReceipt(m.docNumber, m.date, m.partner, m.receiptItems)
      if (m.adjustmentLines.length) await bookAdjustment(m.docNumber, m.date, m.adjustmentLines, wh)
      ok++
    } catch (e: any) {
      console.log(`✗ ${f}: ${e?.message || e}`)
      failed++
    }
  }
  console.log(`\n${execute ? 'Processed' : 'Would process'}: ${ok} document(s), ${failed} failed`)
  if (!execute) console.log('Dry-run — receipts/adjustments not yet written. Re-run with --execute.')
}

await main()
