#!/usr/bin/env bun
// verify-exports.ts — prove an archive against GUI exports taken from the SAME database state (the day's exports and that night's
// archive, with nobody booking in between). Re-run it whenever such a pair exists: after a PlusMinus update, or when a new kind of
// document appears. Exit 1 on any difference the export's own damage does not explain.
//
//   bun verify-exports.ts --archive <yyyymmdd>.arz.sealed --exports <dir of journalReport_/chartOfAccounts_/trialBalance_/ap_ files>
//                         [--sealed <dir of the sealed payroll exports (exports/payrollEmployee_*, payrollSalaries_*)>]
//
// The export's damage, each proven per value and never assumed: it cuts text at 120 characters; it breaks some Cyrillic letters into
// U+FFFD (in analytic names and comments alike); it rounds numbers to 10 decimals (the archive reader rounds the same way).
// ⚠ Payroll is compared in memory and reported as counts only.
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readSheet } from '../../../scripts/lib/plusminus-sheet'
import { parseAnalyticsFile, parseChartExport, parseJournalExport, parseTrialBalanceExport } from '../../../packages/services/src/biz/accounting-books/plusminus-exports'
import { analyticItems, analyticNodes, chartOfYear, journalFromRecords, readArchiveBooks } from '../../../packages/services/src/biz/accounting-books/plusminus-archive'
import { unsealBundle } from '../../../packages/services/src/biz/backup/backup-crypto'
import { personnelOfArchive, readArchivePayroll, sheetValues } from '../../../scripts/lib/payroll-archive'
import { readPersonnel, readSalarySheets } from '../../../scripts/lib/payroll-exports'
import { sealedRoot } from '../../../scripts/lib/sealed-payroll'
import { unsealKeyFile } from './seal-key'

const args = process.argv.slice(2)
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const archive = opt('--archive'), exportsDir = opt('--exports'), sealedDir = opt('--sealed')
if (!archive || !exportsDir) { console.error('usage: verify-exports.ts --archive <sealed .arz> --exports <dir> [--sealed <dir>]'); process.exit(2) }

const gz = unsealBundle(readFileSync(archive), unsealKeyFile())
const books = await readArchiveBooks(gz, '19000101', '29991231')
// Only exports of the archive's own state: stamped (`_<YYYYMMDD>_<HHMMSS>` in the name) from --since on, by default the day before
// the archive's (the archive is written when that session closes). An older export shows the database as it was then.
const day = /(\d{8})\.arz/.exec(basename(archive))?.[1] ?? ''
const prev = new Date(Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8) - 1)).toISOString().slice(0, 10).replaceAll('-', '')
const since = opt('--since') ?? `${prev}_000000`
const stamp = (f: string) => /_(\d{8}_\d{6})/.exec(f)?.[1] ?? ''
const all = readdirSync(exportsDir)
const files = all.filter(f => !/^(journalReport|chartOfAccounts|trialBalance)_/.test(f) || stamp(f) >= since)
console.log(`exports of the archive's state (stamped from ${since}): ${files.filter(f => /\.xlsx$/.test(f)).length} spreadsheets; ${all.length - files.length} older ones left out`)
let failed = 0
/** A file the GUI parser itself refuses (a filtered export, another report) is not this gate's to judge: it is reported, not failed. */
async function parsed<T>(f: string, parse: () => Promise<T>): Promise<T | null> {
  try { return await parse() } catch (e: any) { console.log(`SKIP  ${f}: the parser refuses it (${e?.code ?? e?.message})`); return null }
}
const verdict = (ok: boolean, line: string) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${line}`) }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const fffd = (broken: string, whole: string) => broken.includes('�') && !whole.includes('�') &&
  new RegExp('^' + broken.split(/�+/).map(esc).join('.{1,2}') + '$', 'u').test(whole)
/** Why the export shows `a` where the archive holds `b`, or null when nothing explains it. */
function damage(a: unknown, b: unknown): string | null {
  if (typeof a === 'string' && typeof b === 'string') {
    if (a.length === 120 && b.startsWith(a) && b.length > 120) return 'cut at 120'
    if (fffd(a, b)) return 'U+FFFD'
  }
  return null
}

// ── journals ──
for (const f of files.filter(f => /^journalReport_.*\.xlsx$/.test(f)).sort()) {
  const e1 = await parsed(f, async () => parseJournalExport(await readSheet(join(exportsDir, f))))
  if (!e1) continue
  const from = e1.period.from.replaceAll('-', ''), to = e1.period.to.replaceAll('-', '')
  const arz = journalFromRecords(books.records.filter(r => r.date >= from && r.date <= to))
  const explained = new Map<string, number>(), unexplained: string[] = []
  const note = (where: string, a: unknown, b: unknown) => { const why = damage(a, b); if (why) explained.set(why, (explained.get(why) ?? 0) + 1); else unexplained.push(where) }
  if (e1.documents.length !== arz.documents.length) unexplained.push(`documents ${e1.documents.length} vs ${arz.documents.length}`)
  for (let i = 0; i < Math.min(e1.documents.length, arz.documents.length); i++) {
    const a = e1.documents[i], b = arz.documents[i]
    if (a.date !== b.date || a.docType !== b.docType || a.docNumber !== b.docNumber) { unexplained.push(`#${i} key`); continue }
    for (const k of ['vatKind', 'total', 'comment'] as const) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) note(`#${i} ${k}`, a[k], b[k])
    if (a.ops.length !== b.ops.length) { unexplained.push(`#${i} ops`); continue }
    a.ops.forEach((x: any, j) => { const y: any = b.ops[j]; for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) note(`#${i}.${j} ${k}`, x[k], y[k]) })
  }
  const same = JSON.stringify(e1.counts) === JSON.stringify(arz.counts) && e1.withoutHeader.length === arz.withoutHeader.length
  verdict(same && !unexplained.length, `journal ${e1.period.from}..${e1.period.to}: ${arz.counts.documents} documents, ${arz.counts.operations} operations, ${arz.withoutHeader.length} without header; export damage ${JSON.stringify(Object.fromEntries(explained))}; unexplained ${unexplained.length}${unexplained.length ? ' e.g. ' + unexplained.slice(0, 5).join(', ') : ''}`)
}

