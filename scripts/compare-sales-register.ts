#!/usr/bin/env bun
/**
 * FR-25 R3's gate: the sales register a books org filed for a month, against the register derived
 * from its branches' own documents (`services/biz/vat-files/sales-register.ts`).
 *
 *   bun run scripts/compare-sales-register.ts --org <books org slug> --period <YYYYMM> [--details <file>]
 *
 * Read-only. It reads the filed rows the VAT import stored in the books org (R2) and the issued
 * invoices, debit and credit notes of each branch named by `link-books`, derives each one's row, and
 * prints how many are equal, how many differ and in what, and which rows only one side has. A filed
 * row whose number is in a branch's series but that LGR does not hold is told apart from the rows no
 * branch explains: a protocol, a till's month, a series nobody has named (FR-25 §12).
 *
 * ⚠ Prints counts only, never a number, a partner or an amount, so its output can go in a public PR.
 * `--details <file>` writes one line a row that is not equal, with its number and the differences in
 * cents: that file is for the operator and stays out of the repo.
 *
 * Connects with `autoIndex: false, autoCreate: false`, so it builds nothing where it reads. Exits 1
 * when a filed month has a row that differs, or a branch's document only one side holds.
 */
import { writeFileSync } from 'node:fs'
import { config } from '../packages/config/src/index.js'
import { disconnectDB, mongoose } from '../packages/db/src/connection.js'
import { Org } from '../packages/db/src/models/index.js'
import { SalesRegisterError, compareSalesRegisterOf } from '../packages/services/src/biz/vat-files/sales-register.service.js'

const args = process.argv.slice(2)
const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SLUG = value('--org')
const PERIOD = value('--period')
const DETAILS = value('--details')

async function main(): Promise<number> {
  if (!SLUG || !PERIOD) {
    console.error('Usage: bun run scripts/compare-sales-register.ts --org <books org slug> --period <YYYYMM> [--details <file>]')
    return 2
  }
  await mongoose.connect(process.env.MONGODB_URI || config.mongodb.uri, { autoIndex: false, autoCreate: false })
  const org: any = await Org.findOne({ slug: SLUG }).select('_id').lean()
  if (!org) {
    console.error(`No org ${SLUG}.`)
    return 2
  }
  const gate = await compareSalesRegisterOf(org._id, PERIOD)
  console.log(`${SLUG} ${PERIOD}: ${gate.filedRows} rows filed, ${gate.derivedRows} derived from ${gate.branches.join(' + ')}`)
  if (!gate.filedRows) console.log('No sales register is filed for this period yet: the rows below are what LGR would declare.')
  for (const [k, n] of Object.entries(gate.counts).sort(([a], [b]) => a.localeCompare(b))) console.log(`${String(n).padStart(6)}  ${k}`)
  if (DETAILS) {
    writeFileSync(DETAILS, gate.details.map(d => JSON.stringify(d)).join('\n') + '\n')
    console.log(`\n${gate.details.length} rows that are not equal written to ${DETAILS} (it holds document numbers: keep it out of the repo)`)
  }
  return gate.gap ? 1 : 0
}

main()
  .then(async code => { await disconnectDB(); process.exit(code) })
  .catch(async e => {
    console.error(e instanceof SalesRegisterError ? e.message : e?.message ?? e)
    await disconnectDB().catch(() => {})
    process.exit(e instanceof SalesRegisterError ? 2 : 1)
  })
