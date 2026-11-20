import { createHash } from 'node:crypto'
import { mongoose } from 'db/connection'
import { AccountingAnalytic, BOOKS_IMPORT, DocFile, Invoice, JournalEntry, Org, POSTED_BOOKS, Product, ProductGroupMap, User } from 'db/models'
import { logger } from '../../logger/logger.js'
import { recordAuditEntry } from '../audit-log.service.js'
import { sofiaDay } from '../vat-files/sales-register.js'
import { SALES_DOCUMENT_TYPES, TILL_TYPES, isAccountants } from './product-groups.js'
import {
  GOODS_ROOT, ProductGroupsError, eachSalesDocument, goodsGroupOf, goodsGroupsOf, loadLearning, mapRowOf, periodOf, productIndexOf, seriesOf,
  type GoodsGroupRow, type LearnPeriod, type MapRowDoc,
} from './product-groups.service.js'
import {
  REVIEW_SORTS, REVIEW_STATES, addSales, buildQueue, newSales, reviewEvidenceOf,
  type PeriodSales, type ReviewEvidence, type ReviewQuery, type ReviewQueue, type ReviewRow, type ReviewSort, type ReviewState, type StoredRow,
} from './product-group-review.js'
import { DOC_TYPES } from './registry.js'

/**
 * FR-25 R3, slice 2: the review queue of the product → accounting group map, and the accountant's three writes to it
 * (the rules are `product-group-review.ts`).
 *
 * ⚠ The evidence is a learning run over the org's whole books (`loadLearning`, seconds on a store), so a pod keeps the
 * last one per org, under a key made of what it is read from: the books link, the books' sales entries, the outgoing
 * sales documents, the files that committed them, the products, the goods groups and the accountant's rows (which
 * anchor partition). Each stamp is a count, the latest `updatedAt` and a sum of them, re-read at most every few
 * seconds. A changed key serves the previous snapshot marked `fresh: false` while one run makes the next, at most one
 * a minute per org; a snapshot is made again after half an hour whatever the stamps say. The map's rows themselves are
 * read on every request, so a row's state is never stale, and no write reads the cache: each is checked against the
 * database and conditioned on the row as the queue showed it (`expected`, its `updatedAt`, or null for none).
 */

export class ProductGroupReviewError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly stored?: StoredRowView | null) {
    super(message)
    this.name = 'ProductGroupReviewError'
  }
}

/** A learning error, as the queue answers it: not a books org or no series of its own 409, a period that is none 422. */
function fromLearning(e: unknown): never {
  if (e instanceof ProductGroupsError) throw new ProductGroupReviewError(e.code === 'bad_period' ? 422 : 409, e.code, e.message)
  throw e
}

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v))
const isoDay = (d: Date) => d.toISOString().slice(0, 10)

// ── the query ────────────────────────────────────────────────────────────────────────────────────

export interface ReviewParams {
  from?: string
  to?: string
  query: ReviewQuery
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** The queue's query string: `from`, `to` (`YYYY-MM-DD`), `state` (one or several, by commas), `search`, the sort, the page. */
export function parseReviewParams(raw: Record<string, unknown>): ReviewParams {
  const wanted = raw.state ?? raw.states
  const states = (Array.isArray(wanted) ? wanted : typeof wanted === 'string' ? wanted.split(',') : []).map(s => String(s).trim()).filter(Boolean)
  const unknown = states.filter(s => !(REVIEW_STATES as readonly string[]).includes(s))
  if (unknown.length) throw new ProductGroupReviewError(422, 'bad_query', `Not a state of the queue: ${unknown.join(', ')}`)
  const sortBy = text(raw.sortBy)
  if (sortBy && !(REVIEW_SORTS as readonly string[]).includes(sortBy)) throw new ProductGroupReviewError(422, 'bad_query', `The queue is not sorted by ${sortBy}`)
  const sortOrder = raw.sortOrder === 'asc' || raw.sortOrder === 'desc' ? raw.sortOrder : undefined
  const search = text(raw.search)?.slice(0, 200)
  const number = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v))
  const page = number(raw.page)
  const size = number(raw.size)
  return {
    ...(text(raw.from) ? { from: text(raw.from) } : {}),
    ...(text(raw.to) ? { to: text(raw.to) } : {}),
    query: {
      ...(states.length ? { states: states as ReviewState[] } : {}),
      ...(search ? { search } : {}),
      ...(sortBy ? { sortBy: sortBy as ReviewSort } : {}),
      ...(sortOrder ? { sortOrder } : {}),
      ...(page !== undefined ? { page } : {}),
      ...(size !== undefined ? { size } : {}),
    },
  }
}

