import { describe, it, expect } from 'bun:test'
// PURE module — reached by path like document-payload: `invoicing-ui` is a private app package.
import {
  BASE_CHOICE,
  choiceKeyOf,
  collectDocPriceChoices,
  mapLimit,
  optionForChoice,
  type PriceOptionLike,
} from '../../../invoicing-ui/src/composables/document-form/doc-price'
import { lineAmounts } from '../../../invoicing-ui/src/composables/document-form/document-payload'

/**
 * "One price for the whole document": the user picks a price NAME („Цена 3") once and every line
 * takes its own product's price of that name. The names come from the lines' own option lists
 * (`/pricing/options?all=true`), the same list each line's price picker shows.
 */

const base = (price: number): PriceOptionLike => ({ key: 'selling', name: 'Selling price', price, type: 'base' })
const tier = (i: number, name: string, price: number): PriceOptionLike => ({ key: `tier-${i}`, name, price, type: 'tier' })

describe('choiceKeyOf', () => {
  it('matches the base price by type — its server name is fixed English text', () => {
    expect(choiceKeyOf(base(10))).toBe(BASE_CHOICE)
  })

  it('matches every other price by its trimmed name', () => {
    expect(choiceKeyOf(tier(3, ' Цена 3 ', 1))).toBe('Цена 3')
  })
})

describe('collectDocPriceChoices', () => {
  it('offers base first, then names in first-seen order, counting the lines that carry each', () => {
    const choices = collectDocPriceChoices([
      [base(10), tier(0, 'Цена 1', 9), tier(1, 'Цена 2', 8)],
      [base(20), tier(1, 'Цена 2', 18)],
      [tier(0, 'Цена 1', 4), base(5)],
    ])
    expect(choices.map(c => [c.key, c.lines])).toEqual([
      [BASE_CHOICE, 3],
      ['Цена 1', 2],
      ['Цена 2', 2],
    ])
  })

  it('counts a name once per line even when a product lists it twice', () => {
    const choices = collectDocPriceChoices([
      [tier(3, 'Цена 3', 7), { key: 'tag-0', name: 'Цена 3', price: 6, type: 'tag' }],
    ])
    expect(choices).toEqual([{ key: 'Цена 3', name: 'Цена 3', type: 'tier', lines: 1 }])
  })

  it('is empty when no line has options', () => {
    expect(collectDocPriceChoices([])).toEqual([])
    expect(collectDocPriceChoices([[], []])).toEqual([])
  })
})

describe('optionForChoice', () => {
  const options = [base(10), { key: 'tag-0', name: 'Цена 3', price: 6, type: 'tag' }, tier(3, 'Цена 3', 7)]

  it("finds the line's own price of the chosen name", () => {
    expect(optionForChoice(options, BASE_CHOICE)?.price).toBe(10)
  })

  it('prefers the tier when a product offers the name twice', () => {
    expect(optionForChoice(options, 'Цена 3')?.key).toBe('tier-3')
  })

  it('is undefined when the product has no price of that name — the line keeps its own', () => {
    expect(optionForChoice(options, 'Цена 9')).toBeUndefined()
  })
})

describe('mapLimit', () => {
  it('keeps input order and never runs more than `limit` at once', async () => {
    let running = 0
    let peak = 0
    const out = await mapLimit([5, 1, 4, 2, 3, 0, 6], 3, async (n) => {
      running++
      peak = Math.max(peak, running)
      await new Promise(r => setTimeout(r, n))
      running--
      return n * 10
    })
    expect(out).toEqual([50, 10, 40, 20, 30, 0, 60])
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('handles an empty list', async () => {
    expect(await mapLimit([], 6, async (n: number) => n)).toEqual([])
  })
})

describe('line amount after discount', () => {
  it('the line value is qty × price less the discount — what the line column now shows', () => {
    const a = lineAmounts({ quantity: 4, unitPrice: 25, discount: 10, taxRate: 20 }, true)
    expect(a.net).toBe(100)
    expect(a.taxable).toBe(90)
    expect(a.total).toBeCloseTo(108, 10)
  })
})
