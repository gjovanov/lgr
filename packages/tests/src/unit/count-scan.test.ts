import { describe, it, expect } from 'bun:test'
import {
  SCAN_KEY_GAP_MS, SCAN_MIN_KEYS, decideCodeEnter, scanPace, textAfter, useCountScanner,
} from '../../../web/src/modules/inventory/composables/count-scan'
import type { PickedArticle } from '../../../web/src/modules/inventory/composables/count-lines'

/**
 * FR-33.11 (#933): a scanner on the stock count's entry line. Enter asks what the field's code names (FR-22.55's rule,
 * `GET /warehouse/product/lookup`): an exact code wins and is taken with no list, as a pick is, or shows its line when
 * the article is on the count (FR-33.7); otherwise a typed text is FR-33.12's first hit, and a scanned code that names
 * none or several leaves the list open. A scan is told by its pace, and Enters are taken in turn.
 */

const article = (id: string): PickedArticle => ({ _id: id, name: `Article ${id}`, sku: `SKU-${id}`, barcode: `380${id}`, unit: 'pcs' })

describe('what Enter does with the lookup\'s answer', () => {
  it('an exact code of an article new to the count adds it', () => {
    expect(decideCodeEnter(article('a'), true, ['b'])).toEqual({ kind: 'add', article: article('a') })
    // Typed by hand, an exact code wins all the same.
    expect(decideCodeEnter(article('a'), false, [])).toEqual({ kind: 'add', article: article('a') })
  })

  it('an exact code of an article already on the count shows its line', () => {
    expect(decideCodeEnter(article('b'), true, ['a', 'b'])).toEqual({ kind: 'show', article: article('b') })
    expect(decideCodeEnter(article('b'), false, ['b'])).toEqual({ kind: 'show', article: article('b') })
  })

  it('no code (none, or several hits): typed is FR-33.12\'s first hit, scanned leaves the list open', () => {
    expect(decideCodeEnter(null, false, ['a'])).toEqual({ kind: 'first-hit' })
    expect(decideCodeEnter(null, true, ['a'])).toEqual({ kind: 'list' })
  })

  it('takes only the code\'s own text out of the field', () => {
    expect(textAfter('3800001', '3800001')).toBe('')
    expect(textAfter('38000013800', '3800001')).toBe('3800')
    expect(textAfter('other', '3800001')).toBe('other')
  })
})

describe('a scan is told from typing by its pace', () => {
  function clock() {
    let t = 1000
    return { now: () => t, step: (ms: number) => { t += ms } }
  }
  function burst(pace: ReturnType<typeof scanPace>, c: ReturnType<typeof clock>, text: string, gap: number, fromEmpty = true) {
    for (let i = 0; i < text.length; i++) {
      if (i) c.step(gap)
      pace.key(fromEmpty && i === 0)
    }
  }

  it('a fast burst of the whole code, Enter right behind it, is a scan', () => {
    const c = clock()
    const pace = scanPace(c.now)
    burst(pace, c, '3800001', 8)
    c.step(5)
    expect(pace.enter('3800001')).toBe(true)
  })

  it('typing, a slow Enter, a short code, an edit or a paste is not', () => {
    const c = clock()
    const pace = scanPace(c.now)
    burst(pace, c, 'bolt m8', 120)
    expect(pace.enter('bolt m8')).toBe(false)

    burst(pace, c, '3800001', 8)
    c.step(SCAN_KEY_GAP_MS + 200)
    expect(pace.enter('3800001'), 'Enter long after the last key').toBe(false)

    burst(pace, c, 'abc'.slice(0, SCAN_MIN_KEYS - 1), 5)
    expect(pace.enter('abc'.slice(0, SCAN_MIN_KEYS - 1)), 'fewer keys than a scan').toBe(false)

    burst(pace, c, '3800001', 8)
    pace.edit()
    expect(pace.enter('3800001'), 'an edit').toBe(false)

    // Pasted: the field holds more than was typed.
    expect(pace.enter('3800001')).toBe(false)
  })

  it('a new burst starts in an empty field and after each Enter', () => {
    const c = clock()
    const pace = scanPace(c.now)
    burst(pace, c, 'xy', 300)
    c.step(2000)
    // The field was emptied, then scanned into.
    burst(pace, c, '3800001', 8, true)
    expect(pace.enter('3800001')).toBe(true)
    // The next scan, a while later, typed behind the first code still in the field.
    c.step(900)
    burst(pace, c, '3800002', 8, false)
    expect(pace.enter('3800002')).toBe(true)
  })
})