// ── what a pod keeps ─────────────────────────────────────────────────────────────────────────────

/** How long a pod trusts the stamps it read, per org: a handful of `$group`s. */
const STAMP_MS = 5_000
/** Between the end of one evidence run and the start of the next, per org and pod, unless a caller waits for one. */
const REFRESH_GAP_MS = 60_000
/** A snapshot older than this is made again whatever the stamps say: the bound on a change no stamp sees. */
const MAX_AGE_MS = 30 * 60_000
/** An org whose queue nobody opened for this long is forgotten by the pod. */
const IDLE_MS = 60 * 60_000
/** Periods whose sales a pod keeps per org. */
const SALES_PERIODS = 6
/** A sum of `updatedAt`s, each taken modulo a prime so the sum stays an exact number. */
const STAMP_MOD = 1_000_000_007

interface Stamps {
  day: string
  books: string
  entries: string
  documents: string
  till: string
  files: string
  products: string
  groups: string
  decisions: string
}

interface EvidenceSnapshot {
  key: string
  computedAt: Date
  ms: number
  evidence: ReviewEvidence
}

interface SalesSnapshot {
  sales: PeriodSales
  names: Map<string, { name: string; sku?: string }>
}

interface OrgCache {
  usedAt: number
  stamps?: { at: number; value: Promise<Stamps> }
  snapshot?: EvidenceSnapshot
  refresh?: { key: string; done: Promise<EvidenceSnapshot> }
  /** When the last run ended: the next one waits `REFRESH_GAP_MS` from it, unless a caller waits for it. */
  refreshedAt?: number
  /** A run is wanted once the gap is over. */
  timer?: ReturnType<typeof setTimeout>
  wanted?: boolean
  sales: Map<string, { key: string; value: Promise<SalesSnapshot> }>
}

const caches = new Map<string, OrgCache>()

function cacheOf(orgId: string): OrgCache {
  const now = Date.now()
  for (const [id, c] of caches) {
    if (id !== orgId && now - c.usedAt > IDLE_MS && !c.refresh) {
      if (c.timer) clearTimeout(c.timer)
      caches.delete(id)
    }
  }
  let c = caches.get(orgId)
  if (!c) {
    c = { usedAt: now, sales: new Map() }
    caches.set(orgId, c)
  }
  c.usedAt = now
  return c
}

/** Forget what this pod keeps of an org's queue, or of every org's. */
export function forgetReviewCache(orgId?: string): void {
  for (const [id, c] of caches) {
    if (orgId && id !== orgId) continue
    if (c.timer) clearTimeout(c.timer)
    caches.delete(id)
  }
}

type Stamp = { n: number; at?: Date; sum?: unknown }
const STAMP_GROUP = { n: { $sum: 1 }, at: { $max: '$updatedAt' }, sum: { $sum: { $mod: [{ $toLong: '$updatedAt' }, STAMP_MOD] } } }
const stampText = (r: Stamp | undefined) => (r ? `${r.n}.${r.at ? new Date(r.at).getTime() : 0}.${String(r.sum ?? 0)}` : '0')

async function stampOf(model: mongoose.Model<any>, match: Record<string, unknown>): Promise<string> {
  const [r] = await model.aggregate<Stamp>([{ $match: match }, { $group: { _id: null, ...STAMP_GROUP } }])
  return stampText(r)
}

