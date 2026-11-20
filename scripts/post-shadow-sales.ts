#!/usr/bin/env bun
/**
 * FR-25 R3, slice 3: posts one org's own sales invoices, debit and credit notices of a period into the shadow ledger
 * (`ledger: 'shadow'`), and their rows into the home's shadow sales register. How a document books:
 * `packages/services/src/biz/accounting-books/shadow-sales.ts`; the run: `shadow-sales.service.ts`.
 *
 *   bun scripts/post-shadow-sales.ts --org <slug> --from YYYY-MM-DD --to YYYY-MM-DD
 *       the dry run. Counts only, no names, numbers or amounts: the documents of the period, how many would post and
 *       why the rest cannot, what the run would write, and each postable document against the accountant's entry of
 *       its number (equal, or where it differs; for the cost, by how much).
 *   bun scripts/post-shadow-sales.ts --org <slug> --from … --to … --execute
 *       writes, and one audit row when anything was written.
 *
 * Business days in Sofia, both ends included. ⚠ The shadow ledger is in no reading of the books (no balance, no
 * statement, no register the return is made from): it is LGR's own booking, kept beside the accountant's to be compared.
 * Idempotent: a second run writes nothing; a changed document is reversed and posted again, never written over. Writes
 * only on the homes of the org and of its books (FR-20, P0b-6), connects without building indexes (#546), and refuses to
 * write without the unique indexes of what it writes. A written entry names the org's owner as its creator.
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { AuditLog, FiscalPeriod, FiscalYear, JournalEntry, Org, Sequence, VatRegisterEntry } from '../packages/db/src/models/index.js'
import { initServiceContext } from 'services/context'
import { recordAuditEntry } from '../packages/services/src/biz/audit-log.service.js'
import { booksOrgsOf } from '../packages/services/src/biz/accounting-books/group-cost.service.js'
import { ShadowSalesError, postShadowSales, type ShadowRunReport } from '../packages/services/src/biz/accounting-books/shadow-sales.service.js'
import { assertScriptHome } from './lib/home-guard.js'
import { requireUniqueIndexes } from './lib/require-indexes.js'

const SCRIPT = 'scripts/post-shadow-sales.ts'
const FLAGS = new Set(['org', 'from', 'to', 'execute'])

const argv = process.argv.slice(2)
const args: Record<string, string | boolean> = {}
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue
  const next = argv[i + 1]
  if (next && !next.startsWith('--')) { args[argv[i].slice(2)] = next; i++ } else args[argv[i].slice(2)] = true
}
const slug = typeof args.org === 'string' ? args.org : ''
const execute = args.execute === true
const unknown = Object.keys(args).filter(k => !FLAGS.has(k))
if (!slug || typeof args.from !== 'string' || typeof args.to !== 'string' || unknown.length || typeof args.execute === 'string') {
  console.error(`Usage: bun ${SCRIPT} --org <slug> --from YYYY-MM-DD --to YYYY-MM-DD [--execute]${unknown.length ? ` (unknown: --${unknown.join(', --')})` : ''}`)
  process.exit(2)
}

const row = (n: number, label: string) => console.log(`${String(n).padStart(7)}  ${label}`)

const REASONS: Record<string, string> = {
  not_a_sales_document: 'not an outgoing invoice, debit or credit notice',
  not_issued: 'not issued',
  no_register_number: 'its number has no ten digits',
  not_own_series: "not in the org's own series",
  before_euro_changeover: 'before 2026: the books are in leva',
  currency_not_eur: 'not in euro',
  till_sale_invoice: "an invoice for a till sale: the till's month books it (§12, question 2)",
  vat_row: 'the sales register cannot carry it (a rate other than 20%, …)',
  no_lines: 'no lines',
  line_without_product: 'a line with no product',
  product_unknown: 'a line on a product the org does not hold',
  rule_unsupported: 'a rule this posting cannot apply',
  no_rule: 'a kind of line or amount no rule books',
  rules_overlap: 'two rules book the same amount',
  rules_conflict: 'the rules disagree (document type, partner root, register)',
  unknown_account: 'a rule names an account the chart lacks',
  no_partner: 'no partner',
  no_partner_analytic: "the partner has no analytic under the rule's root",
  partner_ambiguous: 'the partner has several analytics under the root',
  product_suggestion_only: 'a product whose group is only a suggestion (rule, ai)',
  product_unmapped: 'a product with no group',
  group_inactive: 'a product whose group is no longer active',
  no_cost: 'a group the books held none of before the day: no cost',
  nothing_to_post: 'nothing to post (all amounts zero)',
}

function print(r: ShadowRunReport): void {
  console.log(`Org ${slug} — ${execute ? 'EXECUTE' : 'DRY-RUN'} — business days ${r.from} to ${r.to}`)
  console.log('\nThe rules')
  if (r.rules.fromSeed) console.log(`  none stored: evaluated with the ${r.rules.active} a seed adds (scripts/seed-posting-rules.ts)`)
  else row(r.rules.stored, `stored, ${r.rules.active} active`)
  console.log(`\nCost basis: the books' own group average at the start of each sale's day (${r.cost.buckets} group-day sums, from ${r.cost.from ? `the opening of ${r.cost.from}` : 'the first entry'}, ${r.cost.asBooked ? 'as booked' : 'base amounts'})`)

  console.log('\nThe documents')
  row(r.documents, "issued sales documents of the org's, in the period")
  row(r.posts, 'post')
  row(r.voided, '  of all of them, voided')
  console.log('  cannot post, by the first reason:')
  for (const [k, n] of Object.entries(r.refused)) row(n, `  ${REASONS[k] ?? k}`)

  console.log(`\nWhat the run ${execute ? 'did' : 'would do'}`)
  row(r.actions.post, 'post')
  row(r.actions.repost, 'changed: reverse the live posting and post it again')
  row(r.actions.reverse, 'reverse the live posting (voided, or no longer postable)')
  row(r.actions.post_and_reverse, 'voided before it was posted: post and reverse')
  row(r.actions.none, 'nothing to do')
  row(r.periodClosed, 'left alone: a day it would be written on is in a closed fiscal period')
  row(r.periodsToCreate, 'business days no fiscal period holds yet (created with --execute)')
  console.log("  the home's shadow sales register:")
  row(r.vatRows.create, '  rows to add')
  row(r.vatRows.update, '  rows to update')
  row(r.vatRows.remove, '  rows to remove (the document no longer posts)')
  row(r.vatRows.unchanged, '  rows unchanged')
  row(r.vatRows.frozen, '  rows frozen by a filed return, left as filed')

  if (r.check) {
    const c = r.check
    console.log("\nAgainst the accountant's entry of the same number")
    row(c.compared, 'compared (postable, paired, not voided)')
    row(c.equal, 'equal: every account, analytic and side to the cent, and the quantities')
    row(c.differs, 'differ; where (a document can differ in several places):')
    row(c.by.revenue, '  revenue (K702 / K703)')
    row(c.by.vat, '  VAT (K4532)')
    row(c.by.cost, '  cost (D702, K304 per group, amount or quantity)')
    row(c.by.partner, '  partner (the same money on another analytic of 411)')
    row(c.by.cash, '  cash (D501, K411)')
    row(c.by.other, '  another account')
    console.log('  the cost, against the books\' cost of the document:')
    row(c.costSpread.within05, '  within 0.5%')
    row(c.costSpread.within5, '  within 5%')
    row(c.costSpread.more, '  more')
    row(c.booksMissing, "postable, but no books entry of the org's own series has the number")
    row(c.voided, 'voided: posted and reversed, nothing to compare')
  }
  if (r.written) {
    const w = r.written
    console.log(`\nWritten: ${w.entries} entries, ${w.reversals} reversals, ${w.vatRows} register rows`)
    if (w.raced) console.log(`Left to another run: ${w.raced} documents whose posting another run made meanwhile. Run again to see them.`)
  }
  if (!execute) console.log('\nDry run — nothing written. Re-run with --execute to write.')
}

await connectDB({ readOnly: true })
let code = 1
try {
  const org = await Org.findOne({ slug }).select('_id ownerId').lean<{ _id: unknown; ownerId?: unknown }>()
  if (!org) {
    console.error(`No org ${slug}.`)
    code = 2
  } else {
    const orgId = String(org._id)
    await assertScriptHome(orgId, slug)
    if (execute) {
      const { homeOrg } = await booksOrgsOf(orgId)
      if (homeOrg !== orgId) await assertScriptHome(homeOrg, 'the home of its books')
      await requireUniqueIndexes([JournalEntry, VatRegisterEntry, Sequence, FiscalYear, FiscalPeriod, AuditLog])
      if (!org.ownerId) throw new ShadowSalesError('The org names no owner, and a written entry names its creator.', 'no_creator')
    }
    const { createMongoRepositories } = await import('dal-mongo')
    initServiceContext(await createMongoRepositories({ backend: 'mongo' }))
    const report = await postShadowSales(orgId, { from: args.from, to: args.to, execute, ...(org.ownerId ? { by: String(org.ownerId) } : {}) })
    print(report)
    const w = report.written
    if (w && w.entries + w.reversals + w.vatRows > 0) {
      const audited = await recordAuditEntry({
        orgId, userId: '', via: SCRIPT, action: 'create', module: 'accounting', entityType: 'journal_entry', entityId: orgId,
        entityName: `sales documents posted into the shadow ledger (${SCRIPT})`,
        changes: Object.entries({ entries: w.entries, reversals: w.reversals, vatRows: w.vatRows, from: report.from, to: report.to })
          .map(([field, newValue]) => ({ field, oldValue: null, newValue })),
      })
      if (!audited) throw new Error('the audit row of the run was not written; the postings themselves were')
    }
    code = 0
  }
} catch (e) {
  if (!(e instanceof ShadowSalesError)) throw e
  console.error(`Refused (${e.code}): ${e.message}`)
  code = 2
} finally {
  await disconnectDB()
}
process.exit(code)
