/**
 * FR-25 R3, slice 2: the review queue's page (`ProductGroupsView.vue`), its rules without Vue, unit-tested. The wire
 * shapes mirror `services/biz/accounting-books/product-group-review.ts` (a UI package does not import services);
 * `unit/product-groups-page.test.ts` holds the two lists of states equal.
 */

export type ReviewState = 'conflict' | 'unmapped' | 'learned' | 'exact' | 'accountant' | 'reviewed'
export const REVIEW_STATES: readonly ReviewState[] = ['conflict', 'unmapped', 'learned', 'exact', 'accountant', 'reviewed']

/** The queue's work: the products with no group a line could post by, and those whose documents disagree. */
export const TO_REVIEW: readonly ReviewState[] = ['conflict', 'unmapped']

/** What the page lists: the work (the default), one state, or everything sold. */
export type ReviewFilter = 'todo' | ReviewState | 'all'
export const REVIEW_FILTERS: readonly ReviewFilter[] = ['todo', ...REVIEW_STATES, 'all']

export type EvidenceRule = 'one_group' | 'line_for_line' | 'partition' | 'contradicts'
export const EVIDENCE_RULES: readonly EvidenceRule[] = ['one_group', 'line_for_line', 'partition', 'contradicts']
export type MapSource = 'exact' | 'learned' | 'rule' | 'ai' | 'accountant'
export const MAP_SOURCES: readonly MapSource[] = ['exact', 'learned', 'rule', 'ai', 'accountant']

export interface EvidenceDocument {
  docId: string
  number: string
  type: string
  /** The business day, as a UTC midnight. */
  day: string
  groupId?: string
  rule: EvidenceRule
}

export interface StoredGroup {
  analyticId: string
  source: MapSource
  evidenceCount: number
  conflictCount: number
  reviewedAt?: string
  reviewedBy?: string
  /** What a write names the row by. */
  updatedAt: string
}

export interface ReviewRow {
  productId: string
  name: string
  sku?: string
  value: number
  lines: number
  state: ReviewState
  stored?: StoredGroup
  suggestion?: { analyticId: string; source: 'exact' | 'learned' }
  oneDocument?: boolean
  groups: { analyticId: string; docs: number; last: string; documents: EvidenceDocument[] }[]
  contradicting: { docs: number; documents: EvidenceDocument[] }
}

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

export interface ReviewSummary {
  products: number
  byState: Record<ReviewState, number>
  oneDocumentConflicts: number
  suggested: number
  coverage: Record<'all' | 'invoices' | 'till', CoverageShare>
}

