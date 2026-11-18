import { LIST_CEILING } from 'config/list-rows'

/**
 * FR-30.9: "All" in the browser.
 *
 * A list answer carries at most `LIST_CEILING` rows (FR-30.8), so "All" is offered only while the list's total is within
 * it. On Products at shop size "All" was 81.6 MB, and the tab did not answer for the 200 s it was watched. The choice
 * stayed in the address (`?size=-1`) and in the list's remembered state, so it came back: a stored or bookmarked `-1`
 * now opens the list at the largest page size, and "All" is offered again once the list is known to be small enough.
 *
 * Import-pure, so the unit test reads it without a browser.
 */

/** Vuetify's value for "All". */
export const ALL_ROWS = -1

/** The largest page the size control offers besides "All". */
export const LARGEST_PAGE_SIZE = 100

/** A page size read from the address or the remembered state: one the control offers, "All" read as the largest. */
export function pageSizeFromUrl(v: number, allowed: readonly number[]): number | undefined {
  if (v === ALL_ROWS) return LARGEST_PAGE_SIZE
  return allowed.includes(v) ? v : undefined
}

/** Whether "All" may be offered for a list of `total` rows. */
export function offersAll(total: number): boolean {
  return Number.isFinite(total) && total <= LIST_CEILING
}

type SizeOption = number | { value: number; title?: string }
const valueOf = (o: SizeOption): number => (typeof o === 'number' ? o : o.value)

/** The size control's options for a list of `total` rows: without "All" above the ceiling. */
export function pageSizeOptions<T extends SizeOption>(options: readonly T[], total: number): T[] {
  return offersAll(total) ? [...options] : options.filter((o) => valueOf(o) !== ALL_ROWS)
}
