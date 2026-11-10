import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { httpClient } from '../useHttpClient'
import type { ProductList } from './useProductList'
import {
  MAX_SELECTION,
  applyTableChange,
  emptySelection,
  matchingIsCurrent,
  offersSelectAllMatching,
  overCap as selectionOverCap,
  previewBody,
  selectAllMatching,
  selectionCount,
  tickedOnPage,
  type ProductSelectionState,
} from './product-selection'

/**
 * FR-28.14 — the Products list's selection: what is ticked, across pages, sorts, columns and filter changes, and
 * how many of it the current filter hides. The rules are `product-selection.ts`'s; this adds the state, and the one
 * question only the server can answer: which of the ticked articles does the list's own filter hide?
 *
 * Not in the URL (FR-28.14): a selection is a working state, and a link must not carry a hundred ids.
 *
 * Returned as a `reactive` object, like `useProductList`, so a template can `v-model="selection.ticked"`.
 */
const OUTSIDE_CALL_SIZE = 100

export function useProductSelection(list: ProductList, orgUrl: () => string) {
  const state = ref<ProductSelectionState>(emptySelection())

  const pageIds = computed(() => list.items.map((p) => p._id).filter(Boolean))
  /** The list's own query, as the server takes it (a plain copy, to be compared and sent). */
  const currentFilter = computed<Record<string, string>>(() => ({ ...(list.filters as Record<string, string>) }))

  /** `v-model:selected` of the table: what it shows ticked. */
  const ticked = computed<string[]>({
    get: () => tickedOnPage(state.value, pageIds.value, currentFilter.value),
    set: (ids) => { state.value = applyTableChange(state.value, ids, pageIds.value, currentFilter.value) },
  })

  const count = computed(() => selectionCount(state.value))
  const overCap = computed(() => selectionOverCap(state.value))
  const isMatching = computed(() => !!state.value.matching)
  const matchingCurrent = computed(() => matchingIsCurrent(state.value, currentFilter.value))
  const offerSelectAll = computed(() => offersSelectAllMatching(state.value, pageIds.value, list.pagination.total, currentFilter.value))

  // ── how many ticked articles the current filter hides ──
  const outside = ref(0)
  let outsideSeq = 0
  let outsideTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Of these ids, the ones the list's filter shows, asked of the list's own endpoint (so it is the list's own rule).
   * The ones on the page need no question. With a warehouse chosen the endpoint lets `ids` override that restriction
   * (its contract, FR-28.3), so an article the warehouse holds none of counts as shown: the chip does not claim more.
   */
  async function shownByCurrentFilter(ids: readonly string[]): Promise<Set<string>> {
    const shown = new Set(ids.filter((id) => pageIds.value.includes(id)))
    const ask = ids.filter((id) => !shown.has(id))
    for (let i = 0; i < ask.length; i += OUTSIDE_CALL_SIZE) {
      const chunk = ask.slice(i, i + OUTSIDE_CALL_SIZE)
      const { data } = await httpClient.get(`${orgUrl()}/warehouse/product`, {
        params: { ...currentFilter.value, ids: chunk.join(','), page: 0, size: OUTSIDE_CALL_SIZE, sortBy: 'name', sortOrder: 'asc' },
      })
      for (const p of (data.products || data.items || []) as Array<{ _id: string }>) shown.add(String(p._id))
    }
    return shown
  }

  async function refreshOutside() {
    const mine = ++outsideSeq
    const ids = state.value.ids
    if (!ids.length) { outside.value = 0; return }
    try {
      const shown = await shownByCurrentFilter(ids)
      if (mine === outsideSeq) outside.value = ids.filter((id) => !shown.has(id)).length
    } catch {
      // The chip is a courtesy: a failed question leaves the last answer.
    }
  }
  function scheduleOutside() {
    if (outsideTimer) clearTimeout(outsideTimer)
    // The ones on the page are known at once; the rest wait for the server.
    if (state.value.ids.every((id) => pageIds.value.includes(id))) { outsideSeq++; outside.value = 0; return }
    outsideTimer = setTimeout(() => { void refreshOutside() }, 300)
  }
  watch([() => state.value.ids, currentFilter, pageIds], scheduleOutside, { deep: true })
  onBeforeUnmount(() => { if (outsideTimer) clearTimeout(outsideTimer) })

  // ── actions ──
  function clear() { state.value = emptySelection(); outside.value = 0 }

  /** "Select all N that match the filter": the filter travels, not the ids. */
  async function selectAll() {
    let hidden: string[] = state.value.ids
    try {
      if (state.value.ids.length) {
        const shown = await shownByCurrentFilter(state.value.ids)
        hidden = state.value.ids.filter((id) => !shown.has(id))
      }
    } catch { /* keep them all: counted twice at worst, and the dialog shows the real number */ }
    state.value = selectAllMatching(state.value, currentFilter.value, list.pagination.total, hidden)
  }

  /** What the order dialogs ask the preview for. */
  const body = () => previewBody(state.value, list.warehouseFilter)

  return reactive({
    ticked, count, overCap, isMatching, matchingCurrent, offerSelectAll, outside, max: MAX_SELECTION,
    clear, selectAll, body,
  })
}

export type ProductSelection = ReturnType<typeof useProductSelection>
