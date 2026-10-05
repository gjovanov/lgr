/**
 * check-doc-sequences — detect MISSING or DUPLICATE document numbers in the PlusMinus
 * daily exports (invoicem / stokrazp / sklrazp / sklisk) across one or many day folders,
 * and — optionally — verify each present document actually landed in LGR.
 *
 * Why: a missing number in a type's run means a document was skipped in the export (never
 * delivered) or voided in the source ERP; if it carried stock, LGR silently drifts. This
 * is the reusable form of the ad-hoc gap scan used throughout the regal-pz migration.
 *
 * Detection is O(n) over the SORTED present numbers (jumps between consecutive docs) — it
 * never enumerates min..max, so unrelated number spaces (e.g. proforma 7xxx vs sales
 * 3000100xxx) can't blow up. invoicem and invoiceProf are kept as SEPARATE spaces.
 *
 * LGR cross-check (--org): movement notes carry `stokrazp:` / `corr:` / `sklrazp:` /
 * `sklisk:` markers and issued sales invoices carry the original 3000100… number, so we
 * can report (a) folder docs with NO LGR record ("not imported") and (b) gaps in LGR's own
 * per-type sequence near the scanned range (catches cross-day gaps even for a single day).
 *
 * Usage:
 *   bun run scripts/check-doc-sequences.ts --root <_docs dir>              # all 2026-MM-DD folders
 *   bun run scripts/check-doc-sequences.ts --folder <one day dir>          # a single day folder
 *   bun run scripts/check-doc-sequences.ts --root <dir> --org regal-pz     # + LGR import verify
 *
 * Options:
 *   --root <dir>     scan every 2026-MM-DD folder under <dir> (global cross-day sequence)
 *   --folder <dir>   scan one folder (repeatable; comma-separated ok)
 *   --org <slug>     verify vs LGR (env LGR_TOKEN or LGR_USERNAME+LGR_PASSWORD)
 *   --api <url>      API base (default https://lgrai.app)
 *   --out <path>     also write a CSV of every finding
 *   --json           print machine-readable JSON instead of the text report
 *   --quiet          suppress the per-type "✓ contiguous" lines (only show problems)
 * Exit code: 0 = no missing docs, 1 = at least one missing/not-imported doc found.
 */
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

function parseArgs(argv: string[]) {
  const o: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; if (!a.startsWith('--')) continue
    const k = a.slice(2), n = argv[i + 1]
    if (n && !n.startsWith('--')) { o[k] = n; i++ } else { o[k] = true }
  }
  return o
}
const args = parseArgs(process.argv.slice(2))
const rootArg = args.root as string | undefined
const folderArg = args.folder as string | undefined
const orgSlug = args.org as string | undefined
const api = ((args.api as string) || 'https://lgrai.app').replace(/\/$/, '')
const asJson = !!args.json
const quiet = !!args.quiet
if (!rootArg && !folderArg) { console.error('Required: --root <_docs dir> or --folder <day dir>. See header.'); process.exit(2) }

// Doc types with a per-type numeric sequence. salesAnalysis/docJournalReport/storeAvailability
// are 1-per-day or timestamped → no sequence, excluded. invoiceProf is its own space.
const DOC_TYPES: Array<{ type: string; re: RegExp; sales?: boolean; note?: string }> = [
  { type: 'invoicem', re: /^invoicem_(\d+)\.pdf$/i, sales: true },
  { type: 'invoiceProf', re: /^invoiceProf_(\d+)\.pdf$/i, note: 'proforma — separate number space' },
  { type: 'stokrazp', re: /^stokrazp_(\d+)\.pdf$/i },
  { type: 'sklrazp', re: /^sklrazp_(\d+)\.pdf$/i },
  { type: 'sklisk', re: /^sklisk_(\d+)\.pdf$/i },
]

function resolveFolders(): string[] {
  if (folderArg) return String(folderArg).split(',').map(s => s.trim()).filter(Boolean)
  const out: string[] = []
  for (const d of readdirSync(rootArg!)) {
    if (!/^2026-\d\d-\d\d$/.test(d)) continue
    try { if (statSync(join(rootArg!, d)).isDirectory()) out.push(join(rootArg!, d)) } catch { }
  }
  return out.sort()
}

