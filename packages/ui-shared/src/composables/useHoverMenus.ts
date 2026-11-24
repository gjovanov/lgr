import { computed, getCurrentScope, onScopeDispose } from 'vue'
import { useDisplay } from 'vuetify'
import { hoverOpenGate, type ActivatorProps } from './hover-open'

/** How long the pointer (or keyboard focus) rests on a menu's button before the menu opens. */
const HOVER_OPEN_DELAY = 100

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
 *
 * The activator binds `hoverActivator(props)`, never the slot's `props` alone: the wait
 * before a hover opens the menu is `hover-open.ts`'s, which a click, leaving or a blur cancels,
 * and `openDelay` (Vuetify's own, which nothing cancels) is 0 (#923).
 */
export function useHoverMenus() {
  const { mobile } = useDisplay()
  const canHover =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches

  const hoverEnabled = computed(() => !mobile.value && canHover)

  const gate = hoverOpenGate(HOVER_OPEN_DELAY)
  if (getCurrentScope()) onScopeDispose(gate.cancel)

  function hoverActivator(props: ActivatorProps): ActivatorProps {
    return hoverEnabled.value ? gate.wrap(props) : props
  }

  return {
    hoverEnabled,
    hoverActivator,
    /** Vuetify's own wait: none, `hoverActivator` waits instead (VMenu's default would be 300 ms). */
    openDelay: 0,
    closeDelay: 250,
  }
}
