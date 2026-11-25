import { mongoose } from 'db/connection'
import {
  Account, AccountingAnalytic, BOOKS_IMPORT, Contact, FiscalPeriod, Invoice, JournalEntry, POSTED_BOOKS, Product, ProductGroupMap, SHADOW_SALES, VatRegisterEntry,
} from 'db/models'
import { committedFromFiles, markedImported } from '../vat-files/sales-register.service.js'
import { sofiaDay } from '../vat-files/sales-register.js'
import { ensureFiscalPeriod } from '../accounting.service.js'
import { reserveNumbers } from '../sequence.service.js'
import { inTransaction, isDuplicateKey } from '../transaction.js'
import { booksOrgsOf, loadGroupCosts, type GroupCosts } from './group-cost.service.js'
import { SALES_POSTING_RULES, type PostingRuleData } from './posting-rule-seed.js'
import { assertBooksOrg, postingRulesOf } from './posting-rule.service.js'
import { NOT_ISSUED, POSTABLE_SOURCES, SALES_DOCUMENT_TYPES, pairDocuments, placeOf, type BooksSalesEntry, type LgrSalesDocument } from './product-groups.js'
import { ProductGroupsError, seriesOf } from './product-groups.service.js'
import { DOC_TYPES, SHADOW_ENTRY_NUMBER_PREFIX } from './registry.js'
import { DIFFERENCES, costOf, differencesOf, spreadOf, type ComparedLine, type CostDifference, type CostSpread, type Difference } from './shadow-compare.js'
import {
  SHADOW_REFUSALS, parseShadowKey, planShadowAction, postShadowSale, shadowPostingKey,
  type ExistingShadowEntry, type PartnerFacts, type ProductFacts, type ShadowAction, type ShadowDocument, type ShadowOutcome, type ShadowRefusal,
} from './shadow-sales.js'

/**
 * FR-25 R3, slice 3: posts one org's own sales documents of a period into the shadow ledger (`ledger: 'shadow'`), and,
 * on a dry run, checks each against the accountant's entry of the same number (`scripts/post-shadow-sales.ts`). What a
 * document books is `shadow-sales.ts`, which boots nothing.
 *
 * Where it writes (R7): the entry in the org that issued the document, which is the org that holds its books entries
 * (its own series); the document's row of the sales register in the HOME, where the VAT files are, with
 * `ledger: 'shadow'` and a `source` naming the document.
 *
 * Idempotent on the document: a posting carries `postingKey` `shadow:invoice:<document>:<revision>` (unique per org)
 * and the hash of what it books. A re-run that finds it unchanged writes nothing. A changed document is never written
 * over: its live revision is reversed (the same lines, negative, on the same sides) on its own day and the next one
 * posted. A voided document's posting is reversed on the void's day. Shadow entries move no balance (`balanceEffects`)
 * and no reading of the books reads them (`POSTED_BOOKS`), so they are written as posted, directly.
 */

export class ShadowSalesError extends Error {
  constructor(message: string, readonly code: 'not_a_books_org' | 'no_series' | 'bad_period' | 'no_rules' | 'no_creator') {
    super(message)
    this.name = 'ShadowSalesError'
  }
}

export interface ShadowRunOptions {
  /** `YYYY-MM-DD`, business days in Sofia, both ends included. */
  from: string
  to: string
  execute?: boolean
  /** The user a written entry names as its creator. Required with `execute`. */
  by?: string
}

type ActionName = ShadowAction['action']
type VatPlan = 'create' | 'update' | 'remove' | 'unchanged' | 'frozen' | 'none'

export interface SelfCheck {
  /** Postable documents paired with the books' entry of their number, and not voided. */
  compared: number
  equal: number
  differs: number
  /** Of those that differ, by where: a document can differ in several places. */
  by: Record<Difference, number>
  /** Of those whose cost differs: the quantities per group differ (the map), or only the amounts (the average). */
  cost: Record<CostDifference, number>
  /** Of those whose cost differs, how far the document's cost is from the books'. */
  costSpread: CostSpread
  /** Postable documents no books entry of the org's own series pairs with. */
  booksMissing: number
  /** Voided: posted and reversed, so nothing to compare. */
  voided: number
}

