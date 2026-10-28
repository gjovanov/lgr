/**
 * Daily sales-invoice import DIRECTLY from PlusMinus's own `/mobile` API data — no PDF, no OCR,
 * no remote desktop. Reads the JSON `pull-plusminus-api` already wrote
 * (`_docs/<org>/<day>/api/invoicem_*.json`), maps each straight to a `DocumentExtraction`
 * (`map-plusminus-invoice.ts` — PlusMinus's own structured data IS the extraction), and pushes it
 * through the SAME, already-proven matching/VAT/counter/dedup/stock-dispatch engine the OCR path
 * uses — via `POST /doc-import/analyze` (with the pre-built `draft`, skipping OCR/AI entirely) →
 * `POST /doc-import/commit` (create + issue).
 *
 * Companion to `scripts/import-sales-invoices.ts` (which drives the OCR path from PDFs) — same
 * credentials, same safety-gate philosophy, same CLI ergonomics where they apply.
 *
 * Safety gates (per invoice, must ALL pass before commit/convert):
 *   - the source JSON has a `header.docNumber` — a document missing one is skipped before it
 *     ever reaches the API
 *   - `header.sum` is not negative — the printed tell for a Кредитно/Дебитно известие (credit /
 *     debit note), which this mapper does not yet know how to type correctly (see
 *     `map-plusminus-invoice.ts`'s header comment — PlusMinus's JSON has no confirmed structural
 *     signal for these yet). A negative-sum document is skipped with a warning rather than mapped
 *     as a malformed plain invoice; import it via the existing PDF/OCR `import-sales-invoices`
 *     skill instead, which detects the type from the printed title.
 *   - direction resolved to `outgoing` and not flagged uncertain (`--include-uncertain` overrides)
 *   - not already imported (dedup by reference/invoiceNumber, same as the OCR script)
 *
 * ⚠ regal-sf ONLY: this script does not (yet) check till-overlap — a sale rung on the till AND
 * separately invoiced must not dispatch stock twice (memory `lgr-regal-sf-org`: historically
 * roughly a third of regal-sf's daily invoices are till-duplicates). That check needs the day's
 * till (storeOperations) ALREADY committed in LGR, which is separate, not-yet-built scope. Until
 * that lands, run regal-sf through this script with `--no-stock` and reconcile stock separately
 * once the till is in — do NOT `--convert` with stock dispatch for regal-sf before that.
 *
 * Usage:
 *   bun run scripts/import-sales-invoices-api.ts --dir <dir with invoicem_*.json>   # analyze + summary (no commit)
 *   bun run scripts/import-sales-invoices-api.ts --dir <dir> --convert              # ...then commit+issue eligible documents
 *
 * Options:
 *   --dir <dir>            (required) folder with invoicem_<number>.json (pull-plusminus-api's output)
 *   --org <slug>           org slug (default: regal-pz)
 *   --api <url>            API base (default: https://lgrai.app)
 *   --warehouse <code>     warehouse code (default: the org's isDefault warehouse)
 *   --convert              commit AND issue eligible documents to INV-<legacy number>
 *   --no-stock             convert WITHOUT dispatching stock
 *   --include-uncertain    also convert documents flagged needs-review (direction uncertain)
 *   --only <nums>          comma-separated invoice numbers to limit the run to
 *
 * Credentials (env): LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD (login via /api/auth/login).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertTokenOrg } from './lib/token-org.js'
import {
  plusminusInvoiceToExtraction,
  buildSyntheticRawText,
  type PlusMinusDocument,
} from '../packages/services/src/biz/doc-import/map-plusminus-invoice.js'

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
const dir = args.dir as string
const orgSlug = (args.org as string) || 'regal-pz'
const api = ((args.api as string) || 'https://lgrai.app').replace(/\/$/, '')
const warehouseCode = args.warehouse as string | undefined
const doConvert = !!args.convert
const noStock = !!args['no-stock']
const includeUncertain = !!args['include-uncertain']
const only = args.only ? new Set(String(args.only).split(',').map(s => s.trim())) : null

if (!dir) { console.error('Required: --dir <dir with invoicem_*.json>. See header for options.'); process.exit(2) }

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

async function login(): Promise<any> {
  if (TOKEN) {
    const me = await http('GET', '/api/auth/me')
    assertTokenOrg(me, orgSlug) // a token from a tab switched to another org must not write there
    ORG_ID = me.user?.orgId || me.orgId
    if (!ORG_ID) throw new Error('LGR_TOKEN valid but orgId missing from /auth/me')
    console.log(`auth: token (user ${me.user?.username ?? '?'}) org ${orgSlug} (${ORG_ID})`)
    return me
  }
  const username = process.env.LGR_USERNAME
  const password = process.env.LGR_PASSWORD
  if (!username || !password) { console.error('Set LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.'); process.exit(2) }
  const res = await http('POST', '/api/auth/login', { orgSlug, username, password })
  TOKEN = res.token
  ORG_ID = res.org?.id || res.user?.orgId
  console.log(`auth: logged in as ${username} → org ${orgSlug} (${ORG_ID})`)
  return await http('GET', '/api/auth/me')
}

interface SrcFile { num: string; name: string; doc: PlusMinusDocument }

function scanFolder(): SrcFile[] {
  const out: SrcFile[] = []
  for (const f of readdirSync(dir)) {
    const m = /^invoicem_(\d+)\.json$/i.exec(f)
    if (!m) continue
    if (only && !only.has(m[1])) continue
    const doc: PlusMinusDocument = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    out.push({ num: m[1], name: f, doc })
  }
  out.sort((a, b) => a.num.localeCompare(b.num))
  return out
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

async function pollTask(taskId: string, maxMs = 5 * 60_000): Promise<any> {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const t = await http('GET', org(`/doc-import/task/${taskId}`))
    if (t.status === 'completed') return t.result
    if (t.status === 'failed') throw new Error(`task ${taskId} failed: ${t.error}`)
    await Bun.sleep(1000)
  }
  throw new Error(`task ${taskId} timed out`)
}

async function main() {
  console.log(`Import sales invoices (direct API) | dir: ${dir}`)
  console.log(`Org: ${orgSlug} | API: ${api} | mode: ${doConvert ? 'ANALYZE + COMMIT + CONVERT' : 'ANALYZE ONLY (no commit)'}${doConvert ? (noStock ? ' | stock: SKIP' : ' | stock: dispatch') : ''}`)
  console.log()

  const files = scanFolder()
  if (!files.length) { console.error('No invoicem_*.json files found in dir.'); process.exit(1) }
  console.log(`Files found: ${files.length} (${files[0].num} … ${files[files.length - 1].num})`)

  const me = await login()
  const o = me.org || {}
  const addr = (o.addresses || [])[0] || {}
  const supplier = {
    name: o.name || orgSlug,
    eik: String(o.taxNumber || o.vatNumber || '').replace(/\D/g, ''),
    vatNumber: o.vatNumber as string | undefined,
    address: addr.street as string | undefined,
    city: addr.city as string | undefined,
  }
  if (!supplier.eik) { console.error("Could not resolve the org's own ЕИК from /auth/me — needed so direction resolves to outgoing."); process.exit(1) }
  console.log(`Supplier identity: ${supplier.name} (ЕИК ${supplier.eik})`)

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
  const todo: SrcFile[] = []
  for (const f of files) {
    const hit = byNum.get(f.num)
    if (!hit) { todo.push(f); continue }
    console.log(`  ✓ ${f.num} already imported (${hit.invoiceNumber}, ${hit.status}) — skip`)
  }
  console.log(`New to import: ${todo.length} | already issued/drafted: ${files.length - todo.length}`)

  // ── pre-flight: refuse what this path cannot safely type ──
  const skipped: Array<{ num: string; reason: string }> = []
  const candidates: SrcFile[] = []
  for (const f of todo) {
    if (!f.doc?.header?.docNumber) { skipped.push({ num: f.num, reason: 'no header.docNumber' }); continue }
    const sum = Number(f.doc.header.sum)
    if (Number.isFinite(sum) && sum < 0) {
      skipped.push({ num: f.num, reason: `header.sum is negative (${sum}) — likely a credit/debit note; use the PDF/OCR skill for this one` })
      continue
    }
    candidates.push(f)
  }
  for (const s of skipped) console.log(`  ⚠ ${s.num}: ${s.reason} — skipped`)

  // ── analyze (draft supplied directly — skips OCR/AI entirely) ──
  // One HTTP round trip per document, each wrapped: a server error or timeout on one invoice
  // must not abandon the rest of the day's batch (same principle commitDocuments itself follows).
  const rows: any[] = []
  for (const f of candidates) {
    let result: any
    try {
      const extraction = plusminusInvoiceToExtraction(f.doc, supplier)
      // analyzeOne reads rawText from `item.text` independently of `item.draft` — placeOfTransaction
      // /paymentMethod/terms are parsed from THAT, not from the extraction, so it must be sent too.
      const rawText = buildSyntheticRawText(f.doc.header)
      const draft = { extraction, validation: { status: 'valid', checks: [] }, model: 'direct', engine: 'plusminus-api' }
      const res = await http('POST', org('/doc-import/analyze'), {
        target: 'sales_invoice',
        items: [{ fileId: `plusminus:${f.num}`, filename: f.name, text: rawText, draft }],
        // Load-bearing: without this, every matched line's warehouseId stays unset
        // (map-invoice.ts only sets it when opts.warehouseId is present), and convert later
        // throws "Refusing to book stock ... no warehouseId" AFTER the invoice is already
        // issued — found live 2026-10-28 on regal-pz's first real batch (16 invoices issued
        // with no stock movement, fixed by a one-off remediation script; see git history).
        context: { warehouseId: wh._id },
      })
      result = await pollTask(res.taskId)
    } catch (e: any) { rows.push({ num: f.num, ok: false, problems: [String(e?.message || e)] }); continue }
    const doc = result?.results?.[0]
    if (!doc || doc.error) { rows.push({ num: f.num, ok: false, problems: [doc?.error || 'analyze returned no result'] }); continue }

    const warnings: string[] = doc.diagnostics?.warnings || []
    const uncertain = !!doc.uncertain
    const problems: string[] = []
    if (doc.direction !== 'outgoing') problems.push(`direction=${doc.direction}`)
    if (doc.duplicate) problems.push(`duplicate: ${doc.duplicate.reason} — ${doc.duplicate.number}`)
    if (uncertain && !includeUncertain) problems.push('uncertain (needs-review)')
    if (String(doc.mapped?.reference) !== f.num) problems.push(`reference ${doc.mapped?.reference} != filename ${f.num}`)

    rows.push({ num: f.num, ok: problems.length === 0, problems, warnings, mapped: doc.mapped })
  }

  console.log('\n─── Analysis summary ───')
  for (const r of rows) {
    const flag = r.ok ? 'OK ' : '✗  '
    const m = r.mapped
    console.log(`  ${flag} ${r.num} ${String(m?.contactName || '?').slice(0, 34).padEnd(36)} ${String((m?.lines || []).length).padStart(2)} lines  ${Number(m?.total ?? 0).toFixed(2)} ${m?.currency ?? ''}${r.problems?.length ? '   ⚠ ' + r.problems.join('; ') : ''}${r.warnings?.length ? '   (' + r.warnings.join('; ') + ')' : ''}`)
  }
  const eligible = rows.filter(r => r.ok)
  console.log(`Eligible for commit: ${eligible.length}/${rows.length} (pre-flight skipped: ${skipped.length})`)

  if (!doConvert) {
    console.log('\nAnalyze-only run complete. Review above, then re-run with --convert.')
    return
  }
  if (!eligible.length) { console.log('\nNothing eligible to commit.'); return }

  // ── commit + convert (one call: options.convert issues immediately after creating) ──
  const mvBefore = (await http('GET', org('/warehouse/movement?page=0&size=1'))).total ?? 0
  const commitItems = eligible.map(r => ({
    fileId: `plusminus:${r.num}`,
    mapped: r.mapped,
    options: { convert: true, adjustStock: !noStock },
  }))
  const res = await http('POST', org('/doc-import/commit'), { target: 'sales_invoice', items: commitItems })
  const result = await pollTask(res.taskId)
  const results: any[] = result?.results || []
  console.log('\n─── Commit + convert ───')
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const row = eligible[i]
    console.log(`  ${r.ok ? '✓' : '✗'} ${row.num} → ${r.issuedNumber || r.number || r.error}`)
  }
  const mvAfter = (await http('GET', org('/warehouse/movement?page=0&size=1'))).total ?? 0
  console.log(`Converted: ${results.filter(r => r.ok).length}/${eligible.length} | stock movements: ${mvBefore} → ${mvAfter} (+${mvAfter - mvBefore})`)

  // sequence check: SALES_DOC must now be ≥ max imported number
  try {
    const seqs = (await http('GET', org('/invoicing/sequences'))).sequences || []
    const sales = seqs.find((s: any) => s.prefix === 'SALES_DOC')
    const maxNum = Math.max(...eligible.map(r => Number(r.num)))
    if (sales) console.log(`SALES_DOC counter: ${sales.lastNumber ?? '?'} (max imported: ${maxNum}) ${Number(sales.lastNumber) >= maxNum ? 'OK' : '⚠ NOT BUMPED'}`)
  } catch { /* sequences endpoint is admin-only; non-fatal */ }
}

await main()
