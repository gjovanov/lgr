import { mongoose } from 'db/connection'
import { Account, AccountingAnalytic, Org, PostingRule } from 'db/models'
import { SALES_POSTING_RULES, planSeed, type PostingRuleData } from './posting-rule-seed.js'

/**
 * FR-25 R3, slice 3: the posting rules of one org that keeps books (§3.7), seeded and read
 * (`scripts/seed-posting-rules.ts`). What a seed holds is `posting-rule-seed.ts`, which boots nothing.
 *
 * ⚠ A seed run inserts the rules an org lacks and never touches one it has: a rule the accountant changed or turned
 * off (`isActive: false`) stays as they left it. A rule is recognised by its `code`, unique per org.
 */

export class PostingRulesError extends Error {
  constructor(message: string, readonly code: 'not_a_books_org' | 'chart_incomplete') {
    super(message)
    this.name = 'PostingRulesError'
  }
}

export interface SeedReport {
  /** Rules this slice seeds. */
  rules: number
  /** Planned: the ones the org lacks. */
  create: number
  /** The ones it holds, left as they are. */
  kept: number
  /** With `execute`: inserted. Fewer than planned when a run at the same time got there first. */
  written?: number
}

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v))

/** Throws unless the org keeps books (`settings.accounting.books.mode: 'books'`). */
export async function assertBooksOrg(orgId: string): Promise<void> {
  const org = await Org.findOne({ _id: oid(orgId) }).select('settings.accounting.books.mode').lean<{ settings?: { accounting?: { books?: { mode?: string } } } }>()
  if (org?.settings?.accounting?.books?.mode !== 'books') {
    throw new PostingRulesError('The org keeps no books (settings.accounting.books.mode is not `books`).', 'not_a_books_org')
  }
}

/** Seeds the org's posting rules: the ones it lacks, when its chart and tree hold every account and root they name. */
export async function seedPostingRules(orgId: string, opts: { execute?: boolean } = {}): Promise<SeedReport> {
  await assertBooksOrg(orgId)
  const org = oid(orgId)
  const [codes, chart, roots] = await Promise.all([
    PostingRule.distinct('code', { orgId: org }),
    Account.distinct('code', { orgId: org }),
    AccountingAnalytic.distinct('root', { orgId: org }),
  ])
  const plan = planSeed(new Set(codes.map(String)), new Set(chart.map(String)), new Set(roots.map(String)))
  if (plan.missingAccounts.length || plan.missingRoots.length) {
    const what = [...plan.missingAccounts.map(c => `account ${c}`), ...plan.missingRoots.map(r => `root ${r}`)].join(', ')
    throw new PostingRulesError(`The org's books lack what the rules name (${what}): import its chart and analytics first.`, 'chart_incomplete')
  }
  const report: SeedReport = { rules: SALES_POSTING_RULES.length, create: plan.create.length, kept: plan.kept }
  if (!opts.execute || !plan.create.length) return opts.execute ? { ...report, written: 0 } : report
  // An upsert that only ever inserts: a rule that appeared meanwhile, the accountant's or another run's, is left alone.
  const res = await PostingRule.bulkWrite(plan.create.map(({ code, ...rule }) => ({
    updateOne: { filter: { orgId: org, code }, update: { $setOnInsert: { ...rule, source: 'seed' } }, upsert: true },
  })), { ordered: false })
  return { ...report, written: res.upsertedCount }
}

/** The org's rules, as the posting reads them. Inactive ones included: the posting ignores them. */
export async function postingRulesOf(orgId: string): Promise<PostingRuleData[]> {
  const rows = await PostingRule.find({ orgId: oid(orgId) }).sort({ code: 1 }).lean<PostingRuleData[]>()
  return rows.map(r => ({
    code: r.code, label: r.label, isActive: r.isActive !== false, match: r.match, docType: r.docType,
    ...(r.partnerRoot ? { partnerRoot: r.partnerRoot } : {}), operations: r.operations, ...(r.vat?.register ? { vat: r.vat } : {}),
  }))
}
