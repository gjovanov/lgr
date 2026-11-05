#!/usr/bin/env bun
/**
 * FR-25 §5.1: a company's filed payroll into LGR. It opens the sealed files in memory and posts them
 * to the API, and that is the only place anything leaves them.
 *
 *   LGR_TOKEN=… bun scripts/import-payroll.ts --root <dir of *.sealed> --identity <seal key file> \
 *     --api <url> --org <orgId> [--months 202509,202510] [--version 202501=20250210_111111] [--execute] [--verify]
 *
 * Dry run by default: each step answers with what it would change, and nothing is written.
 *   --execute            writes.
 *   --verify             reads each month back from the API and compares it with the filed file.
 *   --months             only these months. People and contracts always come from every month.
 *   --version P=STAMP    takes this version of a month. A month with several takes the newest, and
 *                        they are listed: which one was filed is the accountant's to say.
 *   --books <dir>        personnel and salary sheets from a pull-plusminus-books day folder (sealed, read
 *                        out of the accountant's archive) instead of the GUI's Excel exports under --root.
 *                        The declarations still come from --root. Its sheet rows carry the ЕГН, so they
 *                        join the declaration by it, not by surname and initials.
 *
 * Credentials (env): LGR_TOKEN of a session in that org holding `payroll.import` and
 * `payroll.personal`.
 *
 * ⚠ Prints counts and month names, never a name, an ЕГН or an amount of one person. The decrypted
 * files are never written anywhere, a temporary file included.
 */
import type { PersonnelSnapshot } from '../packages/services/src/biz/payroll/bg/contract-fold'
import { parseEtz, parseUtd62, type ContractEvent } from '../packages/services/src/biz/payroll/bg/files/contract-events'
import { emitEmpl, parseEmpl, type EmplRow } from '../packages/services/src/biz/payroll/bg/files/empl2021'
import { emitNra, parseNra } from '../packages/services/src/biz/payroll/bg/files/nra62007'
import { nameParts, readPersonnel, readSalarySheets, declarationKey, sheetKey, sheetLines, type PersonnelRow, type SalarySheet, type SheetRow } from './lib/payroll-exports'
import { argValue, declarationFiles, requiredArg, sealedRoot, versionsByMonth, type SealedDeclaration } from './lib/sealed-payroll'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unsealBundle } from '../packages/services/src/biz/backup/backup-crypto'

const api = requiredArg('api').replace(/\/$/, '')
const orgId = requiredArg('org')
const token = process.env.LGR_TOKEN
if (!token) {
  console.error('LGR_TOKEN is required')
  process.exit(1)
}
const execute = process.argv.includes('--execute')
const verify = process.argv.includes('--verify')
const onlyMonths = argValue('months')?.split(',').map(m => m.trim())
const chosen = new Map((process.argv.flatMap((a, i) => (a === '--version' ? [process.argv[i + 1]] : [])) as string[]).map(v => v.split('=') as [string, string]))

const root = sealedRoot(requiredArg('root'), requiredArg('identity'))
const files = declarationFiles(root)

// --books: the newest sealed file of a kind in the folder, opened in memory only.
const books = argValue('books')
function openBooks<T>(prefix: string): T {
  const name = readdirSync(books!).filter(f => f.startsWith(prefix) && f.endsWith('.json.sealed')).sort().at(-1)
  if (!name) { console.error(`${books} has no ${prefix}*.json.sealed: run pull-books.ts with payroll`); process.exit(1) }
  return JSON.parse(unsealBundle(readFileSync(join(books!, name)), readFileSync(requiredArg('identity'), 'utf8').trim()).toString('utf8'))
}
const empl = versionsByMonth(files, 'empl')
const nra = versionsByMonth(files, 'nra')

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${api}/api/org/${orgId}/payroll/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    // Only the status and the code: a validation error can quote the value it refused.
    const answer: any = await res.json().catch(() => null)
    console.error(`${path}: ${res.status} ${answer?.code ?? ''}`)
    process.exit(1)
  }
  return res.json() as Promise<T>
}

function versionOf(period: string, versions: SealedDeclaration[]): SealedDeclaration {
  const wanted = chosen.get(period)
  const version = wanted ? versions.find(v => v.stamp === wanted) : versions[0]
  if (!version) {
    console.error(`${period}: no version ${wanted}. Held: ${versions.map(v => v.stamp).join(' ')}`)
    process.exit(1)
  }
  return version
}

const dated = (period: string) => `${period.slice(0, 4)}-${period.slice(4)}-01`

