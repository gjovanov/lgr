import { describe, it, expect } from 'bun:test'
import {
  MAX_SELECTION,
  applyTableChange,
  emptySelection,
  filterKey,
  matchingIsCurrent,
  offersSelectAllMatching,
  overCap,
  pageFullyTicked,
  previewBody,
  selectAllMatching,
  selectionCount,
  tickedOnPage,
  type ProductSelectionState,
} from 'ui-shared/composables/product-list/product-selection'

/**
 * FR-28.13 / .14 — what is ticked on the Products list.
 *
 * The cases pin: the selection holds IDS across pages, sorts and filter changes; "all that match" travels as the
 * filter and is shown ticked only under the filter it was chosen for; unticking a row ends it; the banner is offered
 * only when the whole page is ticked and the filter matches more; the cap is 500.
 */

const page1 = ['a1', 'a2', 'a3']
const page2 = ['b1', 'b2', 'b3']
const FILTER = { isActive: 'true', belowMin: 'true' }
const OTHER = { isActive: 'true', search: 'bolt' }

/** What the table does: it reports every id it shows ticked, on every page. */
function tick(sel: ProductSelectionState, page: string[], filter: Record<string, string>, change: { add?: string[]; remove?: string[] }) {
  const shown = tickedOnPage(sel, page, filter)
  const next = [...shown.filter((id) => !(change.remove ?? []).includes(id)), ...(change.add ?? [])]
  return applyTableChange(sel, next, page, filter)
}

describe('ids held across pages, sorts and filter changes', () => {
  it('ticking on one page and on another keeps both: the table\'s model is ids, not rows', () => {
    let sel = emptySelection()
    sel = tick(sel, page1, FILTER, { add: ['a1', 'a3'] })
    expect(tickedOnPage(sel, page1, FILTER)).toEqual(['a1', 'a3'])
    // Page 2: the model the table is given still holds page 1's ids, and the new ticks join them.
    expect(tickedOnPage(sel, page2, FILTER)).toEqual(['a1', 'a3'])
    sel = tick(sel, page2, FILTER, { add: ['b2'] })
    expect(sel.ids).toEqual(['a1', 'a3', 'b2'])
    // Back on page 1: still ticked.
    expect(tickedOnPage(sel, page1, FILTER)).toEqual(['a1', 'a3', 'b2'])
    expect(selectionCount(sel)).toBe(3)
  })

  it('survives a filter change: the ids stay, whatever the list shows now', () => {
    let sel = tick(emptySelection(), page1, FILTER, { add: ['a1', 'a2'] })
    // Another filter, another page of rows: nothing is lost, and nothing is added.
    expect(tickedOnPage(sel, ['c1', 'c2'], OTHER)).toEqual(['a1', 'a2'])
    sel = tick(sel, ['c1', 'c2'], OTHER, { add: ['c2'] })
    expect(sel.ids).toEqual(['a1', 'a2', 'c2'])
  })

  it('unticking removes one id and leaves the rest, on this page or another', () => {
    let sel = tick(emptySelection(), page1, FILTER, { add: ['a1', 'a2', 'a3'] })
    sel = tick(sel, page2, FILTER, { add: ['b1'] })
    sel = tick(sel, page2, FILTER, { remove: ['a2'] })
    expect(sel.ids).toEqual(['a1', 'a3', 'b1'])
  })

  it('a repeated id is one article', () => {
    const sel = applyTableChange(emptySelection(), ['a1', 'a1', 'a2'], page1, FILTER)
    expect(sel.ids).toEqual(['a1', 'a2'])
  })

  it('is empty after Clear, and has no filter to send', () => {
    expect(emptySelection()).toEqual({ ids: [], matching: null })
    expect(previewBody(emptySelection())).toEqual({})
  })
})

