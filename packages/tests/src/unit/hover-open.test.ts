import { describe, it, expect } from 'bun:test'
import { hoverOpenGate, type HoverClock } from '../../../ui-shared/src/composables/hover-open'

/**
 * #923: a top-bar menu closed within the hover wait (Escape, a second click) opened again by itself.
 *
 * Vuetify's own open-delay timer, started by the mouseenter, fired after the close. `hover-open.ts` keeps that wait
 * instead. `vuetifyMenu` below stands for Vuetify's activator (`VOverlay/useActivator`) as the menus configure it:
 * `open-delay` 0, `close-delay` 250, a click toggles, and a delay's end opens or closes only when that matches
 * whether the pointer or a visible focus is on it.
 */

/** A clock run by hand: `tick(ms)` fires what is due. */
function manualClock() {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  const clock: HoverClock = {
    set: (run, ms) => { const id = next++; timers.set(id, { at: now + ms, run }); return id },
    clear: id => { timers.delete(id as number) },
  }
  function tick(ms: number) {
    const until = now + ms
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].run()
    }
    now = until
  }
  return { clock, tick, pending: () => timers.size }
}

function vuetifyMenu(clock: HoverClock) {
  const s = { open: false, hovered: false, focused: false, hovers: 0 }
  let delay: unknown
  const runDelay = (opening: boolean) => {
    if (delay !== undefined) clock.clear(delay)
    delay = undefined
    const cb = () => { if (opening === (s.hovered || s.focused)) s.open = opening }
    if (opening) cb() // open-delay 0
    else delay = clock.set(cb, 250)
  }
  const activator = {
    onClick: () => { s.open = !s.open },
    onMouseenter: () => { s.hovers++; s.hovered = true; runDelay(true) },
    onMouseleave: () => { s.hovered = false; runDelay(false) },
    onFocus: (e: any) => { if (!e.focusVisible) return; s.focused = true; runDelay(true) },
    onBlur: () => { s.focused = false; runDelay(false) },
    'aria-haspopup': 'menu',
  }
  /** The list's own hover events, which keep the menu open while the pointer is in it. */
  const content = {
    enter: () => { s.hovered = true; runDelay(true) },
    leave: () => { s.hovered = false; runDelay(false) },
  }
  /** The button, which says whether its menu is open as Vuetify renders it. */
  const button = { getAttribute: (name: string) => (name === 'aria-expanded' ? String(s.open) : null) }
  const ev = (extra: Record<string, unknown> = {}) => ({ currentTarget: button, stopPropagation() {}, ...extra }) as unknown as Event
  return { s, activator, content, ev }
}