// Every month's rows, for the people on them.
const months = new Map<string, { version: SealedDeclaration; rows: EmplRow[] }>()
for (const [period, versions] of empl) {
  const version = versionOf(period, versions)
  months.set(period, { version, rows: parseEmpl(root.open(version.rel)) })
}
const several = [...empl.entries()].filter(([, v]) => v.length > 1)
console.log(`months ${months.size}, rows ${[...months.values()].reduce((n, m) => n + m.rows.length, 0)}`)
if (several.length) console.log(`several versions, the newest taken unless --version says: ${several.map(([p, v]) => `${p}×${v.length}`).join(' ')}`)

// What the register was told, and what the personnel exports say.
const events: ContractEvent[] = []
for (const rel of root.list('nap').filter(f => /\/ETZ[^/]*\.xml\.sealed$/i.test(f))) events.push(...parseEtz(root.open(rel)))
for (const rel of root.list('nap').filter(f => /\/UTD[^/]*\.txt\.sealed$/i.test(f))) events.push(...parseUtd62(root.open(rel)))
const personnel: PersonnelRow[] = books ? openBooks<PersonnelRow[]>('personnel-') : await readPersonnel(root)
const snapshots: PersonnelSnapshot[] = personnel.map(({ name: _name, ...snapshot }) => snapshot)
// What the declarations add: each person's newest row gives the codes the floor and ТЗПБ go by.
for (const [period, { rows }] of [...months.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  for (const row of rows) {
    snapshots.push({
      personId: row.personId,
      asOf: dated(period),
      activityKid: row.kid,
      qualificationGroup: row.qualificationGroup,
      mainActivityRow: row.mainActivityRow,
      statutoryHours: Number(row.totalDays[2]) || undefined,
      hoursPerDay: Number(row.totalDays[3]) || undefined,
    })
  }
}

// People: everyone on a declaration, under the fullest name a file gives.
const lastPeriod = [...months.keys()].sort().at(-1)!
const people = new Map<string, { personId: string; personIdKind: number; firstName?: string; middleName?: string; lastName: string; active: boolean; knownFrom: string }>()
for (const [period, { rows }] of [...months.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  for (const row of rows) {
    const held = people.get(row.personId)
    if (held) { held.active = held.active || period === lastPeriod; continue }
    people.set(row.personId, { personId: row.personId, personIdKind: row.personIdKind, firstName: row.initials[0], lastName: row.surname, active: period === lastPeriod, knownFrom: dated(period) })
  }
}
for (const row of personnel) {
  const person = people.get(row.personId)
  const name = nameParts(row.name)
  if (person && name.lastName) Object.assign(person, name)
}
for (const event of events) {
  const person = people.get(event.personId)
  if (person && event.lastName) Object.assign(person, { firstName: event.firstName, middleName: event.middleName || undefined, lastName: event.lastName })
}

// The month's sheets, newest of each, joined to the declaration by surname and initials.
const sheets: SalarySheet[] = books ? openBooks<SalarySheet[]>('salary-sheets-') : await readSalarySheets(root)
const sheetRows = new Map<string, SheetRow>()
// A row read from the archive names its person by ЕГН as well, and then joins by it ONLY: surname and initials can collide, and a
// row that has an ЕГН must never land on someone else's declaration through the name.
const sheetRowsById = new Map<string, SheetRow>()
for (const sheet of [...sheets].sort((a, b) => a.stamp.localeCompare(b.stamp))) for (const row of sheet.rows) {
  const personId = (row as SheetRow & { personId?: string }).personId
  if (personId) sheetRowsById.set(`${row.period}|${personId}`, row)
  else sheetRows.set(sheetKey(row), row)
}

function sheetFor(period: string, rows: EmplRow[]) {
  const out: { personId: string; lines: ReturnType<typeof sheetLines>; paidLeaveDays?: number }[] = []
  for (const row of rows) {
    const onSheet = sheetRowsById.get(`${period}|${row.personId}`) ?? sheetRows.get(declarationKey(period, row.surname, row.initials))
    if (onSheet) out.push({ personId: row.personId, lines: sheetLines(onSheet), paidLeaveDays: onSheet.values['Платен отпуск'] })
  }
  return out.length ? out : undefined
}

const dryRun = !execute
console.log(execute ? 'WRITING' : 'dry run: nothing is written')
const employeesReport = await post<{ create: number }>('import/employees', { people: [...people.values()], dryRun })
console.log('employees', JSON.stringify(employeesReport))
if (dryRun && employeesReport.create) console.log('  until those people exist, a dry run counts them as unknown below, and refuses their months')
// ⚠ Only the people this payroll is about. The register and the personnel exports reach further back
// than the declarations, and a person on neither was sent, and dropped, until 2026-11-03.
const declared = (p: { personId: string }) => people.has(p.personId)
console.log('contracts', JSON.stringify(await post('import/contracts', { events: events.filter(declared), snapshots: snapshots.filter(declared), people: [...people.keys()], dryRun })))

const wanted = onlyMonths ?? [...months.keys()].sort()
const tally = new Map<string, number>()
const flagged: string[] = []
for (const period of wanted) {
  const month = months.get(period)
  if (!month) {
    console.error(`${period}: not held`)
    process.exit(1)
  }
  const filedVersions = nra.get(period)
  const filed = filedVersions ? parseNra(root.open(versionOf(period, filedVersions).rel)) : undefined
  const report = await post<any>('import/months', { period, version: month.version.stamp, rows: month.rows, sheet: sheetFor(period, month.rows), filed, dryRun })
  tally.set(report.action, (tally.get(report.action) ?? 0) + 1)
  const noted = report.action === 'refused' || report.changed || report.gone || report.withoutContract
  if (noted) flagged.push(`${period} ${report.action}${report.reason ? ` ${report.reason}` : ''} people ${report.people} added ${report.added} changed ${report.changed} gone ${report.gone} without a contract ${report.withoutContract}`)
}
console.log('months', [...tally.entries()].map(([k, v]) => `${k}=${v}`).join(' '))
for (const line of flagged) console.log(`  ${line}`)

if (verify) {
  // §5.1's gate: what is stored emits what was filed, the developer field aside.
  const res = await fetch(`${api}/api/org/${orgId}/payroll/run?size=0`, { headers: { authorization: `Bearer ${token}` } })
  const runs: any[] = (await res.json()).payrollRuns ?? []
  const runOf = new Map(runs.filter(r => r.source === 'imported').map(r => [r.periodCode, r]))
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])
  const tallyGate = { empl: { equal: 0, differ: [] as string[] }, nra: { equal: 0, differ: [] as string[] }, sums: { equal: 0, differ: [] as string[] }, people: { equal: 0, differ: [] as string[] } }
  for (const period of wanted) {
    const run = runOf.get(period)
    if (!run) { tallyGate.empl.differ.push(`${period} (not imported)`); continue }
    const id = run._id ?? run.id
    const answer = await post<{ contentBase64: string }>(`run/${id}/declaration`, { form: 'empl', reason: 'declaration' })
    const stored = parseEmpl(Buffer.from(answer.contentBase64, 'base64'))
    const original = months.get(period)!.rows
    const developerId = original[0].developerId
    const equal = same(emitEmpl(stored, { developerId }), emitEmpl(original, { developerId }))
    if (equal) tallyGate.empl.equal++
    else tallyGate.empl.differ.push(period)
    if (run.totals?.employeeCount === original.length) tallyGate.people.equal++
    else tallyGate.people.differ.push(period)
    const filedVersions = nra.get(period)
    if (!filedVersions) continue
    const filed = parseNra(root.open(versionOf(period, filedVersions).rel))
    const back = await post<{ contentBase64: string }>(`run/${id}/declaration`, { form: 'nra', reason: 'declaration' })
    const again = parseNra(Buffer.from(back.contentBase64, 'base64'))
    const options = { developerId: filed.record.developerId, ending: filed.ending }
    if (same(emitNra(again.record, options), emitNra(filed.record, options))) tallyGate.nra.equal++
    else tallyGate.nra.differ.push(period)
    // Contributions recomputed from the rows equal the filed обр. 6, per fund (§7.4).
    const funds = run.totals?.contributions
    const [owed] = filed.record.columns
    const cents = (x: number | null | undefined) => Math.round((x ?? 0) * 100)
    const held = funds && cents(funds.doo.employer) + cents(funds.doo.employee) + cents(funds.tzpb.employer) === cents(owed.doo)
      && cents(funds.dzpo.employer) + cents(funds.dzpo.employee) === cents(owed.dzpoUpf)
      && cents(funds.zo.employer) + cents(funds.zo.employee) === cents(owed.zo)
    if (held) tallyGate.sums.equal++
    else tallyGate.sums.differ.push(period)
  }
  console.log(`gate: обр. 1 equal ${tallyGate.empl.equal}, differ ${tallyGate.empl.differ.length} ${tallyGate.empl.differ.join(' ')}`)
  console.log(`gate: обр. 6 equal ${tallyGate.nra.equal}, differ ${tallyGate.nra.differ.length} ${tallyGate.nra.differ.join(' ')}`)
  console.log(`gate: contributions = обр. 6 equal ${tallyGate.sums.equal}, differ ${tallyGate.sums.differ.length} ${tallyGate.sums.differ.join(' ')}`)
  console.log(`gate: people = rows equal ${tallyGate.people.equal}, differ ${tallyGate.people.differ.length} ${tallyGate.people.differ.join(' ')}`)
}
