import { describe, expect, it } from 'bun:test'
import { GroupCostBook, type CostBucket } from 'services/biz/accounting-books/group-cost'
import { differencesOf, spreadOf, type ComparedLine } from 'services/biz/accounting-books/shadow-compare'

/**
 * FR-25 R3, slice 3: the books' own cost of a goods group as of a sale (`costBasis: 'books'`), and the dry run's
 * self-check of a shadow posting against the accountant's entry. Made-up groups, days and amounts.
 */

const G = 'СТОКИ:ТЕСТ ГРУПА 1'
const move = (day: string, over: Partial<CostBucket>): CostBucket => ({
  path: G, day, opening: false, debit: 0, credit: 0, quantityDebit: 0, quantityCredit: 0, ...over,
})
/** A purchase of `qty` for `value`, and a sale of `qty` at `value`. */
const bought = (day: string, qty: number, value: number) => move(day, { debit: value, quantityDebit: qty })
const sold = (day: string, qty: number, value: number) => move(day, { credit: value, quantityCredit: qty })

describe('the books\' cost of a group as of a sale', () => {
  it('is the state at the START of the sale\'s day: the day\'s own purchases and sales do not count', () => {
    const book = new GroupCostBook([bought('2026-03-02', 10, 5), bought('2026-03-05', 10, 15), sold('2026-03-05', 5, 2.5)])
    expect(book.unitCostAt(G, '2026-03-03')).toBe(0.5)
    expect(book.unitCostAt(G, '2026-03-05')).toBe(0.5)
    // The next day reads the 5th whole: (5 + 15 − 2.5) / (10 + 10 − 5).
    expect(book.unitCostAt(G, '2026-03-06')).toBeCloseTo(17.5 / 15, 12)
  })

  it('starts from an imported opening, which counts on its own day and restates what came before', () => {
    const book = new GroupCostBook([
      bought('2025-12-20', 4, 400),
      move('2026-01-01', { opening: true, debit: 30, quantityDebit: 20 }),
      sold('2026-01-01', 2, 3),
    ], ['2026-01-01'])
    expect(book.unitCostAt(G, '2026-01-01')).toBe(1.5)
    // The sale at the books' own average leaves it where it was.
    expect(book.unitCostAt(G, '2026-01-02')).toBe(1.5)
  })

  it('keeps the last average while nothing is on hand, or less than nothing', () => {
    const book = new GroupCostBook([bought('2026-03-02', 4, 8), sold('2026-03-03', 4, 8), sold('2026-03-04', 2, 4)])
    expect(book.unitCostAt(G, '2026-03-04')).toBe(2)
    expect(book.unitCostAt(G, '2026-03-05')).toBe(2)
  })

  it('has none for a group the books never held before the day', () => {
    const book = new GroupCostBook([bought('2026-03-05', 1, 1)])
    expect(book.unitCostAt(G, '2026-03-04')).toBeUndefined()
    expect(book.unitCostAt(G, '2026-03-05')).toBeUndefined()
    expect(book.unitCostAt(G, '2026-03-06')).toBe(1)
    expect(book.unitCostAt('СТОКИ:ДРУГА', '2026-03-06')).toBeUndefined()
  })

  it('with a sale and never a purchase, takes the unit cost the books last sold it at', () => {
    const book = new GroupCostBook([sold('2026-03-02', 2, 3)])
    expect(book.unitCostAt(G, '2026-03-03')).toBe(1.5)
  })
})

const CUSTOMER = 'c1'
const OTHER_CUSTOMER = 'c2'
const G1 = 'g1'
const G2 = 'g2'
const op = (debit: string, credit: string, amount: number, over: { ad?: string; ak?: string; qty?: number } = {}): ComparedLine[] => [
  { account: debit, side: 'debit', amount, ...(over.ad ? { analyticId: over.ad } : {}), ...(over.qty !== undefined ? { quantity: over.qty } : {}) },
  { account: credit, side: 'credit', amount, ...(over.ak ? { analyticId: over.ak } : {}), ...(over.qty !== undefined ? { quantity: over.qty } : {}) },
]
/** A sale: cost per group, the goods' and the services' net and the VAT on the customer, the cash paid at issue. */
const sale = (over: { cost?: [string, number, number][]; goods?: number; services?: number; vat?: number; cash?: number; customer?: string } = {}) => [
  ...(over.cost ?? [[G1, 2, 1.5], [G2, 1, 4]]).flatMap(([group, qty, amount]) => op('702', '304', amount, { ak: group, qty })),
  ...op('411', '702', over.goods ?? 20, { ad: over.customer ?? CUSTOMER }),
  ...op('411', '703', over.services ?? 5, { ad: over.customer ?? CUSTOMER }),
  ...op('411', '4532', over.vat ?? 5, { ad: over.customer ?? CUSTOMER }),
  ...((over.cash ?? 30) ? op('501', '411', over.cash ?? 30, { ak: over.customer ?? CUSTOMER }) : []),
]
const places = (shadow: ComparedLine[], books: ComparedLine[]) => [...differencesOf(shadow, books).places].sort()

describe('the self-check: a shadow posting against the books\' entry', () => {
  it('is equal when every account, analytic and side agrees to the cent, however the operations are cut', () => {
    // The books carried the group's cost in two operations, and a rounding below the cent.
    const books = [...op('702', '304', 1, { ak: G1, qty: 1 }), ...op('702', '304', 0.5, { ak: G1, qty: 1 }), ...sale({ cost: [[G2, 1, 4.001]] })]
    expect(differencesOf(sale(), books)).toEqual({ places: new Set() })
  })

  it('names the revenue, the VAT and the cash by their totals', () => {
    expect(places(sale(), sale({ goods: 21, services: 4 }))).toEqual(['revenue'])
    expect(places(sale(), sale({ vat: 5.01 }))).toEqual(['vat'])
    expect(places(sale(), sale({ cash: 0 }))).toEqual(['cash'])
  })

  it('tells a product in another group from another average', () => {
    expect(differencesOf(sale(), sale({ cost: [[G1, 2, 1.6], [G2, 1, 4]] }))).toEqual({ places: new Set(['cost']), cost: 'average' })
    expect(differencesOf(sale(), sale({ cost: [[G1, 3, 5.5]] }))).toEqual({ places: new Set(['cost']), cost: 'groups' })
  })

  it('names another customer even when the money is the same', () => {
    expect(places(sale(), sale({ customer: OTHER_CUSTOMER }))).toEqual(['partner'])
  })

  it('names an account the sales rules do not book, and a customer total nothing else explains', () => {
    // An advance: the books take 2 of the goods' net to 412.
    expect(places(sale(), [...sale({ goods: 18 }), ...op('411', '412', 2, { ad: CUSTOMER })])).toEqual(['other', 'revenue'])
    // The same money on the customer, but 702 split over an analytic the posting never names.
    const split = sale().map(l => (l.account === '702' && l.side === 'credit' ? { ...l, analyticId: G1 } : l))
    expect(places(sale(), split)).toEqual(['other'])
  })

  it('puts a cost difference within half a percent, five percent, or more', () => {
    expect(spreadOf(100.4, 100)).toBe('within05')
    expect(spreadOf(-104, -100)).toBe('within5')
    expect(spreadOf(106, 100)).toBe('more')
    expect(spreadOf(0.5, 0)).toBe('more')
  })
})