const SALES_ENTRY_TYPES = DOC_TYPES.filter(d => d.family === 'sales').map(d => d.code)

/** What the evidence and the sales are read from, as stamps that change whenever it does. */
async function readStamps(orgId: string): Promise<Stamps> {
  const org = oid(orgId)
  const [link, entries, invoices, files, products, groups, decisions] = await Promise.all([
    Org.findOne({ _id: org }).select('settings.accounting.books').lean<{ settings?: { accounting?: { books?: unknown } } }>(),
    stampOf(JournalEntry, { orgId: org, ...POSTED_BOOKS, sourceModule: BOOKS_IMPORT, docType: { $in: SALES_ENTRY_TYPES } }),
    Invoice.aggregate<Stamp & { _id: boolean }>([
      { $match: { orgId: org, direction: 'outgoing', type: { $in: [...SALES_DOCUMENT_TYPES, ...TILL_TYPES] } } },
      { $group: { _id: { $in: ['$type', [...TILL_TYPES]] }, ...STAMP_GROUP } },
    ]),
    stampOf(DocFile, { orgId: org }),
    stampOf(Product, { orgId: org }),
    stampOf(AccountingAnalytic, { orgId: org, root: GOODS_ROOT }),
    stampOf(ProductGroupMap, { orgId: org, $or: [{ source: 'accountant' }, { reviewedAt: { $exists: true } }] }),
  ])
  return {
    day: isoDay(sofiaDay(new Date())),
    books: createHash('sha1').update(JSON.stringify(link?.settings?.accounting?.books ?? null)).digest('hex'),
    entries,
    documents: stampText(invoices.find(r => r._id === false)),
    till: stampText(invoices.find(r => r._id === true)),
    files, products, groups, decisions,
  }
}

function stampsOf(orgId: string, c: OrgCache): Promise<Stamps> {
  const now = Date.now()
  if (c.stamps && now - c.stamps.at < STAMP_MS) return c.stamps.value
  const value = readStamps(orgId)
  c.stamps = { at: now, value }
  void value.catch(() => {
    // The caller answers the error; the next request reads the stamps again.
    if (c.stamps?.value === value) c.stamps = undefined
  })
  return value
}

/** The evidence's key: everything a learning run over the whole books reads, the day it runs to included. */
const evidenceKey = (s: Stamps) => JSON.stringify([s.day, s.books, s.entries, s.documents, s.files, s.products, s.groups, s.decisions])

async function computeEvidence(orgId: string, key: string): Promise<EvidenceSnapshot> {
  const started = Date.now()
  const l = await loadLearning(orgId)
  const evidence = reviewEvidenceOf({
    paired: l.paired, learned: l.learned, goodsProducts: l.goodsProducts, exact: l.exact.byProduct, exactAmbiguous: l.exact.ambiguous,
    activeGroups: l.activeGroups,
  })
  const ms = Date.now() - started
  logger.info({ orgId, ms, documents: evidence.docs.length, products: evidence.refs.size }, 'Product group review: the evidence read')
  // As of when the run began to read: what it read is no older than that.
  return { key, computedAt: new Date(started), ms, evidence }
}

function startRefresh(orgId: string, c: OrgCache, key: string): Promise<EvidenceSnapshot> {
  if (c.timer) clearTimeout(c.timer)
  c.timer = undefined
  c.wanted = false
  const done = computeEvidence(orgId, key).then(snap => {
    // A run that started earlier and ended later never replaces a newer snapshot.
    if (!c.snapshot || c.snapshot.computedAt <= snap.computedAt) c.snapshot = snap
    return snap
  })
  c.refresh = { key, done }
  void done
    .catch(err => logger.warn({ orgId, err: String(err) }, 'Product group review: the evidence could not be read'))
    .finally(() => {
      if (c.refresh?.done === done) c.refresh = undefined
      c.refreshedAt = Date.now()
      if (c.wanted) want(orgId, c)
    })
  return done
}

