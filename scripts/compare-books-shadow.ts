#!/usr/bin/env bun
/**
 * FR-25 R3, slice 5: one store's months, the accountant's books against LGR's shadow ledger (§6.3).
 *
 *   bun scripts/compare-books-shadow.ts --org <store slug> --from YYYYMM [--to YYYYMM]
 *
 * Per month: the store's own sales documents each ledger holds, the ones both hold (equal, or where they differ),
 * each goods group's quantity and cost over those, the month's cost of sales, the documents one ledger holds alone,
 * and the home's sales register rows, the shadow's against the filed. The comparison is
 * `packages/services/src/biz/accounting-books/books-shadow-compare.ts`.
 *
 * Read-only. ⚠ Prints counts only, never a number, a partner, a group or an amount, so its output can go in a public
 * PR. Connects without building indexes (#546). Before `post-shadow-sales.ts --execute` has written a month, the
 * shadow side of it is empty: every books document is counted as the books' alone.
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Org } from '../packages/db/src/models/index.js'
import { groupCounts } from '../packages/services/src/biz/accounting-books/books-shadow-compare.js'
import { BooksShadowError, compareBooksShadowOf, type BooksShadowMonth } from '../packages/services/src/biz/accounting-books/books-shadow-compare.service.js'

const SCRIPT = 'scripts/compare-books-shadow.ts'
const FLAGS = new Set(['org', 'from', 'to'])

const argv = process.argv.slice(2)
const args: Record<string, string | boolean> = {}
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue
  const next = argv[i + 1]
  if (next && !next.startsWith('--')) { args[argv[i].slice(2)] = next; i++ } else args[argv[i].slice(2)] = true
}
const slug = typeof args.org === 'string' ? args.org : ''
const from = typeof args.from === 'string' ? args.from : ''
const to = typeof args.to === 'string' ? args.to : from
const unknown = Object.keys(args).filter(k => !FLAGS.has(k))
const PERIOD = /^\d{4}(0[1-9]|1[0-2])$/
if (!slug || !PERIOD.test(from) || !PERIOD.test(to) || to < from || unknown.length) {
  console.error(`Usage: bun ${SCRIPT} --org <store slug> --from YYYYMM [--to YYYYMM]${unknown.length ? ` (unknown: --${unknown.join(', --')})` : ''}`)
  process.exit(2)
}

function months(first: string, last: string): string[] {
  const out: string[] = []
  for (let y = Number(first.slice(0, 4)), m = Number(first.slice(4)); `${y}${String(m).padStart(2, '0')}` <= last; m === 12 ? (y++, m = 1) : m++) {
    out.push(`${y}${String(m).padStart(2, '0')}`)
  }
  return out
}

const row = (n: number, label: string) => console.log(`${String(n).padStart(7)}  ${label}`)
const SPREAD: Record<string, string> = { equal: 'equal to the cent', within05: 'within 0.5%', within5: 'within 5%', more: 'more than 5% apart' }

function print(r: BooksShadowMonth): void {
  console.log(`\n${slug} ${r.period}: the books against the shadow`)
  const d = r.documents
  console.log("The store's own sales documents")
  row(d.books, 'in the books')
  row(d.shadow, 'in the shadow')
  row(d.compared, 'in both, compared')
  row(d.booksOnly, 'only in the books')
  row(d.shadowOnly, 'only in the shadow')
  row(d.typeDiffers, 'in both, one as an invoice and the other as a notice: not compared')
  row(d.severalInShadow, 'in the shadow, several LGR documents under one number')
  row(d.noNumber, 'entries whose number is not digits, in neither count')
  row(r.leftOut.till, "the books' tills' months, which the shadow does not post yet (slice 4)")
  row(r.leftOut.otherSeries, "the books' sales entries of other series")

  const c = r.compared
  console.log('Of the compared documents')
  row(c.equal, 'equal: every account, analytic and side to the cent, and the quantities')
  row(c.differs, 'differ; where (a document can differ in several places):')
  row(c.by.revenue, '  revenue (K702 / K703)')
  row(c.by.vat, '  VAT (K4532)')
  row(c.by.cost, '  cost (D702, K304 per group)')
  row(c.cost.groups, '    of which the quantities per group differ (a product in another group)')
  row(c.cost.average, "    of which only the amounts differ (the cost's average)")
  row(c.by.partner, '  partner (another analytic on 411)')
  row(c.by.cash, '  cash (D501, K411)')
  row(c.by.other, '  another account, or a split the rest does not explain')
  console.log("  the cost, against the books' cost of the document, where it differs:")
  row(c.costSpread.within05, '  within 0.5%')
  row(c.costSpread.within5, '  within 5%')
  row(c.costSpread.more, '  more')

  const g = groupCounts(r.groups)
  console.log('The goods groups, over the compared documents')
  row(r.groups.length, 'groups either ledger takes goods out of')
  row(g.equal, 'equal: quantity, and cost to the cent')
  row(g.quantity, 'the quantities differ')
  row(g.within05, 'the same quantity, the cost within 0.5%')
  row(g.within5, 'the same quantity, the cost within 5%')
  row(g.more, 'the same quantity, the cost further apart')
  console.log(`The month's cost of sales over the compared documents: ${SPREAD[r.costOfSales.outcome]}`)

  const v = r.register
  console.log("The sales register in the home: the shadow's rows against the filed rows of the store's series")
  row(v.shadow, 'shadow rows')
  row(v.filed, 'filed rows')
  row(v.equal, 'equal')
  for (const [k, n] of Object.entries(v.differs).sort(([a], [b]) => a.localeCompare(b))) row(n, `differ in ${k}`)
  row(v.filedOnly, 'filed, not in the shadow')
  row(v.shadowOnly, 'in the shadow, not filed')
  row(v.several, 'a number with several rows on one side, compared by its first')
}

await connectDB({ readOnly: true })
let code = 1
try {
  const org = await Org.findOne({ slug }).select('_id').lean<{ _id: unknown }>()
  if (!org) {
    console.error(`No org ${slug}.`)
    code = 2
  } else {
    console.log(`Org ${slug}: ${from === to ? from : `${from} to ${to}`}. Read-only; counts only.`)
    for (const period of months(from, to)) print(await compareBooksShadowOf(String(org._id), period))
    code = 0
  }
} catch (e) {
  if (!(e instanceof BooksShadowError)) throw e
  console.error(`Refused (${e.code}): ${e.message}`)
  code = 2
} finally {
  await disconnectDB()
}
process.exit(code)