export interface ShadowRunReport {
  from: string
  to: string
  /** `fromSeed`: the seed's rules the org lacks, which a dry run read from the seed (a real run refuses while any are). */
  rules: { stored: number; active: number; fromSeed: number }
  cost: GroupCosts['read']
  /** The org's issued sales documents of the period. */
  documents: number
  posts: number
  refused: Record<ShadowRefusal, number>
  voided: number
  actions: Record<ActionName, number>
  /** Documents left alone: a day they would be written on is in a closed fiscal period. */
  periodClosed: number
  /** Business days no fiscal period holds yet: created on `execute`. */
  periodsToCreate: number
  vatRows: Record<Exclude<VatPlan, 'none'>, number>
  written?: { entries: number; reversals: number; vatRows: number; raced: number }
  check?: SelfCheck
}

const DAY_MS = 86_400_000
const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v))
const isoDay = (d: Date) => d.toISOString().slice(0, 10)

function parseDay(value: string, flag: string): Date {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : new Date(NaN)
  if (isNaN(d.getTime()) || isoDay(d) !== value) throw new ShadowSalesError(`${flag} is not a day: ${value} (YYYY-MM-DD)`, 'bad_period')
  return d
}

function voidedAt(doc: { statusHistory?: { status?: string; changedAt?: Date }[] }): Date | undefined {
  const entries = (doc.statusHistory ?? []).filter(h => h.status === 'voided' && h.changedAt)
  return entries.length ? new Date(entries[entries.length - 1].changedAt!) : undefined
}

interface StoredLine {
  accountId: unknown
  debit: number
  credit: number
  baseDebit: number
  baseCredit: number
  side?: 'debit' | 'credit'
  analyticId?: unknown
  quantity?: number
  [k: string]: unknown
}

/** A stored line, reversed: negative on the same side (§1.4). */
const reversedStored = (l: StoredLine): StoredLine => ({
  ...l,
  debit: -l.debit || 0, credit: -l.credit || 0, baseDebit: -l.baseDebit || 0, baseCredit: -l.baseCredit || 0,
  ...(typeof l.quantity === 'number' ? { quantity: -l.quantity || 0 } : {}),
})

const zeroes = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map(k => [k, 0])) as Record<K, number>

