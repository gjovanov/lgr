/**
 * Re-mirror EXISTING LGR sales invoices from PlusMinus's own `/mobile` API data — the repair
 * counterpart of `import-sales-invoices-api.ts` (which only creates invoices that are not there yet).
 *
 * Why it exists: a full-history audit of regal-pz (2026-11-01) found issued invoices whose LGR copy
 * does not match the PlusMinus document of the SAME number — service lines imported at a
 * placeholder price, an invoice that carried ANOTHER invoice's lines, a line quantity off by 100. The
 * importer cannot fix them (it skips any number it already holds), and rebuilding lines by hand
 * repeats mapping logic the importer already got right.
 *
 * So this runs the SAME mapping — `plusminusInvoiceToExtraction` → `POST /doc-import/analyze` with the
 * pre-built draft, product/contact/tax matching all server-side — and applies the resulting `mapped`
 * payload (contact, lines, totals, the „Словом" note) onto the existing invoice with `PUT /invoices/:id`.
 * It changes DOCUMENT CONTENT only. A PUT moves no stock and re-posts nothing (see the PUT handler):
 * the stock that a wrong invoice dispatched is brought right by the snapshot true-up
 * (`true-up-stock-api.ts`), and the ledger entry, if the org posts one, stays at its old amounts.
 *
 * Safety:
 *   - `--only` is REQUIRED: this never sweeps a folder. Name the invoices you mean.
 *   - dry-run by default: prints what would change per invoice, writes nothing.
 *   - only draft / sent / paid invoices are edited; voided and cancelled ones are refused.
 *   - a `paid` invoice keeps its payment figures: its TOTAL must already equal PlusMinus's, otherwise
 *     it is refused (a different total would need a payment correction, which is a person's call).
 *   - the contact must resolve to an existing contact; this does not create one.
 *   - re-read after the PUT; a total that did not take is reported as FAILED.
 *
 * Usage:
 *   bun run scripts/repair-invoices-from-plusminus.ts --dir <dir with invoicem_*.json> --only <number>,<number>
 *   bun run scripts/repair-invoices-from-plusminus.ts --dir <dir> --only <nums> --execute
 *
 * Options:
 *   --dir <dir>        (required) folder with invoicem_<number>.json (pull-plusminus-api's output)
 *   --only <nums>      (required) comma-separated invoice numbers
 *   --org <slug>       org slug (default: regal-pz)
 *   --api <url>        API base (default: https://lgrai.app)
 *   --warehouse <c>    warehouse code (default: the org's isDefault warehouse)
 *   --execute          actually PUT (default: dry-run)
 *
 * Credentials (env): LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { assertTokenOrg } from './lib/token-org.js'
import {
  plusminusInvoiceToExtraction,
  buildSyntheticRawText,
  type PlusMinusDocument,
} from '../packages/services/src/biz/doc-import/map-plusminus-invoice.js'

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
const execute = !!args.execute
const only = args.only ? String(args.only).split(',').map(s => s.trim()).filter(Boolean) : []

if (!dir || !only.length) { console.error('Required: --dir <dir with invoicem_*.json> and --only <invoice numbers>. See header.'); process.exit(2) }

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
    assertTokenOrg(me, orgSlug)
    ORG_ID = me.user?.orgId || me.orgId
    return me
  }
  const username = process.env.LGR_USERNAME
  const password = process.env.LGR_PASSWORD
  if (!username || !password) { console.error('Set LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.'); process.exit(2) }
  const res = await http('POST', '/api/auth/login', { orgSlug, username, password })
  TOKEN = res.token
  ORG_ID = res.org?.id || res.user?.orgId
  return await http('GET', '/api/auth/me')
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

/** The keys the invoice PUT accepts on a line — anything else (match diagnostics etc.) is dropped. */
const LINE_KEYS = ['productId', 'product', 'description', 'quantity', 'unit', 'unitPrice', 'discount', 'taxRate', 'taxAmount', 'lineTotal', 'warehouseId', 'priceExplanation', 'orderRef', 'sourceText'] as const
const pickLine = (l: any) => {
  const o: any = {}
  for (const k of LINE_KEYS) if (l[k] !== undefined && l[k] !== null) o[k] = l[k]
  return o
}
const round2 = (v: number) => Math.round(v * 100) / 100
/** GET /invoices/:id returns `contactId` POPULATED ({_id, companyName}); the list row and the mapped payload carry a bare id. */
const idOf = (x: any): string => String(x?._id ?? x?.id ?? x ?? '')
const sig = (lines: any[]) => lines.filter(l => Number(l.quantity)).map(l => `${l.productId ?? '∅'}|${+Number(l.quantity).toFixed(4)}|${+Number(l.unitPrice).toFixed(4)}`).sort().join(';')

