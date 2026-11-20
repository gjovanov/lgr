import type { ProductGroupSource } from 'db/models'
import {
  POSTABLE_SOURCES, evidenceOf, isAccountants, planProductGroups, postsBy,
  type CoverageDocument, type CoverageKind, type Evidence, type GroupVote, type MapPlan, type MapRow, type PairedDocument,
} from './product-groups.js'

/**
 * FR-25 R3, slice 2: the accountant's review queue of the product → accounting group map (§6.1 item 5, §9 "R3 after
 * R7"). The products a store sold in a period, by their sales value, with the state of each one's group and the
 * documents that name it. Import-pure: `product-group-review.service.ts` loads and caches what this reads.
 *
 * Nothing here decides a group. The evidence is a learning run's (`learnWithPartition`, over the whole books), the plan
 * is `planProductGroups` against the map as it is stored now, and a conflict is read from that evidence the way the
 * plan reads one: it is never stored (FR-25 §9, slice 2).
 */

/** Where a product stands. `accountant` and `reviewed` are done; the queue's work is `conflict` and `unmapped`. */
export type ReviewState = 'conflict' | 'unmapped' | 'learned' | 'exact' | 'accountant' | 'reviewed'
export const REVIEW_STATES: readonly ReviewState[] = ['conflict', 'unmapped', 'learned', 'exact', 'accountant', 'reviewed']

/** The rule a document named a product's group by: slice 1's two, partition's, or none (it contradicts the group a run gave it). */
export type EvidenceRule = 'one_group' | 'line_for_line' | 'partition' | 'contradicts'

/** A paired document, once per snapshot. */
export interface EvidenceDocMeta {
  id: string
  /** As LGR shows it. */
  number: string
  type: string
  /** The business day in Sofia. */
  day: Date
}

/** What one document says of one product: an index into `ReviewEvidence.docs`, the group it names (none when it contradicts), the rule. */
export interface EvidenceRef {
  doc: number
  groupId?: string
  rule: EvidenceRule
}

/** A document of a row, as the page shows it. */
export interface EvidenceDocument extends Omit<EvidenceDocMeta, 'id'> {
  docId: string
  groupId?: string
  rule: EvidenceRule
}

/** What the queue keeps of one learning run: the evidence, and per product the documents behind it, newest first. */
export interface ReviewEvidence {
  evidence: Evidence
  contradicted: ReadonlyMap<string, number>
  docs: readonly EvidenceDocMeta[]
  refs: ReadonlyMap<string, readonly EvidenceRef[]>
  /** What `planProductGroups` is given besides the evidence and the map. */
  goodsProducts: readonly string[]
  exact: ReadonlyMap<string, string>
  exactAmbiguous: number
  activeGroups: ReadonlySet<string>
}

/**
 * The documents behind a run's evidence. Slice 1's votes are read again per books entry, each labelled with the rule
 * that gave it (`evidenceOf`, the function the run used); partition's votes and contradictions are the run's own
 * (`taughtBy`, `contradictedBy`). One per document, product and group, slice 1's label first: what `tallyEvidence`
 * counts, so a group's documents are as many as its `docs`.
 */