export interface ReviewAnswer {
  rows: ReviewRow[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  summary: ReviewSummary
  period: { from?: string; to: string }
  evidence: { computedAt: string; fresh: boolean; refreshing: boolean }
  analytics: Record<string, { name: string; path: string; active: boolean; goods: boolean }>
  reviewers: Record<string, string>
}

export interface GoodsGroup {
  id: string
  name: string
  path: string
  active: boolean
}

/** The query string of the queue for the page's filters: only what is set. */
export function reviewFilters(f: { filter: ReviewFilter; search?: string | null; from?: string | null; to?: string | null }): Record<string, string> {
  const out: Record<string, string> = {}
  if (f.filter === 'todo') out.state = TO_REVIEW.join(',')
  else if (f.filter !== 'all') out.state = f.filter
  const search = f.search?.trim()
  if (search) out.search = search
  if (f.from) out.from = f.from
  if (f.to) out.to = f.to
  return out
}

/** How many products a filter lists, from the summary's counts. */
export function filterCount(filter: ReviewFilter, summary: ReviewSummary | null | undefined): number | undefined {
  if (!summary) return undefined
  if (filter === 'all') return summary.products
  if (filter === 'todo') return TO_REVIEW.reduce((n, s) => n + (summary.byState[s] ?? 0), 0)
  return summary.byState[filter] ?? 0
}

export const stateLabelKey = (s: ReviewState) => `accounting.productGroups.states.${s}`
export const filterLabelKey = (f: ReviewFilter) => (f === 'todo' || f === 'all' ? `accounting.productGroups.filters.${f}` : stateLabelKey(f))
export const ruleLabelKey = (r: EvidenceRule) => `accounting.productGroups.rules.${r}`
export const sourceLabelKey = (s: MapSource) => `accounting.productGroups.sources.${s}`

/** The queue's work in red and orange, a group a line posts by in blue, a decision of the accountant in green. */
export function stateColor(s: ReviewState): string {
  switch (s) {
    case 'conflict': return 'error'
    case 'unmapped': return 'warning'
    case 'learned':
    case 'exact': return 'info'
    default: return 'success'
  }
}

/** A goods group as a row shows it: its path under the goods root, which every group shares. */
export function groupLabel(path: string | null | undefined): string {
  const p = String(path ?? '')
  const i = p.indexOf(':')
  return i >= 0 && i < p.length - 1 ? p.slice(i + 1) : p
}

/** The share of the sales value whose lines post by a group: none when the period sold nothing. */
export function valueShare(c: CoverageShare | null | undefined): number | null {
  return c && c.value > 0 ? c.postingValue / c.value : null
}

/** The share of `valueShare` once learning has run again: what the suggestions add. */
export function valueShareAfterLearning(c: CoverageShare | null | undefined): number | null {
  return c && c.value > 0 ? c.afterLearningValue / c.value : null
}

/** A decision of the accountant's: their own group, or an automatic one they confirmed. */
export const isDecided = (row: Pick<ReviewRow, 'stored'>) => !!row.stored && (row.stored.source === 'accountant' || !!row.stored.reviewedAt)

export interface RowActions {
  /** The group a learning run would give, in one click. */
  accept: boolean
  /** The group a learning run gave, kept as it is and reviewed. */
  confirm: boolean
  /** Their decision withdrawn. */
  withdraw: boolean
}

/** What a row offers. A rule's or an AI's row is set, not confirmed: the server confirms only `exact` and `learned`. */
export function actionsOf(row: Pick<ReviewRow, 'stored' | 'suggestion'>): RowActions {
  const decided = isDecided(row)
  return {
    accept: !!row.suggestion && !decided,
    confirm: !!row.stored && !decided && (row.stored.source === 'exact' || row.stored.source === 'learned'),
    withdraw: decided,
  }
}

/** Where a product opens. */
export const productPath = (productId: string) => `/inventory/products/${productId}/edit`

/** The row a write names: its `updatedAt` as the page showed it, or null for none. */
export const expectedOf = (row: Pick<ReviewRow, 'stored'>): string | null => row.stored?.updatedAt ?? null

const TILL_TYPES = new Set(['cash_sale', 'cash_storno'])

/** Where a document of the evidence opens: a till sale in its own form, an invoice or a note in the documents' form. */
export function documentPath(doc: Pick<EvidenceDocument, 'docId' | 'type'>): string {
  return TILL_TYPES.has(doc.type) ? `/invoicing/cash-sales/${doc.docId}/edit` : `/invoicing/invoices/${doc.docId}/edit`
}

/**
 * The picker: the active groups the row's documents name, most named first (one click each), and every active group
 * of the org. An inactive group is never offered: the server refuses it.
 */
export function pickerOf(row: Pick<ReviewRow, 'groups'>, groups: readonly GoodsGroup[]): {
  named: (GoodsGroup & { docs: number })[]
  all: GoodsGroup[]
} {
  const active = groups.filter(g => g.active)
  const byId = new Map(active.map(g => [g.id, g]))
  const named = row.groups.flatMap(g => {
    const group = byId.get(g.analyticId)
    return group ? [{ ...group, docs: g.docs }] : []
  })
  return { named, all: active }
}

/** The group a picker opens on: the suggestion, else the group the documents name most, else none. */
export function pickerStart(row: Pick<ReviewRow, 'groups' | 'suggestion' | 'stored'>, groups: readonly GoodsGroup[]): string | null {
  const active = new Set(groups.filter(g => g.active).map(g => g.id))
  if (row.suggestion && active.has(row.suggestion.analyticId)) return row.suggestion.analyticId
  const named = row.groups.find(g => active.has(g.analyticId) && g.analyticId !== row.stored?.analyticId)
  return named?.analyticId ?? null
}

/** Why a write was refused, as the page says it: a changed row is reloaded, the rest are the server's words. */
export function writeErrorKey(code: string | undefined): string | null {
  switch (code) {
    case 'row_changed': return 'accounting.productGroups.rowChanged'
    case 'already_reviewed': return 'accounting.productGroups.alreadyReviewed'
    case 'not_a_goods_group': return 'accounting.productGroups.notAGoodsGroup'
    default: return null
  }
}

/** How long the page waits before it asks again while the evidence is being made anew, and how many times. */
export const STALE_POLL_MS = 10_000
export const STALE_POLLS = 18
