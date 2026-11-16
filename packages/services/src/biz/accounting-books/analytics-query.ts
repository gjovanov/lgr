/**
 * FR-25a §3.2: what the analytics grid asks of `AccountingAnalytic`, as data. The query string becomes a match, a sort
 * and a page here; `analytics.service.ts` runs them. The rule for what may be edited is here too.
 *
 * Import-pure: the unit tests read this without a database.
 */

/**
 * The code a write is refused with when the record is the books' (FR-25a §3, the shared rules): an analytic, or an
 * account, of an org that keeps a legal entity's books as the accountant booked them. The next import would overwrite
 * an edit, and a book the accountant filed must not differ from ours.
 */
export const AS_BOOKED = 'books_as_booked'

/**
 * Whether an org keeps a legal entity's books, its own or a store's share of a split (FR-25 §3.1, R7). Its chart and
 * its analytic tree are the books' then, read-only for everyone. The same rule as `org-clone/policy.ts#keepsBooks`.
 */
export const keepsBooks = (org: { settings?: any } | null | undefined): boolean => org?.settings?.accounting?.books?.mode === 'books'

/**
 * What separates a path's segments in the tree's order. `:` sorts above a space, a digit and most punctuation, so
 * ordered by the path itself `РАЗХОДИ:УСЛУГИ АДМ` lands between `РАЗХОДИ:УСЛУГИ` and its child `РАЗХОДИ:УСЛУГИ:Наем`,
 * and an indented grid draws the child under the wrong parent. Below every character a name holds, it cannot.
 */
export const TREE_SEPARATOR = '\u0001'

/** A path as the tree orders it: a node, then everything under it, then its next sibling. */
export const treeKeyOf = (path: string): string => path.split(':').join(TREE_SEPARATOR)

/** How deep a path is: 0 for a root, 1 for what is right under it. */
export const depthOf = (path: string): number => (path.match(/:/g) ?? []).length

export const ANALYTIC_SORTS = ['path', 'root', 'name', 'kind', 'unit', 'isActive'] as const
export type AnalyticSort = (typeof ANALYTIC_SORTS)[number]

