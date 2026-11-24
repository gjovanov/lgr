import { describe, it, expect } from 'bun:test'
import { hoverOpenGate, type HoverClock } from '../../../ui-shared/src/composables/hover-open'

/**
 * #923: a top-bar menu closed within the hover wait (Escape, a second click) opened again by itself.
 *
 * Vuetify's own open-delay timer, started by the mouseenter, fired after the close. `hover-open.ts` keeps that wait
 * instead, and a click, leaving the button or its blur cancels it. The activator below stands for Vuetify's: a click
 * toggles the menu, a hover that reaches it opens it.
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
    now += ms
    for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at > now) continue
      timers.delete(id)
      t.run()
    }
  }
  return { clock, tick, pending: () => timers.size }
}

function menu() {
  const state = { open: false, hovers: 0 }
  const activator = {
    onClick: () => { state.open = !state.open },
    onMouseenter: () => { state.hovers++; state.open = true },
    onFocus: () => { state.open = true },
    onMouseleave: () => {},
    onBlur: () => {},
    'aria-haspopup': 'menu',
  }
  return { state, activator }
}

const ev = () => ({}) as Event

describe('the hover wait of a top-bar menu (#923)', () => {
  it('opens the menu once the pointer has rested for the wait', () => {
    const { clock, tick } = manualClock()
    const { state, activator } = menu()
    const props = hoverOpenGate(100, clock).wrap(activator)
    props.onMouseenter(ev())
    tick(99)
    expect(state.open).toBe(false)
    tick(1)
    expect(state.open).toBe(true)
  })

  it('a menu clicked open and closed with Escape within the wait stays closed', () => {
    const { clock, tick, pending } = manualClock()
    const { state, activator } = menu()
    const props = hoverOpenGate(100, clock).wrap(activator)
    props.onMouseenter(ev())
    props.onClick(ev())
    expect(state.open).toBe(true)
    state.open = false // Escape: Vuetify closes the menu itself
    tick(500)
    expect(state.open).toBe(false)
    expect(state.hovers).toBe(0)
    expect(pending()).toBe(0)
  })

  it('a second click within the wait closes it for good', () => {
    const { clock, tick } = manualClock()
    const { state, activator } = menu()
    const props = hoverOpenGate(100, clock).wrap(activator)
    props.onMouseenter(ev())
    props.onClick(ev())
    tick(40)
    props.onClick(ev())
    tick(500)
    expect(state.open).toBe(false)
  })

  it('leaving the button, or its blur, within the wait opens nothing', () => {
    const { clock, tick } = manualClock()
    const { state, activator } = menu()
    const props = hoverOpenGate(100, clock).wrap(activator)
    props.onMouseenter(ev())
    tick(50)
    props.onMouseleave(ev())
    props.onFocus(ev())
    tick(50)
    props.onBlur(ev())
    tick(500)
    expect(state.open).toBe(false)
  })

  it('moving to the next button waits for that one alone, and hands Vuetify the event it was given', () => {
    const { clock, tick } = manualClock()
    const first = menu()
    const second = menu()
    const gate = hoverOpenGate(100, clock)
    const seen: Event[] = []
    const a = gate.wrap(first.activator)
    const b = gate.wrap({ ...second.activator, onMouseenter: (e: Event) => { seen.push(e); second.activator.onMouseenter() } })
    a.onMouseenter(ev())
    tick(60)
    const entered = ev()
    b.onMouseenter(entered)
    tick(100)
    expect(first.state.open).toBe(false)
    expect(second.state.open).toBe(true)
    expect(seen).toEqual([entered])
    expect(seen[0]).toBe(entered)
  })

  it('keeps the props it does not handle, and cancel drops what is pending', () => {
    const { clock, tick } = manualClock()
    const { state, activator } = menu()
    const gate = hoverOpenGate(100, clock)
    const props = gate.wrap(activator)
    expect(props['aria-haspopup']).toBe('menu')
    props.onMouseenter(ev())
    gate.cancel()
    tick(500)
    expect(state.open).toBe(false)
  })
})
