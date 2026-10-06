/**
 * Purchase-invoice import against an Order (ORD-) — OCR → AI draft → receive.
 *
 * Takes a folder of supplier invoice PDFs (any filenames) plus the ORD- number they
 * belong to, and pushes them through the deployed ORD-aware batch pipeline:
 *
 *   1. extract  POST /bills/import/extract   (multipart, chunked) → per-PDF text
 *   2. draft    POST /bills/import/draft     ({ warehouseId, orderId, items }) →
 *                background job → DRF-BILL-* drafts. Per line the matching ladder is
 *                learned supplier alias → exact name/SKU → AI against the order
 *                group's products (DIN/ISO wording); matched quantities are split
 *                across the order line's warehouse allocations (orderRef per part).
 *   3. convert  POST /bills/import/convert   → BILL-<supplier №> received: books the
 *                stock receipt per warehouse, learns supplier aliases from confirmed
 *                lines, updates the order's receivedQuantity/status and activates the
 *                client-reservation stock holds.
 *
 * Repeatable: drafts are deduplicated by supplier document number (reference) in the
 * summary gate — already-issued references are excluded from convert.
 *
 * Safety gates (per draft, must ALL pass before convert):
 *   - direction resolved to `incoming` (org is the ПОЛУЧАТЕЛ/customer on the PDF)
 *   - the supplier matched a group of the requested order (tag ord:<ORD number>)
 *   - has a supplier document number (reference) not already issued in LGR
 *   - not flagged needs-review (`--include-uncertain` overrides)
 *
 * Usage:
 *   bun run scripts/import-purchase-invoices.ts --folder <dir> --order ORD-2026-00001              # draft + summary
 *   bun run scripts/import-purchase-invoices.ts --folder <dir> --order ORD-2026-00001 --convert    # ...then receive
 *
 * Options:
 *   --folder <dir>        (required) folder with supplier invoice PDFs
 *   --order <number>      (required) the ORD- number these deliveries belong to
 *   --org <slug>          org slug (default: regal-pz)
 *   --api <url>           API base (default: https://lgrai.app)
 *   --warehouse <code>    fallback warehouse code (default: the org's isDefault) —
 *                         order allocations decide where matched lines go
 *   --convert             convert eligible drafts → received bills (stock + order sync)
 *   --no-stock            convert WITHOUT booking the stock receipt (rare — e.g. the
 *                         delivery was already booked via the storeOperations import)
 *   --include-uncertain   also convert drafts flagged needs-review
 *
 * Credentials (env): LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD (login via /api/auth/login).
 *
 * ⚠ Double-receipt guard (regal ops): a delivery received here must NOT also be booked
 *   by the daily `receive-stock` (storeOperations Доставки) import — skip those rows
 *   there, or run this with --no-stock and let receive-stock book the quantities.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { assertTokenOrg } from './lib/token-org.js'

// ── args ──
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
const folder = args.folder as string
const orderNumber = args.order as string
const orgSlug = (args.org as string) || 'regal-pz'
const api = ((args.api as string) || 'https://lgrai.app').replace(/\/$/, '')
const warehouseCode = args.warehouse as string | undefined
const doConvert = !!args.convert
const noStock = !!args['no-stock']
const includeUncertain = !!args['include-uncertain']

if (!folder || !orderNumber) {
  console.error('Required: --folder <dir with supplier PDFs> --order <ORD- number>. See header for options.')
  process.exit(2)
}

const EXTRACT_CHUNK = 4
const POLL_MS = 5000
const POLL_STABLE = 36
const POLL_MAX_MS = 30 * 60_000

let TOKEN = process.env.LGR_TOKEN || ''
let ORG_ID = ''

async function http(method: string, path: string, body?: any): Promise<any> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }
  let payload: any
  if (body instanceof FormData) payload = body
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
  const res = await fetch(`${api}${path}`, { method, headers, body: payload })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`)
  return json
}
const org = (path: string) => `/api/org/${ORG_ID}${path}`

async function login() {
  if (TOKEN) {
    const me = await http('GET', '/api/auth/me')
    assertTokenOrg(me, orgSlug) // a token from a tab switched to another org must not write there
    ORG_ID = me.user?.orgId || me.orgId
    if (!ORG_ID) throw new Error('LGR_TOKEN valid but orgId missing from /auth/me')
    console.log(`auth: token (user ${me.user?.username ?? '?'}) org ${orgSlug} (${ORG_ID})`)
    return
  }
  const username = process.env.LGR_USERNAME
  const password = process.env.LGR_PASSWORD
  if (!username || !password) { console.error('Set LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.'); process.exit(2) }
  const res = await http('POST', '/api/auth/login', { orgSlug, username, password })
  TOKEN = res.token
  ORG_ID = res.org?.id || res.user?.orgId
  console.log(`auth: logged in as ${username} → org ${orgSlug} (${ORG_ID})`)
}

function scanFolder(): Array<{ name: string; path: string }> {
  return readdirSync(folder)
    .filter((f) => /\.pdf$/i.test(f))
    .sort()
    .map((f) => ({ name: f, path: join(folder, f) }))
}

// Invoice list pagination is 0-based `page` + `size` (default 10).
async function fetchInvoices(extraQuery = ''): Promise<any[]> {
  const all: any[] = []
  for (let page = 0; page < 200; page++) {
    const d = await http('GET', org(`/invoices?page=${page}&size=200${extraQuery ? '&' + extraQuery : ''}`))
    const items = d.invoices || []
    all.push(...items)
    if (!items.length || all.length >= (d.total ?? 0)) break
  }
  return all
}

function orderTotals(order: any): { ordered: number; received: number } {
  let ordered = 0
  let received = 0
  for (const g of order?.supplierGroups || [])
    for (const l of g.lines || []) {
      ordered += Number(l.quantity) || 0
      received += Number(l.receivedQuantity) || 0
    }
  return { ordered, received }
}

async function main() {
  console.log(`Import purchase invoices | folder: ${folder} | order: ${orderNumber}`)
  console.log(`Org: ${orgSlug} | API: ${api} | mode: ${doConvert ? 'DRAFT + CONVERT' : 'DRAFT ONLY (no convert)'}${doConvert ? (noStock ? ' | stock: SKIP' : ' | stock: receive') : ''}`)
  console.log()

  const pdfs = scanFolder()
  if (!pdfs.length) { console.error('No *.pdf files found in folder.'); process.exit(1) }
  console.log(`PDFs found: ${pdfs.length}`)

  await login()

  // ── resolve the order ──
  const search = await http('GET', org(`/invoicing/orders?search=${encodeURIComponent(orderNumber)}&size=20`))
  const order = (search.orders || []).find((o: any) => o.orderNumber === orderNumber)
  if (!order) { console.error(`Order ${orderNumber} not found (searched ${search.orders?.length ?? 0} matches).`); process.exit(1) }
  if (!['sent', 'partially_received', 'received'].includes(order.status)) {
    console.error(`Order ${orderNumber} is ${order.status} — only sent/partially_received/received orders accept receipts.`)
    process.exit(1)
  }
  const before = orderTotals((await http('GET', org(`/invoicing/orders/${order._id}`))).order)
  console.log(`Order: ${order.orderNumber} (${order.status}) suppliers: ${(order.supplierNames || []).join(', ')} | received ${before.received}/${before.ordered}`)

  // fallback warehouse
  const whs = (await http('GET', org('/warehouse/warehouse?size=1000'))).warehouses || []
  const wh = warehouseCode ? whs.find((w: any) => w.code === warehouseCode) : (whs.find((w: any) => w.isDefault) || whs[0])
  if (!wh) { console.error(`Warehouse ${warehouseCode ? `"${warehouseCode}"` : '(default)'} not found.`); process.exit(1) }
  console.log(`Fallback warehouse: ${wh.name} (${wh.code}) — order allocations take precedence`)

  // existing incoming references (dedup at the summary gate)
  const existingBills = await fetchInvoices('direction=incoming')
  const issuedRefs = new Set(existingBills.filter((b: any) => b.status !== 'draft').map((b: any) => String(b.reference ?? '')).filter(Boolean))

  // ── step 1: extract ──
  const items: Array<{ fileId: string; text: string; name: string; warn: string[] }> = []
  for (let i = 0; i < pdfs.length; i += EXTRACT_CHUNK) {
    const chunk = pdfs.slice(i, i + EXTRACT_CHUNK)
    const fd = new FormData()
    for (const p of chunk) fd.append('files', new Blob([await Bun.file(p.path).arrayBuffer()], { type: 'application/pdf' }), p.name)
    const res = await http('POST', org('/bills/import/extract'), fd)
    for (const f of res.files || []) {
      const warn: string[] = []
      if (f.error) warn.push(`extract error: ${f.error}`)
      items.push({ fileId: f.fileId, text: f.text, name: f.filename, warn })
      console.log(`  extract ${f.filename}: ${f.method ?? 'ERR'} ${f.pages ?? '-'}p ${f.chars ?? 0}ch${warn.length ? '  ⚠ ' + warn.join('; ') : ''}`)
    }
  }
  const draftable = items.filter((i) => i.text && !i.warn.some((w) => w.startsWith('extract error')))

  // ── step 2: draft (ORD-aware background job; poll by batch tag) ──
  let created: any[] = []
  if (draftable.length) {
    const res = await http('POST', org('/bills/import/draft'), {
      warehouseId: wh._id,
      orderId: order._id,
      items: draftable.map((i) => ({ fileId: i.fileId, text: i.text })),
    })
    const batchId = res.batchId
    console.log(`\nDrafting ${draftable.length} bills (batch ${batchId}) ...`)
    const tagQuery = `tags=${encodeURIComponent('ocr:' + batchId)}`
    const t0 = Date.now()
    let last = -1
    let stable = 0
    while (Date.now() - t0 < POLL_MAX_MS) {
      await Bun.sleep(POLL_MS)
      const d = await http('GET', org(`/invoices?page=0&size=1&${tagQuery}`))
      const count = d.total ?? 0
      if (count !== last) { console.log(`  drafted ${count}/${draftable.length}`); last = count; stable = 0 }
      else if (++stable >= POLL_STABLE && count > 0) break
      if (count >= draftable.length) break
    }
    created = await fetchInvoices(tagQuery)
    if (created.length < draftable.length) console.log(`  ⚠ only ${created.length}/${draftable.length} drafts appeared (server-side errors likely — check API logs)`)
  }

  // ── summary + gates ──
  const rows: any[] = []
  for (const c of created) {
    const inv = (await http('GET', org(`/invoices/${c._id || c.id}`))).invoice
    if (!inv) continue
    const tags: string[] = inv.tags || []
    const matched = (inv.lines || []).filter((l: any) => l.productId).length
    const ordLinked = tags.includes(`ord:${orderNumber}`)
    const problems: string[] = []
    if (inv.direction !== 'incoming') problems.push(`direction=${inv.direction}`)
    if (!ordLinked) problems.push(tags.includes('ord-unmatched') ? 'supplier not in this order' : 'not linked to the order')
    if (!String(inv.reference ?? '').trim()) problems.push('no supplier document number')
    else if (issuedRefs.has(String(inv.reference))) problems.push(`reference ${inv.reference} already issued`)
    if (tags.includes('needs-review') && !includeUncertain) problems.push('uncertain (needs-review)')
    rows.push({
      id: inv._id || inv.id,
      ref: String(inv.reference ?? '?'),
      draft: inv.invoiceNumber,
      contact: inv.contactId?.companyName || '',
      total: inv.total,
      currency: inv.currency,
      lines: (inv.lines || []).length,
      matched,
      ok: problems.length === 0,
      problems,
    })
  }
  rows.sort((a, b) => a.ref.localeCompare(b.ref))

  console.log('\n─── Draft summary ───')
  for (const r of rows) {
    console.log(`  ${r.ok ? 'OK ' : '✗  '} ${r.ref.padEnd(12)} ${String(r.draft).padEnd(22)} ${String(r.contact).slice(0, 30).padEnd(32)} ${String(r.matched).padStart(2)}/${String(r.lines).padEnd(3)} matched  ${Number(r.total).toFixed(2)} ${r.currency}${r.problems.length ? '   ⚠ ' + r.problems.join('; ') : ''}`)
  }
  const eligible = rows.filter((r) => r.ok)
  console.log(`Eligible for convert: ${eligible.length}/${rows.length}`)

  if (!doConvert) {
    console.log('\nDraft-only run complete. Review unmatched lines in the UI (fixes are learned as supplier aliases on convert), then re-run with --convert.')
    return
  }
  if (!eligible.length) { console.log('\nNothing eligible to convert.'); return }

  // ── step 3: convert (receive) ──
  const mvBefore = (await http('GET', org('/warehouse/movement?page=0&size=1'))).total ?? 0
  const conv = await http('POST', org('/bills/import/convert'), { invoiceIds: eligible.map((r) => r.id), adjustStock: !noStock })
  console.log('\n─── Convert ───')
  for (const r of conv.results || []) {
    const row = eligible.find((e) => e.id === r.invoiceId)
    console.log(`  ${r.ok ? '✓' : '✗'} ${row?.ref ?? r.invoiceId} → ${r.invoiceNumber ?? r.error}`)
  }
  const mvAfter = (await http('GET', org('/warehouse/movement?page=0&size=1'))).total ?? 0
  const after = orderTotals((await http('GET', org(`/invoicing/orders/${order._id}`))).order)
  const orderAfter = (await http('GET', org(`/invoicing/orders/${order._id}`))).order
  console.log(`Converted: ${conv.converted}/${eligible.length} | stock movements: ${mvBefore} → ${mvAfter} (+${mvAfter - mvBefore})`)
  console.log(`Order ${orderNumber}: received ${before.received} → ${after.received} of ${after.ordered} | status: ${orderAfter.status}`)
}

await main()
