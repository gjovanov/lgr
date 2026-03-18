import { ref, watch, type Ref } from 'vue'

/**
 * Debounced search composable. Returns `search` (for v-model binding)
 * and `debouncedSearch` (for use in filters computed).
 * Only search changes are debounced — use debouncedSearch in your filters.
 */
export function useSearchDebounce(delayMs = 300): { search: Ref<string>; debouncedSearch: Ref<string> } {
  const search = ref('')
  const debouncedSearch = ref('')
  let timer: ReturnType<typeof setTimeout> | null = null

  watch(search, (val) => {
    if (timer) clearTimeout(timer)
    if (!val) {
      // Clear immediately (user cleared the field)
      debouncedSearch.value = ''
      return
    }
    timer = setTimeout(() => {
      debouncedSearch.value = val
    }, delayMs)
  })

  return { search, debouncedSearch }
}
