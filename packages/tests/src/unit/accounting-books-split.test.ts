import { describe, it, expect } from 'bun:test'
import { ownerOf, ownsEntry, planMonth } from 'services/biz/accounting-books/journal-plan'
import { ContactIndex, matchRank } from 'services/biz/accounting-books/contact-match'
import { itemOfRow, paramsOfRow, parseAnalyticsFile } from 'services/biz/accounting-books/plusminus-exports'
import {
  compareTrialBalance,
  sumAnalyticTrialBalances,
  sumMainBooks,
  sumTrialBalances,
} from 'services/biz/accounting-books/compare'
import type { AnalyticBalanceRow, MainBookAccount, TrialBalanceRow } from 'services/biz/accounting-books/books-ledger'
import type { ImportDocument } from 'services/biz/accounting-books/import.types'

/** FR-25 R7: the pure parts of a split. Fictional ids, numbers and names only. */

const HOME = 'home'
const STORE = 'store'

describe('who holds an entry', () => {
  // [self, home, the store the entry's number names (none: no store's series), holds it?]
  const TABLE: [string, string | undefined, string | undefined, boolean][] = [
    // The home: its own series' sales, and everything no store's series names.
    [HOME, HOME, HOME, true],
    [HOME, HOME, STORE, false],
    [HOME, HOME, undefined, true],
    // A store: only its own series' sales.
    [STORE, HOME, STORE, true],
    [STORE, HOME, HOME, false],
    [STORE, HOME, undefined, false],
    // No split: a books org holds whatever it is sent, its stores' sales included.
    [HOME, undefined, HOME, true],
    [HOME, undefined, STORE, true],
    [HOME, undefined, undefined, true],
  ]

  for (const [self, home, branch, holds] of TABLE) {
    it(`${self} ${holds ? 'holds' : 'does not hold'} an entry of ${branch ?? 'no store'}${home ? `, home ${home}` : ', no split'}`, () => {
      expect(ownsEntry(self, home, branch)).toBe(holds)
    })
  }

  it('the owner is the store a series names, else the home', () => {
    expect(ownerOf(HOME, STORE)).toBe(STORE)
    expect(ownerOf(HOME, undefined)).toBe(HOME)
  })

  const branches = [{ orgId: HOME, docSeries: ['00001'] }, { orgId: STORE, docSeries: ['00002'] }]
  const month: ImportDocument[] = [
    { date: '2025-03-03', docType: '-ФЕ', docNumber: '0000100001', ops: [{ d: '411', k: '702', amount: 1 }] },
    { date: '2025-03-03', docType: '-ФЕ', docNumber: '0000200001', ops: [{ d: '411', k: '702', amount: 2 }] },
    // A purchase whose number happens to start like a store's: only a sales document is a store's.
    { date: '2025-03-04', docType: '+ФЕ', docNumber: '0000200009', ops: [{ d: '304', k: '401', amount: 3 }] },
    { date: '2025-03-05', ops: [{ d: '4532', k: '4539', amount: 4 }] },
    { date: '2025-03-05', ops: [{ d: '4532', k: '4539', amount: 5 }] },
  ]

  it('a planned month says who holds each entry, and keys it exactly as the whole month would', () => {
    const whole = planMonth(month, branches)
    const split = planMonth(month, branches, HOME)
    expect(split.map(p => p.ownerOrgId)).toEqual([HOME, STORE, HOME, HOME, HOME])
    expect(split.map(p => p.importKey)).toEqual(whole.map(p => p.importKey))
    expect(split.map(p => p.contentHash)).toEqual(whole.map(p => p.contentHash))
    // The second operation of the same kind that day keeps its place in the FILE, whoever holds the first.
    expect(split[4].importKey.endsWith('#2')).toBe(true)
    expect(whole.every(p => p.ownerOrgId === undefined)).toBe(true)
  })
})