export function reviewEvidenceOf(input: {
  paired: readonly PairedDocument[]
  learned: { evidence: Evidence; contradicted: ReadonlyMap<string, number>; taughtBy: ReadonlyMap<string, readonly GroupVote[]>; contradictedBy: ReadonlyMap<string, readonly string[]> }
  goodsProducts: readonly string[]
  exact: ReadonlyMap<string, string>
  exactAmbiguous: number
  activeGroups: ReadonlySet<string>
}): ReviewEvidence {
  const docs: EvidenceDocMeta[] = []
  const refs = new Map<string, EvidenceRef[]>()
  const seen = new Set<string>()
  for (const p of input.paired) {
    const doc = docs.length
    let used = false
    const add = (productId: string, rule: EvidenceRule, groupId?: string) => {
      const key = `${doc}|${productId}|${groupId ?? ''}`
      if (seen.has(key)) return
      seen.add(key)
      used = true
      const list = refs.get(productId) ?? []
      list.push({ doc, rule, ...(groupId ? { groupId } : {}) })
      refs.set(productId, list)
    }
    for (const entry of p.entries) {
      const ev = evidenceOf(entry, p.doc)
      if (ev.outcome !== 'one_group' && ev.outcome !== 'line_for_line') continue
      for (const v of ev.votes) add(v.productId, ev.outcome, v.groupId)
    }
    for (const v of input.learned.taughtBy.get(p.doc.id) ?? []) add(v.productId, 'partition', v.groupId)
    for (const productId of input.learned.contradictedBy.get(p.doc.id) ?? []) add(productId, 'contradicts')
    if (used) docs.push({ id: p.doc.id, number: p.doc.number, type: p.doc.type, day: p.doc.day })
  }
  const newest = (a: EvidenceRef, b: EvidenceRef) => {
    const x = docs[a.doc], y = docs[b.doc]
    return y.day.getTime() - x.day.getTime() || (x.number < y.number ? -1 : x.number > y.number ? 1 : 0)
  }
  for (const list of refs.values()) list.sort(newest)
  return {
    evidence: input.learned.evidence,
    contradicted: input.learned.contradicted,
    docs,
    refs,
    goodsProducts: input.goodsProducts,
    exact: input.exact,
    exactAmbiguous: input.exactAmbiguous,
    activeGroups: input.activeGroups,
  }
}

/** The map after a learning run, were it run now: the run's evidence against the rows as they are stored. */
export function planAgainst(ev: ReviewEvidence, stored: readonly MapRow[]): MapPlan {
  return planProductGroups({
    goodsProducts: ev.goodsProducts, exact: ev.exact, exactAmbiguous: ev.exactAmbiguous, evidence: ev.evidence, activeGroups: ev.activeGroups,
    existing: stored, contradicted: ev.contradicted,
  })
}

// ── a product's state ────────────────────────────────────────────────────────────────────────────

type StateEvidence = Pick<ReviewEvidence, 'evidence' | 'contradicted' | 'exact'>

/**
 * A conflict, read as `planProductGroups` reads one: its documents name more than one group, or a document
 * contradicts the group a run gives it. A product with a group by its name (`exact`) keeps its row in the plan, and a
 * document naming another group is such a contradiction (the plan counts it in `conflictCount`), so it is listed too.
 */
export function isConflict(ev: StateEvidence, productId: string): boolean {
  if ((ev.contradicted.get(productId) ?? 0) > 0) return true
  const groups = ev.evidence.get(productId)
  if (!groups) return false
  if (groups.size > 1) return true
  const exact = ev.exact.get(productId)
  return !!exact && !groups.has(exact)
}

/** One document against all the others, as the learning run counts it. */
export function isOneDocumentConflict(ev: Pick<ReviewEvidence, 'evidence' | 'contradicted'>, productId: string): boolean {
  const docs = [...(ev.evidence.get(productId)?.values() ?? [])].map(s => s.docs)
  const against = ev.contradicted.get(productId) ?? 0
  if (against) docs.push(against)
  if (docs.length < 2) return false
  return docs.reduce((a, b) => a + b, 0) - Math.max(...docs) === 1
}

/** The accountant's rows are done; a conflict comes before an automatic row; a row no line posts by is no group. */
export function stateOf(ev: StateEvidence, productId: string, stored: Pick<MapRow, 'source' | 'reviewedAt'> | undefined): ReviewState {
  if (stored && isAccountants(stored)) return stored.source === 'accountant' ? 'accountant' : 'reviewed'
  if (isConflict(ev, productId)) return 'conflict'
  if (stored?.source === 'exact' || stored?.source === 'learned') return stored.source
  return 'unmapped'
}

/** A group a learning run would give the product: what "accept" sets, offered only where it is not the stored one. */
export interface Suggestion {
  analyticId: string
  source: 'exact' | 'learned'
}