/** A run once the gap since the last one is over, with the stamps as they are then. */
function want(orgId: string, c: OrgCache): void {
  c.wanted = true
  if (c.refresh || c.timer) return
  const wait = Math.max(0, (c.refreshedAt ?? 0) + REFRESH_GAP_MS - Date.now())
  c.timer = setTimeout(() => {
    c.timer = undefined
    // A run a caller started meanwhile takes it up when it ends (`wanted`).
    if (caches.get(orgId) !== c || !c.wanted || c.refresh) return
    c.stamps = undefined
    void stampsOf(orgId, c)
      .then(stamps => {
        const key = evidenceKey(stamps)
        if (c.snapshot?.key === key && !expired(c.snapshot)) { c.wanted = false; return }
        return startRefresh(orgId, c, key).then(() => undefined)
      })
      .catch(err => logger.warn({ orgId, err: String(err) }, 'Product group review: the evidence could not be read'))
  }, wait)
  ;(c.timer as { unref?: () => void }).unref?.()
}

const expired = (s: EvidenceSnapshot) => Date.now() - s.computedAt.getTime() >= MAX_AGE_MS

interface EvidenceAnswer {
  snapshot: EvidenceSnapshot
  fresh: boolean
  refreshing: boolean
}

/**
 * The evidence for the stamps: the snapshot when it is theirs; otherwise the previous one while a run makes theirs, or,
 * with nothing to show yet (or `wait`), the run itself.
 */
async function evidenceFor(orgId: string, c: OrgCache, stamps: Stamps, wait: boolean): Promise<EvidenceAnswer> {
  const key = evidenceKey(stamps)
  const ours = (s: EvidenceSnapshot | undefined): s is EvidenceSnapshot => !!s && s.key === key && !expired(s)
  if (ours(c.snapshot)) return { snapshot: c.snapshot, fresh: true, refreshing: false }
  if (c.snapshot && !wait) {
    if (c.refresh?.key !== key) want(orgId, c)
    return { snapshot: c.snapshot, fresh: false, refreshing: true }
  }
  // Nothing to show, or asked for this key's: join its run, or start one after the run under way.
  if (c.refresh && c.refresh.key !== key) {
    await c.refresh.done.catch(() => {
      // That run's failure is logged where it ran; this one is made all the same, and answers for itself.
    })
  }
  if (ours(c.snapshot)) return { snapshot: c.snapshot, fresh: true, refreshing: false }
  const snap = await (c.refresh?.key === key ? c.refresh.done : startRefresh(orgId, c, key))
  return { snapshot: snap, fresh: snap.key === key, refreshing: false }
}

/** The period's sales by product, kept per period under the stamps of the documents and the products. */
function salesFor(c: OrgCache, org: mongoose.Types.ObjectId, period: LearnPeriod, stamps: Stamps): Promise<SalesSnapshot> {
  const periodKey = `${period.from ? isoDay(period.from) : ''}|${isoDay(period.to)}`
  const key = JSON.stringify([stamps.documents, stamps.till, stamps.products])
  const hit = c.sales.get(periodKey)
  if (hit && hit.key === key) {
    c.sales.delete(periodKey)
    c.sales.set(periodKey, hit)
    return hit.value
  }
  const value = readSales(org, period)
  c.sales.delete(periodKey)
  c.sales.set(periodKey, { key, value })
  void value.catch(() => {
    // The caller answers the error; the next request reads the period again.
    if (c.sales.get(periodKey)?.value === value) c.sales.delete(periodKey)
  })
  while (c.sales.size > SALES_PERIODS) c.sales.delete(c.sales.keys().next().value as string)
  return value
}