describe('which contact a partner analytic finds', () => {
  const index = (split: boolean, ...contacts: [string, string, { taxId?: string; vatNumber?: string; companyName?: string }][]) => {
    const i = new ContactIndex<string>(split)
    for (const [id, type, keys] of contacts) i.add(id, { type, ...keys })
    return i
  }

  it('in a books org of its own: the partner\'s own type only, and the last one held wins, as before', () => {
    const held = index(false, ['c1', 'customer', { taxId: '1' }], ['b1', 'both', { taxId: '1' }], ['c2', 'customer', { taxId: '1' }])
    expect(held.find({ type: 'customer', taxId: '1' })).toBe('c2')
    expect(held.find({ type: 'supplier', taxId: '1' })).toBeUndefined()
    expect(held.find({ type: 'both', taxId: '1' })).toBe('b1')
  })

  it('in a split: a customer finds a customer first, else someone who both buys and sells', () => {
    expect(index(true, ['b', 'both', { taxId: '1' }], ['c', 'customer', { taxId: '1' }]).find({ type: 'customer', taxId: '1' })).toBe('c')
    expect(index(true, ['b', 'both', { taxId: '1' }]).find({ type: 'customer', taxId: '1' })).toBe('b')
    expect(index(true, ['s', 'supplier', { taxId: '1' }]).find({ type: 'customer', taxId: '1' })).toBeUndefined()
  })

  it('in a split: a supplier finds a supplier or a `both`, never a customer', () => {
    expect(index(true, ['b', 'both', { taxId: '1' }]).find({ type: 'supplier', taxId: '1' })).toBe('b')
    expect(index(true, ['c', 'customer', { taxId: '1' }]).find({ type: 'supplier', taxId: '1' })).toBeUndefined()
  })

  it('in a split: a partner finds anyone, a `both` first', () => {
    expect(index(true, ['c', 'customer', { taxId: '1' }]).find({ type: 'both', taxId: '1' })).toBe('c')
    expect(index(true, ['c', 'customer', { taxId: '1' }], ['b', 'both', { taxId: '1' }], ['s', 'supplier', { taxId: '1' }]).find({ type: 'both', taxId: '1' })).toBe('b')
  })

  it('looks up by the partner\'s first identifier only: never its name when it has a number', () => {
    const held = index(true, ['n', 'customer', { companyName: 'Едно' }], ['v', 'customer', { vatNumber: 'BG2' }])
    expect(held.find({ type: 'customer', taxId: '9', companyName: 'Едно' })).toBeUndefined()
    expect(held.find({ type: 'customer', companyName: 'Едно' })).toBe('n')
    expect(held.find({ type: 'customer', vatNumber: 'BG2', companyName: 'Друго' })).toBe('v')
    expect(held.find({ type: 'customer' })).toBeUndefined()
  })

  it('ranks a stand-in after the type itself, and never in a books org of its own', () => {
    expect([matchRank('customer', 'customer', true), matchRank('customer', 'both', true), matchRank('customer', 'supplier', true)]).toEqual([0, 1, undefined])
    expect(matchRank('customer', 'both', false)).toBeUndefined()
  })
})

describe('an analytic\'s properties', () => {
  const rows = [
    { ap: 'КЛИЕНТИ:Фирма', params: { 'БУЛСТАТ': ' 000000011 ', 'ИНДДС': 'BG000000011', 'Адрес': 'ул. Една 2', 'град': 'гр. Някъде', 'Телефон': '000', 'МОЛ': 'Лице', 'ТАР.КОД': 'x' } },
    { ap: 'ДОСТАВЧИЦИ:Друга', params: { 'ИН ПО ДДС': 'BG000000022' } },
    { ap: 'СТОКИ:БОЛТОВЕ', params: { 'МЯРКА': 'бр' } },
    { ap: 'БАНКОВИ СМЕТКИ:XX00', params: { 'Банка': 'Банка' }, currency: 'true' },
  ]

  it('are a list of pairs in file order, a name with a dot kept whole', () => {
    expect(paramsOfRow(rows[0].params).map(p => p.key)).toEqual(['БУЛСТАТ', 'ИНДДС', 'Адрес', 'град', 'Телефон', 'МОЛ', 'ТАР.КОД'])
    expect(paramsOfRow(rows[0].params)[0].value).toBe('000000011')
    expect(paramsOfRow(undefined)).toEqual([])
  })

  it('read back from what an analytic keeps, say what the file\'s parser says', () => {
    const parsed = parseAnalyticsFile(new TextEncoder().encode(JSON.stringify(rows)))
    // The parser keeps the properties on the item too (`params`): one reading, the same pairs.
    expect(parsed.map(({ foreignCurrency: _f, params: _p, ...item }) => item)).toEqual(rows.map(r => itemOfRow(r.ap, paramsOfRow(r.params))))
    expect(parsed.map(item => item.params)).toEqual(rows.map(r => paramsOfRow(r.params)))
    const { params: _first, ...first } = parsed[0]
    expect(first).toEqual({ path: 'КЛИЕНТИ:Фирма', taxId: '000000011', vatNumber: 'BG000000011', address: 'ул. Една 2', city: 'Някъде', phone: '000', contactPerson: 'Лице' })
    expect(parsed[1]).toMatchObject({ taxId: '000000022', vatNumber: 'BG000000022' })
    expect(parsed[3]).toMatchObject({ bankName: 'Банка', foreignCurrency: true })
  })
})