export async function postShadowSales(orgId: string, opts: ShadowRunOptions): Promise<ShadowRunReport> {
  const from = parseDay(opts.from, '--from')
  const to = parseDay(opts.to, '--to')
  if (from > to) throw new ShadowSalesError(`--from ${opts.from} is after --to ${opts.to}`, 'bad_period')
  if (opts.execute && !opts.by) throw new ShadowSalesError('A written entry names its creator: none given.', 'no_creator')
  const org = oid(orgId)
  await assertBooksOrg(orgId).catch(e => { throw new ShadowSalesError(e.message, 'not_a_books_org') })
  const series = await seriesOf(orgId).catch(e => {
    if (e instanceof ProductGroupsError && (e.code === 'not_a_books_org' || e.code === 'no_series')) throw new ShadowSalesError(e.message, e.code)
    throw e
  })
  const { homeOrg } = await booksOrgsOf(orgId)

  // The rules: the org's own. A rule of the seed's that the org lacks (none stored, or one added to the seed after the
  // org was seeded) is read from the seed by a dry run, which says so. ⚠ A real run refuses until
  // scripts/seed-posting-rules.ts has added it: without it, every document that needs it would be refused, and a refused
  // document's live posting is reversed (`planShadowAction`).
  const stored = await postingRulesOf(orgId)
  const storedCodes = new Set(stored.map(r => r.code))
  const unseeded = SALES_POSTING_RULES.filter(r => !storedCodes.has(r.code))
  if (unseeded.length && opts.execute) {
    const lacks = stored.length ? `lacks ${unseeded.length} of the seed's posting rules (${unseeded.map(r => r.code).join(', ')})` : 'holds no posting rules'
    throw new ShadowSalesError(`The org ${lacks}: run scripts/seed-posting-rules.ts first.`, 'no_rules')
  }
  const rules: readonly PostingRuleData[] = [...stored, ...unseeded]
  const partnerRoots = [...new Set(rules.map(r => r.partnerRoot).filter((r): r is string => !!r))]

  // The documents: issued (a voided one too), of a business day in the period.
  const docRows: any[] = await Invoice.find({
    orgId: org, direction: 'outgoing', type: { $in: SALES_DOCUMENT_TYPES }, status: { $nin: NOT_ISSUED },
    issueDate: { $gte: new Date(from.getTime() - DAY_MS), $lt: new Date(to.getTime() + 2 * DAY_MS) },
  }).select('invoiceNumber type direction status statusHistory tags issueDate currency subtotal discountTotal taxTotal total contactId cashSaleRef.cashSaleId lines.productId lines.quantity lines.unitPrice lines.discount lines.taxRate payments.date payments.amount payments.method payments.origin').lean()
  const docs = docRows.filter(d => { const day = sofiaDay(d.issueDate); return day >= from && day <= to })

  // The chart, and the products the documents sell with their groups, all of the posting org.
  const accounts = new Map((await Account.find({ orgId: org }).select('code').lean<{ _id: unknown; code: string }[]>()).map(a => [a.code, String(a._id)]))
  const groupRows = await AccountingAnalytic.find({ orgId: org, kind: 'goods_group' }).select('isActive unit').lean<{ _id: unknown; isActive?: boolean; unit?: string }[]>()
  const groups = new Map(groupRows.map(g => [String(g._id), { id: String(g._id), active: g.isActive !== false, ...(g.unit ? { unit: g.unit } : {}) }]))
  const productIds = [...new Set(docs.flatMap(d => (d.lines ?? []).map((l: any) => l.productId).filter(Boolean).map(String)))].map(oid)
  const maps = new Map((await ProductGroupMap.find({ orgId: org, productId: { $in: productIds } }).select('productId analyticId source').lean<{ productId: unknown; analyticId: unknown; source: string }[]>())
    .map(m => [String(m.productId), m]))
  const products = new Map<string, ProductFacts>()
  for (const p of await Product.find({ orgId: org, _id: { $in: productIds } }).select('type').lean<{ _id: unknown; type?: string }[]>()) {
    const id = String(p._id)
    if (p.type === 'service') { products.set(id, { service: true }); continue }
    const m = maps.get(id)
    const group = m ? groups.get(String(m.analyticId)) : undefined
    products.set(id, !m ? { service: false } : POSTABLE_SOURCES.has(m.source as never) ? { service: false, ...(group ? { group } : {}) } : { service: false, suggestionOnly: true })
  }
  const contactIds = [...new Set(docs.map(d => d.contactId).filter(Boolean).map(String))]
  const contacts = new Map((await Contact.find({ orgId: org, _id: { $in: contactIds.map(oid) } }).select('taxId vatNumber companyName firstName lastName').lean<any[]>()).map(c => [String(c._id), c]))
  const partnerRows = await AccountingAnalytic.find({ orgId: org, root: { $in: partnerRoots }, contactId: { $in: contactIds.map(oid) } }).select('root contactId').lean<{ _id: unknown; root: string; contactId: unknown }[]>()
  const partnerOf = (contactId: string | undefined, root: string): PartnerFacts => {
    const found = partnerRows.filter(a => a.root === root && String(a.contactId) === contactId)
    return found.length === 1 ? { analyticId: String(found[0]._id) } : { refused: found.length ? 'partner_ambiguous' : 'no_partner_analytic' }
  }

  const cost = await loadGroupCosts(orgId, from, to)
  const existing = new Map<string, ExistingShadowEntry[]>()
  for (const e of await JournalEntry.find({ orgId: org, ledger: 'shadow', sourceModule: SHADOW_SALES, sourceId: { $in: docs.map(d => d._id) } })
    .select('sourceId postingKey postingHash status date').lean<any[]>()) {
    const k = parseShadowKey(e.postingKey)
    if (!k) continue
    existing.set(String(e.sourceId), [...(existing.get(String(e.sourceId)) ?? []), {
      id: String(e._id), revision: k.revision, reversal: k.reversal, voided: e.status === 'voided', ...(e.postingHash ? { hash: e.postingHash } : {}), date: e.date,
    }])
  }
  const vatRows = new Map((await VatRegisterEntry.find({ orgId: oid(homeOrg), ledger: 'shadow', 'source.orgId': org, 'source.id': { $in: docs.map(d => d._id) } }).lean<any[]>())
    .map(r => [String(r.source.id), r]))
  const periods = await FiscalPeriod.find({ orgId: org }).select('startDate endDate status').lean<{ _id: unknown; startDate: Date; endDate: Date; status: string }[]>()
  const periodOf = (day: Date) => periods.find(p => p.startDate <= day && p.endDate >= day)

  const report: ShadowRunReport = {
    from: opts.from, to: opts.to,
    rules: { stored: stored.length, active: rules.filter(r => r.isActive).length, fromSeed: unseeded.length },
    cost: cost.read,
    documents: docs.length, posts: 0, refused: zeroes(SHADOW_REFUSALS), voided: 0,
    actions: zeroes(['post', 'repost', 'reverse', 'post_and_reverse', 'none'] as const),
    periodClosed: 0, periodsToCreate: 0,
    vatRows: zeroes(['create', 'update', 'remove', 'unchanged', 'frozen'] as const),
  }

  interface Work { doc: any; input: ShadowDocument; outcome: ShadowOutcome; action: ShadowAction; vat: VatPlan; days: Date[] }
  const work: Work[] = []
  // Every document, written or not: the self-check reads a closed month too, which is what it is run on.
  const checked: CheckedDocument[] = []
  const missingDays = new Set<string>()
  for (const d of docs) {
    const c = d.contactId ? contacts.get(String(d.contactId)) : undefined
    const input: ShadowDocument = {
      id: String(d._id), type: d.type, direction: d.direction, number: String(d.invoiceNumber ?? ''), status: d.status, issueDate: d.issueDate,
      ...(d.status === 'voided' ? { voidedAt: voidedAt(d) } : {}), currency: d.currency,
      subtotal: d.subtotal, discountTotal: d.discountTotal, taxTotal: d.taxTotal, total: d.total,
      ...(d.contactId ? { contactId: String(d.contactId) } : {}),
      partner: c ? { vatNumber: c.vatNumber, taxId: c.taxId, name: c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') } : undefined,
      ...(d.cashSaleRef?.cashSaleId ? { tillSale: true } : {}),
      lines: (d.lines ?? []).map((l: any) => ({ ...(l.productId ? { productId: String(l.productId) } : {}), quantity: Number(l.quantity) || 0, unitPrice: Number(l.unitPrice) || 0, discount: Number(l.discount) || 0, taxRate: l.taxRate })),
      payments: (d.payments ?? []).map((p: any) => ({ date: p.date ? new Date(p.date) : (undefined as never), amount: Number(p.amount) || 0, method: p.method, origin: p.origin })),
    }
    const outcome = postShadowSale(input, {
      series, rules, accounts, products,
      partner: root => partnerOf(input.contactId, root),
      unitCost: cost.unitCost,
    })
    const voidDay = d.status === 'voided' ? sofiaDay(input.voidedAt ?? d.issueDate) : undefined
    if (voidDay) report.voided++
    if ('posting' in outcome) report.posts++
    else report.refused[outcome.refused]++
    checked.push({ id: input.id, type: input.type, number: input.number, day: sofiaDay(input.issueDate), voided: !!voidDay, outcome, doc: d })
    const action = planShadowAction(outcome, existing.get(input.id) ?? [], voidDay)
    const entryDay = 'posting' in outcome ? outcome.posting.entry.date : undefined
    const days = action.action === 'post' ? [entryDay!]
      : action.action === 'repost' ? [action.reverse.date, entryDay!]
        : action.action === 'reverse' ? [action.on]
          : action.action === 'post_and_reverse' ? [entryDay!, action.on] : []
    const row = vatRows.get(input.id)
    const vat: VatPlan = 'posting' in outcome
      ? !row ? 'create' : row.frozen ? (sameRow(row, outcome.posting.vatRow) ? 'unchanged' : 'frozen') : sameRow(row, outcome.posting.vatRow) ? 'unchanged' : 'update'
      : !row ? 'none' : row.frozen ? 'frozen' : 'remove'
    // A closed period is never written into: the document waits whole, its register row too.
    if (days.some(day => { const p = periodOf(day); return !!p && p.status !== 'open' })) { report.periodClosed++; continue }
    for (const day of days) if (!periodOf(day)) missingDays.add(isoDay(day))
    report.actions[action.action]++
    if (vat !== 'none') report.vatRows[vat]++
    work.push({ doc: d, input, outcome, action, vat, days })
  }
  report.periodsToCreate = missingDays.size

  if (!opts.execute) report.check = await selfCheck(orgId, series, from, to, checked)
  else report.written = await write(orgId, homeOrg, opts.by!, work)
  return report
}

/** Whether a stored register row says what the document's row says. */
function sameRow(stored: any, want: { period: string; row: Record<string, any> }): boolean {
  const r = want.row
  const cells = (c: Record<string, number> | undefined) => JSON.stringify(Object.entries(c ?? {}).filter(([, v]) => v).sort(([a], [b]) => a.localeCompare(b)))
  return stored.period === want.period && stored.docTypeCode === r.docTypeCode && stored.docNumber === r.docNumber
    && +new Date(stored.docDate) === +r.docDate && (stored.partnerVat ?? '') === r.partnerVat && (stored.partnerName ?? '') === r.partnerName
    && (stored.description ?? '') === r.description && (stored.code ?? '') === r.code && cells(stored.cells) === cells(r.cells)
}

// ── the writes ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function write(orgId: string, homeOrg: string, by: string, work: { doc: any; input: ShadowDocument; outcome: ShadowOutcome; action: ShadowAction; vat: VatPlan; days: Date[] }[]) {
  const written = { entries: 0, reversals: 0, vatRows: 0, raced: 0 }
  const org = oid(orgId)
  const todo = work.filter(w => w.action.action !== 'none' || (w.vat !== 'none' && w.vat !== 'unchanged' && w.vat !== 'frozen'))
  // The numbers first, a year at a time: a number drawn and not used is a gap in a series nobody files.
  const needed = new Map<number, number>()
  for (const w of todo) for (const day of w.days) needed.set(day.getUTCFullYear(), (needed.get(day.getUTCFullYear()) ?? 0) + 1)
  const numbers = new Map<number, string[]>()
  for (const [year, n] of needed) numbers.set(year, await reserveNumbers(orgId, SHADOW_ENTRY_NUMBER_PREFIX, n, 6, year))
  const numberOn = (day: Date) => numbers.get(day.getUTCFullYear())!.shift()!
  const periodIds = new Map<string, string>()
  const periodOn = async (day: Date) => {
    const k = isoDay(day)
    if (!periodIds.has(k)) periodIds.set(k, await ensureFiscalPeriod(orgId, day))
    return oid(periodIds.get(k))
  }

  for (const w of todo) {
    const { action, outcome, input } = w
    const posting = 'posting' in outcome ? outcome.posting : undefined
    const plan: { reverse?: { id: string; revision: number; on: Date }; post?: { revision: number } } = {}
    if (action.action === 'repost') { plan.reverse = { id: action.reverse.id, revision: action.reverse.revision, on: action.reverse.date }; plan.post = { revision: action.revision } }
    if (action.action === 'reverse') plan.reverse = { id: action.reverse.id, revision: action.reverse.revision, on: action.on }
    if (action.action === 'post') plan.post = { revision: action.revision }
    // Posted, then reversed on the void's day: the order the ledger would hold had the run come in time.
    const reverseNew = action.action === 'post_and_reverse' ? { on: action.on, revision: action.revision } : undefined
    if (action.action === 'post_and_reverse') plan.post = { revision: action.revision }
    const newDoc = posting && plan.post ? {
      orgId: org, entryNumber: numberOn(posting.entry.date), date: posting.entry.date, docDate: posting.entry.date, fiscalPeriodId: await periodOn(posting.entry.date),
      description: `${posting.entry.docType} ${posting.entry.docNumber}`, reference: input.number, type: 'standard', status: 'posted', ledger: 'shadow',
      sourceModule: SHADOW_SALES, sourceId: oid(input.id), postingKey: shadowPostingKey(input.id, plan.post.revision), postingHash: posting.hash,
      docType: posting.entry.docType, docNumber: posting.entry.docNumber, registerDocType: posting.entry.registerDocType,
      partnerAnalyticId: posting.entry.partnerAnalyticId ? oid(posting.entry.partnerAnalyticId) : undefined,
      docTotal: posting.entry.docTotal, docVat: posting.entry.docVat, docCurrency: 'EUR', branchOrgId: org,
      lines: posting.entry.lines.map(l => ({
        accountId: oid(l.accountId), debit: l.side === 'debit' ? l.amount : 0, credit: l.side === 'credit' ? l.amount : 0, currency: 'EUR', exchangeRate: 1,
        baseDebit: l.side === 'debit' ? l.amount : 0, baseCredit: l.side === 'credit' ? l.amount : 0, opNo: l.opNo, side: l.side,
        ...(l.analyticId ? { analyticId: oid(l.analyticId) } : {}), ...(l.contactId ? { contactId: oid(l.contactId) } : {}),
        ...(l.quantity !== undefined ? { quantity: l.quantity } : {}), ...(l.unit ? { unit: l.unit } : {}), branchOrgId: org,
      })),
      totalDebit: posting.entry.total, totalCredit: posting.entry.total, createdBy: oid(by), postedBy: oid(by), postedAt: new Date(),
    } : undefined
    const reversalPeriod = plan.reverse ? await periodOn(plan.reverse.on) : undefined
    const voidPeriod = reverseNew ? await periodOn(reverseNew.on) : undefined
    const reversalNumber = plan.reverse ? numberOn(plan.reverse.on) : undefined
    const voidNumber = reverseNew ? numberOn(reverseNew.on) : undefined

    try {
      await inTransaction(async session => {
        const made = { entries: 0, reversals: 0, vatRows: 0 }
        // The entry it reverses, header and all, on the day given: the same lines, negative, on the same sides.
        const reverse = async (source: any, revision: number, on: Date, fiscalPeriodId: mongoose.Types.ObjectId, entryNumber: string) => {
          const header = Object.fromEntries(['orgId', 'docDate', 'reference', 'ledger', 'sourceModule', 'sourceId', 'docType', 'docNumber', 'registerDocType', 'partnerAnalyticId', 'docCurrency', 'branchOrgId']
            .filter(k => source[k] !== undefined).map(k => [k, source[k]]))
          await JournalEntry.create([{
            ...header, entryNumber, date: on, fiscalPeriodId, type: 'reversing', status: 'posted', description: `${source.description} (reversal)`,
            postingKey: shadowPostingKey(input.id, revision, true),
            lines: (source.lines ?? []).map((l: any) => reversedStored(Object.fromEntries(Object.entries(l).filter(([k]) => k !== '_id')) as StoredLine)),
            totalDebit: -source.totalDebit || 0, totalCredit: -source.totalCredit || 0, docTotal: -source.docTotal || 0, docVat: -source.docVat || 0,
            createdBy: oid(by), postedBy: oid(by), postedAt: new Date(),
          }], { session })
          made.reversals++
        }
        if (plan.reverse) {
          const live = await JournalEntry.findOne({ _id: oid(plan.reverse.id), orgId: org, ledger: 'shadow' }).session(session).lean()
          if (live) await reverse(live, plan.reverse.revision, plan.reverse.on, reversalPeriod!, reversalNumber!)
        }
        if (newDoc) {
          const [created] = await JournalEntry.create([newDoc], { session })
          made.entries++
          if (reverseNew) await reverse(created.toObject(), reverseNew.revision, reverseNew.on, voidPeriod!, voidNumber!)
        }
        const home = oid(homeOrg)
        const source = { orgId: org, kind: 'invoice', id: oid(input.id) }
        if ((w.vat === 'create' || w.vat === 'update') && posting) {
          const { period, row } = posting.vatRow
          await VatRegisterEntry.updateOne(
            { orgId: home, ledger: 'shadow', 'source.orgId': org, 'source.id': source.id, frozen: { $ne: true } },
            { $set: { period, side: 'sales', ...row, cells: row.cells, source, frozen: false }, $setOnInsert: { rowNo: 0 } },
            { upsert: true, session },
          )
          made.vatRows++
        } else if (w.vat === 'remove') {
          await VatRegisterEntry.deleteOne({ orgId: home, ledger: 'shadow', 'source.orgId': org, 'source.id': source.id, frozen: { $ne: true } }, { session })
          made.vatRows++
        }
        written.entries += made.entries
        written.reversals += made.reversals
        written.vatRows += made.vatRows
      })
    } catch (e) {
      // Another run made this posting meanwhile: its key is taken, and this one leaves the document to it.
      if (!isDuplicateKey(e)) throw e
      written.raced++
    }
  }
  return written
}