export interface AnalyticsQuery {
  page: number
  /** 0: every row. */
  size: number
  sortBy: AnalyticSort
  sortOrder: 1 | -1
  root?: string
  kind?: string
  hasContact?: boolean
  isActive?: boolean
  search?: string
  /** Which analytics point at this record: the forms of a contact, a bank account, a fixed asset. */
  contactId?: string
  bankAccountId?: string
  fixedAssetId?: string
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** `true` and `false` as a query string says them; anything else is no filter. */
function flag(v: unknown): boolean | undefined {
  if (v === true || v === 'true' || v === '1') return true
  if (v === false || v === 'false' || v === '0') return false
  return undefined
}

/** A query string, made safe: a page, a size, a sort it knows, and the filters it was given. */
export function parseAnalyticsQuery(raw: Record<string, unknown>): AnalyticsQuery {
  const page = Math.max(0, Math.floor(Number(raw.page)) || 0)
  // 0 is every row, as every list here has it; a size that is no number is the default, never "every row".
  const asked = Number(raw.size)
  const size = raw.size === undefined || raw.size === '' || !Number.isFinite(asked) || asked < 0 ? 25 : Math.floor(asked)
  const sortBy = (ANALYTIC_SORTS as readonly string[]).includes(String(raw.sortBy)) ? (raw.sortBy as AnalyticSort) : 'path'
  const q: AnalyticsQuery = { page, size, sortBy, sortOrder: raw.sortOrder === 'desc' ? -1 : 1 }
  const root = text(raw.root)
  const kind = text(raw.kind)
  const search = text(raw.search)
  const hasContact = flag(raw.hasContact)
  const isActive = flag(raw.isActive)
  if (root) q.root = root
  if (kind) q.kind = kind
  if (search) q.search = search
  if (hasContact !== undefined) q.hasContact = hasContact
  if (isActive !== undefined) q.isActive = isActive
  for (const key of ['contactId', 'bankAccountId', 'fixedAssetId'] as const) {
    const id = text(raw[key])
    if (id) q[key] = id
  }
  return q
}

const OBJECT_ID = /^[a-f0-9]{24}$/i

/**
 * The filters as a match, without the org (the caller adds it) and without the search (`buildSearchFilter` makes it).
 * An id that is no id matches nothing, rather than being dropped and matching everything.
 */
export function analyticsMatch(q: AnalyticsQuery, toId: (id: string) => unknown): Record<string, unknown> {
  const match: Record<string, unknown> = {}
  if (q.root) match.root = q.root
  if (q.kind) match.kind = q.kind
  // `null` too: an unlinked analytic may have the field set to null by an older write.
  if (q.hasContact === true) match.contactId = { $exists: true, $ne: null }
  if (q.hasContact === false) match.contactId = { $in: [null] }
  // An analytic with no `isActive` is active: the field defaults to true.
  if (q.isActive === true) match.isActive = { $ne: false }
  if (q.isActive === false) match.isActive = false
  for (const key of ['contactId', 'bankAccountId', 'fixedAssetId'] as const) {
    const id = q[key]
    if (!id) continue
    match[key] = OBJECT_ID.test(id) ? toId(id) : { $in: [] }
  }
  return match
}

/**
 * The order of a page. Every sort ends in the tree's order, so a page is stable and rows that tie stay in their tree.
 * `treeKey` is computed by the pipeline (`$replaceAll` of `:` by `TREE_SEPARATOR`); by `path` is by it alone, which
 * is the root, then the tree under it.
 */
export function analyticsSort(q: AnalyticsQuery): Record<string, 1 | -1> {
  const dir = q.sortOrder
  switch (q.sortBy) {
    case 'path': return { treeKey: dir, _id: 1 }
    case 'root': return { root: dir, treeKey: 1, _id: 1 }
    case 'name': return { nameLower: dir, treeKey: 1, _id: 1 }
    default: return { [q.sortBy]: dir, treeKey: 1, _id: 1 }
  }
}

/** The most properties a person may keep on an analytic of their own, and how long a name and a value may be. */
export const MAX_PARAMS = 200
export const MAX_PARAM_KEY = 200
export const MAX_PARAM_VALUE = 2000

export type ParamsRefusal = 'param_key_required' | 'param_key_duplicate' | 'too_many_params'

/**
 * An analytic's own properties as a person keyed them, in their order: each named (a name is trimmed, and required)
 * and named once, each value text. A refusal names the first rule broken.
 */
export function normaliseParams(params: readonly { key?: unknown; value?: unknown }[]): { params: { key: string; value: string }[] } | { refusal: ParamsRefusal } {
  if (params.length > MAX_PARAMS) return { refusal: 'too_many_params' }
  const out: { key: string; value: string }[] = []
  const seen = new Set<string>()
  for (const p of params) {
    const key = typeof p?.key === 'string' ? p.key.trim() : ''
    if (!key) return { refusal: 'param_key_required' }
    if (seen.has(key)) return { refusal: 'param_key_duplicate' }
    seen.add(key)
    out.push({ key, value: p.value === undefined || p.value === null ? '' : String(p.value) })
  }
  return { params: out }
}

/**
 * FR-25a §3.1: the chart's two filters from the books, as a match. `hasAnalytics`: its lines name analytics of some
 * root (`analyticRoots` not empty). `quantitative`: its lines carry quantities. An account the books never described
 * has neither, so it is a "no" to both, and a filter left out is no filter.
 */
export function accountBooksFilter(raw: Record<string, unknown>): Record<string, unknown> {
  const match: Record<string, unknown> = {}
  const hasAnalytics = flag(raw.hasAnalytics)
  const quantitative = flag(raw.quantitative)
  if (hasAnalytics === true) match['analyticRoots.0'] = { $exists: true }
  if (hasAnalytics === false) match['analyticRoots.0'] = { $exists: false }
  if (quantitative === true) match.quantitative = true
  if (quantitative === false) match.quantitative = { $ne: true }
  return match
}

/** `YYYY-MM` as the half-open range of the days an entry is dated on (entries are dated at midnight UTC). */
export function monthRange(month: string): { from: Date; to: Date } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) return null
  const year = Number(m[1])
  const index = Number(m[2]) - 1
  if (index < 0 || index > 11) return null
  return { from: new Date(Date.UTC(year, index, 1)), to: new Date(Date.UTC(year, index + 1, 1)) }
}
