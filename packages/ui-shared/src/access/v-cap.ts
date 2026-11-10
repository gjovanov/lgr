import { shallowRef, watchEffect, type Directive, type ShallowRef, type WatchStopHandle } from 'vue'
import { can, isCapability, type CapabilityId, type Grant } from 'config/access'
import { accessGrant } from './useAccess'

/**
 * FR-27.7 (#529) — generic read-only: `v-cap="'contacts.edit'"` (or a list: any one of them) shows a control only to a
 * session whose grant holds the capability, the same `can()` the server decides by. A role that reads a feature and
 * does not work on it sees its pages without New, Save, Delete, Import or Export.
 *
 * Every gated element carries `data-cap` (what it needs) and, while hidden, `data-cap-hidden`, so a walk or an e2e test
 * can tell a control the role lacks from one that is missing. An id the catalogue does not know hides the control
 * (`unit/access-read-only.test.ts` refuses such a literal in a view). Presentation: the server answers on its own.
 *
 * Reactive: an edit to the role reaches the live grant (`live-grant.ts`) and the control follows, with no reload.
 */
export type CapValue = string | readonly string[] | null | undefined

function capsOf(value: CapValue): string[] {
  if (value == null) return []
  return (Array.isArray(value) ? value : [value]).filter(Boolean) as string[]
}

/** Whether a control gated by `value` shows: any one of the capabilities. Nothing named shows it; an unknown id hides it. */
export function capShows(value: CapValue, grant: Grant = accessGrant()): boolean {
  const caps = capsOf(value)
  if (!caps.length) return true
  const known = caps.filter(isCapability) as CapabilityId[]
  return known.length > 0 && can(grant, known)
}

function apply(el: HTMLElement, value: CapValue): void {
  const caps = capsOf(value)
  el.dataset.cap = caps.join(' ')
  const show = capShows(value)
  el.style.display = show ? '' : 'none'
  if (show) delete el.dataset.capHidden
  else el.dataset.capHidden = ''
}

const state = new WeakMap<HTMLElement, { value: ShallowRef<CapValue>; stop: WatchStopHandle }>()
const same = (a: CapValue, b: CapValue) => capsOf(a).join(' ') === capsOf(b).join(' ')

export const vCap: Directive<HTMLElement, CapValue> = {
  mounted(el, binding) {
    const value = shallowRef<CapValue>(binding.value)
    const stop = watchEffect(() => apply(el, value.value))
    state.set(el, { value, stop })
  },
  updated(el, binding) {
    const s = state.get(el)
    if (s && !same(s.value.value, binding.value)) s.value.value = binding.value
  },
  unmounted(el) {
    state.get(el)?.stop()
    state.delete(el)
  },
}