describe('Enters are taken in turn', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))
  function harness(answers: Record<string, PickedArticle | null>, onCount: string[] = []) {
    const state = { text: '' }
    const log: string[] = []
    const pending: Array<() => void> = []
    const scanner = useCountScanner({
      text: () => state.text,
      lookup: (code) => new Promise((resolve) => {
        log.push(`lookup ${code}`)
        pending.push(() => resolve(answers[code] ?? null))
      }),
      onCount: () => onCount,
      taken: (rest) => { log.push(`taken "${rest}"`); state.text = rest },
      add: (a) => { log.push(`add ${a._id}`) },
      firstHit: () => { log.push(`first-hit ${state.text}`) },
    })
    /** The turn waiting has started (it read the field and asked): its lookup answers. */
    const answer = async () => { await tick(); pending.shift()?.(); await tick() }
    return { state, log, scanner, answer }
  }

  it('an exact code is added, with the field cleared for a fresh entry line', async () => {
    const h = harness({ '3800001': article('a') })
    h.state.text = '3800001'
    const done = h.scanner.enter(true)
    await h.answer()
    expect(await done).toEqual({ kind: 'add', article: article('a') })
    expect(h.log).toEqual(['lookup 3800001', 'taken ""', 'add a'])
  })

  it('a code of an article on the count goes the same way: the count shows its line', async () => {
    const h = harness({ '3800001': article('a') }, ['a'])
    h.state.text = '3800001'
    const done = h.scanner.enter(true)
    await h.answer()
    expect((await done)?.kind).toBe('show')
    expect(h.log).toEqual(['lookup 3800001', 'taken ""', 'add a'])
  })

  it('a second scan typed during the first lookup waits, and finds just its own code', async () => {
    const h = harness({ '3800001': article('a'), '3800002': article('b') })
    h.state.text = '3800001'
    const first = h.scanner.enter(true)
    await tick()
    // The next scan lands behind the first code while it is looked up.
    h.state.text = '38000013800002'
    const second = h.scanner.enter(true)
    expect(h.scanner.busy()).toBe(true)
    await h.answer()
    await first
    await h.answer()
    await second
    expect(h.log).toEqual(['lookup 3800001', 'taken "3800002"', 'add a', 'lookup 3800002', 'taken ""', 'add b'])
    expect(h.scanner.busy()).toBe(false)
  })

  it('several hits: typed falls back to the first hit, while the field still holds the text', async () => {
    const h = harness({})
    h.state.text = 'bolt'
    const typed = h.scanner.enter(false)
    await h.answer()
    expect(await typed).toEqual({ kind: 'first-hit' })
    expect(h.log).toEqual(['lookup bolt', 'first-hit bolt'])

    // The text changed while the lookup was out: that Enter answered a text the field no longer holds.
    h.log.length = 0
    const stale = h.scanner.enter(false)
    await tick()
    h.state.text = 'bolt m8'
    await h.answer()
    await stale
    expect(h.log).toEqual(['lookup bolt'])
  })

  it('no code, scanned: nothing is taken and the list stays open on it', async () => {
    const h = harness({})
    h.state.text = '9999999'
    const done = h.scanner.enter(true)
    await h.answer()
    expect(await done).toEqual({ kind: 'list' })
    expect(h.log).toEqual(['lookup 9999999'])
    expect(h.state.text).toBe('9999999')
  })

  it('a failed lookup is a miss, and a field too short is no code', async () => {
    const calls: string[] = []
    const failing = useCountScanner({
      text: () => 'bolt', lookup: () => Promise.reject(new Error('offline')), onCount: () => [],
      taken: () => {}, add: () => {}, firstHit: () => { calls.push('first-hit') },
    })
    expect(await failing.enter(false)).toEqual({ kind: 'first-hit' })
    expect(calls).toEqual(['first-hit'])

    const h = harness({})
    h.state.text = ' a '
    expect(await h.scanner.enter(true)).toBeNull()
    expect(h.log).toEqual([])
  })
})