describe('"Select all N that match the filter"', () => {
  const ticked = (sel: ProductSelectionState) => tickedOnPage(sel, page1, FILTER)

  it('is offered only when the whole page is ticked and the filter matches more than the page shows', () => {
    let sel = emptySelection()
    expect(offersSelectAllMatching(sel, page1, 40, FILTER)).toBe(false)
    sel = tick(sel, page1, FILTER, { add: ['a1', 'a2'] })
    expect(pageFullyTicked(ticked(sel), page1)).toBe(false)
    expect(offersSelectAllMatching(sel, page1, 40, FILTER)).toBe(false)
    sel = tick(sel, page1, FILTER, { add: ['a3'] })
    expect(offersSelectAllMatching(sel, page1, 40, FILTER)).toBe(true)
    // A filter that matches exactly what the page shows has nothing more to select.
    expect(offersSelectAllMatching(sel, page1, 3, FILTER)).toBe(false)
    // An empty page offers nothing.
    expect(offersSelectAllMatching(emptySelection(), [], 40, FILTER)).toBe(false)
  })

  it('travels as the filter: the body carries the filter and never the ids of the matches', () => {
    let sel = tick(emptySelection(), page1, FILTER, { add: page1 })
    sel = selectAllMatching(sel, FILTER, 213, [])
    expect(sel.matching).toEqual({ filter: FILTER, total: 213 })
    expect(selectionCount(sel)).toBe(213)
    expect(previewBody(sel)).toEqual({ filter: FILTER })
    // The ticks the filter shows are in "all that match" already: they are not counted twice or sent as ids.
    expect(sel.ids).toEqual([])
  })

  it('keeps the explicit ids the filter hides, which are not part of what it matches', () => {
    let sel = tick(emptySelection(), page1, OTHER, { add: ['x1', 'x2'] })
    sel = tick(sel, page1, FILTER, { add: page1 })
    sel = selectAllMatching(sel, FILTER, 40, ['x1', 'x2'])
    expect(sel.ids).toEqual(['x1', 'x2'])
    expect(selectionCount(sel)).toBe(42)
    expect(previewBody(sel, 'wh-1')).toEqual({ productIds: ['x1', 'x2'], filter: FILTER, warehouseId: 'wh-1' })
  })

  it('shows every row of every page ticked while the list shows the filter it was chosen under', () => {
    const sel = selectAllMatching(emptySelection(), FILTER, 213, [])
    expect(matchingIsCurrent(sel, { belowMin: 'true', isActive: 'true' })).toBe(true)
    expect(tickedOnPage(sel, page1, FILTER)).toEqual(page1)
    expect(tickedOnPage(sel, page2, FILTER)).toEqual(page2)
    // The banner is not offered again for it.
    expect(offersSelectAllMatching(sel, page1, 213, FILTER)).toBe(false)
  })

  it('shows nothing ticked under another filter, and keeps the selection: it was chosen for the first', () => {
    const sel = selectAllMatching(emptySelection(), FILTER, 213, [])
    expect(matchingIsCurrent(sel, OTHER)).toBe(false)
    expect(tickedOnPage(sel, ['c1', 'c2'], OTHER)).toEqual([])
    expect(selectionCount(sel)).toBe(213)
    // What the user ticks there is explicit, and the selection holds both.
    const more = tick(sel, ['c1', 'c2'], OTHER, { add: ['c1'] })
    expect(more.matching).toEqual({ filter: FILTER, total: 213 })
    expect(more.ids).toEqual(['c1'])
    expect(previewBody(more)).toEqual({ productIds: ['c1'], filter: FILTER })
  })

  it('unticking a row ends it: what stays ticked is the rest of the page', () => {
    const sel = selectAllMatching(emptySelection(), FILTER, 213, [])
    const after = tick(sel, page1, FILTER, { remove: ['a2'] })
    expect(after.matching).toBeNull()
    expect(after.ids).toEqual(['a1', 'a3'])
    expect(selectionCount(after)).toBe(2)
    // The header checkbox of a fully ticked page unticks the page, and so ends it too.
    const header = tick(sel, page1, FILTER, { remove: page1 })
    expect(header.matching).toBeNull()
    expect(header.ids).toEqual([])
  })

  it('ticking a row that was shown ticked already changes nothing', () => {
    const sel = selectAllMatching(emptySelection(), FILTER, 213, [])
    const same = tick(sel, page1, FILTER, { add: ['a1'] })
    expect(same.matching).toEqual({ filter: FILTER, total: 213 })
    expect(same.ids).toEqual([])
  })
})

describe('the cap (D-12)', () => {
  it('is 500 articles, counting the ticked ones and "all that match" together', () => {
    expect(MAX_SELECTION).toBe(500)
    expect(overCap({ ids: Array.from({ length: 500 }, (_, i) => `i${i}`), matching: null })).toBe(false)
    expect(overCap({ ids: Array.from({ length: 501 }, (_, i) => `i${i}`), matching: null })).toBe(true)
    expect(overCap({ ids: [], matching: { filter: FILTER, total: 500 } })).toBe(false)
    expect(overCap({ ids: [], matching: { filter: FILTER, total: 501 } })).toBe(true)
    expect(overCap({ ids: ['x'], matching: { filter: FILTER, total: 500 } })).toBe(true)
  })
})

describe('a filter is one thing whatever the order its keys were set in', () => {
  it('compares equal', () => {
    expect(filterKey({ a: '1', b: '2' })).toBe(filterKey({ b: '2', a: '1' }))
    expect(filterKey({ a: '1' })).not.toBe(filterKey({ a: '2' }))
  })
})
