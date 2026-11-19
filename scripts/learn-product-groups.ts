#!/usr/bin/env bun
/**
 * FR-25 R3, slice 1: the accounting group each product of one org books to (`ProductGroupMap`), learned
 * from what the accountant typed for the org's own sales documents, and how much of its sales the map
 * covers. The rules are `packages/services/src/biz/accounting-books/product-groups.ts`.
 *
 *   bun scripts/learn-product-groups.ts --org <slug> [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *       the dry run. Counts only, no names, numbers or amounts: the books' sales documents and where they
 *       belong, how many pair with an LGR document and how many do not, what the paired ones teach, the
 *       products mapped by source, the conflicts and the unmapped, and per month the share of lines and
 *       of value that has a group, for the invoices and notes and for the till's sales.
 *   bun scripts/learn-product-groups.ts --org <slug> [--from …] [--to …] --execute
 *       writes the map, and one audit row when anything changed.
 *
 * The period is in business days in Sofia, both ends included; unset, from the first to today. Learn over
 * the whole of the books: a learned row stays until a period that names the product says otherwise, so a
 * short period only ever adds evidence of its own.
 *
 * For an org that keeps a share of its books (`settings.accounting.books`, R7) and issues documents in a
 * series of its own. ⚠ Never changes a row of `source: 'accountant'` or one with `reviewedAt`. Writes only
 * on the org's home (FR-20, P0b-6), connects without building indexes (#546), and refuses to write without
 * the unique index of what it writes. Idempotent: a second run plans nothing.
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { AuditLog, Org, ProductGroupMap } from '../packages/db/src/models/index.js'
import { recordAuditEntry } from '../packages/services/src/biz/audit-log.service.js'
import { ProductGroupsError, learnProductGroups, type LearnReport } from '../packages/services/src/biz/accounting-books/product-groups.service.js'
import type { CoverageCell } from '../packages/services/src/biz/accounting-books/product-groups.js'
import { assertScriptHome } from './lib/home-guard.js'
import { requireUniqueIndexes } from './lib/require-indexes.js'

const SCRIPT = 'scripts/learn-product-groups.ts'
const FLAGS = new Set(['org', 'from', 'to', 'execute'])

function parseArgs(argv: string[]) {
  const o: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { o[key] = next; i++ } else { o[key] = true }
  }
  return o
}

const args = parseArgs(process.argv.slice(2))
const slug = typeof args.org === 'string' ? args.org : ''
const execute = args.execute === true
const unknown = Object.keys(args).filter(k => !FLAGS.has(k))

if (!slug || unknown.length || args.from === true || args.to === true || typeof args.execute === 'string') {
  console.error(`Usage: bun ${SCRIPT} --org <slug> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--execute]${unknown.length ? ` (unknown: --${unknown.join(', --')})` : ''}`)
  process.exit(2)
}

const row = (n: number, label: string) => console.log(`${String(n).padStart(7)}  ${label}`)
const pct = (part: number, whole: number) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : '-')

function coverageTable(title: string, months: { month: string; cell: CoverageCell }[]): void {
  console.log(`\n${title}`)
  if (!months.length) { console.log('  none in the period'); return }
  console.log('  month       lines   with a group   of value   typed, no product')
  const all: CoverageCell = { lines: 0, mappedLines: 0, noProduct: 0, value: 0, mappedValue: 0 }
  const line = (label: string, c: CoverageCell) =>
    console.log(`  ${label.padEnd(9)} ${String(c.lines).padStart(7)}   ${pct(c.mappedLines, c.lines).padStart(12)}   ${pct(c.mappedValue, c.value).padStart(8)}   ${String(c.noProduct).padStart(17)}`)
  for (const { month, cell } of months) {
    line(month, cell)
    for (const k of Object.keys(all) as (keyof CoverageCell)[]) all[k] += cell[k]
  }
  if (months.length > 1) line('all', all)
}

function print(r: LearnReport): void {
  console.log(`Org ${slug} — ${execute ? 'EXECUTE' : 'DRY-RUN'} — business days ${r.from ?? 'from the first'} to ${r.to}`)

  console.log('\nThe books\' sales documents this org holds')
  row(r.places.own, 'of its own series: paired with LGR below')
  row(r.places.till, 'a till\'s month (one document a device): no LGR document carries its number')
  row(r.places.outside, 'of a store that sells outside LGR')
  row(r.places.other_store, 'of another store\'s series')
  row(r.places.no_series, 'in no series')

  const p = r.pairing
  console.log('\nPairing with LGR\'s invoices, debit and credit notes')
  row(p.pairedEntries, `paired, with ${p.pairedDocuments} LGR documents`)
  row(p.notInLgr, 'not paired: LGR holds no document of the number')
  row(p.ambiguous, 'not paired: LGR holds several documents of the number, and not exactly one of them imported')
  row(p.typeDiffers, 'not paired: LGR\'s document of the number is of another register type')
  row(p.noNumber, 'not paired: the number is not digits')
  row(p.notInBooks, 'LGR documents of the period whose number no books document of the series names')

  const o = r.outcomes
  console.log('\nWhat the paired documents teach (one line an LGR document)')
  row(o.one_group, 'one group, at LGR\'s quantity: every product on it')
  row(o.line_for_line, 'line for line: the lines whose quantity is unique on both sides')
  row(o.no_unique_quantity, 'line for line, no quantity unique on both sides: nothing')
  row(o.not_line_for_line, 'not line for line (another count of goods operations than of goods lines): nothing')
  row(r.oneGroupQuantityDiffers, '  of the last three, one group in the books at another quantity than LGR\'s')
  row(o.no_goods_in_books, 'no goods group in the books')
  row(o.no_goods_in_lgr, 'no goods line in LGR')
  row(o.two_groups_in_one_operation, 'an operation names two groups: nothing')
  const l = r.lines
  console.log(`  their goods lines: ${l.goods}; by one group ${l.byOneGroup}, by a unique quantity ${l.byQuantity}, not matched ${l.notMatched}, typed with no product ${l.noProduct}`)

  const c = r.products
  console.log(`\nProducts (the org's goods, services left out: ${c.goods})`)
  row(c.exact, 'exact: the name of one active group')
  row(c.exactAmbiguous, '  of no single group: the name of two or more (not mapped by name)')
  row(c.learned, 'learned: every document of theirs names the same group')
  row(c.conflicts, 'conflict: their documents name more than one group (not mapped; to review)')
  row(c.conflictsOfOneDocument, '  of them, one document against all the others')
  row(c.inactiveGroup, 'their documents name a group that is no longer active (not mapped)')
  row(c.accountants, 'the accountant\'s (or reviewed) rows, left as they are')
  row(c.unmapped, 'goods with no group a line posts by')

  const s = r.rows.bySource
  console.log('\nThe map after the run, by source')
  row(s.exact, 'exact')
  row(s.learned, 'learned')
  row(s.accountant, 'accountant')
  row(s.rule + s.ai, 'rule or ai (suggestions: they post nothing until reviewed)')
  row(r.rows.reviewed, 'of all of them, reviewed by the accountant')

  const pl = r.planned
  console.log(`\nPlanned: ${pl.create} to create, ${pl.update} to update, ${pl.remove} to remove, ${pl.unchanged} unchanged`)
  if (r.written) {
    const w = r.written
    console.log(`Written: ${w.created} created, ${w.updated} updated, ${w.removed} removed`)
    if (w.skipped) console.log(`Left alone: ${w.skipped} rows changed since they were read (the accountant's by now?). Run again to see them.`)
  }

  console.log('\nCoverage after the run: lines not on a service, and the share of their net value')
  coverageTable('Invoices, debit and credit notes', r.coverage.invoices)
  coverageTable('Till sales', r.coverage.till)

  if (!execute) console.log(`\nDry run — nothing written. Re-run with --execute to write the map.`)
}

await connectDB({ readOnly: true })
let code = 1
try {
  const org = await Org.findOne({ slug }).select('_id').lean<{ _id: unknown }>()
  if (!org) {
    console.error(`No org ${slug}.`)
    code = 2
  } else {
    const orgId = String(org._id)
    await assertScriptHome(orgId, slug)
    // Documents only: building indexes is the app's (scripts/lib/require-indexes.ts).
    if (execute) await requireUniqueIndexes([ProductGroupMap, AuditLog])
    const report = await learnProductGroups(orgId, { from: typeof args.from === 'string' ? args.from : undefined, to: typeof args.to === 'string' ? args.to : undefined, execute })
    print(report)
    const w = report.written
    if (w && w.created + w.updated + w.removed > 0) {
      const audited = await recordAuditEntry({
        orgId, userId: '', via: SCRIPT, action: 'update', module: 'accounting', entityType: 'product_group_map', entityId: orgId,
        entityName: `products' accounting groups learned from the books (${SCRIPT})`,
        changes: Object.entries({ created: w.created, updated: w.updated, removed: w.removed, from: report.from ?? null, to: report.to })
          .map(([field, newValue]) => ({ field, oldValue: null, newValue })),
      })
      if (!audited) throw new Error('the audit row of the run was not written; the map itself was')
    }
    code = 0
  }
} catch (e) {
  if (!(e instanceof ProductGroupsError)) throw e
  console.error(`Refused (${e.code}): ${e.message}`)
  code = 2
} finally {
  await disconnectDB()
}
process.exit(code)
