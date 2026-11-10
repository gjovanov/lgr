/**
 * FR-28.13 / .14 — what is ticked on the Products list, as pure functions (no Vue, no `window`:
 * `unit/product-selection.test.ts` holds the rules).
 *
 * A selection is the articles ticked one by one (`ids`, kept across pages, sorts, columns and filter changes: ids,
 * never rows) and, optionally, "all that match the filter" (`matching`): the filter as it was when the user pressed
 * the banner, and how many it matched then. That one TRAVELS AS THE FILTER (FR-28.14): the server resolves it with the
 * list's own builder, so an article that appears later is in it and no id list ever leaves the browser for it.
 *
 * While `matching` holds and the list shows the very filter it was chosen under, every row of every page is ticked.
 * Unticking a row ends it, as in a mail list: what remains is the ticked rows of the page (and the explicit ids).
 * Under another filter its rows are not shown ticked (the filter is not the list's any more), and what the user ticks
 * there is explicit.
 */

/** D-12: the most articles an order is made from. */
export const MAX_SELECTION = 500

export interface MatchingSelection {
  /** The list's query (`GET /warehouse/product`'s parameters) at the moment of "Select all N that match". */
  filter: Record<string, string>
  /** How many articles it matched then. */
  total: number
}

export interface ProductSelectionState {
  ids: string[]
  matching: MatchingSelection | null
}

export const emptySelection = (): ProductSelectionState => ({ ids: [], matching: null })

/** A filter as text, whatever the order its keys were set in. */
export function filterKey(filter: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(filter).sort().map((k) => [k, filter[k]]))
}

/** True when "all that match" was chosen under the filter the list shows now. */
export function matchingIsCurrent(sel: ProductSelectionState, current: Record<string, string>): boolean {
  return !!sel.matching && filterKey(sel.matching.filter) === filterKey(current)
}

/** How many articles the selection names (the ones ticked one by one, plus those "all that match" named). */
export function selectionCount(sel: ProductSelectionState): number {
  return sel.ids.length + (sel.matching?.total ?? 0)
}

/** More than an order can be made from. */
export function overCap(sel: ProductSelectionState): boolean {
  return selectionCount(sel) > MAX_SELECTION
}

/** What the table shows ticked: the ids, and every row of the page while "all that match" holds for this very filter. */
export function tickedOnPage(sel: ProductSelectionState, pageIds: readonly string[], current: Record<string, string>): string[] {
  if (!matchingIsCurrent(sel, current)) return [...sel.ids]
  return [...new Set([...sel.ids, ...pageIds])]
}

/**
 * The table reported the ids it shows ticked (all of them, on every page: Vuetify keeps the selection by id). The
 * selection becomes those. Unticking a row of the page while "all that match" holds ends it: its other rows are not
 * representable one by one, so the page's remaining rows are what stays ticked.
 */
export function applyTableChange(
  sel: ProductSelectionState,
  newIds: readonly string[],
  pageIds: readonly string[],
  current: Record<string, string>,
): ProductSelectionState {
  const ids = [...new Set(newIds)]
  if (!matchingIsCurrent(sel, current)) return { ids, matching: sel.matching }
  const unticked = pageIds.some((id) => !ids.includes(id))
  return unticked ? { ids, matching: null } : { ids: sel.ids, matching: sel.matching }
}

/** True when every row of the page is ticked. */
export function pageFullyTicked(ticked: readonly string[], pageIds: readonly string[]): boolean {
  return pageIds.length > 0 && pageIds.every((id) => ticked.includes(id))
}

/**
 * The banner "Select all N that match the filter": offered when the whole page is ticked, the filter matches more
 * than the page shows, and "all that match" is not already chosen for it.
 */
export function offersSelectAllMatching(
  sel: ProductSelectionState,
  pageIds: readonly string[],
  total: number,
  current: Record<string, string>,
): boolean {
  if (matchingIsCurrent(sel, current)) return false
  return pageFullyTicked(tickedOnPage(sel, pageIds, current), pageIds) && total > pageIds.length
}

/**
 * "Select all N that match the filter". `outside` are the explicit ids the filter HIDES: they are not part of what
 * it matches, so they stay; the ones it shows are in "all that match" already and are dropped (counted once).
 */
export function selectAllMatching(
  sel: ProductSelectionState,
  current: Record<string, string>,
  total: number,
  outside: readonly string[],
): ProductSelectionState {
  return { ids: sel.ids.filter((id) => outside.includes(id)), matching: { filter: { ...current }, total } }
}

/**
 * What an order's preview is asked for: the ids ticked one by one, and "all that match" as the filter.
 * `warehouseId` is the list's own warehouse filter (it scopes the figures and starts the allocations).
 */
export function previewBody(sel: ProductSelectionState, warehouseId?: string | null): { productIds?: string[]; filter?: Record<string, string>; warehouseId?: string } {
  return {
    ...(sel.ids.length ? { productIds: [...sel.ids] } : {}),
    ...(sel.matching ? { filter: { ...sel.matching.filter } } : {}),
    ...(warehouseId ? { warehouseId } : {}),
  }
}
