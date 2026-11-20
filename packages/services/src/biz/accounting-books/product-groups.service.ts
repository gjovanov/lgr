import { lineAmounts } from 'config/line-amounts'
import { mongoose } from 'db/connection'
import { AccountingAnalytic, BOOKS_IMPORT, Invoice, JournalEntry, Org, POSTED_BOOKS, Product, ProductGroupMap, type ProductGroupSource } from 'db/models'
import { committedFromFiles, markedImported } from '../vat-files/sales-register.service.js'
import { sofiaDay } from '../vat-files/sales-register.js'
import {
  NOT_A_DOCUMENT, NOT_ISSUED, SALES_DOCUMENT_TYPES, TILL_TYPES,
  addCoverage, evidenceOfDocument, exactGroupsOf, newCoverage, pairDocuments, placeOf, postsBy, rowsBySource,
  type BooksGoodsOp, type BooksSalesEntry, type CoverageCell, type CoverageDocument, type CoverageKind, type EntryPlace, type EvidenceOutcome,
  type GoodsGroup, type GroupVote, type LgrSalesDocument, type LineCounts, type MapPlan, type MapRow, type OrgSeries, type PairedDocument,
  type PairingCounts, type ProductCounts,
} from './product-groups.js'
import { learnWithPartition, type PartitionCounts, type PartitionLearning } from './product-group-partition.js'
import { ANALYTIC_ROOTS, DOC_TYPES } from './registry.js'

/**
 * FR-25 R3, slice 1: learns the product → accounting group map of one org from its own books and its
 * own documents, and measures what the map covers (`scripts/learn-product-groups.ts`). The rules are
 * in `product-groups.ts` and, for the books' quantity per group (slice 1b), `product-group-partition.ts`;
 * neither boots anything.
 *
 * One org, the way R7 split the books: a store's sales documents and its products are in the same org,
 * so the map is too. Reads only that org. Writes only `ProductGroupMap`, and only with `execute`.
 *
 * Slice 2's review queue (`product-group-review.service.ts`) reads through the same functions:
 * `loadLearning` for the evidence, `eachSalesDocument` for the sales and their value, `goodsGroupsOf`
 * and `asGoodsGroup` for which analytics are groups.
 */

export class ProductGroupsError extends Error {
  constructor(message: string, readonly code: 'not_a_books_org' | 'no_series' | 'bad_period') {
    super(message)
    this.name = 'ProductGroupsError'
  }
}

export interface LearnOptions {
  /** `YYYY-MM-DD`, the first business day. Unset: from the first. */
  from?: string
  /** `YYYY-MM-DD`, the last business day. Unset: today in Sofia. */
  to?: string
  execute?: boolean
  now?: Date
}

export interface LearnReport {
  from?: string
  to: string
  /** The org's books sales entries in the period, by where their document belongs. */
  places: Record<EntryPlace, number>
  pairing: PairingCounts
  /** Per paired LGR document. */
  outcomes: Record<EvidenceOutcome, number>
  /** Paired documents whose books name one group at another total quantity than LGR's. */
  oneGroupQuantityDiffers: number
  lines: LineCounts
  /** What the books' quantity per group taught on the documents the two rules above leave a product line on (slice 1b). */
  partition: PartitionCounts
  products: ProductCounts
  rows: ReturnType<typeof rowsBySource>
  planned: { create: number; update: number; remove: number; unchanged: number }
  /** With `execute`: what was written, and what was planned but found changed meanwhile. */
  written?: { created: number; updated: number; removed: number; skipped: number }
  coverage: Record<CoverageKind, { month: string; cell: CoverageCell }[]>
}

const DAY_MS = 86_400_000
const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v))
const isoDay = (d: Date) => d.toISOString().slice(0, 10)

function parseDay(value: string | undefined, flag: string): Date | undefined {
  if (value === undefined) return undefined
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : new Date(NaN)
  if (isNaN(d.getTime()) || isoDay(d) !== value) throw new ProductGroupsError(`${flag} is not a day: ${value} (YYYY-MM-DD)`, 'bad_period')
  return d
}

/** Business days in Sofia, both ends included: `from` unset is from the first. */
export interface LearnPeriod {
  from?: Date
  to: Date
}

/** The period of `from` and `to` (`YYYY-MM-DD`), `to` unset today in Sofia; refused (`bad_period`) when it is none. */
export function periodOf(opts: Pick<LearnOptions, 'from' | 'to' | 'now'>): LearnPeriod {
  const from = parseDay(opts.from, '--from')
  const to = parseDay(opts.to, '--to') ?? sofiaDay(opts.now ?? new Date())
  if (from && from > to) throw new ProductGroupsError(`--from ${isoDay(from)} is after --to ${isoDay(to)}`, 'bad_period')
  return { ...(from ? { from } : {}), to }
}

