/**
 * The wait before a hover opens a menu, kept by us instead of by Vuetify (#923).
 *
 * Vuetify's `open-delay` timer, once a mouseenter (or a keyboard focus) starts it, fires whatever
 * happened meanwhile, and nothing outside Vuetify can cancel it. A menu opened by a click and
 * closed within that wait (Escape, a second click) therefore opened again by itself a moment
 * later, with the pointer still on its button. The nightly saw it: the till's menu test pressed
 * Escape on one group 85 ms after the pointer reached it, the group reopened at 100 ms, and the
 * next group's list was read while the two overlays traded places.
 *
 * Here the activator's `onMouseenter` and `onFocus` reach Vuetify only after `delay`, and the menu
 * is given no delay of its own. A click, leaving the button and its blur cancel what is pending.
 */

type Handler = (e: Event) => void
export type ActivatorProps = Record<string, any>

/** The timer the gate waits with; a test passes a clock it runs by hand. */
export interface HoverClock {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realClock: HoverClock = {
  set: (run, ms) => setTimeout(run, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function hoverOpenGate(delay: number, clock: HoverClock = realClock) {
  // One pending open at a time: the pointer rests on one button only.
  let pending: { handle: unknown } | undefined

  function cancel() {
    if (!pending) return
    clock.clear(pending.handle)
    pending = undefined
  }

  const later = (handler: unknown): Handler => (e) => {
    cancel()
    if (typeof handler !== 'function') return
    const mine = { handle: undefined as unknown }
    pending = mine
    mine.handle = clock.set(() => {
      if (pending === mine) pending = undefined
      handler(e)
    }, delay)
  }

  const now = (handler: unknown): Handler => (e) => {
    cancel()
    if (typeof handler === 'function') handler(e)
  }

  /** The activator slot's props, with the opening ones delayed and the rest cancelling them. */
  function wrap(props: ActivatorProps): ActivatorProps {
    return {
      ...props,
      onMouseenter: later(props.onMouseenter),
      onFocus: later(props.onFocus),
      onMouseleave: now(props.onMouseleave),
      onBlur: now(props.onBlur),
      onClick: now(props.onClick),
    }
  }

  return { wrap, cancel }
}