async function readSales(org: mongoose.Types.ObjectId, period: LearnPeriod): Promise<SalesSnapshot> {
  const productRows = await Product.find({ orgId: org }).select('name sku type').lean<{ _id: unknown; name?: string; sku?: string; type?: string }[]>()
  const sales = newSales()
  await eachSalesDocument(org, period, productIndexOf(productRows), doc => addSales(sales, doc))
  const names = new Map<string, { name: string; sku?: string }>()
  for (const p of productRows) {
    const id = String(p._id)
    if (sales.products.has(id)) names.set(id, { name: String(p.name ?? ''), ...(p.sku ? { sku: String(p.sku) } : {}) })
  }
  return { sales, names }
}

// ── the queue ────────────────────────────────────────────────────────────────────────────────────

export type StoredRowView = NonNullable<ReviewRow['stored']>

const MAP_FIELDS = 'productId analyticId source evidenceCount conflictCount lastEvidenceAt reviewedAt reviewedBy updatedAt'

function storedRowOf(r: MapRowDoc): StoredRow {
  return { ...mapRowOf(r), id: String(r._id), updatedAt: new Date(r.updatedAt ?? 0), ...(r.reviewedBy ? { reviewedBy: String(r.reviewedBy) } : {}) }
}

function viewOf(r: MapRowDoc): StoredRowView {
  const s = storedRowOf(r)
  return {
    analyticId: s.analyticId, source: s.source, evidenceCount: s.evidenceCount, conflictCount: s.conflictCount,
    ...(s.reviewedAt ? { reviewedAt: s.reviewedAt } : {}), ...(s.reviewedBy ? { reviewedBy: s.reviewedBy } : {}), updatedAt: s.updatedAt,
  }
}

export interface ReviewAnswer extends ReviewQueue {
  period: { from?: string; to: string }
  /** The learning run the states and the documents are read from: when, whether the stamps are still its, whether the next is under way. */
  evidence: { computedAt: Date; fresh: boolean; refreshing: boolean }
  /** The analytics the page's rows name, by id. */
  analytics: Record<string, { name: string; path: string; active: boolean; goods: boolean }>
  /** Who reviewed the page's rows, by user id. */
  reviewers: Record<string, string>
}

/**
 * The review queue of a books org for a period (`from` unset: from the first; `to` unset: today in Sofia). Refused
 * with 409 `not_a_books_org` / `no_series` before anything is read for an org that keeps no books of its own.
 * `wait`: the evidence as the stamps are now, even if that means a learning run (tests, never a page).
 */
export async function reviewQueue(orgId: string, raw: Record<string, unknown>, opts: { wait?: boolean; now?: Date } = {}): Promise<ReviewAnswer> {
  const params = parseReviewParams(raw)
  let period: LearnPeriod
  try {
    period = periodOf({ from: params.from, to: params.to, now: opts.now })
  } catch (e) {
    fromLearning(e)
  }
  await seriesOf(orgId).catch(fromLearning)
  const org = oid(orgId)
  const c = cacheOf(orgId)
  const stamps = await stampsOf(orgId, c)
  const [ev, sold, storedDocs] = await Promise.all([
    evidenceFor(orgId, c, stamps, !!opts.wait).catch(fromLearning),
    salesFor(c, org, period, stamps),
    ProductGroupMap.find({ orgId: org }).select(MAP_FIELDS).lean<MapRowDoc[]>(),
  ])
  const queue = buildQueue({ sales: sold.sales, names: sold.names, evidence: ev.snapshot.evidence, stored: storedDocs.map(storedRowOf), query: params.query })

  const ids = new Set<string>()
  const reviewerIds = new Set<string>()
  for (const r of queue.rows) {
    if (r.stored) ids.add(r.stored.analyticId)
    if (r.stored?.reviewedBy) reviewerIds.add(r.stored.reviewedBy)
    if (r.suggestion) ids.add(r.suggestion.analyticId)
    for (const g of r.groups) ids.add(g.analyticId)
  }
  const [analyticRows, users] = await Promise.all([
    ids.size
      ? AccountingAnalytic.find({ orgId: org, _id: { $in: [...ids].filter(id => mongoose.isValidObjectId(id)).map(oid) } }).select('root path name isActive')
        .lean<{ _id: unknown; root?: string; path: string; name: string; isActive?: boolean }[]>()
      : [],
    reviewerIds.size
      ? User.find({ orgId: org, _id: { $in: [...reviewerIds].map(oid) } }).select('firstName lastName username').lean<{ _id: unknown; firstName?: string; lastName?: string; username?: string }[]>()
      : [],
  ])
  const analytics: ReviewAnswer['analytics'] = {}
  for (const a of analyticRows) {
    analytics[String(a._id)] = { name: a.name, path: a.path, active: a.isActive !== false, goods: a.root === GOODS_ROOT && a.path !== GOODS_ROOT }
  }
  const reviewers: Record<string, string> = {}
  for (const u of users) reviewers[String(u._id)] = [u.firstName, u.lastName].filter(Boolean).join(' ') || String(u.username ?? '')

  return {
    ...queue,
    period: { ...(period.from ? { from: isoDay(period.from) } : {}), to: isoDay(period.to) },
    evidence: { computedAt: ev.snapshot.computedAt, fresh: ev.fresh, refreshing: !ev.fresh },
    analytics,
    reviewers,
  }
}