describe('the group\'s books, added up for the gate', () => {
  const columns = (o: Partial<TrialBalanceRow>) => ({ openingDebit: 0, openingCredit: 0, turnoverDebit: 0, turnoverCredit: 0, closingDebit: 0, closingCredit: 0, ...o })
  const row = (code: string, o: Partial<TrialBalanceRow>): TrialBalanceRow => ({ accountId: `id-${code}`, code, name: code, ...columns(o) })

  it('adds turnovers per side, and balances as nets on the side of their sign', () => {
    const home = [row('411', { openingDebit: 100, turnoverDebit: 50, turnoverCredit: 20, closingDebit: 130 }), row('702', { turnoverCredit: 10, closingCredit: 10 })]
    const store = [row('411', { openingCredit: 30, turnoverDebit: 5, closingCredit: 25 }), row('4532', { turnoverCredit: 2, closingCredit: 2 })]
    const sum = sumTrialBalances([home, store])
    expect(sum.map(r => r.code)).toEqual(['411', '4532', '702'])
    expect(sum[0]).toMatchObject({ openingDebit: 70, openingCredit: 0, turnoverDebit: 55, turnoverCredit: 20, closingDebit: 105, closingCredit: 0 })
    // A net that changes side lands on the other side, as one company's print shows it.
    expect(sumTrialBalances([[row('401', { closingDebit: 5 })], [row('401', { closingCredit: 8 })]])[0]).toMatchObject({ closingDebit: 0, closingCredit: 3 })
    // Equal to the company's print, cell by cell.
    const print = [{ code: '411', ...columns({ openingDebit: 70, turnoverDebit: 55, turnoverCredit: 20, closingDebit: 105 }) }, { code: '702', ...columns({ turnoverCredit: 10, closingCredit: 10 }) }, { code: '4532', ...columns({ turnoverCredit: 2, closingCredit: 2 }) }]
    expect(compareTrialBalance(print as any, sum).differingCells).toBe(0)
  })

  it('adds an analytic\'s shares by path, quantities too', () => {
    const a = (path: string, o: Partial<AnalyticBalanceRow>): AnalyticBalanceRow => ({
      analyticId: `id-${path}`, path, ...columns({}), openingQuantity: 0, turnoverDebitQuantity: 0, turnoverCreditQuantity: 0, closingQuantity: 0, ...o,
    })
    const sum = sumAnalyticTrialBalances([
      [a('СТОКИ:А', { unit: 'бр', openingDebit: 10, openingQuantity: 5, turnoverCredit: 4, turnoverCreditQuantity: 2, closingDebit: 6, closingQuantity: 3 })],
      [a('СТОКИ:А', { turnoverCredit: 2, turnoverCreditQuantity: 1, closingCredit: 2, closingQuantity: -1 }), a('КЛИЕНТИ:Б', { turnoverDebit: 1, closingDebit: 1 })],
    ])
    expect(sum.map(r => r.path)).toEqual(['КЛИЕНТИ:Б', 'СТОКИ:А'])
    expect(sum[1]).toMatchObject({ unit: 'бр', openingDebit: 10, turnoverCredit: 6, closingDebit: 4, openingQuantity: 5, turnoverCreditQuantity: 3, closingQuantity: 2 })
  })

  it('adds a main book\'s correspondents per account', () => {
    const m = (code: string, counters: MainBookAccount['counters'], o: Partial<TrialBalanceRow> = {}): MainBookAccount => ({ ...row(code, o), counters })
    const sum = sumMainBooks([
      [m('702', [{ code: '411', name: '411', debit: 0, credit: 100 }, { code: '304', name: '304', debit: 60, credit: 0 }], { turnoverDebit: 60, turnoverCredit: 100, closingCredit: 40 })],
      [m('702', [{ code: '411', name: '411', debit: 0, credit: 20 }], { turnoverCredit: 20, closingCredit: 20 })],
    ])
    expect(sum).toHaveLength(1)
    expect(sum[0]).toMatchObject({ code: '702', turnoverDebit: 60, turnoverCredit: 120, closingCredit: 60 })
    expect(sum[0].counters).toEqual([{ code: '304', name: '304', debit: 60, credit: 0 }, { code: '411', name: '411', debit: 0, credit: 120 }])
  })

  it('one org is its own sum', () => {
    const only = [row('411', { openingDebit: 1, closingDebit: 1 })]
    expect(sumTrialBalances([only])).toEqual(only)
  })
})
