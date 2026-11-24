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
 * is given no delay of its own. Leaving the button cancels a pending hover, its blur a pending focus.
 *
 * ⚠ A click while the hover waits hands Vuetify that hover AT ONCE (which opens the menu) instead of
 * dropping it. Vuetify must know the pointer is on the button: its mouseenter is also what clears a
 * close timer still running, and a menu it believes unhovered is closed when that timer ends. The
 * pointer leaving a menu's list (it had just clicked an entry there) starts one for 250 ms; dropping
 * the hover left it running, and `till-printer-walk.spec` saw the menu clicked open next close under
 * the pointer on its way to an entry. The click itself then reaches Vuetify only when the menu was
 * already open (it closes it); on a closed menu the hover has just opened it, and Vuetify's click
 * would toggle it shut again.
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

interface Pending { handle: unknown; run: () => void }

/** Whether the menu is open, as its button says it (`aria-expanded`, Vuetify's). */
function expanded(e: Event, props: ActivatorProps): boolean {
  const el = e.currentTarget as { getAttribute?: (name: string) => string | null } | null
  const said = el?.getAttribute?.('aria-expanded') ?? props['aria-expanded']
  return String(said) === 'true'
}

export function hoverOpenGate(delay: number, clock: HoverClock = realClock) {
  // One pending hover and one pending focus at a time: the pointer rests on one button only, and a
  // click focuses the button it lands on, which must not drop that button's hover.
  let hover: Pending | undefined
  let focus: Pending | undefined

  function drop(p: Pending | undefined) {
    if (p) clock.clear(p.handle)
  }
  function cancel() {
    drop(hover)
    drop(focus)
    hover = focus = undefined
  }

  function schedule(run: () => void, done: (p: Pending) => void): Pending {
    const p: Pending = { handle: undefined, run }
    p.handle = clock.set(() => { done(p); run() }, delay)
    return p
  }

  /** The activator slot's props, with the opening ones delayed and the rest cancelling them. */
  function wrap(props: ActivatorProps): ActivatorProps {
    const call = (name: string, e: Event) => {
      const handler = props[name]
      if (typeof handler === 'function') (handler as Handler)(e)
    }
    return {
      ...props,
      onMouseenter: (e: Event) => {
        drop(hover)
        hover = schedule(() => call('onMouseenter', e), p => { if (hover === p) hover = undefined })
      },
      onFocus: (e: Event) => {
        drop(focus)
        focus = schedule(() => call('onFocus', e), p => { if (focus === p) focus = undefined })
      },
      onMouseleave: (e: Event) => {
        drop(hover)
        hover = undefined
        call('onMouseleave', e)
      },
      onBlur: (e: Event) => {
        drop(focus)
        focus = undefined
        call('onBlur', e)
      },
      onClick: (e: Event) => {
        drop(focus)
        focus = undefined
        const waiting = hover
        if (waiting) {
          drop(waiting)
          hover = undefined
          const wasOpen = expanded(e, props)
          waiting.run()
          if (!wasOpen) {
            e.stopPropagation?.() // as Vuetify's own click handler does
            return
          }
        }
        call('onClick', e)
      },
    }
  }

  return { wrap, cancel }
}