/** The org's goods groups for the picker, the active ones first (an inactive one is only ever shown on a stored row). */
export async function goodsGroupList(orgId: string): Promise<{ groups: { id: string; name: string; path: string; active: boolean }[] }> {
  await seriesOf(orgId).catch(fromLearning)
  const groups = [...(await goodsGroupsOf(oid(orgId))).values()]
  groups.sort((a, b) => Number(b.active) - Number(a.active) || a.path.localeCompare(b.path, 'bg'))
  return { groups: groups.map(g => ({ id: g.id, name: g.name, path: g.path, active: g.active })) }
}

// ── the accountant's writes ──────────────────────────────────────────────────────────────────────

export interface ProductGroupEditor {
  id: string
  operatorCode?: string
}

/** The row as it is after a write: none once a decision is withdrawn from a row of the accountant's own. */
export interface ProductGroupWrite {
  productId: string
  stored: StoredRowView | null
}

const notFound = () => new ProductGroupReviewError(404, 'product_not_found', 'This organisation holds no such product.')

/** A product of the org's goods: a service needs no group. */
async function goodsProductOf(org: mongoose.Types.ObjectId, productId: string): Promise<{ id: string; name: string }> {
  if (!/^[a-fA-F0-9]{24}$/.test(productId)) throw notFound()
  const p = await Product.findOne({ _id: oid(productId), orgId: org }).select('name type').lean<{ _id: unknown; name?: string; type?: string }>()
  if (!p) throw notFound()
  if (p.type === 'service') throw new ProductGroupReviewError(422, 'service_product', 'A service needs no goods group.')
  return { id: String(p._id), name: String(p.name ?? '') }
}

/** An active goods group of the org: the rule learning reads its groups by (`asGoodsGroup`, active). */
async function activeGoodsGroupOf(org: mongoose.Types.ObjectId, analyticId: string): Promise<GoodsGroupRow> {
  const g = await goodsGroupOf(org, analyticId)
  if (!g?.active) throw new ProductGroupReviewError(422, 'not_a_goods_group', 'Not an active goods group of this organisation.')
  return g
}

function expectedOf(v: unknown): Date {
  const d = typeof v === 'string' && v.trim() ? new Date(v) : new Date(NaN)
  if (isNaN(d.getTime())) throw new ProductGroupReviewError(422, 'bad_expected', "expected: the row's updatedAt as the queue showed it, or null for no row.")
  return d
}

async function currentOf(org: mongoose.Types.ObjectId, productId: string): Promise<MapRowDoc | null> {
  return ProductGroupMap.findOne({ orgId: org, productId: oid(productId) }).select(MAP_FIELDS).lean<MapRowDoc>()
}

