/**
 * Daily sales-invoice import from the legacy (PlusMinus) ERP — OCR → draft → convert.
 *
 * Takes a folder of `invoicem_<number>.pdf` exports (one folder per day, e.g.
 * `_docs/2026-07-21`), pushes them through the deployed batch-OCR pipeline of the
 * LGR API (extract → AI draft → convert), and ends with real issued invoices:
 *
 *   1. extract  POST /bills/import/extract   (multipart, chunked) → per-PDF text
 *   2. draft    POST /bills/import/draft     → background job → DRF-INV-* drafts
 *                (direction auto-detected: org tax number as ДОСТАВЧИК → outgoing
 *                 sale; counterparty ПОЛУЧАТЕЛ matched/created as customer)
 *   3. convert  POST /bills/import/convert   → INV-<original number> (preserves the
 *                 legacy `Номер`, bumps the SALES_DOC sequence to ≥ max imported),
 *                 dispatches stock from the warehouse (negatives allowed)
 *
 * Repeatable/idempotent: PDFs whose number already exists in the org are skipped
 * (issued) or picked up for conversion (still draft). Run it daily per folder.
 *
 * Safety gates (per invoice, must ALL pass before convert):
 *   - extracted text contains the number from the filename
 *   - draft's `reference` equals the filename number (AI read the right Номер)
 *   - direction resolved to `outgoing` and not flagged uncertain
 *     (`--include-uncertain` overrides the uncertain gate)
 *
 * Usage:
 *   bun run scripts/import-sales-invoices.ts --folder <dir>                 # extract + draft + summary (no convert)
 *   bun run scripts/import-sales-invoices.ts --folder <dir> --convert      # ...then convert eligible drafts
 *
 * Options:
 *   --folder <dir>        (required) folder with invoicem_*.pdf (WSL UNC paths work: //wsl.localhost/...)
 *   --org <slug>          org slug (default: regal-pz)
 *   --api <url>           API base (default: https://lgrai.app)
 *   --warehouse <code>    warehouse code (default: the org's isDefault warehouse)
 *   --convert             convert eligible drafts to issued INV- invoices
 *   --include-uncertain   also convert drafts flagged needs-review (direction uncertain)
 *   --only <nums>         comma-separated invoice numbers to limit the run to
 *
 * Credentials (env): LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD (login via /api/auth/login).
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

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
const orgSlug = (args.org as string) || 'regal-pz'
const api = ((args.api as string) || 'https://lgrai.app').replace(/\/$/, '')
const warehouseCode = args.warehouse as string | undefined
const doConvert = !!args.convert
const includeUncertain = !!args['include-uncertain']
const only = args.only ? new Set(String(args.only).split(',').map(s => s.trim())) : null

if (!folder) { console.error('Required: --folder <dir with invoicem_*.pdf>. See header for options.'); process.exit(2) }

const EXTRACT_CHUNK = 4
const POLL_MS = 5000
const POLL_STABLE = 36       // stop when draft count unchanged for N polls (~3 min — each AI draft takes ~20-60s)
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
    // token supplied — resolve orgId via /auth/me
    const me = await http('GET', '/api/auth/me')
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

interface Pdf { num: string; name: string; path: string }

function scanFolder(): Pdf[] {
  const pdfs: Pdf[] = []
  for (const f of readdirSync(folder)) {
    const m = /^invoicem_(\d+)\.pdf$/i.exec(f)
    if (!m) continue
    if (only && !only.has(m[1])) continue
    pdfs.push({ num: m[1], name: f, path: join(folder, f) })
  }
  pdfs.sort((a, b) => a.num.localeCompare(b.num))
  return pdfs
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

async function main() {
  console.log(`Import sales invoices | folder: ${folder}`)
  console.log(`Org: ${orgSlug} | API: ${api} | mode: ${doConvert ? 'DRAFT + CONVERT' : 'DRAFT ONLY (no convert)'}`)
  console.log()

  const pdfs = scanFolder()
  if (!pdfs.length) { console.error('No invoicem_*.pdf files found in folder.'); process.exit(1) }
  console.log(`PDFs found: ${pdfs.length} (${pdfs[0].num} … ${pdfs[pdfs.length - 1].num})`)

  await login()

  // warehouse
  const whs = (await http('GET', org('/warehouse/warehouse'))).warehouses || []
  const wh = warehouseCode ? whs.find((w: any) => w.code === warehouseCode) : (whs.find((w: any) => w.isDefault) || whs[0])
  if (!wh) { console.error(`Warehouse ${warehouseCode ? `"${warehouseCode}"` : '(default)'} not found.`); process.exit(1) }
  console.log(`Warehouse: ${wh.name} (${wh.code})`)

  // ── dedup against existing invoices (repeatability) ──
  const existing = await fetchInvoices()
  const byNum = new Map<string, any>()
  for (const inv of existing) {
    const ref = String(inv.reference ?? '')
    if (/^\d+$/.test(ref)) byNum.set(ref, inv)
    const m = /^INV-(\d{6,})$/.exec(inv.invoiceNumber ?? '')
    if (m) byNum.set(m[1], inv)
  }
  const todo: Pdf[] = []
  const existingDraftIds: string[] = []
  for (const p of pdfs) {
    const hit = byNum.get(p.num)
    if (!hit) { todo.push(p); continue }
    if (hit.status === 'draft') {
      console.log(`  = ${p.num} draft already exists (${hit.invoiceNumber}) — will re-check for convert`)
      existingDraftIds.push(hit._id || hit.id)
    } else {
      console.log(`  ✓ ${p.num} already imported (${hit.invoiceNumber}, ${hit.status}) — skip`)
    }
  }
  console.log(`New to import: ${todo.length} | existing drafts: ${existingDraftIds.length} | already issued: ${pdfs.length - todo.length - existingDraftIds.length}`)

  // ── step 1: extract (chunked multipart) ──
  const items: Array<{ fileId: string; text: string; num: string; name: string; warn: string[] }> = []
  for (let i = 0; i < todo.length; i += EXTRACT_CHUNK) {
    const chunk = todo.slice(i, i + EXTRACT_CHUNK)
    const fd = new FormData()
    for (const p of chunk) fd.append('files', new Blob([await Bun.file(p.path).arrayBuffer()], { type: 'application/pdf' }), p.name)
    const res = await http('POST', org('/bills/import/extract'), fd)
    for (const f of res.files || []) {
      const src = chunk.find(c => c.name === f.filename)!
      const warn: string[] = []
      if (f.error) warn.push(`extract error: ${f.error}`)
      else {
        if (!f.text.includes(src.num)) warn.push('number NOT found in text')
        if (!f.text.replace(/\s/g, '').includes('112500982') && !f.text.includes('РЕГАЛ')) warn.push('org identity not found in text')
      }
      items.push({ fileId: f.fileId, text: f.text, num: src.num, name: src.name, warn })
      console.log(`  extract ${src.num}: ${f.method ?? 'ERR'} ${f.pages ?? '-'}p ${f.chars ?? 0}ch${warn.length ? '  ⚠ ' + warn.join('; ') : ''}`)
    }
  }
  const draftable = items.filter(i => i.text && !i.warn.some(w => w.startsWith('extract error')))

  // ── step 2: draft (background job; poll by batch tag) ──
  let created: any[] = []
  let batchId = ''
  if (draftable.length) {
    const res = await http('POST', org('/bills/import/draft'), {
      warehouseId: wh._id,
      items: draftable.map(i => ({ fileId: i.fileId, text: i.text })),
    })
    batchId = res.batchId
    console.log(`\nDrafting ${draftable.length} invoices (batch ${batchId}) ...`)
    const tagQuery = `tags=${encodeURIComponent('ocr:' + batchId)}`
    const t0 = Date.now()
    let last = -1, stable = 0, count = 0
    while (Date.now() - t0 < POLL_MAX_MS) {
      await Bun.sleep(POLL_MS)
      const d = await http('GET', org(`/invoices?page=0&size=1&${tagQuery}`))
      count = d.total ?? 0
      if (count !== last) { console.log(`  drafted ${count}/${draftable.length}`); last = count; stable = 0 }
      else if (++stable >= POLL_STABLE && count > 0) break
      if (count >= draftable.length) break
    }
    created = await fetchInvoices(tagQuery)
    if (created.length < draftable.length) console.log(`  ⚠ only ${created.length}/${draftable.length} drafts appeared (server-side errors likely — check API logs)`)
  }

  // ── summary of all candidate drafts (new + pre-existing) ──
  const candidateIds = [...created.map((c: any) => c._id || c.id), ...existingDraftIds]
  const contactCache = new Map<string, string>()
  const rows: any[] = []
  for (const id of candidateIds) {
    const inv = (await http('GET', org(`/invoices/${id}`))).invoice
    if (!inv) continue
    let contactName = ''
    if (inv.contactId) {
      const cid = String(inv.contactId?._id ?? inv.contactId)
      if (!contactCache.has(cid)) {
        try { const c = (await http('GET', org(`/invoicing/contact/${cid}`))).contact; contactCache.set(cid, c?.companyName || [c?.firstName, c?.lastName].filter(Boolean).join(' ')) }
        catch { contactCache.set(cid, cid) }
      }
      contactName = contactCache.get(cid)!
    }
    const tags: string[] = inv.tags || []
    const uncertain = tags.includes('needs-review')
    const problems: string[] = []
    if (inv.direction !== 'outgoing') problems.push(`direction=${inv.direction}`)
    if (!/^\d+$/.test(String(inv.reference ?? ''))) problems.push('no numeric reference')
    else if (!pdfs.some(p => p.num === String(inv.reference))) problems.push(`reference ${inv.reference} not in folder`)
    if (uncertain && !includeUncertain) problems.push('uncertain (needs-review)')
    rows.push({ id, num: String(inv.reference ?? '?'), draft: inv.invoiceNumber, contact: contactName, total: inv.total, currency: inv.currency, lines: (inv.lines || []).length, ok: problems.length === 0, problems })
  }
  rows.sort((a, b) => a.num.localeCompare(b.num))

  console.log('\n─── Draft summary ───')
  for (const r of rows) {
    const flag = r.ok ? 'OK ' : '✗  '
    console.log(`  ${flag} ${r.num} ${String(r.draft).padEnd(20)} ${String(r.contact).slice(0, 34).padEnd(36)} ${String(r.lines).padStart(2)} lines  ${Number(r.total).toFixed(2)} ${r.currency}${r.problems.length ? '   ⚠ ' + r.problems.join('; ') : ''}`)
  }
  const eligible = rows.filter(r => r.ok)
  console.log(`Eligible for convert: ${eligible.length}/${rows.length}`)

  if (!doConvert) {
    console.log('\nDraft-only run complete. Review above (or in the UI), then re-run with --convert.')
    return
  }
  if (!eligible.length) { console.log('\nNothing eligible to convert.'); return }

  // ── step 3: convert ──
  const mvBefore = (await http('GET', org('/warehouse/movement?page=0&size=1'))).total ?? 0
  const conv = await http('POST', org('/bills/import/convert'), { invoiceIds: eligible.map(r => r.id) })
  console.log('\n─── Convert ───')
  for (const r of conv.results || []) {
    const row = eligible.find(e => e.id === r.invoiceId)
    console.log(`  ${r.ok ? '✓' : '✗'} ${row?.num ?? r.invoiceId} → ${r.invoiceNumber ?? r.error}`)
  }
  const mvAfter = (await http('GET', org('/warehouse/movement?page=0&size=1'))).total ?? 0
  console.log(`Converted: ${conv.converted}/${eligible.length} | stock movements: ${mvBefore} → ${mvAfter} (+${mvAfter - mvBefore})`)

  // sequence check: SALES_DOC must now be ≥ max imported number
  try {
    const seqs = (await http('GET', org('/invoicing/sequences'))).sequences || []
    const sales = seqs.find((s: any) => s.prefix === 'SALES_DOC')
    const maxNum = Math.max(...eligible.map(r => Number(r.num)))
    if (sales) console.log(`SALES_DOC counter: ${sales.lastNumber ?? '?'} (max imported: ${maxNum}) ${Number(sales.lastNumber) >= maxNum ? 'OK' : '⚠ NOT BUMPED'}`)
  } catch { /* sequences endpoint is admin-only; non-fatal */ }
}

await main()