// scan: type -> Map<number, folderBasename[]>
function scan(folders: string[]) {
  const by: Record<string, Map<number, string[]>> = {}
  for (const t of DOC_TYPES) by[t.type] = new Map()
  for (const dir of folders) {
    let files: string[] = []
    try { files = readdirSync(dir) } catch { continue }
    const tag = basename(dir)
    for (const f of files) for (const t of DOC_TYPES) {
      const m = f.match(t.re)
      if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n)) { const map = by[t.type]; if (!map.has(n)) map.set(n, []); map.get(n)!.push(tag) } }
    }
  }
  return by
}

// O(n) gaps: runs of missing numbers between consecutive present numbers.
function gapRuns(nums: number[]): Array<{ a: number; b: number }> {
  const s = [...new Set(nums)].sort((x, y) => x - y)
  const runs: Array<{ a: number; b: number }> = []
  for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] > 1) runs.push({ a: s[i - 1] + 1, b: s[i] - 1 })
  return runs
}
const showRun = (r: { a: number; b: number }) => r.a === r.b ? `${r.a}` : `${r.a}–${r.b} (${r.b - r.a + 1})`

/**
 * Numbers PlusMinus allocated and then DELETED — `scripts/data/deleted-doc-numbers.json`.
 *
 * A gap where one of these sits is CLOSED, not pending: the document will never be exported, so
 * reporting it as missing every single run teaches people to ignore the warning, which is worse
 * than not having it. They are listed separately and excluded from the exit code.
 *
 * ⚠ A deleted document brought no stock on either side. So it can never explain a quantity
 * difference — if a reconciliation was blaming one of these for a shortfall, that attribution is
 * wrong and the shortfall still needs a cause. (It happened: regal-pz's 2026-10-02 report pinned
 * 2,030 units on 3000016475-477/479 before they turned out to be deleted.)
 *
 * The same number means different documents in different orgs, so the list has to be attributed.
 * `--org` is the explicit answer — but it also switches on the LGR cross-check and therefore
 * DEMANDS credentials, while a deleted number is a local fact about the export that needs no API
 * at all. So the org is also recognised from the scanned path, by matching a path segment against
 * the file's own top-level keys (`_docs/regal-pz/2026-10-01` → `regal-pz`). An offline gap scan
 * gets the list too, and nothing is hardcoded here beyond the filename.
 */