export const inPeriodOf = (p: LearnPeriod) => (day: Date) => (!p.from || day >= p.from) && day <= p.to

/** A range of `issueDate` or `date`, `margin` days wider on each side. */
const rangeOf = (from: Date | undefined, to: Date, margin: number) => ({
  ...(from ? { $gte: new Date(from.getTime() - margin * DAY_MS) } : {}),
  $lt: new Date(to.getTime() + (margin + 1) * DAY_MS),
})

interface BooksSettings {
  mode?: string
  branches?: { orgId?: unknown; docSeries?: string[] }[]
  externalBranches?: { docSeries?: string[] }[]
}

/** The org's own series, the other stores' and the ones outside LGR, from the books link (`link-books`). */
export async function seriesOf(orgId: string): Promise<OrgSeries> {
  const org = await Org.findOne({ _id: oid(orgId) }).select('settings.accounting.books').lean<{ settings?: { accounting?: { books?: BooksSettings } } }>()
  const books = org?.settings?.accounting?.books
  if (books?.mode !== 'books') throw new ProductGroupsError('The org keeps no books (settings.accounting.books.mode is not `books`).', 'not_a_books_org')
  const branches = books.branches ?? []
  const own = branches.filter(b => String(b.orgId) === orgId).flatMap(b => b.docSeries ?? [])
  if (!own.length) throw new ProductGroupsError('The org is no branch of its books with a series of its own: its books name none of its documents.', 'no_series')
  return {
    own,
    otherStores: branches.filter(b => String(b.orgId) !== orgId).flatMap(b => b.docSeries ?? []),
    outside: (books.externalBranches ?? []).flatMap(b => b.docSeries ?? []),
  }
}

// ── the goods groups and the products ────────────────────────────────────────────────────────────

/** The root every goods group is under (`СТОКИ`). */
export const GOODS_ROOT = ANALYTIC_ROOTS.find(r => r.kind === 'goods_group')!.root

export interface GoodsGroupRow extends GoodsGroup {
  path: string
}

/**
 * An analytic as a goods group, or nothing: one under the goods root, the root itself not one, active unless switched
 * off. The one rule learning reads its groups by and the review queue checks an accountant's choice by.
 */
export function asGoodsGroup(a: { _id: unknown; root?: string; path: string; name: string; isActive?: boolean }): GoodsGroupRow | undefined {
  if (a.root !== GOODS_ROOT || a.path === GOODS_ROOT) return undefined
  return { id: String(a._id), name: a.name, path: a.path, active: a.isActive !== false }
}

type AnalyticRow = { _id: unknown; root?: string; path: string; name: string; isActive?: boolean }

/** The org's goods groups, by id, the inactive ones too. */
export async function goodsGroupsOf(org: mongoose.Types.ObjectId): Promise<Map<string, GoodsGroupRow>> {
  const analytics = await AccountingAnalytic.find({ orgId: org, root: GOODS_ROOT }).select('root path name isActive').lean<AnalyticRow[]>()
  const out = new Map<string, GoodsGroupRow>()
  for (const a of analytics) {
    const g = asGoodsGroup(a)
    if (g) out.set(g.id, g)
  }
  return out
}

/** One analytic of the org as a goods group, or nothing: what an accountant's choice is checked by. */
export async function goodsGroupOf(org: mongoose.Types.ObjectId, analyticId: string): Promise<GoodsGroupRow | undefined> {
  if (!mongoose.isValidObjectId(analyticId)) return undefined
  const a = await AccountingAnalytic.findOne({ _id: oid(analyticId), orgId: org }).select('root path name isActive').lean<AnalyticRow>()
  return a ? asGoodsGroup(a) : undefined
}

/** The org's products as a run reads its lines: a line on a product the org does not hold is typed, a service needs no group. */
export interface ProductIndex {
  productOf(id: unknown): string | undefined
  isService(productId: string): boolean
}

export function productIndexOf(products: readonly { _id: unknown; type?: string }[]): ProductIndex {
  const services = new Set(products.filter(p => p.type === 'service').map(p => String(p._id)))
  const known = new Set(products.map(p => String(p._id)))
  return {
    productOf: id => (id && known.has(String(id)) ? String(id) : undefined),
    isService: productId => services.has(productId),
  }
}

