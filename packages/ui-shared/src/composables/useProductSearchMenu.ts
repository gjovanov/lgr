import { ref } from 'vue'

/**
 * Shared count of currently-open product line-search menus.
 *
 * The invoice line-table's grid navigation runs a capture-phase keydown handler on an
 * ancestor, so a descendant component (ProductLineDescription) cannot stop it via
 * stopPropagation, and DOM-attribute / focus checks proved unreliable (v-menu teleports
 * its list, focus can move off the input). This module-level flag is the single source of
 * truth: while any product menu is open, grid navigation yields ↑/↓/Enter to it. Only one
 * line's menu is ever open at a time, so a simple count is safe.
 */
const openCount = ref(0)

export const productSearchMenuOpen = openCount

export function setProductSearchMenuOpen(open: boolean) {
  openCount.value = Math.max(0, openCount.value + (open ? 1 : -1))
}