export function suggestionOf(plan: MapPlan, ev: Pick<ReviewEvidence, 'activeGroups'>, productId: string, stored: MapRow | undefined, state: ReviewState): Suggestion | undefined {
  if (state === 'accountant' || state === 'reviewed') return undefined
  const planned = plan.after.get(productId)
  if (!planned || isAccountants(planned) || (planned.source !== 'exact' && planned.source !== 'learned')) return undefined
  if (!ev.activeGroups.has(planned.analyticId)) return undefined
  if (stored && stored.analyticId === planned.analyticId && POSTABLE_SOURCES.has(stored.source)) return undefined
  return { analyticId: planned.analyticId, source: planned.source }
}

// ── the period's sales ───────────────────────────────────────────────────────────────────────────

export interface SalesCell {
  lines: number
  /** NET, base currency, sign dropped, as coverage sums it. */
  value: number
}

export interface ProductSales {
  productId: string
  lines: number
  value: number
  byKind: Record<CoverageKind, SalesCell>
}

/** What a period sold that is not a service: per product, and in all with the lines typed with no product, by kind. */
export interface PeriodSales {
  products: Map<string, ProductSales>
  totals: Record<CoverageKind, SalesCell & { noProduct: SalesCell }>
}

const cell = (): SalesCell => ({ lines: 0, value: 0 })

export const newSales = (): PeriodSales => ({
  products: new Map(),
  totals: { invoices: { ...cell(), noProduct: cell() }, till: { ...cell(), noProduct: cell() } },
})

/** Adds a document's lines as `addCoverage` reads them: a service left out, a value's sign dropped. */
export function addSales(sales: PeriodSales, doc: CoverageDocument): void {
  const total = sales.totals[doc.kind]
  for (const l of doc.lines) {
    if (l.service) continue
    const value = Math.abs(Number(l.value) || 0)
    total.lines++
    total.value += value
    if (!l.productId) {
      total.noProduct.lines++
      total.noProduct.value += value
      continue
    }
    const p = sales.products.get(l.productId) ?? { productId: l.productId, lines: 0, value: 0, byKind: { invoices: cell(), till: cell() } }
    p.lines++
    p.value += value
    p.byKind[doc.kind].lines++
    p.byKind[doc.kind].value += value
    sales.products.set(l.productId, p)
  }
}

/** A period's lines and value, and how much of it posts by the map as stored, and as a learning run would leave it. */
export interface CoverageShare {
  lines: number
  value: number
  noProductLines: number
  noProductValue: number
  postingLines: number
  postingValue: number
  afterLearningLines: number
  afterLearningValue: number
}

export function coverageOf(sales: PeriodSales, posts: (productId: string) => boolean, postsAfter: (productId: string) => boolean): Record<CoverageKind | 'all', CoverageShare> {
  const share = (kind: CoverageKind): CoverageShare => {
    const t = sales.totals[kind]
    const out: CoverageShare = {
      lines: t.lines, value: t.value, noProductLines: t.noProduct.lines, noProductValue: t.noProduct.value,
      postingLines: 0, postingValue: 0, afterLearningLines: 0, afterLearningValue: 0,
    }
    for (const p of sales.products.values()) {
      const c = p.byKind[kind]
      if (!c.lines) continue
      if (posts(p.productId)) { out.postingLines += c.lines; out.postingValue += c.value }
      if (postsAfter(p.productId)) { out.afterLearningLines += c.lines; out.afterLearningValue += c.value }
    }
    return out
  }
  const invoices = share('invoices')
  const till = share('till')
  const all = Object.fromEntries((Object.keys(invoices) as (keyof CoverageShare)[]).map(k => [k, invoices[k] + till[k]])) as unknown as CoverageShare
  return { all, invoices, till }
}

// ── the queue ────────────────────────────────────────────────────────────────────────────────────

/** A stored row as the page shows it, and as a write names it (`updatedAt`). */
export interface StoredRow extends MapRow {
  id: string
  updatedAt: Date
  reviewedBy?: string
}

