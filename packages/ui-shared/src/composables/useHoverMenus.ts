import { computed } from 'vue'
import { useDisplay } from 'vuetify'

/**
 * FR-05 (#12): desktop menus open on mouse-over; touch devices keep tap-only behavior.
 *
 * `hoverEnabled` is true only when BOTH hold:
 *  - the viewport is not Vuetify's mobile breakpoint (the mobile navs are accordions /
 *    bottom sheets that hover must never touch), and
 *  - the primary pointer actually hovers (`hover: hover` + `pointer: fine`) — a touch
 *    laptop used by finger reports `pointer: coarse` on the primary input and stays
 *    tap-only, while its trackpad/mouse profile gets hover.
 *
 * Consumers spread the delays so sweeping the cursor across the bar doesn't flicker
 * adjacent groups, and moving from the activator into the list doesn't close it.
 * Click stays a valid opener everywhere (`open-on-click` is passed explicitly — Vuetify
 * silently defaults it to false the moment open-on-hover is set).
 */
export function useHoverMenus() {
  const { mobile } = useDisplay()
  const canHover =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches

  const hoverEnabled = computed(() => !mobile.value && canHover)

  return {
    hoverEnabled,
    openDelay: 100,
    closeDelay: 250,
  }
}
