import { describe, it, expect, afterAll, beforeAll } from 'bun:test'
import { Vue, settle, memoryStorage } from '../helpers/vue-harness'
import {
  chunks, countPayload, linesFromStock, lineNumbers, missingLevels, planAdditions, type CountLine,
} from '../../../web/src/modules/inventory/composables/count-lines'
import { useCountGridKeys } from '../../../web/src/modules/inventory/composables/count-grid-keys'

// The API modules read the org from the app store, which reads the browser's storage as it loads.
const storage = memoryStorage()
afterAll(() => storage.restore())
const { useCountArticles } = await import('../../../web/src/modules/inventory/composables/useCountArticles')

/**
 * FR-33.5 to .10 (#933, slice B-UI): the rules of a stock count's lines. One article, one line; System read for every
 * picked article from one stock answer; Counted starting at System; "Load products" on a count with lines adding only
 * what is missing; the entry line never in the payload; and the keyboard's walk over rows a virtual table has not drawn.
 */

const line = (id: string, system = 0, counted = system): CountLine => ({
  productId: id, productName: `Article ${id}`, productSku: `SKU-${id}`, productBarcode: '', systemQuantity: system, countedQuantity: counted, avgCost: 0,
})
const level = (id: string, quantity: number) => ({
  productId: id, warehouseId: 'w1', quantity, avgCost: 2, productSku: `SKU-${id}`, productName: `Article ${id}`, productUnit: 'pcs', warehouseName: 'Main',
})