async function main() {
  console.log(`Repair invoices from PlusMinus | dir: ${dir} | ${only.length} invoice(s) | org ${orgSlug} | mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)
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
  if (!supplier.eik) { console.error("Could not resolve the org's own ЕИК from /auth/me."); process.exit(1) }
  const whs = (await http('GET', org('/warehouse/warehouse'))).warehouses || []
  const wh = warehouseCode ? whs.find((w: any) => w.code === warehouseCode) : (whs.find((w: any) => w.isDefault) || whs[0])
  if (!wh) { console.error('Warehouse not found.'); process.exit(1) }

  let repaired = 0, refused = 0, same = 0
  for (const num of only) {
    const file = join(dir, `invoicem_${num}.json`)
    if (!existsSync(file)) { console.log(`✗ ${num}: ${file} not found`); refused++; continue }
    const pm: PlusMinusDocument = JSON.parse(readFileSync(file, 'utf8'))
    if (String(pm.header?.doc) !== '-ФЕ') { console.log(`✗ ${num}: header.doc is ${pm.header?.doc}, not -ФЕ — refused`); refused++; continue }
    if (Number(pm.header?.sum) < 0) { console.log(`✗ ${num}: negative total (credit-type) — typed by sign, not repaired here`); refused++; continue }

    const found = await http('GET', org(`/invoices?search=${encodeURIComponent('INV-' + num)}&page=0&size=10`))
    const cur = (found.invoices || []).find((i: any) => i.invoiceNumber === `INV-${num}`)
    if (!cur) { console.log(`✗ ${num}: INV-${num} is not in LGR — import it instead (import-sales-invoices-api.ts)`); refused++; continue }
    if (!['draft', 'sent', 'paid'].includes(cur.status)) { console.log(`✗ ${num}: status ${cur.status} — refused`); refused++; continue }
    const full = (await http('GET', org(`/invoices/${cur._id || cur.id}`))).invoice
    if (full.type !== 'invoice') { console.log(`✗ ${num}: LGR type is ${full.type}, not invoice — refused`); refused++; continue }

    const extraction = plusminusInvoiceToExtraction(pm, supplier)
    const res = await http('POST', org('/doc-import/analyze'), {
      target: 'sales_invoice',
      items: [{ fileId: `plusminus:${num}`, filename: `invoicem_${num}.json`, text: buildSyntheticRawText(pm.header), draft: { extraction, validation: { status: 'valid', checks: [] }, model: 'direct', engine: 'plusminus-api' } }],
      context: { warehouseId: wh._id },
    })
    const result = await pollTask(res.taskId)
    const doc = result?.results?.[0]
    const m = doc?.mapped
    if (!m || doc?.error) { console.log(`✗ ${num}: analyze failed — ${doc?.error || 'no mapped payload'}`); refused++; continue }
    if (!m.contactId) { console.log(`✗ ${num}: the contact "${m.contactName}" does not resolve to an existing contact — not creating one here`); refused++; continue }
    // A quantity line with no product is invoiced but moves nothing (normal for a service line, a
    // problem for goods) — say so, never hide it.
    const unlinkedQty = (m.lines || []).filter((l: any) => Number(l.quantity) && !l.productId)
    if (unlinkedQty.length) console.log(`   ⚠ ${num}: ${unlinkedQty.length} quantity line(s) with no product link: ${unlinkedQty.map((l: any) => `"${String(l.description).slice(0, 40)}"`).join(', ')}`)

    const wantTotal = round2(Number(pm.header.sum))
    const curTotal = round2(Number(full.total))
    const mTotal = round2(Number(m.total))
    if (Math.abs(mTotal - wantTotal) > 0.03) { console.log(`✗ ${num}: mapped total ${mTotal} ≠ PlusMinus ${wantTotal} — the mapping disagrees with the source, not applying`); refused++; continue }
    if (full.status === 'paid' && Math.abs(curTotal - mTotal) > 0.011) { console.log(`✗ ${num}: PAID and the total would change (${curTotal} → ${mTotal}) — needs a payment correction first`); refused++; continue }

    const contactChanged = idOf(full.contactId) !== idOf(m.contactId)
    const sameLines = sig(full.lines || []) === sig(m.lines || [])
    const sameTotal = Math.abs(curTotal - mTotal) <= 0.011
    console.log(`${num} [${full.status}] LGR: ${cur.contactName ?? full.contactId?.companyName} · ${(full.lines || []).length} lines · total ${curTotal}  →  PlusMinus: ${m.contactName} · ${(m.lines || []).length} lines · total ${mTotal}${contactChanged ? '  (CONTACT changes)' : ''}${sameLines ? '  (lines identical)' : ''}`)
    if (!contactChanged && sameLines && sameTotal) { console.log('   nothing to change'); same++; continue }
    if (!execute) { repaired++; continue }

    const body: any = {
      contactId: m.contactId,
      lines: (m.lines || []).map(pickLine),
      subtotal: m.subtotal, discountTotal: m.discountTotal ?? 0, taxTotal: m.taxTotal, total: m.total,
      totalBase: m.totalBase ?? m.total,
      ...(m.notes ? { notes: m.notes } : {}),
    }
    await http('PUT', org(`/invoices/${cur._id || cur.id}`), body)
    const after = (await http('GET', org(`/invoices/${cur._id || cur.id}`))).invoice
    const ok = Math.abs(round2(Number(after.total)) - mTotal) <= 0.011 && idOf(after.contactId) === idOf(m.contactId) && (after.lines || []).length === (m.lines || []).length
    console.log(`   ${ok ? '✓' : '✗ FAILED'} now ${after.contactId?.companyName ?? m.contactName} · ${(after.lines || []).length} lines · total ${round2(Number(after.total))} · status ${after.status}`)
    if (ok) repaired++; else refused++
  }
  console.log(`\n${execute ? 'Repaired' : 'Would repair'}: ${repaired} | unchanged: ${same} | refused: ${refused}`)
  if (!execute) console.log('Dry-run — nothing written. Re-run with --execute.')
}

await main()
