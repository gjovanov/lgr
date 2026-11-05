#!/usr/bin/env bun
// pull-books.ts — the accountant's books and payroll, exported from one of the books PC's nightly archives (fetch-archive.ts) into a
// day folder the FR-25 importers read. No vendor server, no GUI: the archive IS the database (see SKILL.md for the proof).
//
//   bun pull-books.ts [--archive <dir>/<yyyymmdd>.arz.sealed]   default: the newest in $ACC_DOCS_ROOT/archives
//                     [--years 2025,2026]                       default: asOf's year and the one before
//                     [--dest DIR]                              default: $ACC_DOCS_ROOT/books/<yyyymmdd>
//                     [--no-payroll]
//
// Writes, under the day folder (a re-run writes the same bytes and says `same`):
//   journal-<YYYY>.json              ParsedJournal (services/biz/accounting-books/plusminus-exports.ts), the year's booked currency
//   chart-<YYYY>.json                { eik, year, rows: ParsedChartRow[] } with that year's stored openings
//   ap_<ROOT>_<eik>.json             each analytic root exactly as „Запис/четене от файл" writes it (UTF-8); ПЕРСОНАЛ never
//   opening-analytics-<YYYY>.json    { year, roots: { <ROOT>: [{ path, debit, credit, quantity? }] } }: the import names the account
//   payroll-<asOf>.json.sealed       ТРЗ: every person (params, months, absences) and the module's other tables     ┐ lgr-sealed-1,
//   personnel-<asOf>.json.sealed     PersonnelRow[] (scripts/lib/payroll-exports.ts), one per engagement             │ never written
//   salary-sheets-<asOf>.json.sealed SalarySheet[], each row with its personId                                       ┘ in the clear
//   meta.json, pull-books-manifest.txt
//
// ⚠ Prints counts only. Payroll is personal data: no name, ЕГН or per-person amount is printed or written unsealed.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { need } from '../pull-plusminus-api/stores-env'
import { sealBundle, unsealBundle } from '../../../packages/services/src/biz/backup/backup-crypto'
import {
  analyticNodes, analyticOpenings, analyticsFileRows, chartOfYear, journalOfYear, readArchiveBooks,
} from '../../../packages/services/src/biz/accounting-books/plusminus-archive'
import { personnelOfArchive, readArchivePayroll, sheetsOfArchive } from '../../../scripts/lib/payroll-archive'
import { sealKey, unsealKeyFile } from './seal-key'

const args = process.argv.slice(2)
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const withPayroll = !args.includes('--no-payroll')

