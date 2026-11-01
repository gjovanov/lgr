/**
 * Read-only document audit: what PlusMinus says exists (pulled with `pull-plusminus-api`) against what
 * LGR holds, family by family — the step BEFORE any import or true-up, so each is chosen on evidence.
 * Written for regal-pz's full-history audit (2026-11-01); the importers only ever report "already
 * imported" for a document they can see, which is not the same as "everything is in".
 *
 * What it answers (one section each):
 *   1. INVOICES   which `-ФЕ` numbers are not `INV-<n>` in LGR, and why (hand-entered under an LGR number,
 *                 an unissued draft of that number, or really missing); present invoices whose total or
 *                 line count differs from the document; `-ФЕА` ANNULMENTS (same number, negative sum) whose
 *                 original LGR still holds live; `INV-<n>` with no PlusMinus document.
 *   2. FAMILIES   receipts (СТ), transfers-out (СР), write-offs (СИ): which numbers have no marker in any
 *                 LGR movement (read numerically — see lib/doc-marker.ts), split into price-only documents
 *                 (nothing to book), PRE-baseline (already inside LGR's numbers — never book with stock) and
 *                 post-baseline candidates; markers in LGR that point at no PlusMinus document.
 *   3. TILL DAYS  trading days (days with a PlusMinus invoice) that have no cash-sale document in LGR.
 *   4. GUARD      (--snapshot) for every unbooked document line: does booking it close the product's gap to
 *                 the snapshot (EXACT/PARTIAL), or would it CREATE drift because LGR already agrees
 *                 (ALREADY)? This is the double-count rule written down; see lib/audit-coverage.ts.
 *   5. DRIFT      (--lines) documents LGR booked whose PlusMinus version has since CHANGED — PlusMinus lets
 *                 staff edit a booked receipt in place (a quantity corrected by an order of magnitude);
 *                 LGR keeps the quantity it booked.
 *
 * Nothing here writes. Usage:
 *   bun run scripts/audit-coverage-api.ts --org regal-pz --dir <pull dir>[,<pull dir>…] [--baseline 2026-07-30]
 *        [--snapshot <storeAvailability_*.json>] [--lines] [--out summary.json]
 *
 * Options:
 *   --org <slug>        org slug (default: regal-pz)
 *   --api <url>         API base (default: https://lgrai.app)
 *   --dir <dirs>        (required) one or more pull folders, comma-separated; later ones win on a repeated number
 *   --baseline <ISO>    date of the last full quantity re-baseline; documents on/before it count as already in
 *   --snapshot <file>   enables the guard (section 4)
 *   --lines             enables the drift check (section 5); fetches ~one request per booked document
 *   --out <file>        also write the findings as JSON
 *
 * Credentials (env): LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { assertTokenOrg } from './lib/token-org.js'
import { docMarkerNumbers } from './lib/doc-marker.js'
import { fold, docLineEffects, classifyLine, isPreBaseline, isoFromPm, type DocFamily } from './lib/audit-coverage.js'

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
const orgSlug = (args.org as string) || 'regal-pz'
const api = ((args.api as string) || 'https://lgrai.app').replace(/\/$/, '')
const dirs = String(args.dir || '').split(',').map(s => s.trim()).filter(Boolean)
const baseline = args.baseline as string | undefined
const snapPath = args.snapshot as string | undefined
const wantLines = !!args.lines
const outPath = args.out as string | undefined
if (!dirs.length) { console.error('Required: --dir <pull folder>[,<pull folder>…]. See the header.'); process.exit(2) }

let TOKEN = process.env.LGR_TOKEN || ''
let ORG_ID = ''
async function http(method: string, path: string): Promise<any> {
  const res = await fetch(`${api}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}` } })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`)
  return json
}
const org = (p: string) => `/api/org/${ORG_ID}${p}`
async function login() {
  if (TOKEN) {
    const me = await http('GET', '/api/auth/me')
    assertTokenOrg(me, orgSlug)
    ORG_ID = me.user?.orgId || me.orgId
  } else {
    const username = process.env.LGR_USERNAME, password = process.env.LGR_PASSWORD
    if (!username || !password) { console.error('Set LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.'); process.exit(2) }
    const res = await fetch(`${api}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgSlug, username, password }) })
    const j: any = await res.json().catch(() => ({}))
    if (!res.ok || !j.token) { console.error(`login failed: ${res.status}`); process.exit(1) }
    TOKEN = j.token
    ORG_ID = j.org?.id || j.user?.orgId
  }
}
async function fetchAll(path: string, key: string, size = 1000): Promise<any[]> {
  const seen = new Set<string>(), out: any[] = []
  const sep = path.includes('?') ? '&' : '?'
  for (let page = 0, total = Infinity; out.length < total && page < 2000; page++) {
    const d = await http('GET', org(`${path}${sep}page=${page}&size=${size}&sortBy=_id&sortOrder=asc`))
    const items = d[key] || []
    if (d.total != null) total = d.total
    if (!items.length) break
    let added = 0
    for (const it of items) { const id = String(it._id || it.id); if (!seen.has(id)) { seen.add(id); out.push(it); added++ } }
    if (!added) break
  }
  return out
}

// ── PlusMinus side ────────────────────────────────────────────────────────
interface PmInvoice { n: string; date: string; sum: number; partner: string; lines: number }
const pmInv = new Map<string, PmInvoice>(), pmAnnul: PmInvoice[] = []
const pmDocs: Record<DocFamily, Map<number, { n: number; date: string; partner: string; doc: any }>> = { stokrazp: new Map(), sklrazp: new Map(), sklisk: new Map() }
for (const d of dirs) for (const f of readdirSync(d)) {
  const m = /^(invoicem|stokrazp|sklrazp|sklisk)_(\d+)(\.fea)?\.json$/.exec(f)
  if (!m) continue
  const doc = JSON.parse(readFileSync(`${d}/${f}`, 'utf8'))
  const h = doc.header ?? {}
  const date = isoFromPm(h.docDate)
  if (m[1] === 'invoicem') {
    const rec = { n: m[2], date, sum: Number(h.sum), partner: String(h.partner ?? '').replace(/^[^:]+:/, ''), lines: (doc.lines ?? []).filter((l: any) => Number(l.quantity)).length }
    if (m[3]) pmAnnul.push(rec); else pmInv.set(m[2], rec)
  } else {
    pmDocs[m[1] as DocFamily].set(Number(m[2]), { n: Number(m[2]), date, partner: String(h.partner ?? '').replace(/^[^:]+:/, ''), doc })
  }
}
const day = (d: unknown) => String(d ?? '').slice(0, 10)
const dow = (d: string) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(d + 'T12:00:00Z').getUTCDay()]
const findings: any = { org: orgSlug, dirs, baseline: baseline ?? null }

async function main() {
  console.log(`Audit coverage | org ${orgSlug} | ${dirs.length} folder(s) | PlusMinus: ${pmInv.size} invoices (+${pmAnnul.length} annulments), ` +
    `${pmDocs.stokrazp.size} receipts, ${pmDocs.sklrazp.size} transfers, ${pmDocs.sklisk.size} write-offs${baseline ? ` | baseline ${baseline}` : ''}`)
  await login()
  console.log('fetching LGR invoices + movements…')
  const invoices = await fetchAll('/invoices', 'invoices')
  const movements = await fetchAll('/warehouse/movement', 'stockMovements')
  console.log(`LGR: ${invoices.length} invoices, ${movements.length} movements\n`)

  // ── 1. invoices ──
  const byNumber = new Map<string, any>(invoices.map(i => [i.invoiceNumber, i]))
  const missing: PmInvoice[] = [], present: PmInvoice[] = []
  for (const p of pmInv.values()) (byNumber.has(`INV-${p.n}`) ? present : missing).push(p)
  const handEntered = invoices.filter(i => i.direction === 'outgoing' && i.type === 'invoice' && !/^INV-\d{10}$/.test(i.invoiceNumber || '') && !/^(DRF-|CSR-)/.test(i.invoiceNumber || ''))
  const used = new Set<string>()
  const viaNative: string[] = [], viaDraft: string[] = [], gone: PmInvoice[] = []
  for (const p of missing.sort((a, b) => a.n.localeCompare(b.n))) {
    const draft = invoices.find(i => i.status === 'draft' && String(i.reference) === p.n)
    if (draft) { viaDraft.push(`${p.n} ← ${draft.invoiceNumber}`); continue }
    const nat = handEntered.find(i => !used.has(i.invoiceNumber) && day(i.issueDate) === p.date && Math.abs(Number(i.total) - p.sum) <= 0.011)
    if (nat) { used.add(nat.invoiceNumber); viaNative.push(`${p.n} ↔ ${nat.invoiceNumber}`); continue }
    gone.push(p)
  }
  let rounding = 0, creditSign = 0
  const contentDiff: string[] = []
  for (const p of present) {
    const i = byNumber.get(`INV-${p.n}`)
    const lgrTotal = Number(i.total), dv = Math.abs(Math.abs(lgrTotal) - Math.abs(p.sum))
    const lgrLines = (i.lines ?? []).filter((l: any) => Number(l.quantity)).length
    if (dv > 0.03 || lgrLines !== p.lines) contentDiff.push(`${p.n} ${p.date} [${i.status}] PM ${p.sum} · ${p.lines} lines ↔ LGR ${lgrTotal} · ${lgrLines} lines`)
    else if (dv > 0.001) rounding++
    if (p.sum < 0 && lgrTotal > 0) creditSign++
  }
  const strayDrafts = invoices.filter(i => i.status === 'draft' && /^\d+$/.test(String(i.reference ?? '')) && pmInv.has(String(i.reference)))
  const extra = invoices.filter(i => /^INV-\d{10}$/.test(i.invoiceNumber || '') && !pmInv.has(i.invoiceNumber.slice(4)) && [...dirs].length)
  console.log('═══ 1. INVOICES (-ФЕ) ═══')
  console.log(`PlusMinus ${pmInv.size} · as INV-<number> in LGR ${present.length} · not under that number ${missing.length}: ${viaNative.length} hand-entered in LGR under another number (matched by day+total), ${viaDraft.length} still an unissued draft, ${gone.length} NO counterpart`)
  for (const s of viaDraft) console.log(`  DRAFT   ${s}`)
  for (const p of gone) console.log(`  MISSING ${p.n} ${p.date} · ${p.lines} lines · ${p.partner.slice(0, 36)}`)
  console.log(`present but different: ${contentDiff.length} (beyond rounding); rounding-only ${rounding}; credit-note sign convention ${creditSign}`)
  for (const s of contentDiff) console.log(`  DIFF    ${s}`)
  console.log(`annulments (-ФЕА): ${pmAnnul.length}`)
  for (const a of pmAnnul) { const i = byNumber.get(`INV-${a.n}`); console.log(`  ${a.n} ${a.date} · LGR original: ${i ? `${i.type}/${i.status}${['voided', 'cancelled'].includes(i.status) ? ' (annulled)' : '  ← STILL LIVE'}` : 'ABSENT'}`) }
  console.log(`LGR INV-<number> with no PlusMinus document: ${extra.length}${extra.length ? ' → ' + extra.map(i => i.invoiceNumber).join(', ') : ''}`)
  console.log(`unissued drafts carrying a PlusMinus number: ${strayDrafts.length}${strayDrafts.length ? ' → ' + strayDrafts.map(i => `${i.invoiceNumber}(${i.reference})`).join(', ') : ''}`)
  findings.invoices = { pm: pmInv.size, present: present.length, handEntered: viaNative.length, drafts: viaDraft, missing: gone.map(p => p.n), contentDiff, rounding, creditSign, annulments: pmAnnul.map(a => ({ n: a.n, lgrStatus: byNumber.get(`INV-${a.n}`)?.status ?? null })), lgrOnly: extra.map(i => i.invoiceNumber) }

  // ── 2. families ──
  const hay = movements.map(m => ({ m, text: `${m.notes ?? ''} ${m.reference ?? ''}` }))
  const MARKERS: Record<DocFamily, string[]> = { stokrazp: ['stokrazp', 'corr', 'reconcile'], sklrazp: ['sklrazp', 'reconcile'], sklisk: ['sklisk'] }
  const booked: Record<DocFamily, Set<number>> = { stokrazp: new Set(), sklrazp: new Set(), sklisk: new Set() }
  for (const fam of Object.keys(MARKERS) as DocFamily[]) for (const { text } of hay) for (const marker of MARKERS[fam]) for (const n of docMarkerNumbers(marker, text)) booked[fam].add(n)
  const candidates: Array<{ fam: DocFamily; n: number; date: string; partner: string; doc: any; pre: boolean }> = []
  findings.families = {}
  console.log('\n═══ 2. RECEIPTS · TRANSFERS · WRITE-OFFS ═══')
  for (const fam of ['stokrazp', 'sklrazp', 'sklisk'] as DocFamily[]) {
    const docs = [...pmDocs[fam].values()].sort((a, b) => a.n - b.n)
    if (!docs.length) continue
    const unbooked = docs.filter(d => !booked[fam].has(d.n))
    const priceOnly = unbooked.filter(d => !docLineEffects(fam, d.doc).length)
    const real = unbooked.filter(d => docLineEffects(fam, d.doc).length)
    const pre = real.filter(d => isPreBaseline(d.date, baseline)), post = real.filter(d => !isPreBaseline(d.date, baseline))
    const lo = docs[0].n, hi = docs[docs.length - 1].n
    const orphans = [...booked[fam]].filter(n => n >= lo && n <= hi && !pmDocs[fam].has(n))
    console.log(`${fam.padEnd(9)} PlusMinus ${docs.length} (${lo}…${hi}) · booked ${docs.length - unbooked.length} · unbooked ${unbooked.length}: ${post.length} post-baseline, ${pre.length} pre-baseline, ${priceOnly.length} price-only/empty · LGR markers with no document in range: ${orphans.length}${orphans.length ? ' → ' + orphans.join(',') : ''}`)
    for (const d of post) console.log(`  POST  ${d.n} ${d.date} · ${docLineEffects(fam, d.doc).length} lines · ${d.partner.slice(0, 30)}`)
    if (pre.length) console.log(`  pre-baseline: ${pre.length} document(s) dated ${pre[0].date}…${pre[pre.length - 1].date} — already inside the baseline, do not book with stock (section 4 shows whether any line is NOT)`)
    if (priceOnly.length) console.log(`  price-only/empty: ${priceOnly.map(d => d.n).join(', ')}`)
    for (const d of real) candidates.push({ fam, n: d.n, date: d.date, partner: d.partner, doc: d.doc, pre: isPreBaseline(d.date, baseline) })
    findings.families[fam] = { pm: docs.length, booked: docs.length - unbooked.length, post: post.map(d => d.n), pre: pre.map(d => d.n), priceOnly: priceOnly.map(d => d.n), orphans }
  }

  // ── 3. till days ──
  const cash = invoices.filter(i => i.type === 'cash_sale')
  if (cash.length) {
    const csrDays = new Set(cash.map(i => String(i.reference ?? '').replace(/^salesAnalysis:/, '')))
    const tradingDays = [...new Set([...pmInv.values()].map(p => p.date))].sort()
    const noTill = tradingDays.filter(d => !csrDays.has(d))
    const orphanTill = [...csrDays].filter(d => !tradingDays.includes(d)).sort()
    console.log('\n═══ 3. TILL (cash-sale) DAYS ═══')
    console.log(`trading days with a PlusMinus invoice ${tradingDays.length} · LGR cash-sale days ${csrDays.size} · trading days WITHOUT a cash-sale document: ${noTill.length}${noTill.length ? ' → ' + noTill.map(d => `${d}(${dow(d)})`).join(', ') : ''}`)
    console.log(`cash-sale days with no PlusMinus invoice that day: ${orphanTill.length}${orphanTill.length ? ' → ' + orphanTill.map(d => `${d}(${dow(d)})`).join(', ') : ''}`)
    findings.tillDays = { trading: tradingDays.length, lgr: csrDays.size, missing: noTill, orphan: orphanTill }
  }

  // ── 4. guard ──
  if (snapPath) {
    const whs = (await http('GET', org('/warehouse/warehouse?page=0&size=100'))).warehouses || []
    const wh = whs.find((w: any) => w.isDefault) || whs[0]
    const snapRaw = JSON.parse(readFileSync(snapPath, 'utf8'))
    const rows = snapRaw[Object.keys(snapRaw)[0]]
    const snap = new Map<string, number>()
    for (const k of Object.keys(rows)) { const key = fold(k.replace(/^СТОКИ:/, '')); snap.set(key, (snap.get(key) ?? 0) + (parseFloat(rows[k].quantity ?? '0') || 0)) }
    console.log('\nfetching LGR products + stock levels for the guard…')
    const products = await fetchAll('/warehouse/product', 'products')
    const levels = await fetchAll(`/warehouse/stock-level?warehouseId=${wh._id}`, 'stockLevels')
    const qtyById = new Map<string, number>(levels.map(l => [String(l.productId?._id || l.productId), Number(l.quantity) || 0]))
    const lgr = new Map<string, number>()
    for (const p of products) lgr.set(fold(p.name), (lgr.get(fold(p.name)) ?? 0) + (qtyById.get(String(p._id || p.id)) ?? 0))
    const gap = (key: string): number | null => (lgr.has(key) ? (snap.get(key) ?? 0) - (lgr.get(key) ?? 0) : null)
    const setEffect = new Map<string, number>()
    for (const c of candidates.filter(c => !c.pre)) for (const l of docLineEffects(c.fam, c.doc)) setEffect.set(l.key, (setEffect.get(l.key) ?? 0) + l.eff)
    console.log('\n═══ 4. GUARD — would booking each unbooked document close a gap to the snapshot? ═══')
    console.log('EXACT = closes it · PARTIAL = same direction, smaller · ALREADY = LGR agrees, booking would CREATE drift · CONTRA = other things are off too · NOPRODUCT = article absent from LGR')
    const preTally: Record<string, number> = {}
    const preOdd: string[] = []
    for (const c of candidates.sort((a, b) => a.date.localeCompare(b.date) || a.n - b.n)) {
      const tally: Record<string, number> = {}
      for (const l of docLineEffects(c.fam, c.doc)) { const k = classifyLine(gap(l.key), l.eff, setEffect.get(l.key) ?? l.eff); tally[k] = (tally[k] ?? 0) + 1 }
      const row = `${c.fam} ${c.n} ${c.date} ${c.partner.slice(0, 24).padEnd(24)} ${Object.entries(tally).map(([k, v]) => `${k}:${v}`).join(' ')}`
      if (!c.pre) { console.log(`  POST ${row}`); continue }
      for (const [k, v] of Object.entries(tally)) preTally[k] = (preTally[k] ?? 0) + v
      if (Object.keys(tally).some(k => k !== 'ALREADY')) preOdd.push(row)
    }
    if (Object.keys(preTally).length) console.log(`  pre-baseline lines: ${Object.entries(preTally).map(([k, v]) => `${k}:${v}`).join(' ')}  (expected: almost all ALREADY)`)
    for (const r of preOdd) console.log(`    pre-baseline but not all ALREADY → ${r}`)
    if (!candidates.length) console.log('  (no unbooked documents with quantity lines)')
  }

  // ── 5. drift ──
  if (wantLines) {
    const marked = movements.filter(m => /(stokrazp|sklrazp|sklisk|corr|reconcile)[:_]\d/i.test(`${m.notes ?? ''} ${m.reference ?? ''}`))
    console.log(`\nfetching ${marked.length} document movements for the drift check…`)
    const detail: Array<{ n: string; type: string; from: boolean; to: boolean; text: string; lines: Array<{ name: string; q: number }> }> = []
    let next = 0
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (next < marked.length) {
        const m = marked[next++]
        const d = await http('GET', org(`/warehouse/movement/${m._id || m.id}`))
        const mv = d.stockMovement ?? d.movement ?? d
        detail.push({ n: mv.movementNumber, type: mv.type, from: !!mv.fromWarehouseId, to: !!mv.toWarehouseId, text: `${mv.notes ?? ''} ${mv.reference ?? ''}`, lines: (mv.lines ?? []).map((l: any) => ({ name: l.productName, q: Number(l.quantity) || 0 })) })
      }
    }))
    const lgrEff = new Map<string, number>(), lgrDoc = new Set<string>(), lgrName = new Map<string, string>()
    for (const d of detail) {
      const sign = d.type === 'receipt' || d.type === 'return' ? 1 : d.type === 'transfer' || d.type === 'dispatch' ? -1 : d.type === 'adjustment' ? (d.from && !d.to ? -1 : 1) : 0
      for (const fam of Object.keys(MARKERS) as DocFamily[]) {
        const nums = new Set<number>() // a movement names its document in notes AND reference: count it once
        for (const marker of MARKERS[fam]) for (const n of docMarkerNumbers(marker, d.text)) nums.add(n)
        for (const n of nums) { lgrDoc.add(`${fam}|${n}`); for (const l of d.lines) { const k = `${fam}|${n}|${fold(l.name)}`; lgrEff.set(k, (lgrEff.get(k) ?? 0) + sign * l.q); lgrName.set(fold(l.name), l.name) } }
      }
    }
    const drift: Array<{ fam: DocFamily; n: number; name: string; pm: number; lgr: number }> = []
    for (const fam of Object.keys(MARKERS) as DocFamily[]) for (const d of pmDocs[fam].values()) {
      if (!lgrDoc.has(`${fam}|${d.n}`)) continue
      const eff = new Map(docLineEffects(fam, d.doc).map(e => [e.key, e]))
      const keys = new Set<string>(eff.keys())
      for (const k of lgrEff.keys()) if (k.startsWith(`${fam}|${d.n}|`)) keys.add(k.slice(`${fam}|${d.n}|`.length))
      for (const k of keys) { const pm = eff.get(k)?.eff ?? 0, lg = lgrEff.get(`${fam}|${d.n}|${k}`) ?? 0; if (Math.abs(pm - lg) > 0.001) drift.push({ fam, n: d.n, name: eff.get(k)?.name ?? lgrName.get(k) ?? k, pm, lgr: lg }) }
    }
    drift.sort((a, b) => Math.abs(b.pm - b.lgr) - Math.abs(a.pm - a.lgr))
    console.log('\n═══ 5. DRIFT — booked documents whose PlusMinus version differs from what LGR booked ═══')
    console.log(`${drift.length} line(s) in ${new Set(drift.map(d => `${d.fam}|${d.n}`)).size} document(s)  (a pair that differs only by Latin/Cyrillic spelling cancels out in the totals)`)
    for (const d of drift.slice(0, 40)) console.log(`  ${d.fam} ${d.n}  PlusMinus ${String(d.pm).padStart(9)}  LGR ${String(d.lgr).padStart(9)}  Δ ${String(+(d.pm - d.lgr).toFixed(3)).padStart(10)}  ${d.name.slice(0, 44)}`)
    findings.drift = { lines: drift.length, documents: new Set(drift.map(d => `${d.fam}|${d.n}`)).size, top: drift.slice(0, 40) }
  }

  if (outPath) { writeFileSync(outPath, JSON.stringify(findings, null, 1)); console.log(`\nfindings written to ${outPath}`) }
}
main().catch(e => { console.error('FAILED', e); process.exit(1) })