function loadDeleted(slug: string | undefined, scanned: string): { byType: Record<string, Set<number>>; org?: string; inferred: boolean } {
  const byType: Record<string, Set<number>> = {}
  let raw: any
  try { raw = JSON.parse(readFileSync(join(import.meta.dir, 'data', 'deleted-doc-numbers.json'), 'utf8')) }
  catch { return { byType, inferred: false } }           // absent or unreadable: every gap stays a gap
  const orgs = Object.keys(raw).filter((k) => !k.startsWith('_'))
  const segs = scanned.split(/[\\/,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
  const explicit = slug && orgs.includes(slug) ? slug : undefined
  const org = explicit ?? orgs.find((o) => segs.includes(o.toLowerCase()))
  if (!org) return { byType, inferred: false }
  for (const [type, rows] of Object.entries((raw[org] ?? {}) as Record<string, Array<{ number: number }>>))
    byType[type] = new Set((rows || []).map((r) => Number(r.number)).filter(Number.isFinite))
  return { byType, org, inferred: !explicit }
}
const deletedList = loadDeleted(orgSlug, String(folderArg || rootArg || ''))
const DELETED = deletedList.byType
/** Split a gap run on the deleted numbers inside it, so only genuinely absent numbers remain. */
function withoutDeleted(runs: Array<{ a: number; b: number }>, gone: Set<number> | undefined): { runs: Array<{ a: number; b: number }>; skipped: number[] } {
  if (!gone?.size) return { runs, skipped: [] }
  const kept: Array<{ a: number; b: number }> = []
  const skipped: number[] = []
  for (const r of runs) {
    let start: number | null = null
    for (let n = r.a; n <= r.b; n++) {
      if (gone.has(n)) { skipped.push(n); if (start !== null) { kept.push({ a: start, b: n - 1 }); start = null } continue }
      if (start === null) start = n
    }
    if (start !== null) kept.push({ a: start, b: r.b })
  }
  return { runs: kept, skipped }
}

// ── optional LGR cross-check ──
let TOKEN = process.env.LGR_TOKEN || '', ORG_ID = ''
async function http(method: string, path: string, body?: any) {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }
  let payload: any; if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
  const res = await fetch(`${api}${path}`, { method, headers, body: payload })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 200)}`)
  return json
}
async function fetchAll(path: string, key: string): Promise<any[]> {
  const org = (p: string) => `/api/org/${ORG_ID}${p}`
  const sep = path.includes('?') ? '&' : '?'
  const seen = new Set<string>(), out: any[] = []
  let page = 0, total = Infinity, empty = 0
  while (out.length < total) {
    const d = await http('GET', org(`${path}${sep}page=${page}&size=1000&sortBy=_id&sortOrder=asc`))
    const items = d[key] || []; if (d.total != null) total = d.total
    if (!items.length) break
    let added = 0; for (const it of items) { const id = String(it._id || it.id); if (!seen.has(id)) { seen.add(id); out.push(it); added++ } }
    if (added === 0) { if (++empty >= 2) break } else empty = 0
    if (++page > 2000) break
  }
  return out
}
async function lgrNumbers(): Promise<Record<string, Set<number>>> {
  const org = (p: string) => `/api/org/${ORG_ID}${p}`
  const username = process.env.LGR_USERNAME, password = process.env.LGR_PASSWORD
  if (TOKEN) { const me = await http('GET', '/api/auth/me'); ORG_ID = me.user?.orgId || me.orgId }
  else { if (!username || !password) { console.error('LGR cross-check needs LGR_TOKEN or LGR_USERNAME+LGR_PASSWORD'); process.exit(2) }
    const r = await http('POST', '/api/auth/login', { orgSlug, username, password }); TOKEN = r.token; ORG_ID = r.org?.id || r.user?.orgId }
  const stok = new Set<number>(), skl = new Set<number>(), isk = new Set<number>(), inv = new Set<number>(), prof = new Set<number>()
  for (const mv of await fetchAll('/warehouse/movement', 'stockMovements')) {
    const notes = String(mv.notes || '')
    for (const m of notes.matchAll(/stokrazp:(\d+)/g)) stok.add(+m[1])
    for (const m of notes.matchAll(/corr:(\d+)/g)) stok.add(+m[1])
    for (const m of notes.matchAll(/sklrazp:(\d+)/g)) skl.add(+m[1])
    for (const m of notes.matchAll(/sklisk:(\d+)/g)) isk.add(+m[1])
  }
  for (const i of await fetchAll('/invoices', 'invoices')) for (const m of String(i.invoiceNumber || '').matchAll(/(\d{9,})/g)) inv.add(+m[1])
  return { invoicem: inv, invoiceProf: prof, stokrazp: stok, sklrazp: skl, sklisk: isk }
}

async function main() {
  const folders = resolveFolders()
  const by = scan(folders)
  const lgr = orgSlug ? await lgrNumbers() : null
  const findings: any[] = []
  const report: string[] = []
  report.push(`check-doc-sequences | ${folders.length} folder(s): ${folders.map(f => basename(f)).join(', ').slice(0, 120)}${orgSlug ? ` | LGR: ${orgSlug}` : ''}`)
  // Say whose deleted-number list is in effect: a silently applied exclusion list is worse
  // than none, because a reader cannot tell a closed gap from one nobody looked at.
  if (deletedList.org) {
    const n = Object.values(DELETED).reduce((a, s2) => a + s2.size, 0)
    report.push(`  deleted-in-source list: ${deletedList.org} (${n} number(s))${deletedList.inferred ? ' — recognised from the path' : ''}`)
  }

  let anyMissing = false
  for (const t of DOC_TYPES) {
    const map = by[t.type]
    const nums = [...map.keys()].sort((a, b) => a - b)
    if (!nums.length) { if (!quiet) report.push(`── ${t.type}: (none)`); continue }
    const min = nums[0], max = nums[nums.length - 1]
    const dayOf = (n: number) => map.get(n)?.[0] || '?'
    let intra = gapRuns(nums)
    const lgrset = lgr?.[t.type]
    const notImported = lgrset && lgrset.size ? nums.filter(n => !lgrset.has(n)) : []
    // cross-day (single-folder or first-folder): LGR numbers just below the scanned min
    let crossDay: Array<{ a: number; b: number }> = []
    if (lgrset && lgrset.size) {
      const below = [...lgrset].filter(n => n < min)
      if (below.length) { const prev = Math.max(...below); if (prev < min - 1 && min - prev <= 50) crossDay.push({ a: prev + 1, b: min - 1 }) }
    }
    // Numbers the operator has confirmed PlusMinus deleted are not pending — see `loadDeleted`.
    const gone = DELETED[t.type]
    const intraClean = withoutDeleted(intra, gone)
    const crossClean = withoutDeleted(crossDay, gone)
    intra = intraClean.runs
    crossDay = crossClean.runs
    const deletedHere = [...new Set([...intraClean.skipped, ...crossClean.skipped])].sort((a, b) => a - b)

    const problems = intra.length || crossDay.length || notImported.length
    if (problems) anyMissing = true
    if (!problems && quiet && !deletedHere.length) continue
    report.push(`── ${t.type}${t.note ? ` (${t.note})` : ''}: ${nums.length} docs, range [${min}–${max}]${problems ? '' : '   ✓ contiguous' + (lgrset?.size ? ' & imported' : '')}`)
    if (deletedHere.length) {
      report.push(`   • deleted in PlusMinus, never coming: ${deletedHere.join(' ')}  — gap closed, not pending`)
      for (const n of deletedHere) findings.push({ type: t.type, kind: 'deleted_in_source', number: n, between: 'n/a' })
    }
    for (const r of intra) { report.push(`   ⚠ MISSING ${showRun(r)}  — between ${dayOf(r.a - 1)} and ${dayOf(r.b + 1)}`); for (let n = r.a; n <= r.b; n++) findings.push({ type: t.type, kind: 'missing', number: n, between: `${dayOf(r.a - 1)}..${dayOf(r.b + 1)}` }) }
    for (const r of crossDay) { report.push(`   ⚠ MISSING vs prior LGR ${showRun(r)}  — before ${dayOf(min)}`); for (let n = r.a; n <= r.b; n++) findings.push({ type: t.type, kind: 'missing_prior', number: n, between: `LGR..${dayOf(min)}` }) }
    for (const n of notImported) { report.push(`   ⚠ NOT imported ${n}  (in folder ${dayOf(n)}, no LGR record)`); findings.push({ type: t.type, kind: 'not_imported', number: n, between: dayOf(n) }) }
    const dups = nums.filter(n => (map.get(n)?.length || 0) > 1)
    for (const n of dups) findings.push({ type: t.type, kind: 'duplicate', number: n, between: map.get(n)!.join(',') })
    if (dups.length && !quiet) report.push(`   • ${dups.length} number(s) exported in >1 folder (dedup-guarded): ${dups.map(n => `${n}[${map.get(n)!.join(',')}]`).slice(0, 8).join('  ')}`)
  }
  const missingCount = findings.filter(f => f.kind.startsWith('missing') || f.kind === 'not_imported').length
  report.push(`\nSummary: ${missingCount} missing/not-imported, ${findings.filter(f => f.kind === 'duplicate').length} duplicate number(s).`)

  if (asJson) console.log(JSON.stringify({ folders: folders.map(f => basename(f)), findings, missingCount }, null, 2))
  else console.log(report.join('\n'))
  if (args.out) { writeFileSync(String(args.out), ['type,kind,number,between', ...findings.map(f => `${f.type},${f.kind},${f.number},"${f.between}"`)].join('\n'), 'utf8'); if (!asJson) console.log(`\nCSV → ${args.out}`) }
  process.exit(anyMissing ? 1 : 0)
}
await main()
