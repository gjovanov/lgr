import { describe, it, expect, afterAll } from 'bun:test'
import { latestOnly, isAbort } from 'ui-shared/composables/latest-only'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { flushPriceLookups, waitingPriceLookup, PRICE_LOOKUP_DELAY_MS } from 'ui-shared/composables/price-lookups'

// FR-31.4 (#796): the latest question wins.

/** A request the test answers by hand, which rejects as aborted when its signal is. */
function server<T>() {
  const calls: { arg: string; signal: AbortSignal; answer: (v: T) => void; fail: (e: unknown) => void }[] = []
  const fn = (signal: AbortSignal, arg: string) => new Promise<T>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' })))
    calls.push({ arg, signal, answer: resolve, fail: reject })
  })
  return { calls, fn }
}

describe('latestOnly', () => {
  it('delivers the answer to the latest call only, whatever order the answers come in', async () => {
    const s = server<string>()
    const search = latestOnly(s.fn)
    const first = search('bo')
    const second = search('bolt')
    s.calls[1].answer('bolt hits')
    expect(await second).toEqual({ latest: true, value: 'bolt hits' })
    s.calls[0].answer('bo hits')
    expect(await first).toEqual({ latest: false })
  })

  it('aborts the request a newer call replaces', async () => {
    const s = server<string>()
    const search = latestOnly(s.fn)
    const first = search('a')
    expect(s.calls[0].signal.aborted).toBe(false)
    const second = search('ab')
    expect(s.calls[0].signal.aborted).toBe(true)
    expect(s.calls[1].signal.aborted).toBe(false)
    expect(await first).toEqual({ latest: false })
    s.calls[1].answer('ab hits')
    expect(await second).toEqual({ latest: true, value: 'ab hits' })
  })

  it('drops the error of a call that was replaced, and passes on the error of the latest', async () => {
    const s = server<string>()
    const search = latestOnly(s.fn)
    const first = search('a')
    const second = search('ab')
    s.calls[0].fail(new Error('500'))
    expect(await first).toEqual({ latest: false })
    s.calls[1].fail(new Error('refused'))
    let caught: unknown
    try { await second } catch (e) { caught = e }
    expect((caught as Error).message).toBe('refused')
  })

  it('cancel() drops and aborts what is in flight; the next call is the latest again', async () => {
    const s = server<string>()
    const search = latestOnly(s.fn)
    const first = search('a')
    search.cancel()
    expect(s.calls[0].signal.aborted).toBe(true)
    expect(await first).toEqual({ latest: false })
    const next = search('b')
    s.calls[1].answer('b hits')
    expect(await next).toEqual({ latest: true, value: 'b hits' })
  })

  it('two wrappers never drop each other\'s answers', async () => {
    const s = server<string>()
    const a = latestOnly(s.fn)
    const b = latestOnly(s.fn)
    const pa = a('x')
    const pb = b('y')
    s.calls[0].answer('x hits')
    s.calls[1].answer('y hits')
    expect(await pa).toEqual({ latest: true, value: 'x hits' })
    expect(await pb).toEqual({ latest: true, value: 'y hits' })
  })

  it('isAbort knows the aborts of axios and of the platform (the HTTP client says nothing of an abort)', () => {
    expect(isAbort(Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' }))).toBe(true)
    expect(isAbort(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true)
    expect(isAbort(new Error('Request failed with status code 500'))).toBe(false)
    expect(isAbort(null)).toBe(false)
  })
})

describe('a list on usePaginatedTable: the latest request fills it', () => {
  const realGet = httpClient.get
  afterAll(() => { httpClient.get = realGet })

  /** The server, answering each list request when the test says so; an aborted one rejects as axios does. */
  function server() {
    const calls: { params: any; signal: AbortSignal; answer: (rows: any[]) => void; fail: (status: number) => void }[] = []
    httpClient.get = ((_url: string, cfg: any) => new Promise((resolve, reject) => {
      cfg.signal?.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' })))
      calls.push({
        params: cfg.params, signal: cfg.signal,
        answer: (rows) => resolve({ data: { movements: rows, total: rows.length, totalPages: 1 } }),
        fail: (status) => reject(Object.assign(new Error(`status ${status}`), { response: { status, data: {} } })),
      })
    })) as any
    return calls
  }

  it('a slow answer to an earlier page never replaces the rows of the current one, and says nothing', async () => {
    const calls = server()
    const t = usePaginatedTable({ url: '/org/o1/warehouse/movement', entityKey: 'movements' })
    const first = t.fetchItems()
    t.pagination.value.page = 1
    const second = t.fetchItems()
    expect(calls[0].signal.aborted).toBe(true)
    expect(calls[1].params.page).toBe(1)
    calls[1].answer([{ _id: 'page-2-row' }])
    await second
    expect(t.items.value.map((r: any) => r._id)).toEqual(['page-2-row'])
    expect(t.loading.value).toBe(false)
    // The aborted request's own rejection reaches no caller: `first` resolves quietly.
    await first
    expect(t.items.value.map((r: any) => r._id)).toEqual(['page-2-row'])
  })

  it('an error of a replaced request is dropped; the latest one\'s is passed on', async () => {
    const calls = server()
    const t = usePaginatedTable({ url: '/org/o1/warehouse/movement', entityKey: 'movements' })
    const first = t.fetchItems()
    const second = t.fetchItems()
    calls[0].fail(500)
    await first
    calls[1].fail(403)
    let caught: any
    try { await second } catch (e) { caught = e }
    expect(caught?.response?.status).toBe(403)
    expect(t.loading.value).toBe(false)
  })
})

describe('price lookups that wait for the quantity (FR-31.5)', () => {
  it('a waiting lookup runs at once when the field is left or the form saves, and only while it waits', async () => {
    let runs = 0
    const stop = waitingPriceLookup(async () => { runs++ })
    await flushPriceLookups()
    expect(runs).toBe(1)
    stop()
    await flushPriceLookups()
    expect(runs).toBe(1)
    expect(PRICE_LOOKUP_DELAY_MS).toBe(250)
  })
})
