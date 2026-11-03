/**
 * FR-25 R2's gate: every filed VAT month on disk, read and regenerated, compared byte for byte.
 *
 *   bun run scripts/compare-vat-files.ts --dir <nap/vat dir>
 *
 * It keeps the rows and who filed, and computes the rest: row totals, row numbers, all of `DEKLAR`,
 * `VIES` and whether the month has one. So `equal` means LGR's rules arrive at what was filed, not
 * that a parser can repeat itself. `generateMonthFiles` is the same path the app runs.
 *
 * ⚠ Prints `equal` or a count of differing records, never an amount, a partner or a document number:
 * this output lands in transcripts, and the files are customer data. Touches no database. Exit code 1
 * when anything differs.
 */
import { VatFileError } from '../packages/services/src/biz/vat-files/codec.js'
import { compareFiledMonth } from '../packages/services/src/biz/vat-files/month.js'
import { readVatDir } from './lib/vat-dir.js'

const args = process.argv.slice(2)
const dir = args[args.indexOf('--dir') + 1]
if (!args.includes('--dir') || !dir) {
  console.error('Usage: bun run scripts/compare-vat-files.ts --dir <nap/vat dir>')
  process.exit(2)
}

const months = readVatDir(dir)
if (!months.length) {
  console.error('No filed months under that folder (<dir>/<yyyymm>/<eik>/DEKLAR.txt).')
  process.exit(2)
}

let equal = 0
let files = 0
let records = 0
let vies = 0
for (const month of months) {
  try {
    const compared = compareFiledMonth(month.files)
    files += compared.length
    records += compared.reduce((sum, f) => sum + f.records, 0)
    vies += compared.some(f => f.name.toUpperCase() === 'VIES.TXT' && !f.only) ? 1 : 0
    const differs = compared.filter(f => f.differing)
    if (differs.length) {
      console.log(`${month.period}  ${differs.map(f => (f.only ? `${f.name}: only ${f.only}` : `${f.name}: ${f.differing} of ${f.records} records differ`)).join(', ')}`)
    } else {
      equal++
      console.log(`${month.period}  equal`)
    }
  } catch (e) {
    // The codec's errors name a field and a record, never a value. Anything else stays out of the output.
    console.log(`${month.period}  unreadable: ${e instanceof VatFileError ? e.message : 'unexpected error'}`)
  }
}

console.log(`\n${months.length} months: ${equal} equal, ${months.length - equal} differ. ${files} files (${vies} VIES), ${records} records.`)
process.exit(equal === months.length ? 0 : 1)