async function changed(org: mongoose.Types.ObjectId, productId: string): Promise<ProductGroupReviewError> {
  const now = await currentOf(org, productId)
  return new ProductGroupReviewError(409, 'row_changed', "The product's group was changed meanwhile: the queue shows it as it is now.", now ? viewOf(now) : null)
}

const sameTime = (a: Date | undefined, b: Date) => !!a && new Date(a).getTime() === b.getTime()

/**
 * The pod reads the org's stamps again at its next request rather than within `STAMP_MS`: what a write here does, and
 * what a test does after a change made beside the queue.
 */
export function forgetReviewStamps(orgId: string): void {
  const c = caches.get(orgId)
  if (c) c.stamps = undefined
}

async function pathOf(org: mongoose.Types.ObjectId, analyticId: unknown): Promise<string | undefined> {
  return analyticId ? (await goodsGroupOf(org, String(analyticId)))?.path : undefined
}

/**
 * The accountant sets a product's group: the row becomes `source: 'accountant'`, reviewed by them now, which nothing
 * automatic changes again. `expected` is the row the queue showed: its `updatedAt`, or null when it showed none.
 */
export async function setProductGroup(orgId: string, productId: string, body: { analyticId: string; expected: string | null }, by: ProductGroupEditor): Promise<ProductGroupWrite> {
  await seriesOf(orgId).catch(fromLearning)
  const org = oid(orgId)
  const product = await goodsProductOf(org, productId)
  const group = await activeGoodsGroupOf(org, body.analyticId)
  const now = new Date()
  const set = { analyticId: oid(group.id), source: 'accountant' as const, reviewedBy: oid(by.id), reviewedAt: now }

  let before: MapRowDoc | null = null
  let after: MapRowDoc
  if (body.expected === null) {
    try {
      const doc = await ProductGroupMap.create({ orgId: org, productId: oid(product.id), ...set, evidenceCount: 0, conflictCount: 0 })
      after = doc.toObject() as unknown as MapRowDoc
    } catch (e) {
      if ((e as { code?: number })?.code === 11000) throw await changed(org, product.id)
      throw e
    }
  } else {
    const at = expectedOf(body.expected)
    before = await ProductGroupMap.findOneAndUpdate(
      { orgId: org, productId: oid(product.id), updatedAt: at },
      { $set: { ...set, updatedAt: now } },
      { new: false, timestamps: false },
    ).select(MAP_FIELDS).lean<MapRowDoc>()
    if (!before) throw await changed(org, product.id)
    after = { ...before, ...set, updatedAt: now }
  }
  forgetReviewStamps(orgId)

  await recordAuditEntry({
    orgId, userId: by.id, operatorCode: by.operatorCode,
    action: before ? 'update' : 'create',
    module: 'accounting', entityType: 'product_group_map', entityId: product.id, entityName: product.name,
    changes: {
      group: { from: before ? (await pathOf(org, before.analyticId)) ?? String(before.analyticId) : null, to: group.path },
      analyticId: { from: before ? String(before.analyticId) : null, to: group.id },
      source: { from: before?.source ?? null, to: 'accountant' },
    },
  })
  return { productId: product.id, stored: viewOf(after) }
}