// ── what a run reads, and what it learns from it ─────────────────────────────────────────────────

interface EntryRow { docType?: string; docNumber?: string; registerDocType?: string; lines?: { opNo?: number; analyticId?: unknown; quantity?: number }[] }
interface InvoiceRow {
  _id: unknown
  invoiceNumber?: string
  type: string
  issueDate: Date
  exchangeRate?: number
  tags?: string[]
  statusHistory?: { reason?: string }[]
  lines?: { productId?: unknown; quantity?: number; unitPrice?: number; discount?: number }[]
}
export interface MapRowDoc {
  _id: unknown
  productId: unknown
  analyticId: unknown
  source: ProductGroupSource
  evidenceCount?: number
  conflictCount?: number
  lastEvidenceAt?: Date
  reviewedAt?: Date
  reviewedBy?: unknown
  updatedAt?: Date
}

/** A stored row as the rules read it. */
export function mapRowOf(r: MapRowDoc): MapRow {
  return {
    id: String(r._id), productId: String(r.productId), analyticId: String(r.analyticId), source: r.source,
    evidenceCount: r.evidenceCount ?? 0, conflictCount: r.conflictCount ?? 0,
    ...(r.lastEvidenceAt ? { lastEvidenceAt: new Date(r.lastEvidenceAt) } : {}), ...(r.reviewedAt ? { reviewedAt: new Date(r.reviewedAt) } : {}),
  }
}

/** The goods operations of a books entry: one per operation that names a goods group. */
function goodsOf(e: EntryRow, groups: ReadonlyMap<string, unknown>): { goods: BooksGoodsOp[]; mixed: boolean } {
  const ops = new Map<string, { groups: Set<string>; quantity: number }>()
  for (const [i, l] of (e.lines ?? []).entries()) {
    const groupId = l.analyticId ? String(l.analyticId) : ''
    if (!groups.has(groupId)) continue
    // Both lines of an operation carry its quantity; an operation with no number is its own line.
    const key = l.opNo !== undefined && l.opNo !== null ? `op${l.opNo}` : `line${i}`
    const op = ops.get(key) ?? { groups: new Set<string>(), quantity: Number(l.quantity) || 0 }
    op.groups.add(groupId)
    ops.set(key, op)
  }
  const all = [...ops.values()]
  return {
    goods: all.filter(o => o.groups.size === 1).map(o => ({ groupId: [...o.groups][0], quantity: o.quantity })),
    mixed: all.some(o => o.groups.size > 1),
  }
}

const zeroOutcomes = (): Record<EvidenceOutcome, number> => ({
  one_group: 0, line_for_line: 0, no_unique_quantity: 0, not_line_for_line: 0, no_goods_in_books: 0, no_goods_in_lgr: 0, two_groups_in_one_operation: 0,
})

/** What a run reads of one org and what it learns from it, before anything is written. */
export interface Learning {
  period: LearnPeriod
  org: mongoose.Types.ObjectId
  /** The goods groups, by id, the inactive ones too. */
  groups: Map<string, GoodsGroupRow>
  products: ProductIndex
  /** The org's products that are not a service. */
  goodsProducts: string[]
  places: Record<EntryPlace, number>
  pairing: PairingCounts
  paired: PairedDocument[]
  /** Slice 1's votes, per paired document. */
  slice1: { doc: LgrSalesDocument; votes: GroupVote[] }[]
  outcomes: Record<EvidenceOutcome, number>
  oneGroupQuantityDiffers: number
  lines: LineCounts
  exact: { byProduct: Map<string, string>; ambiguous: number }
  activeGroups: Set<string>
  /** The map as stored when the run read it. */
  existing: MapRow[]
  /** Slice 1 and partition: the evidence, the contradictions and the plan. */
  learned: PartitionLearning
}