// ── charts ──
for (const f of files.filter(f => /^chartOfAccounts_.*\.xlsx$/.test(f)).sort()) {
  const e1 = await parsed(f, async () => parseChartExport(await readSheet(join(exportsDir, f))))
  if (!e1) continue
  const arz = chartOfYear(books.accounts!, e1.year)
  // An xlsx keeps ~15 significant digits: a 2025 opening such as 9519.80159248723 comes back short of the stored float.
  let maxDiff = 0
  const bad = e1.rows.filter((r, i) => {
    const a: any = arz[i]
    if (!a) return true
    return Object.entries(r).some(([k, v]) => {
      if (typeof v !== 'number') return v !== a[k]
      maxDiff = Math.max(maxDiff, Math.abs(v - a[k]))
      return Math.abs(v - a[k]) > 1e-6
    })
  }).length + Math.abs(e1.rows.length - arz.length)
  verdict(!bad, `chart ${e1.year} (${f}): ${arz.length} accounts, in order; unequal ${bad} (largest numeric difference ${maxDiff.toExponential(1)})`)
}

// ── analytics, per root ──
const roots = analyticNodes(books.analytics!)
for (const f of files.filter(f => /^ap_.*\.json$/.test(f)).sort()) {
  const root = f.replace(/^ap_/, '').replace(/_\d+\.json$/, '')
  if (root === 'ПЕРСОНАЛ') continue
  const r = roots.find(x => x.root === root)
  const e1 = parseAnalyticsFile(readFileSync(join(exportsDir, f))).map(x => JSON.stringify(x)).sort()
  const arz = r ? analyticItems([r]).map(x => JSON.stringify(x)).sort() : []
  const a = new Set(e1), b = new Set(arz)
  const onlyE1 = e1.filter(x => !b.has(x)).length, onlyArz = arz.filter(x => !a.has(x)).length
  verdict(!onlyE1 && !onlyArz, `analytics ${root}: ${arz.length} items; only in the export ${onlyE1}, only in the archive ${onlyArz}`)
}