const archives = opt('--archive') ? null : join(need('ACC_DOCS_ROOT'), 'archives')
const archive = opt('--archive') ?? (() => {
  const all = readdirSync(archives!).filter(f => /^\d{8}\.arz\.sealed$/.test(f)).sort()
  if (!all.length) { console.error(`pull-books: no archive in ${archives}; run fetch-archive.ts first`); process.exit(2) }
  return join(archives!, all[all.length - 1])
})()
const day = /(\d{8})\.arz\.sealed$/.exec(basename(archive))?.[1]
if (!day) { console.error('pull-books: --archive must be a <yyyymmdd>.arz.sealed from fetch-archive.ts'); process.exit(2) }
const asOf = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`
const years = (opt('--years') ?? `${Number(day.slice(0, 4)) - 1},${day.slice(0, 4)}`).split(',').map(y => Number(y.trim()))
if (years.some(y => !(y > 2000 && y < 2100))) { console.error('pull-books: --years takes YYYY,YYYY'); process.exit(2) }
const dest = opt('--dest') ?? join(need('ACC_DOCS_ROOT'), 'books', day)

const t0 = Date.now()
const gz = unsealBundle(readFileSync(archive), unsealKeyFile())
const archiveSha = createHash('sha256').update(gz).digest('hex')
const from = `${Math.min(...years)}0101`, to = `${Math.max(...years)}1231`
const books = await readArchiveBooks(gz, from, to)
if (!books.eik) throw new Error('pull-books: the archive names no Булстат for its company; refusing (the import checks it against the org)')
if (!books.accounts || !books.analytics) throw new Error('pull-books: the archive has no chart or no analytics')

mkdirSync(dest, { recursive: true })
type Row = { file: string; size: number; sha256: string; state: 'new' | 'same' | 'REPLACED' }
const manifest: Row[] = []
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
function write(name: string, content: string) {
  const path = join(dest, name), bytes = Buffer.from(content, 'utf8'), h = sha(bytes)
  const state: Row['state'] = !existsSync(path) ? 'new' : sha(readFileSync(path)) === h ? 'same' : 'REPLACED'
  if (state !== 'same') writeFileSync(path, bytes)
  manifest.push({ file: name, size: bytes.length, sha256: h, state })
}
/** Sealed output: what counts as "same" is the plaintext (each seal is randomised), kept as the marker beside it. */
function writeSealed(name: string, content: string) {
  const path = join(dest, name), plain = Buffer.from(content, 'utf8'), h = sha(plain)
  const marker = path + '.sha'
  const state: Row['state'] = !existsSync(path) ? 'new' : existsSync(marker) && readFileSync(marker, 'utf8').trim() === h ? 'same' : 'REPLACED'
  if (state !== 'same') { writeFileSync(path, sealBundle(plain, sealKey())); writeFileSync(marker, h) }
  manifest.push({ file: name, size: plain.length, sha256: h, state })
}
const json = (v: unknown) => JSON.stringify(v, null, 1) + '\n'

const perYear: Record<string, unknown> = {}
const roots = analyticNodes(books.analytics)
for (const year of years) {
  const journal = journalOfYear(books, year, asOf)
  write(`journal-${year}.json`, json(journal))
  write(`chart-${year}.json`, json({ eik: books.eik, year, rows: chartOfYear(books.accounts, year) }))
  const openings: Record<string, unknown[]> = {}
  for (const r of roots) {
    const lines = analyticOpenings(r.nodes, year, '').map(({ code: _code, ...line }) => line)
    if (lines.length) openings[r.root] = lines
  }
  write(`opening-analytics-${year}.json`, json({ eik: books.eik, year, roots: openings }))
  perYear[year] = { period: journal.period, currency: journal.currency, ...journal.counts, withoutHeader: journal.withoutHeader.length, openingRoots: Object.keys(openings).length }
  console.log(`${year} ${journal.currency}: ${journal.counts.documents} documents, ${journal.counts.operations} operations${journal.withoutHeader.length ? `, ${journal.withoutHeader.length} without header` : ''}; analytic openings on ${Object.keys(openings).length} roots`)
}
for (const r of roots) write(`ap_${r.root}_${books.eik}.json`, JSON.stringify(analyticsFileRows(r.root, r.nodes)))
console.log(`analytics: ${roots.length} roots, ${roots.reduce((n, r) => n + r.nodes.length, 0)} rows (ПЕРСОНАЛ not read)`)

let payroll: Record<string, number> | undefined
if (withPayroll) {
  const pay = await readArchivePayroll(gz)
  const personnel = personnelOfArchive(pay.employees, asOf)
  const sheets = sheetsOfArchive(pay.employees, day)
  writeSealed(`payroll-${asOf}.json.sealed`, json(pay))
  writeSealed(`personnel-${asOf}.json.sealed`, json(personnel))
  writeSealed(`salary-sheets-${asOf}.json.sealed`, json(sheets))
  payroll = { people: pay.employees.length, engagementsWithEgn: personnel.length, months: sheets.length, sheetRows: sheets.reduce((n, s) => n + s.rows.length, 0) }
  console.log(`payroll (sealed): ${payroll.people} people, ${payroll.months} months, ${payroll.sheetRows} person-months`)
}

write('meta.json', json({
  archive: basename(archive), archiveSha256: archiveSha, asOf, eik: books.eik, span: books.span, years: perYear,
  analyticRoots: roots.map(r => r.root), payroll, tool: 'pull-plusminus-books/pull-books.ts',
}))
writeFileSync(join(dest, 'pull-books-manifest.txt'), manifest.map(m => `${m.state.padEnd(9)} ${m.file.padEnd(48)} ${String(m.size).padStart(10)}  ${m.sha256.slice(0, 12)}`).join('\n') + '\n')
const tally = manifest.reduce((t, m) => ({ ...t, [m.state]: (t[m.state] ?? 0) + 1 }), {} as Record<string, number>)
console.log(`\n${dest}: ${manifest.length} files (${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