/** Read the period's books and documents of `orgId`, and learn from them (`learnProductGroups` without the writes). */
export async function loadLearning(orgId: string, opts: Pick<LearnOptions, 'from' | 'to' | 'now'> = {}): Promise<Learning> {
  const period = periodOf(opts)
  const { from, to } = period
  const inPeriod = inPeriodOf(period)
  const org = oid(orgId)
  const series = await seriesOf(orgId)

  // The groups: every analytic under the goods root, the root itself excluded.
  const groups = await goodsGroupsOf(org)

  // The products: services need no group, and a line on a product the org does not hold is typed.
  const productRows = await Product.find({ orgId: org }).select('name type').lean<{ _id: unknown; name?: string; type?: string }[]>()
  const products = productIndexOf(productRows)
  const goodsRows = productRows.filter(p => p.type !== 'service')

  // The books: the org's own sales entries, as booked.
  const places: Record<EntryPlace, number> = { own: 0, till: 0, outside: 0, other_store: 0, no_series: 0 }
  const entries: BooksSalesEntry[] = []
  const salesTypes = DOC_TYPES.filter(d => d.family === 'sales').map(d => d.code)
  const entryCursor = JournalEntry.find({ orgId: org, ...POSTED_BOOKS, sourceModule: BOOKS_IMPORT, docType: { $in: salesTypes }, date: rangeOf(from, to, 0) })
    .select('docType docNumber registerDocType lines.opNo lines.analyticId lines.quantity').lean<EntryRow[]>().cursor()
  for await (const e of entryCursor) {
    const place = placeOf(e, series)
    if (!place) continue
    places[place]++
    if (place !== 'own') continue
    const { goods, mixed } = goodsOf(e, groups)
    entries.push({ docType: String(e.docType), docNumber: String(e.docNumber ?? ''), registerDocType: e.registerDocType, goods, ...(mixed ? { mixed } : {}) })
  }

  // LGR's documents of those numbers, a month wider than the period so a pair across its edge is found.
  const documents: LgrSalesDocument[] = []
  const marks: { id: unknown; imported: boolean }[] = []
  const docCursor = Invoice.find({ orgId: org, direction: 'outgoing', type: { $in: SALES_DOCUMENT_TYPES }, status: { $nin: NOT_ISSUED }, issueDate: rangeOf(from, to, 32) })
    .select('invoiceNumber type issueDate tags statusHistory.reason lines.productId lines.quantity').lean<InvoiceRow[]>().cursor()
  for await (const d of docCursor) {
    const day = sofiaDay(d.issueDate)
    marks.push({ id: d._id, imported: markedImported(d) })
    documents.push({
      id: String(d._id), type: d.type, number: String(d.invoiceNumber ?? ''), day, imported: false, inPeriod: inPeriod(day),
      lines: (d.lines ?? []).map(l => {
        const productId = products.productOf(l.productId)
        return { ...(productId ? { productId } : {}), quantity: Number(l.quantity) || 0, ...(productId && products.isService(productId) ? { service: true } : {}) }
      }),
    })
  }
  const withPdf = await committedFromFiles(org, marks.map(m => m.id))
  documents.forEach((d, i) => { d.imported = marks[i].imported || withPdf.has(d.id) })

  // Pairing and evidence.
  const { paired, counts: pairing } = pairDocuments(entries, documents)
  const outcomes = zeroOutcomes()
  const lines: LineCounts = { goods: 0, byOneGroup: 0, byQuantity: 0, notMatched: 0, noProduct: 0 }
  let oneGroupQuantityDiffers = 0
  const slice1 = paired.map(p => {
    const ev = evidenceOfDocument(p)
    outcomes[ev.outcome]++
    if (ev.oneGroupQuantityDiffers) oneGroupQuantityDiffers++
    for (const k of Object.keys(lines) as (keyof LineCounts)[]) lines[k] += ev.lines[k]
    return { doc: p.doc, votes: ev.votes }
  })

  // The plan.
  const exact = exactGroupsOf(goodsRows.map(p => ({ id: String(p._id), name: String(p.name ?? '') })), [...groups.values()])
  const stored = await ProductGroupMap.find({ orgId: org }).lean<MapRowDoc[]>()
  const existing = stored.map(mapRowOf)
  const goodsProducts = goodsRows.map(p => String(p._id))
  const activeGroups = new Set([...groups.values()].filter(g => g.active).map(g => g.id))
  // Slice 1's votes as they are, and what the books' quantity per group adds to them (slice 1b).
  const learned = learnWithPartition({ paired, slice1, goodsProducts, exact: exact.byProduct, exactAmbiguous: exact.ambiguous, activeGroups, existing })
  return {
    period, org, groups, products, goodsProducts, places, pairing, paired, slice1, outcomes, oneGroupQuantityDiffers, lines, exact, activeGroups,
    existing, learned,
  }
}

/**
 * Every document coverage reads in the period, as it reads it: the outgoing invoices, notes and till sales that are
 * documents, and of each line its product (none when the org does not hold it), whether it is a service, and its NET
 * value in the base currency. ⚠ `lineAmounts(…).taxable × rate`, never `lineTotal`: that is gross on a cash sale.
 */