/** The accountant confirms the group a learning run gave (`exact`, `learned`): group and source stay, the row is reviewed. */
export async function confirmProductGroup(orgId: string, productId: string, body: { expected: string }, by: ProductGroupEditor): Promise<ProductGroupWrite> {
  await seriesOf(orgId).catch(fromLearning)
  const org = oid(orgId)
  const product = await goodsProductOf(org, productId)
  const at = expectedOf(body.expected)
  const current = await currentOf(org, product.id)
  if (!current || !sameTime(current.updatedAt, at)) throw await changed(org, product.id)
  if (isAccountants(mapRowOf(current))) throw new ProductGroupReviewError(422, 'already_reviewed', "The product's group is already the accountant's.", viewOf(current))
  // Only a row a line posts by is a learning run's proposal; a reserved source (`rule`, `ai`) is set, not confirmed.
  if (current.source !== 'exact' && current.source !== 'learned') {
    throw new ProductGroupReviewError(422, 'not_a_proposal', 'Only a group learning gave (by name or by the books) is confirmed; set this one.', viewOf(current))
  }
  const group = await activeGoodsGroupOf(org, String(current.analyticId))
  const now = new Date()
  const before = await ProductGroupMap.findOneAndUpdate(
    { _id: current._id, orgId: org, updatedAt: at, source: current.source, analyticId: oid(group.id), reviewedAt: { $exists: false } },
    { $set: { reviewedBy: oid(by.id), reviewedAt: now, updatedAt: now } },
    { new: false, timestamps: false },
  ).select(MAP_FIELDS).lean<MapRowDoc>()
  if (!before) throw await changed(org, product.id)
  forgetReviewStamps(orgId)

  await recordAuditEntry({
    orgId, userId: by.id, operatorCode: by.operatorCode,
    action: 'update', module: 'accounting', entityType: 'product_group_map', entityId: product.id, entityName: product.name,
    changes: { reviewedAt: { from: null, to: now.toISOString() }, group: { from: group.path, to: group.path }, source: { from: before.source, to: before.source } },
  })
  return { productId: product.id, stored: viewOf({ ...before, reviewedBy: oid(by.id), reviewedAt: now, updatedAt: now }) }
}

/**
 * The accountant withdraws a decision: a row of their own (`source: 'accountant'`) is removed, so the product is
 * learning's again; a confirmed automatic row loses its review and keeps its group. Explicit, and audit-logged.
 */
export async function withdrawProductGroup(orgId: string, productId: string, body: { expected: string }, by: ProductGroupEditor): Promise<ProductGroupWrite> {
  await seriesOf(orgId).catch(fromLearning)
  const org = oid(orgId)
  if (!/^[a-fA-F0-9]{24}$/.test(productId)) throw notFound()
  const at = expectedOf(body.expected)
  const current = await currentOf(org, productId)
  if (!current || !sameTime(current.updatedAt, at)) throw await changed(org, productId)
  if (!isAccountants(mapRowOf(current))) throw new ProductGroupReviewError(422, 'not_reviewed', 'There is no decision of the accountant on this product to withdraw.', viewOf(current))
  // A product deleted or made a service since keeps no name: its decision can still be withdrawn.
  const named = await Product.findOne({ _id: oid(productId), orgId: org }).select('name').lean<{ name?: string }>()
  const path = await pathOf(org, current.analyticId)

  let after: MapRowDoc | null
  if (current.source === 'accountant') {
    const r = await ProductGroupMap.deleteOne({ _id: current._id, orgId: org, updatedAt: at, source: 'accountant' })
    if (!r.deletedCount) throw await changed(org, productId)
    after = null
  } else {
    const now = new Date()
    const before = await ProductGroupMap.findOneAndUpdate(
      { _id: current._id, orgId: org, updatedAt: at, source: current.source },
      { $set: { updatedAt: now }, $unset: { reviewedAt: 1, reviewedBy: 1 } },
      { new: false, timestamps: false },
    ).select(MAP_FIELDS).lean<MapRowDoc>()
    if (!before) throw await changed(org, productId)
    after = { ...before, updatedAt: now }
    delete after.reviewedAt
    delete after.reviewedBy
  }
  forgetReviewStamps(orgId)

  await recordAuditEntry({
    orgId, userId: by.id, operatorCode: by.operatorCode,
    action: after ? 'update' : 'delete',
    module: 'accounting', entityType: 'product_group_map', entityId: productId, entityName: named?.name,
    changes: {
      group: { from: path ?? String(current.analyticId), to: after ? path ?? String(current.analyticId) : null },
      source: { from: current.source, to: after ? current.source : null },
      reviewedAt: { from: current.reviewedAt ? new Date(current.reviewedAt).toISOString() : null, to: null },
    },
  })
  return { productId, stored: after ? viewOf(after) : null }
}