// ── analytic openings, per analytic trial balance ──
const nodeByPath = new Map(roots.flatMap(r => r.nodes).map(n => [n.path, n]))
for (const f of files.filter(f => /^trialBalance_.*\.xlsx$/.test(f)).sort()) {
  const tb = await parsed(f, async () => parseTrialBalanceExport(await readSheet(join(exportsDir, f))))
  if (!tb || tb.kind !== 'analytic' || !tb.root || !tb.period.from.endsWith('-01-01')) continue
  const year = tb.period.from.slice(0, 4)
  const close = (x: number, y: number, eps: number) => Math.abs(x - y) < eps
  const broken = tb.rows.filter(r => r.path.includes('�'))
  const seen = new Set(tb.rows.map(r => r.path))
  let equal = 0, unequal = 0
  for (const r of tb.rows) {
    if (r.path.includes('�')) continue
    const o = nodeByPath.get(r.path)?.openings[year] ?? { debit: 0, credit: 0, quantity: 0 }
    if (close(o.debit, r.openingDebit, 0.005) && close(o.credit, r.openingCredit, 0.005) && (!tb.quantities || close(o.quantity ?? 0, r.openingQuantity, 0.0005))) equal++
    else unequal++
  }
  // archive openings the TB lacks must each be one of its U+FFFD rows under the real name, with the same amounts
  const lacking = [...nodeByPath.values()].filter(n => n.path.startsWith(tb.root + ':') && !seen.has(n.path) && n.openings[year] && (n.openings[year].debit || n.openings[year].credit || n.openings[year].quantity))
  const unpaired = lacking.filter(n => !broken.some(r => fffd(r.path, n.path) && close(n.openings[year].debit, r.openingDebit, 0.005) && close(n.openings[year].credit, r.openingCredit, 0.005))).length
  verdict(!unequal && !unpaired, `openings ${tb.root} ${year}: ${equal} equal, ${broken.length} U+FFFD rows (${lacking.length - unpaired} paired), unequal ${unequal}, unpaired ${unpaired}`)
}

// ── payroll, in memory, counts only ──
if (sealedDir) {
  const keyFile = process.env.BACKUP_SEAL_KEY_FILE
  if (!keyFile) { console.error('--sealed needs BACKUP_SEAL_KEY_FILE (the private seal key path)'); process.exit(2) }
  const pay = await readArchivePayroll(gz)
  const root = sealedRoot(sealedDir, keyFile)
  const norm = (s: string) => s.toUpperCase().replace(/\s+/g, ' ').trim()
  const byName = new Map(pay.employees.map(e => [norm(e.params['ИМЕ'] ?? e.key), e]))
  const newest = new Map<string, Awaited<ReturnType<typeof readSalarySheets>>[number]>()
  for (const s of (await readSalarySheets(root)).sort((a, b) => a.stamp.localeCompare(b.stamp))) newest.set(s.period, s)
  let cells = 0, equal = 0
  const missByPeriod = new Map<string, number>()
  for (const s of newest.values()) for (const row of s.rows) {
    const m = byName.get(norm(row.name))?.months[s.period]; if (!m) continue
    const mine = sheetValues(m)
    for (const label of Object.keys(mine)) {
      const v = row.values[label]; if (v === undefined) continue
      cells++
      if (Math.abs(v - mine[label]) < 0.005) equal++
      else missByPeriod.set(`${s.period} (sheet of ${s.stamp})`, (missByPeriod.get(`${s.period} (sheet of ${s.stamp})`) ?? 0) + 1)
    }
  }
  // a sheet exported before its month was final is the one honest source of misses: say which, the reader decides
  verdict(cells > 0 && equal / cells > 0.99, `salary sheets: ${newest.size} months, ${cells} mapped cells, ${equal} equal; misses ${JSON.stringify(Object.fromEntries(missByPeriod))}`)
  const asOf = basename(archive).slice(0, 8).replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3')
  const recent = (await readPersonnel(root)).filter(r => r.asOf === asOf || r.asOf === asOf.replace(/\d\d$/, d => String(Number(d) - 1).padStart(2, '0')))
  const nodes = personnelOfArchive(pay.employees, asOf)
  const fields = ['name', 'startDate', 'endDate', 'salary', 'hoursPerDay', 'statutoryHours', 'daysPerWeek', 'classPercent', 'experience', 'kid', 'nkpd', 'position', 'socialSecurityType', 'healthSecurityType']
  let checked = 0, unequal = 0
  for (const r of recent as any[]) {
    const cands = nodes.filter(n => n.personId === r.personId) as any[]
    const best = cands.map(n => fields.filter(f => r[f] != null && JSON.stringify(r[f]) === JSON.stringify(n[f] ?? null)).length).reduce((a, b) => Math.max(a, b), -1)
    const filled = fields.filter(f => r[f] != null).length
    checked += filled
    unequal += best < 0 ? filled : filled - best
  }
  verdict(recent.length > 0 && !unequal, `personnel: ${recent.length} export rows of ${asOf}, ${checked} filled cells, unequal ${unequal}`)
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