export async function eachSalesDocument(org: mongoose.Types.ObjectId, period: LearnPeriod, products: ProductIndex, each: (doc: CoverageDocument) => void): Promise<void> {
  const inPeriod = inPeriodOf(period)
  const cursor = Invoice.find({
    orgId: org, direction: 'outgoing', type: { $in: [...SALES_DOCUMENT_TYPES, ...TILL_TYPES] }, status: { $nin: NOT_A_DOCUMENT }, issueDate: rangeOf(period.from, period.to, 1),
  }).select('type issueDate exchangeRate lines.productId lines.quantity lines.unitPrice lines.discount').lean<InvoiceRow[]>().cursor()
  for await (const d of cursor) {
    const day = sofiaDay(d.issueDate)
    if (!inPeriod(day)) continue
    const rate = Number(d.exchangeRate) || 1
    each({
      kind: TILL_TYPES.includes(d.type) ? 'till' : 'invoices',
      day,
      lines: (d.lines ?? []).map(l => {
        const productId = products.productOf(l.productId)
        // Unit prices are net; `lineTotal` is not to be summed for money (it is gross on a cash sale).
        const value = lineAmounts({ quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount }, true).taxable * rate
        return { ...(productId ? { productId } : {}), ...(productId && products.isService(productId) ? { service: true } : {}), value }
      }),
    })
  }
}

/** Learn the map of `orgId` from the period's books and documents; write it with `execute`. */
export async function learnProductGroups(orgId: string, opts: LearnOptions = {}): Promise<LearnReport> {
  const l = await loadLearning(orgId, opts)
  const plan = l.learned.plan
  const written = opts.execute ? await writePlan(l.org, plan) : undefined

  // What the map covers: every line of the period's documents and till sales that is not on a service.
  const coverage = newCoverage()
  const posts = postsBy(plan.after, l.activeGroups)
  await eachSalesDocument(l.org, l.period, l.products, doc => addCoverage(coverage, doc, posts))

  const months = (kind: CoverageKind) => [...coverage[kind].entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, cell]) => ({ month, cell }))
  return {
    ...(l.period.from ? { from: isoDay(l.period.from) } : {}),
    to: isoDay(l.period.to),
    places: l.places, pairing: l.pairing, outcomes: l.outcomes, oneGroupQuantityDiffers: l.oneGroupQuantityDiffers, lines: l.lines,
    partition: l.learned.counts,
    products: plan.products,
    rows: rowsBySource(plan.after),
    planned: { create: plan.create.length, update: plan.update.length, remove: plan.remove.length, unchanged: plan.unchanged },
    ...(written ? { written } : {}),
    coverage: { invoices: months('invoices'), till: months('till') },
  }
}

/**
 * Writes a plan. Every write names the row as it was read and that it is still no reviewed one, so a
 * row the accountant takes in the meantime is left alone and counted as skipped, never overwritten.
 */
async function writePlan(orgId: mongoose.Types.ObjectId, plan: MapPlan): Promise<NonNullable<LearnReport['written']>> {
  const out = { created: 0, updated: 0, removed: 0, skipped: 0 }
  const fields = (r: MapRow) => ({
    analyticId: oid(r.analyticId), source: r.source, evidenceCount: r.evidenceCount, conflictCount: r.conflictCount,
    ...(r.lastEvidenceAt ? { lastEvidenceAt: r.lastEvidenceAt } : {}),
  })
  const untouched = (r: MapRow) => ({ _id: oid(r.id), orgId, source: r.source, reviewedAt: { $exists: false } })
  if (plan.create.length) {
    const r = await ProductGroupMap.bulkWrite(plan.create.map(row => ({
      updateOne: { filter: { orgId, productId: oid(row.productId) }, update: { $setOnInsert: fields(row) }, upsert: true },
    })), { ordered: false })
    out.created = r.upsertedCount
    out.skipped += plan.create.length - r.upsertedCount
  }
  if (plan.update.length) {
    const r = await ProductGroupMap.bulkWrite(plan.update.map(({ from, to }) => ({
      updateOne: { filter: untouched(from), update: { $set: fields(to), ...(to.lastEvidenceAt ? {} : { $unset: { lastEvidenceAt: 1 } }) } },
    })), { ordered: false })
    out.updated = r.matchedCount
    out.skipped += plan.update.length - r.matchedCount
  }
  if (plan.remove.length) {
    const r = await ProductGroupMap.bulkWrite(plan.remove.map(row => ({ deleteOne: { filter: untouched(row) } })), { ordered: false })
    out.removed = r.deletedCount
    out.skipped += plan.remove.length - r.deletedCount
  }
  return out
}