export type ReviewSort = 'value' | 'lines' | 'name'
export const REVIEW_SORTS: readonly ReviewSort[] = ['value', 'lines', 'name']

export interface ReviewQuery {
  /** States to list; none: every state. */
  states?: readonly ReviewState[]
  /** Part of the name or the SKU, in any case. */
  search?: string
  sortBy?: ReviewSort
  sortOrder?: 'asc' | 'desc'
  /** 0-based. */
  page?: number
  size?: number
}

export const REVIEW_PAGE_SIZE = 25
export const REVIEW_MAX_PAGE_SIZE = 100
/** Documents shown per group (and of the contradicting ones) on a row: the counts are always whole. */
export const REVIEW_DOCUMENTS_PER_GROUP = 20

export interface ReviewRow {
  productId: string
  name: string
  sku?: string
  value: number
  lines: number
  state: ReviewState
  stored?: {
    analyticId: string
    source: ProductGroupSource
    evidenceCount: number
    conflictCount: number
    reviewedAt?: Date
    reviewedBy?: string
    updatedAt: Date
  }
  suggestion?: Suggestion
  /** A conflict of one document against all the others. */
  oneDocument?: boolean
  /** Per group its documents name, the most first: how many, the latest day, and the newest of them. */
  groups: { analyticId: string; docs: number; last: Date; documents: EvidenceDocument[] }[]
  /** Documents that contradict the group a run gave it, and the newest of them. */
  contradicting: { docs: number; documents: EvidenceDocument[] }
}

export interface ReviewSummary {
  /** Products of the queue: sold in the period, not a service. */
  products: number
  byState: Record<ReviewState, number>
  /** Of the conflicts, one document against all the others. */
  oneDocumentConflicts: number
  /** Unmapped products a learning run would map: one click each. */
  suggested: number
  coverage: Record<CoverageKind | 'all', CoverageShare>
}

