/**
 * FR-25a §3.1–3.3: what the chart of accounts, the analytics and the bank account screens share about the books.
 *
 * Import-pure (`unit/books-chart.test.ts`): no Vue, no store, no request.
 */

/**
 * The kinds of an analytic, as `db/models/accounting-analytic.model.ts#ANALYTIC_KINDS` lists them. A copy, not an
 * import: the model file is mongoose's, and no UI bundles it. The unit test holds the two equal.
 */
export const ANALYTIC_KINDS = [
  'goods_group', 'material', 'product', 'service', 'customer', 'supplier', 'partner',
  'bank_account', 'expense', 'income', 'settlement', 'personnel', 'fixed_asset', 'equity', 'other',
] as const
export type AnalyticKind = (typeof ANALYTIC_KINDS)[number]

export const BALANCE_SIDES = ['debit', 'credit', 'both'] as const
export type BalanceSide = (typeof BALANCE_SIDES)[number]

/** The code the server refuses a change to the books with (`analytics-query.ts#AS_BOOKED`). */
export const AS_BOOKED = 'books_as_booked'

/**
 * Whether the org keeps a legal entity's books (`settings.accounting.books.mode`, from `/auth/me`). Its chart and its
 * analytics are then as the accountant booked them: read-only here, and the server refuses a change (422).
 */
export function isBooksOrg(org: { settings?: any } | null | undefined): boolean {
  return org?.settings?.accounting?.books?.mode === 'books'
}

/** How deep a path is: 0 for a root (`КЛИЕНТИ`), 1 for what is right under it. */
export function analyticDepth(path: string | null | undefined): number {
  return (String(path ?? '').match(/:/g) ?? []).length
}

/** A row's indent in the tree grid, in pixels. */
export function analyticIndent(path: string | null | undefined, step = 16): number {
  return analyticDepth(path) * step
}

/** The label key of a kind; a kind the list does not know reads as `other`. */
export function kindLabelKey(kind: string | null | undefined): string {
  return `accounting.analytics.kinds.${(ANALYTIC_KINDS as readonly string[]).includes(String(kind)) ? kind : 'other'}`
}

const KIND_COLORS: Partial<Record<AnalyticKind, string>> = {
  goods_group: 'orange', material: 'orange', product: 'orange',
  customer: 'primary', supplier: 'primary', partner: 'primary',
  bank_account: 'blue', expense: 'red', income: 'green', fixed_asset: 'purple', settlement: 'teal', equity: 'indigo',
}

export function kindColor(kind: string | null | undefined): string {
  return KIND_COLORS[kind as AnalyticKind] ?? 'grey'
}

/** The label key of a balance side, or none for an account the books never described. */
export function balanceSideKey(side: string | null | undefined): string | null {
  return (BALANCE_SIDES as readonly string[]).includes(String(side)) ? `accounting.accountBooks.balanceSides.${side}` : null
}

export function balanceSideColor(side: string | null | undefined): string {
  return side === 'debit' ? 'blue' : side === 'credit' ? 'green' : side === 'both' ? 'purple' : 'grey'
}

/** A root as `GET accounting/analytics/roots` answers it. */
export interface AnalyticRootInfo {
  root: string
  kind?: string
  /** `reports.accountingBooks.roots.<labelKey>`, for a root the registry names. */
  labelKey?: string
  count: number
}

/** The label key of a root the registry names; undefined for one it does not (show it as written). */
export function rootLabelKey(root: string, roots: readonly AnalyticRootInfo[]): string | undefined {
  const def = roots.find(r => r.root === root)
  return def?.labelKey ? `reports.accountingBooks.roots.${def.labelKey}` : undefined
}

/** What the analytics grid's filters hold. A select left empty is null. */
export interface AnalyticsFilterState {
  search?: string | null
  root?: string | null
  kind?: string | null
  hasContact?: 'yes' | 'no' | null
  active?: 'active' | 'inactive' | null
}

/** The filters as the API's query (`analytics-query.ts#parseAnalyticsQuery`): only what is set. */
export function analyticsFilters(state: AnalyticsFilterState): Record<string, string> {
  const out: Record<string, string> = {}
  const search = (state.search ?? '').trim()
  if (search) out.search = search
  if (state.root) out.root = state.root
  if (state.kind) out.kind = state.kind
  if (state.hasContact) out.hasContact = state.hasContact === 'yes' ? 'true' : 'false'
  if (state.active) out.isActive = state.active === 'active' ? 'true' : 'false'
  return out
}

export function hasAnalyticsFilters(state: AnalyticsFilterState): boolean {
  return Object.keys(analyticsFilters(state)).length > 0
}

/** One row of an analytic's properties in the form. */
export interface ParamRow {
  key: string
  value: string
}

export type ParamError = 'keyRequired' | 'keyDuplicate'

/**
 * What is wrong with each row, as the server would refuse it (`normaliseParams`): a name is required, and given once.
 * The first of two rows with one name is fine; the second is the duplicate.
 */
export function paramErrors(rows: readonly ParamRow[]): (ParamError | null)[] {
  const seen = new Set<string>()
  return rows.map(row => {
    const key = (row.key ?? '').trim()
    if (!key) return 'keyRequired'
    if (seen.has(key)) return 'keyDuplicate'
    seen.add(key)
    return null
  })
}

/** The rows as the API takes them: each name trimmed, in their order. */
export function paramsPayload(rows: readonly ParamRow[]): ParamRow[] {
  return rows.map(row => ({ key: (row.key ?? '').trim(), value: row.value ?? '' }))
}

/** A link as the API takes it: an id links, null unlinks. */
export function linkPayload(id: string | null | undefined): string | null {
  return id ? String(id) : null
}

/** This month, `YYYY-MM`, on the viewer's clock. */
export function currentMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/** The codes the analytics API refuses with, each with its words in `accounting.analytics.errors`. */
export const ANALYTIC_ERROR_CODES = [
  AS_BOOKED, 'not_found', 'contact_not_found', 'bank_account_not_found', 'fixed_asset_not_found',
  'param_key_required', 'param_key_duplicate', 'too_many_params',
] as const

/** The key of a refusal's words, or undefined for a code without any (show the server's message). */
export function analyticErrorKey(code: unknown): string | undefined {
  return (ANALYTIC_ERROR_CODES as readonly string[]).includes(String(code)) ? `accounting.analytics.errors.${code}` : undefined
}
