import { describe, it, expect } from 'bun:test'
import { useFieldSearch } from 'ui-shared/composables/field-search'

// FR-33.12 (#933): Enter takes the first hit of what the field holds. The search behind both product fields
// (`ProductSearch`, `ProductLineDescription`), driven with a request the test answers by hand and a short pause.

const PAUSE = 5
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Past the pause: the request has gone. */
const pauseOver = () => sleep(PAUSE * 4)

/** A request the test answers by hand, which rejects as aborted when its signal is. */
function server() {
  const calls: { text: string; signal: AbortSignal; answer: (rows: string[]) => void; fail: (e: unknown) => void }[] = []
  const search = (signal: AbortSignal, text: string) => new Promise<string[]>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { name: 'CanceledError' })))
    calls.push({ text, signal, answer: resolve, fail: reject })
  })
  const last = (text: string) => {
    const call = [...calls].reverse().find((c) => c.text === text)
    if (!call) throw new Error(`no request for "${text}"`)
    return call
  }
  return { calls, search, last }
}

/** The field and the list it fills: `shown` is what the list holds, with the text it answers. */
function field(enterWaitMs?: number) {
  const s = server()
  const list = { shown: [] as string[], for: '' }
  const f = useFieldSearch<string[]>({
    search: s.search,
    onAnswer: (rows, text) => { list.shown = rows; list.for = text },
    minChars: 2,
    debounceMs: PAUSE,
    enterWaitMs,
  })
  return { s, list, f }
}

/** Whether a promise has settled yet, without waiting for it. */
async function settled<T>(p: Promise<T>): Promise<boolean> {
  let done = false
  void p.then(() => { done = true })
  await sleep(0)
  return done
}

describe('a late answer to an earlier text is dropped', () => {
  it('an answer that lands during the pause after a newer text is never shown', async () => {
    const { s, list, f } = field()
    f.input('bo')
    await pauseOver()
    expect(s.last('bo').signal.aborted).toBe(false)
    // "bolt" is typed: its pause runs, and the answer to "bo" lands meanwhile.
    f.input('bolt')
    s.last('bo').answer(['Bolt M8', 'Box'])
    await sleep(0)
    expect(list.shown).toEqual([])
    expect(f.answeredFor.value).toBe('')
    expect(f.answers('bo')).toBe(false)
    // "bolt"'s own answer is shown.
    await pauseOver()
    s.last('bolt').answer(['Bolt M8'])
    await sleep(0)
    expect(list).toEqual({ shown: ['Bolt M8'], for: 'bolt' })
    expect(f.answers('bolt')).toBe(true)
  })

  it('a slow answer to an earlier request loses to the newer one, whichever lands first (FR-31.4)', async () => {
    const { s, list, f } = field()
    f.input('bo')
    await pauseOver()
    f.input('bolt')
    await pauseOver()
    expect(s.last('bo').signal.aborted).toBe(true)
    s.last('bolt').answer(['Bolt M8'])
    await sleep(0)
    expect(list.for).toBe('bolt')
  })

  it('text too short drops what is on its way and what the list answered', async () => {
    const { s, list, f } = field()
    f.input('bolt')
    await pauseOver()
    s.last('bolt').answer(['Bolt M8'])
    await sleep(0)
    f.input('bolts')
    await pauseOver()
    expect(f.input('b')).toBe(false)
    expect(s.last('bolts').signal.aborted).toBe(true)
    expect(f.answeredFor.value).toBe('')
    expect(f.waiting.value).toBe(false)
    expect(f.loading.value).toBe(false)
    expect(list.for).toBe('bolt')
  })
})

describe('Enter takes only an answer to what the field holds', () => {
  it('the list already answers the text: Enter takes it at once', async () => {
    const { s, f } = field()
    f.input('bolt')
    await pauseOver()
    s.last('bolt').answer(['Bolt M8'])
    await sleep(0)
    expect(await f.enter('bolt')).toBe(true)
    expect(await f.enter(' bolt ')).toBe(true)
  })

  it('within the pause, with the first answer on screen, Enter waits for the answer to the second word', async () => {
    const { s, list, f } = field()
    f.input('bolt')
    await pauseOver()
    s.last('bolt').answer(['Bolt M8', 'Bolt M10'])
    await sleep(0)
    // A second word, and Enter at once: the list on screen is the first word's.
    f.input('bolt m10')
    expect(f.unanswered('bolt m10')).toBe(true)
    expect(f.waiting.value).toBe(true)
    let shownWhenTaken: string[] = []
    const took = f.enter('bolt m10').then((ok) => { shownWhenTaken = list.shown; return ok })
    expect(await settled(took)).toBe(false)
    await pauseOver()
    expect(await settled(took)).toBe(false)
    s.last('bolt m10').answer(['Bolt M10'])
    expect(await took).toBe(true)
    // Enter is released once the list holds the new answer: its first row is the second word's hit.
    expect(shownWhenTaken).toEqual(['Bolt M10'])
    expect(f.waiting.value).toBe(false)
  })

  it('a letter typed and taken back: the list answers the text again, and Enter takes it during the pause', async () => {
    const { s, f } = field()
    f.input('bolt')
    await pauseOver()
    s.last('bolt').answer(['Bolt M8'])
    await sleep(0)
    f.input('bolts')
    f.input('bolt')
    expect(f.waiting.value).toBe(false)
    expect(await f.enter('bolt')).toBe(true)
  })

  it('the text changes while Enter waits: Enter takes nothing', async () => {
    const { s, f } = field()
    f.input('bolt')
    const took = f.enter('bolt')
    f.input('bolts')
    expect(await took).toBe(false)
    // Emptied, too.
    const again = f.enter('bolts')
    f.input('')
    expect(await again).toBe(false)
    expect(s.calls).toEqual([])
  })

  it('the search fails while Enter waits: Enter takes nothing, and a later Enter on that text takes nothing either', async () => {
    const { s, f } = field()
    f.input('bolt')
    const took = f.enter('bolt')
    await pauseOver()
    s.last('bolt').fail(new Error('500'))
    expect(await took).toBe(false)
    expect(f.unanswered('bolt')).toBe(true)
    expect(f.waiting.value).toBe(false)
    expect(await f.enter('bolt')).toBe(false)
  })

  it('nothing on its way and nothing answering the text: Enter does not wait', async () => {
    const { f } = field()
    expect(await f.enter('bolt')).toBe(false)
    expect(await f.enter('b')).toBe(false)
  })

  it('Enter waits only so long: past the limit it takes nothing', async () => {
    const { f } = field(20)
    f.input('bolt')
    const took = f.enter('bolt')
    await sleep(60)
    expect(await settled(took)).toBe(true)
    expect(await took).toBe(false)
  })

  it('cancel(): what is on its way is dropped, and a waiting Enter takes nothing', async () => {
    const { s, f } = field()
    f.input('bolt')
    await pauseOver()
    const took = f.enter('bolt')
    f.cancel()
    expect(await took).toBe(false)
    expect(s.last('bolt').signal.aborted).toBe(true)
    expect(f.loading.value).toBe(false)
  })
})