describe('the count’s lines', () => {
  it('an article already on the count is not added again, from the search or from Details; the new ones keep the order picked', () => {
    const lines = [line('a'), line('b')]
    // The search: one article, already there.
    expect(planAdditions(lines, [{ _id: 'b' }])).toEqual({ fresh: [], already: ['b'] })
    // Details: ticked d, a, c, d again.
    const plan = planAdditions(lines, [{ _id: 'd' }, { _id: 'a' }, { _id: 'c' }, { _id: 'd' }])
    expect(plan.fresh.map((p) => p._id)).toEqual(['d', 'c'])
    expect(plan.already).toEqual(['a'])
  })

  it('System is the warehouse’s on-hand quantity, 0 with no level, and Counted starts at it', () => {
    const { lines, stocked } = linesFromStock(
      [{ _id: 'a', name: 'Bolt', sku: 'B-1', unit: 'pcs' }, { _id: 'b', name: 'Washer', sku: 'W-1' }],
      { a: [{ warehouseId: 'w1', warehouseName: 'Main', quantity: 12, availableQuantity: 10 }] },
    )
    expect(lines.map((l) => [l.productId, l.productName, l.productSku, l.systemQuantity, l.countedQuantity])).toEqual([
      ['a', 'Bolt', 'B-1', 12, 12],
      ['b', 'Washer', 'W-1', 0, 0],
    ])
    expect([...stocked]).toEqual(['a'])
  })

  it('"Load products" on a count with lines adds only the levels not on it, and the lines there keep what was typed (D-1)', () => {
    const lines = [line('a', 5, 3)]
    const added = missingLevels(lines, [level('a', 5), level('b', 7), level('b', 7), level('c', 0)])
    expect(added.map((l) => [l.productId, l.systemQuantity, l.countedQuantity])).toEqual([['b', 7, 7], ['c', 0, 0]])
    expect(lines).toEqual([line('a', 5, 3)])
  })

  it('a line’s number is its place in the count', () => {
    const numbers = lineNumbers([line('a'), line('b'), line('c')])
    expect([numbers.get('a'), numbers.get('c')]).toEqual([1, 3])
  })

  it('the payload has the count’s keys and each line’s four, and only the lines', () => {
    const payload = countPayload({ warehouseId: 'w1', date: '2026-11-25', type: 'partial', notes: '', lines: [line('a', 4, 4), line('b', 0, 50)] })
    expect(Object.keys(payload).sort()).toEqual(['date', 'itemCount', 'lines', 'notes', 'type', 'varianceCount', 'warehouseId'])
    expect(payload.lines.map((l) => Object.keys(l).sort())).toEqual([
      ['countedQuantity', 'productId', 'systemQuantity', 'variance'], ['countedQuantity', 'productId', 'systemQuantity', 'variance'],
    ])
    expect(payload.itemCount).toBe(2)
    expect(payload.varianceCount).toBe(1)
    expect(payload.lines[1]).toEqual({ productId: 'b', systemQuantity: 0, countedQuantity: 50, variance: 50 })
  })

  it('ids for the stock go in turns of a bounded size', () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
})

describe('what a pick does (useCountArticles)', () => {
  type Stock = Record<string, { warehouseId: string; warehouseName: string; quantity: number; availableQuantity: number }[]>

  function setup(start: CountLine[], stock: Stock | Error = {}) {
    const lines = Vue.reactive([...start]) as CountLine[]
    const revealed: string[] = []
    const requests: { ids: string[]; warehouseId?: string }[] = []
    const notStocked = new Set<string>()
    const units = new Map<string, string>()
    const articles = useCountArticles({
      lines: () => lines,
      warehouseId: () => 'w1',
      append: (added, stocked, unitsOf) => {
        lines.push(...added)
        for (const l of added) if (!stocked.has(l.productId)) notStocked.add(l.productId)
        for (const [id, u] of unitsOf) units.set(id, u)
      },
      reveal: (id) => { revealed.push(id) },
      lineNo: (id) => lines.findIndex((l) => l.productId === id) + 1,
      t: (key, values) => `${key} ${JSON.stringify(values)}`,
      stockOf: async (ids, warehouseId) => {
        requests.push({ ids, warehouseId })
        if (stock instanceof Error) throw stock
        return { stock }
      },
    })
    return { lines, revealed, requests, notStocked, units, articles }
  }

  it('three articles from Details make one stock request, and become three lines in the order ticked', async () => {
    const { lines, revealed, requests, notStocked, units, articles } = setup([line('p0', 1)], {
      p1: [{ warehouseId: 'w1', warehouseName: 'Main', quantity: 4, availableQuantity: 4 }],
    })
    await articles.addArticles([{ _id: 'p2', name: 'Two', unit: 'kg' }, { _id: 'p1', name: 'One', unit: 'pcs' }, { _id: 'p3', name: 'Three' }])
    expect(requests).toEqual([{ ids: ['p2', 'p1', 'p3'], warehouseId: 'w1' }])
    expect(lines.map((l) => [l.productId, l.systemQuantity, l.countedQuantity])).toEqual([['p0', 1, 1], ['p2', 0, 0], ['p1', 4, 4], ['p3', 0, 0]])
    expect([...notStocked].sort()).toEqual(['p2', 'p3'])
    expect(units.get('p2')).toBe('kg')
    expect(revealed).toEqual(['p2'])
    expect(articles.entryNote.value).toBe('warehouse.countLine.added {"n":3}')
  })

  it('past two hundred articles the ids go in turns, never one request per article', async () => {
    const { lines, requests, articles } = setup([])
    await articles.addArticles(Array.from({ length: 450 }, (_, i) => ({ _id: `p${i}` })))
    expect(requests.map((r) => r.ids.length)).toEqual([200, 200, 50])
    expect(lines).toHaveLength(450)
  })

  it('an article already on the count: no request, no second line; its line is shown, highlighted and named', async () => {
    const { lines, revealed, requests, articles } = setup([line('p0'), line('p1', 3, 2)])
    await articles.addArticles([{ _id: 'p1', name: 'One' }])
    expect(requests).toEqual([])
    expect(lines).toHaveLength(2)
    expect(lines[1].countedQuantity).toBe(2)
    expect(revealed).toEqual(['p1'])
    expect(articles.highlighted.value).toBe('p1')
    expect(articles.entryNote.value).toBe('warehouse.countLine.already {"n":2}')
  })

  it('Details with some already there says how many', async () => {
    const { lines, articles } = setup([line('p0')])
    await articles.addArticles([{ _id: 'p0' }, { _id: 'p5' }])
    expect(lines.map((l) => l.productId)).toEqual(['p0', 'p5'])
    expect(articles.entryNote.value).toBe('warehouse.countLine.addedSomeThere {"n":1,"m":1}')
  })

  it('no System, no line: a stock request that fails adds nothing', async () => {
    const { lines, articles } = setup([], new Error('down'))
    await articles.addArticles([{ _id: 'p9' }])
    await settle()
    expect(lines).toHaveLength(0)
  })
})

describe('the keyboard over a virtual table (useCountGridKeys)', () => {
  const g = globalThis as any
  const had = { CSS: g.CSS, raf: g.requestAnimationFrame }
  beforeAll(() => {
    g.CSS ??= { escape: (s: string) => s }
    g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0)
  })
  afterAll(() => { g.CSS = had.CSS; g.requestAnimationFrame = had.raf })

  /** A table that draws only the rows in `drawn`, and draws more when it is scrolled to an index. */
  function table(ids: string[], drawnFirst: number, drawnCount: number) {
    let first = drawnFirst
    const focused: string[] = []
    const scrolls: number[] = []
    const input = (id: string) => ({ disabled: false, focus: () => focused.push(id), scrollIntoView: () => {}, select: () => {} })
    const root = {
      querySelector: (sel: string) => {
        const id = /data-line-qty="([^"]+)"/.exec(sel)?.[1] ?? ''
        const at = ids.indexOf(id)
        return at >= first && at < first + drawnCount ? input(id) : null
      },
    }
    const field = (id: string) => ({ getAttribute: () => id })
    const target = (id: string) => ({
      closest: (sel: string) => (sel === '[data-line-qty]' ? field(id) : null),
      getAttribute: () => null,
    })
    let entry = 0
    const keys = useCountGridKeys({
      root: () => root as any,
      shown: () => ids.map((productId) => ({ productId })),
      virtual: () => true,
      scrollToIndex: (i) => { scrolls.push(i); first = Math.max(0, i - 2) },
      focusEntry: () => { entry++ },
    })
    const press = (id: string, key: string, shiftKey = false) => keys.onKeydown({ key, shiftKey, target: target(id), preventDefault: () => {} } as any)
    return { focused, scrolls, press, entries: () => entry }
  }

  it('Enter goes to the next line even when the table has not drawn it, and past the last line to the entry line', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `p${i}`)
    const t = table(ids, 0, 10)
    await t.press('p3', 'Enter')
    expect(t.focused).toEqual(['p4'])
    expect(t.scrolls).toEqual([])
    await t.press('p9', 'Enter')
    expect(t.focused.at(-1)).toBe('p10')
    expect(t.scrolls).toEqual([10])
    await t.press('p10', 'Enter', true)
    expect(t.focused.at(-1)).toBe('p9')
    await t.press('p49', 'Tab')
    expect(t.entries()).toBe(1)
  })
})