export interface ReviewQueue {
  rows: ReviewRow[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  summary: ReviewSummary
}

const fold = (s: string) => s.normalize('NFC').toLocaleLowerCase('bg')
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
/** Names in the order of the Bulgarian alphabet, case aside. */
const byName = new Intl.Collator('bg', { sensitivity: 'base', numeric: true }).compare

/**
 * The queue: every product the period sold, its state against the map as stored, sorted (by value, the most first,
 * unless asked otherwise), filtered and paged; and the summary over all of them, whatever the filter.
 */
export function buildQueue(input: {
  sales: PeriodSales
  names: ReadonlyMap<string, { name: string; sku?: string }>
  evidence: ReviewEvidence
  stored: readonly StoredRow[]
  query?: ReviewQuery
}): ReviewQueue {
  const { sales, evidence: ev, query = {} } = input
  const byProduct = new Map(input.stored.map(r => [r.productId, r]))
  const plan = planAgainst(ev, input.stored)
  const posts = postsBy(byProduct)
  const postsAfter = postsBy(plan.after)

  const byState = Object.fromEntries(REVIEW_STATES.map(s => [s, 0])) as Record<ReviewState, number>
  let oneDocumentConflicts = 0
  let suggested = 0
  const listed: { p: ProductSales; state: ReviewState; name: string; sku?: string }[] = []
  const states = query.states?.length ? new Set(query.states) : undefined
  const needle = query.search?.trim() ? fold(query.search.trim()) : ''
  for (const p of sales.products.values()) {
    const stored = byProduct.get(p.productId)
    const state = stateOf(ev, p.productId, stored)
    byState[state]++
    if (state === 'conflict' && isOneDocumentConflict(ev, p.productId)) oneDocumentConflicts++
    if (state === 'unmapped' && suggestionOf(plan, ev, p.productId, stored, state)) suggested++
    if (states && !states.has(state)) continue
    const named = input.names.get(p.productId)
    const name = named?.name ?? ''
    if (needle && !fold(name).includes(needle) && !fold(named?.sku ?? '').includes(needle)) continue
    listed.push({ p, state, name, ...(named?.sku ? { sku: named.sku } : {}) })
  }

  const order = query.sortOrder === 'asc' ? 1 : -1
  const by = query.sortBy ?? 'value'
  listed.sort((a, b) => {
    const d = by === 'name' ? byName(a.name, b.name) : by === 'lines' ? a.p.lines - b.p.lines : a.p.value - b.p.value
    return d ? d * order : byName(a.name, b.name) || byText(a.p.productId, b.p.productId)
  })

  // `size` 0 or less is the grids' "All": here the largest page, as every row carries its documents.
  const want = Math.trunc(Number(query.size ?? REVIEW_PAGE_SIZE))
  const size = !Number.isFinite(want) ? REVIEW_PAGE_SIZE : want <= 0 ? REVIEW_MAX_PAGE_SIZE : Math.min(want, REVIEW_MAX_PAGE_SIZE)
  const totalPages = Math.ceil(listed.length / size)
  const page = Math.min(Math.max(Math.trunc(Number(query.page ?? 0)) || 0, 0), Math.max(totalPages - 1, 0))
  const rows = listed.slice(page * size, page * size + size)
    .map(({ p, state, name, sku }) => rowOf(ev, plan, byProduct.get(p.productId), { productId: p.productId, name, sku, value: p.value, lines: p.lines }, state))

  return {
    rows,
    total: listed.length,
    page,
    pageSize: size,
    totalPages,
    summary: { products: sales.products.size, byState, oneDocumentConflicts, suggested, coverage: coverageOf(sales, posts, postsAfter) },
  }
}

const documentOf = (ev: ReviewEvidence, r: EvidenceRef): EvidenceDocument => {
  const d = ev.docs[r.doc]
  return { docId: d.id, number: d.number, type: d.type, day: d.day, rule: r.rule, ...(r.groupId ? { groupId: r.groupId } : {}) }
}

/** One product's row: its state, the stored row, the suggestion, and the evidence by group with its newest documents. */
export function rowOf(
  ev: ReviewEvidence,
  plan: MapPlan,
  stored: StoredRow | undefined,
  product: { productId: string; name: string; sku?: string; value: number; lines: number },
  state = stateOf(ev, product.productId, stored),
): ReviewRow {
  const refs = ev.refs.get(product.productId) ?? []
  const groups = [...(ev.evidence.get(product.productId) ?? new Map<string, { docs: number; last: Date }>()).entries()]
    .map(([analyticId, s]) => ({
      analyticId, docs: s.docs, last: s.last,
      documents: refs.filter(r => r.groupId === analyticId).slice(0, REVIEW_DOCUMENTS_PER_GROUP).map(r => documentOf(ev, r)),
    }))
    .sort((a, b) => b.docs - a.docs || b.last.getTime() - a.last.getTime() || byText(a.analyticId, b.analyticId))
  const against = refs.filter(r => r.rule === 'contradicts').slice(0, REVIEW_DOCUMENTS_PER_GROUP).map(r => documentOf(ev, r))
  const suggestion = suggestionOf(plan, ev, product.productId, stored, state)
  return {
    productId: product.productId,
    name: product.name,
    ...(product.sku ? { sku: product.sku } : {}),
    value: product.value,
    lines: product.lines,
    state,
    ...(stored ? {
      stored: {
        analyticId: stored.analyticId, source: stored.source, evidenceCount: stored.evidenceCount, conflictCount: stored.conflictCount,
        ...(stored.reviewedAt ? { reviewedAt: stored.reviewedAt } : {}), ...(stored.reviewedBy ? { reviewedBy: stored.reviewedBy } : {}),
        updatedAt: stored.updatedAt,
      },
    } : {}),
    ...(suggestion ? { suggestion } : {}),
    ...(state === 'conflict' && isOneDocumentConflict(ev, product.productId) ? { oneDocument: true } : {}),
    groups,
    contradicting: { docs: ev.contradicted.get(product.productId) ?? 0, documents: against },
  }
}