// ── the self-check ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A stored line's side: as written, or, on a line from before sides were stored, the one that carries the amount. */
export const sideOf = (l: { side?: string; debit?: number; credit?: number }): 'debit' | 'credit' =>
  l.side === 'debit' || l.side === 'credit' ? l.side : Number(l.credit) && !Number(l.debit) ? 'credit' : 'debit'

interface CheckedDocument { id: string; type: string; number: string; day: Date; voided: boolean; outcome: ShadowOutcome; doc: any }

async function selfCheck(orgId: string, series: Awaited<ReturnType<typeof seriesOf>>, from: Date, to: Date, documents: CheckedDocument[]): Promise<SelfCheck> {
  const org = oid(orgId)
  const check: SelfCheck = { compared: 0, equal: 0, differs: 0, by: zeroes(DIFFERENCES), cost: { groups: 0, average: 0 }, costSpread: { within05: 0, within5: 0, more: 0 }, booksMissing: 0, voided: 0 }
  const accounts = new Map((await Account.find({ orgId: org }).select('code').lean<{ _id: unknown; code: string }[]>()).map(a => [String(a._id), a.code]))
  const salesTypes = DOC_TYPES.filter(d => d.family === 'sales').map(d => d.code)
  type Entry = BooksSalesEntry & { lines: ComparedLine[] }
  const entries: Entry[] = []
  for await (const e of JournalEntry.find({
    orgId: org, ...POSTED_BOOKS, sourceModule: BOOKS_IMPORT, docType: { $in: salesTypes },
    date: { $gte: new Date(from.getTime() - 7 * DAY_MS), $lt: new Date(to.getTime() + 8 * DAY_MS) },
  }).select('docType docNumber registerDocType lines.accountId lines.analyticId lines.side lines.debit lines.credit lines.quantity').lean<any[]>().cursor()) {
    if (placeOf(e, series) !== 'own') continue
    entries.push({
      docType: String(e.docType), docNumber: String(e.docNumber ?? ''), registerDocType: e.registerDocType, goods: [],
      lines: (e.lines ?? []).map((l: any) => ({
        account: accounts.get(String(l.accountId)) ?? '', ...(l.analyticId ? { analyticId: String(l.analyticId) } : {}), side: sideOf(l),
        amount: sideOf(l) === 'credit' ? Number(l.credit) || 0 : Number(l.debit) || 0, ...(typeof l.quantity === 'number' ? { quantity: l.quantity } : {}),
      })),
    })
  }
  const withPdf = await committedFromFiles(org, documents.map(d => d.id))
  const lgr: LgrSalesDocument[] = documents.map(d => ({
    id: d.id, type: d.type, number: d.number, day: d.day, imported: markedImported(d.doc) || withPdf.has(d.id), inPeriod: true, lines: [],
  }))
  const { paired } = pairDocuments(entries, lgr)
  const booksOf = new Map(paired.map(p => [p.doc.id, p.entries as Entry[]]))
  for (const d of documents) {
    if (!('posting' in d.outcome)) continue
    if (d.voided) { check.voided++; continue }
    const books = booksOf.get(d.id)
    if (!books?.length) { check.booksMissing++; continue }
    check.compared++
    const shadow: ComparedLine[] = d.outcome.posting.entry.lines.map(l => ({
      account: l.account, ...(l.analyticId ? { analyticId: l.analyticId } : {}), side: l.side, amount: l.amount, ...(l.quantity !== undefined ? { quantity: l.quantity } : {}),
    }))
    const bookedLines = books.flatMap(e => e.lines)
    const diff = differencesOf(shadow, bookedLines)
    if (!diff.places.size) { check.equal++; continue }
    check.differs++
    for (const k of diff.places) check.by[k]++
    if (diff.cost) {
      check.cost[diff.cost]++
      check.costSpread[spreadOf(costOf(shadow), costOf(bookedLines))]++
    }
  }
  return check
}
