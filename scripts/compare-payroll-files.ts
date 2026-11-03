#!/usr/bin/env bun
/**
 * FR-25 §5.1's first gate: parse each filed обр. 1 and обр. 6 and emit it again. The bytes must equal
 * the file's, its own developer field aside.
 *
 *   bun scripts/compare-payroll-files.ts --root <dir of *.sealed> --identity <seal key file>
 *
 * ⚠ Opens the files in memory and prints counts and month names only.
 */
import { emitEmpl, EMPL_FIELD_COUNT, parseEmpl } from '../packages/services/src/biz/payroll/bg/files/empl2021'
import { emitNra, NRA_FIELD_COUNT, parseNra } from '../packages/services/src/biz/payroll/bg/files/nra62007'
import { declarationFiles, requiredArg, sealedRoot, versionsByMonth } from './lib/sealed-payroll'

const root = sealedRoot(requiredArg('root'), requiredArg('identity'))
const files = declarationFiles(root)

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])

function check(kind: 'empl' | 'nra', label: string, roundTrip: (bytes: Buffer) => { emitted: Uint8Array; records: number }) {
  const list = files.filter(f => f.kind === kind)
  const missedMonths = new Set<string>()
  const failedMonths = new Set<string>()
  let passes = 0
  let records = 0
  for (const file of list) {
    try {
      const bytes = root.open(file.rel)
      const result = roundTrip(bytes)
      records += result.records
      if (sameBytes(result.emitted, bytes)) passes++
      else missedMonths.add(file.period)
    } catch {
      // The reason may quote a field, so it stays out of the output: the month is enough to look.
      failedMonths.add(file.period)
    }
  }
  const months = new Set(list.map(f => f.period))
  console.log(`${label}: files ${list.length}, months ${months.size}, records ${records}, byte-identical ${passes}, differ ${missedMonths.size} months, unreadable ${failedMonths.size} months`)
  if (missedMonths.size) console.log(`  differ: ${[...missedMonths].sort().join(' ')}`)
  if (failedMonths.size) console.log(`  unreadable: ${[...failedMonths].sort().join(' ')}`)
}

check('empl', `обр. 1 (${EMPL_FIELD_COUNT} fields)`, bytes => {
  const rows = parseEmpl(bytes)
  return { emitted: emitEmpl(rows, { developerId: rows[0]?.developerId ?? '-' }), records: rows.length }
})

check('nra', `обр. 6 (${NRA_FIELD_COUNT} fields)`, bytes => {
  const { record, ending } = parseNra(bytes)
  return { emitted: emitNra(record, { developerId: record.developerId, ending }), records: 1 }
})

const newestEmpl = versionsByMonth(files, 'empl')
const several = [...newestEmpl.entries()].filter(([, v]) => v.length > 1)
console.log(`months with several versions of обр. 1: ${several.length} ${several.map(([m, v]) => `${m}×${v.length}`).join(' ')}`)