describe('the hover wait of a top-bar menu (#923)', () => {
  it('opens the menu once the pointer has rested for the wait', () => {
    const { clock, tick } = manualClock()
    const m = vuetifyMenu(clock)
    const props = hoverOpenGate(100, clock).wrap(m.activator)
    props.onMouseenter(m.ev())
    tick(99)
    expect(m.s.open).toBe(false)
    tick(1)
    expect(m.s.open).toBe(true)
  })

  it('a menu clicked open and closed with Escape within the wait stays closed', () => {
    const { clock, tick, pending } = manualClock()
    const m = vuetifyMenu(clock)
    const props = hoverOpenGate(100, clock).wrap(m.activator)
    props.onMouseenter(m.ev())
    props.onClick(m.ev())
    expect(m.s.open).toBe(true)
    m.s.open = false // Escape: Vuetify closes the menu itself
    tick(1000)
    expect(m.s.open).toBe(false)
    expect(pending()).toBe(0)
  })

  it('a second click within the wait closes it for good', () => {
    const { clock, tick } = manualClock()
    const m = vuetifyMenu(clock)
    const props = hoverOpenGate(100, clock).wrap(m.activator)
    props.onMouseenter(m.ev())
    props.onClick(m.ev())
    tick(40)
    props.onClick(m.ev())
    tick(1000)
    expect(m.s.open).toBe(false)
  })

  // #925's nightly: every menu opened by a click closed 250 ms later, under the pointer on its way to an entry.
  it('a menu clicked open stays open while the pointer goes from the button to an entry', () => {
    const { clock, tick } = manualClock()
    const m = vuetifyMenu(clock)
    const props = hoverOpenGate(100, clock).wrap(m.activator)
    props.onMouseenter(m.ev())
    props.onFocus(m.ev({ focusVisible: false })) // the mousedown focuses the button
    props.onClick(m.ev())
    expect(m.s.open).toBe(true)
    expect(m.s.hovers).toBe(1) // Vuetify knows the pointer is on the button
    props.onBlur(m.ev()) // the focus goes into the list
    tick(1000)
    expect(m.s.open).toBe(true)
    props.onMouseleave(m.ev())
    tick(30)
    m.content.enter()
    tick(1000)
    expect(m.s.open).toBe(true)
  })

  // The walk's exact path: an entry of the menu clicked, the pointer back on the button, the menu clicked open again.
  it('a menu clicked open right after the pointer left its list is not closed by the list\'s close timer', () => {
    const { clock, tick } = manualClock()
    const m = vuetifyMenu(clock)
    const props = hoverOpenGate(100, clock).wrap(m.activator)
    m.s.open = true
    m.content.enter()
    m.s.open = false // the entry's click closes the menu
    m.content.leave() // the pointer leaves the list on its way back: Vuetify's close timer, 250 ms
    tick(20)
    props.onMouseenter(m.ev())
    props.onClick(m.ev())
    expect(m.s.open).toBe(true)
    tick(1000)
    expect(m.s.open).toBe(true)
  })

  it('a click within the wait on a menu already open closes it, and nothing reopens it', () => {
    const { clock, tick } = manualClock()
    const m = vuetifyMenu(clock)
    const props = hoverOpenGate(100, clock).wrap(m.activator)
    props.onFocus(m.ev({ focusVisible: true })) // keyboard
    tick(100)
    expect(m.s.open).toBe(true)
    props.onMouseenter(m.ev())
    props.onClick(m.ev())
    tick(1000)
    expect(m.s.open).toBe(false)
  })

  it('leaving the button, or its blur, within the wait opens nothing', () => {
    const { clock, tick } = manualClock()
    const m = vuetifyMenu(clock)
    const props = hoverOpenGate(100, clock).wrap(m.activator)
    props.onMouseenter(m.ev())
    tick(50)
    props.onMouseleave(m.ev())
    props.onFocus(m.ev({ focusVisible: true }))
    tick(50)
    props.onBlur(m.ev())
    tick(1000)
    expect(m.s.open).toBe(false)
    expect(m.s.hovers).toBe(0)
  })

  it('moving to the next button waits for that one alone, and hands Vuetify the event it was given', () => {
    const { clock, tick } = manualClock()
    const first = vuetifyMenu(clock)
    const second = vuetifyMenu(clock)
    const gate = hoverOpenGate(100, clock)
    const seen: Event[] = []
    const a = gate.wrap(first.activator)
    const b = gate.wrap({ ...second.activator, onMouseenter: (e: Event) => { seen.push(e); second.activator.onMouseenter() } })
    a.onMouseenter(first.ev())
    tick(60)
    a.onMouseleave(first.ev())
    const entered = second.ev()
    b.onMouseenter(entered)
    tick(100)
    expect(first.s.open).toBe(false)
    expect(second.s.open).toBe(true)
    expect(seen.length).toBe(1)
    expect(seen[0]).toBe(entered)
  })

  it('keeps the props it does not handle, and cancel drops what is pending', () => {
    const { clock, tick } = manualClock()
    const m = vuetifyMenu(clock)
    const gate = hoverOpenGate(100, clock)
    const props = gate.wrap(m.activator)
    expect(props['aria-haspopup']).toBe('menu')
    props.onMouseenter(m.ev())
    props.onFocus(m.ev({ focusVisible: true }))
    gate.cancel()
    tick(1000)
    expect(m.s.open).toBe(false)
  })
})
