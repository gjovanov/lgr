import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FIXED_ASSET_PARAMS,
  mapFixedAssetParams,
  monthsOfYears,
  readDate,
  readNumber,
  readTaxCategory,
} from 'services/biz/accounting-books/fixed-asset-params'

/**
 * FR-25a §4.2: a fixed asset from its `ДА` analytic's properties, row by row of the table the audit verified. Made-up
 * values throughout. What must hold beside the table: a value that cannot be read is a problem that leaves its fields
 * out, never an exception, and a term in years becomes months as `round(years × 12)`.
 */

const CHART = new Map([['201', 'acc-201'], ['204', 'acc-204'], ['2414', 'acc-2414'], ['603', 'acc-603']])

/** One asset as the file lists it: every property of the table, and some it does not map. */
const ASSET = [
  { key: 'СМЕТКА', value: '204' },
  { key: 'ДЕБИТ', value: '603' },
  { key: 'КРЕДИТ', value: '2414' },
  { key: 'МЕТОД', value: 'линеен' },
  { key: 'ДАТА', value: '15.03.2024' },
  { key: 'СТОЙНОСТ', value: '1200' },
  { key: 'ОБЩАСТОЙНОСТ', value: '1500' },
  { key: 'ПРОЦЕНТ', value: '15' },
  { key: 'СРОК', value: '6.6667' },
  { key: 'НАЧ.АМ.', value: '100.5' },
  { key: 'КАТ', value: '4' },
  { key: 'ДАТАЕКСП', value: '01.04.2024' },
  { key: 'ДАННОРМА', value: '30' },
  { key: 'ДАНСРОК', value: '3.3333' },
  { key: 'ДАНСТОЙН', value: '1500' },
  { key: 'ОБЩДАНАМ', value: '450' },
  { key: 'НАЧДАНАМ', value: '0' },
  { key: 'ПЕРДАНАМ', value: '2025' },
  { key: 'ОТПДАТА', value: '' },
  { key: 'ОТПДАП', value: '' },
  { key: 'НАЧИСЛ', value: '' },
  { key: 'ИНВ.N', value: 'X-1' },
]

/** The asset with some properties changed (`undefined` drops one). */
function asset(changes: Record<string, string | undefined> = {}) {
  const out = ASSET.filter(p => !(p.key in changes) || changes[p.key] !== undefined).map(p => (p.key in changes ? { key: p.key, value: changes[p.key]! } : p))
  for (const [key, value] of Object.entries(changes)) if (value !== undefined && !ASSET.some(p => p.key === key)) out.push({ key, value })
  return out
}

const map = (changes: Record<string, string | undefined> = {}) => mapFixedAssetParams(asset(changes), CHART)
const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))
const reasons = (r: ReturnType<typeof map>) => r.problems.map(p => `${p.key} ${p.reason}`)

describe('the whole asset', () => {
  it('maps every row of the table, and keeps every property', () => {
    const { fields, problems } = map()
    expect(problems).toEqual([])
    expect(fields).toEqual({
      accountId: 'acc-204',
      depreciationAccountId: 'acc-603',
      accumulatedDepAccountId: 'acc-2414',
      category: '204',
      depreciationMethod: 'straight_line',
      purchaseDate: day(2024, 3, 15),
      currency: 'EUR',
      purchasePrice: 1500,
      currentValue: 1399.5,
      usefulLifeMonths: 80,
      status: 'active',
      taxCategory: '4',
      inServiceDate: day(2024, 4, 1),
      taxDepreciationRate: 30,
      taxUsefulLifeMonths: 40,
      taxValue: 1500,
      params: ASSET,
    })
  })
})

describe('row by row', () => {
  it('СМЕТКА, ДЕБИТ, КРЕДИТ: the accounts of those codes; the category is the asset\'s own account', () => {
    const { fields } = map({ 'СМЕТКА': '201', 'ДЕБИТ': '603', 'КРЕДИТ': '2414' })
    expect(fields).toMatchObject({ accountId: 'acc-201', category: '201', depreciationAccountId: 'acc-603', accumulatedDepAccountId: 'acc-2414' })
    // A code with its name after it is still its code.
    expect(map({ 'СМЕТКА': ' 204 - Машини ' }).fields).toMatchObject({ accountId: 'acc-204', category: '204' })
  })

  it('МЕТОД: linear, however it is spelled; another method is not guessed at; none is missing', () => {
    for (const v of ['линеен', 'ЛИНЕЕН', 'Линеен метод', 'linear', 'straight_line']) expect(map({ 'МЕТОД': v }).fields.depreciationMethod).toBe('straight_line')
    const other = map({ 'МЕТОД': 'намаляващ' })
    expect(other.fields.depreciationMethod).toBeUndefined()
    expect(other.problems).toEqual([{ key: 'МЕТОД', reason: 'unknown_method', fields: ['depreciationMethod'], value: 'намаляващ' }])
    expect(reasons(map({ 'МЕТОД': '' }))).toEqual(['МЕТОД missing'])
  })

  it('ДАТА: DD.MM.YYYY at UTC midnight', () => {
    expect(map({ 'ДАТА': '31.12.2025' }).fields).toMatchObject({ purchaseDate: day(2025, 12, 31) })
    expect(map({ 'ДАТА': '01.01.2026' }).fields).toMatchObject({ purchaseDate: day(2026, 1, 1), purchasePrice: 1500 })
    const none = map({ 'ДАТА': '' })
    expect(none.fields.purchaseDate).toBeUndefined()
    expect(none.problems).toEqual([{ key: 'ДАТА', reason: 'missing', fields: ['purchaseDate'] }])
  })

  it('the currency is the register\'s at the changeover, not the purchase year\'s: lev only for an asset written off before it', () => {
    // Bought before the changeover and still in the register: PlusMinus converted it, so its properties are in EUR.
    expect(map({ 'ДАТА': '31.12.2025' }).fields.currency).toBe('EUR')
    expect(map({ 'ДАТА': '15.03.2019' }).fields.currency).toBe('EUR')
    // Bought after it: entered in EUR.
    expect(map({ 'ДАТА': '01.01.2026' }).fields.currency).toBe('EUR')
    // Written off before it: left the register unconverted, in lev.
    expect(map({ 'ОТПДАТА': '31.12.2025' }).fields.currency).toBe('BGN')
    expect(map({ 'ДАТА': '15.03.2019', 'ОТПДАТА': '30.06.2022' }).fields.currency).toBe('BGN')
    // Written off on or after it: it was in the register at the changeover.
    expect(map({ 'ОТПДАТА': '01.01.2026' }).fields.currency).toBe('EUR')
    // A purchase date that cannot be read does not decide it: the write-off does.
    expect(map({ 'ДАТА': '' }).fields.currency).toBe('EUR')
    // A write-off date that cannot be read leaves it unknown: an update keeps what the asset holds.
    const garbled = map({ 'ОТПДАТА': '32.13.2025' })
    expect(garbled.fields.currency).toBeUndefined()
    expect(garbled.problems).toContainEqual({ key: 'ОТПДАТА', reason: 'unreadable', fields: ['disposalDate', 'status', 'currency'], value: '32.13.2025' })
  })

  it('СТОЙНОСТ / ОБЩАСТОЙНОСТ: the value with later additions where there is one, else the value', () => {
    expect(map().fields.purchasePrice).toBe(1500)
    expect(map({ 'ОБЩАСТОЙНОСТ': '' }).fields.purchasePrice).toBe(1200)
    expect(map({ 'ОБЩАСТОЙНОСТ': undefined }).fields.purchasePrice).toBe(1200)
    // a total of 0 is no total
    expect(map({ 'ОБЩАСТОЙНОСТ': '0' }).fields.purchasePrice).toBe(1200)
    expect(map({ 'СТОЙНОСТ': '', 'ОБЩАСТОЙНОСТ': '' }).problems).toEqual([{ key: 'СТОЙНОСТ', reason: 'missing', fields: ['purchasePrice', 'currentValue'] }])
    // below the value: kept as the file says, and said
    const below = map({ 'ОБЩАСТОЙНОСТ': '1000' })
    expect(below.fields.purchasePrice).toBe(1000)
    expect(below.problems).toEqual([{ key: 'ОБЩАСТОЙНОСТ', reason: 'total_below_value', fields: [] }])
    // an unreadable total is never swapped for the value: the price is unknown
    const garbled = map({ 'ОБЩАСТОЙНОСТ': '1 5OO' })
    expect(garbled.fields.purchasePrice).toBeUndefined()
    expect(garbled.fields.currentValue).toBeUndefined()
    expect(garbled.problems).toEqual([{ key: 'ОБЩАСТОЙНОСТ', reason: 'unreadable', fields: ['purchasePrice', 'currentValue'], value: '1 5OO' }])
  })

  it('ПРОЦЕНТ, СРОК: the term is in years, `round(СРОК × 12)` months; the rate gives it where no term is stated', () => {
    expect(map({ 'СРОК': '10', 'ПРОЦЕНТ': '10' }).fields.usefulLifeMonths).toBe(120)
    expect(map({ 'СРОК': '2,5', 'ПРОЦЕНТ': '40' }).fields.usefulLifeMonths).toBe(30)
    expect(map({ 'СРОК': '' }).fields.usefulLifeMonths).toBe(80)
    expect(map({ 'СРОК': '', 'ПРОЦЕНТ': '' }).problems).toEqual([{ key: 'СРОК', reason: 'missing', fields: ['usefulLifeMonths'] }])
    // rate × term ≈ 100 on every asset: a term in months shows here
    const months = map({ 'СРОК': '80' })
    expect(months.fields.usefulLifeMonths).toBe(960)
    expect(months.problems).toEqual([{ key: 'СРОК', reason: 'rate_term_mismatch', fields: [] }])
  })

  it('НАЧ.АМ.: the book depreciation before the books start; the asset\'s value starts below it', () => {
    expect(map({ 'НАЧ.АМ.': '' }).fields.currentValue).toBe(1500)
    expect(map({ 'НАЧ.АМ.': '33,37', 'ОБЩАСТОЙНОСТ': '100.1', 'СТОЙНОСТ': '100.1' }).fields.currentValue).toBe(66.73)
    const above = map({ 'НАЧ.АМ.': '1600' })
    expect(above.fields.currentValue).toBe(-100)
    expect(above.problems).toEqual([{ key: 'НАЧ.АМ.', reason: 'opening_above_value', fields: [] }])
    const garbled = map({ 'НАЧ.АМ.': 'abc' })
    expect(garbled.fields.currentValue).toBeUndefined()
    expect(garbled.fields.purchasePrice).toBe(1500)
    expect(garbled.problems).toEqual([{ key: 'НАЧ.АМ.', reason: 'unreadable', fields: ['currentValue'], value: 'abc' }])
  })

  it('КАТ: the tax category 1–7, kept as its digit', () => {
    for (const [v, want] of [['1', '1'], ['7', '7'], [' 03 ', '3'], ['III', '3'], ['vii', '7'], ['5.0', '5']]) expect(map({ 'КАТ': v }).fields.taxCategory).toBe(want)
    expect(map({ 'КАТ': '' }).fields.taxCategory).toBeUndefined()
    expect(map({ 'КАТ': '' }).problems).toEqual([])
    expect(reasons(map({ 'КАТ': '8' }))).toEqual(['КАТ out_of_range'])
    expect(reasons(map({ 'КАТ': '2.5' }))).toEqual(['КАТ unreadable'])
    expect(reasons(map({ 'КАТ': 'x' }))).toEqual(['КАТ unreadable'])
  })

  it('ДАТАЕКСП: the in-service date', () => {
    expect(map({ 'ДАТАЕКСП': '2.5.2024' }).fields.inServiceDate).toEqual(day(2024, 5, 2))
    expect(map({ 'ДАТАЕКСП': '' }).fields).not.toHaveProperty('inServiceDate')
  })

  it('ДАННОРМА: the tax rate in percent, 0 to 100', () => {
    expect(map({ 'ДАННОРМА': '30%' }).fields.taxDepreciationRate).toBe(30)
    expect(map({ 'ДАННОРМА': '0' }).fields.taxDepreciationRate).toBe(0)
    const over = map({ 'ДАННОРМА': '150' })
    expect(over.fields.taxDepreciationRate).toBeUndefined()
    expect(over.problems).toEqual([{ key: 'ДАННОРМА', reason: 'out_of_range', fields: ['taxDepreciationRate'], value: '150' }])
  })

  it('ДАНСРОК: the tax term in years, `round(ДАНСРОК × 12)` months, checked against the tax rate', () => {
    expect(map({ 'ДАНСРОК': '6.6667', 'ДАННОРМА': '15' }).fields.taxUsefulLifeMonths).toBe(80)
    expect(map({ 'ДАНСРОК': '50', 'ДАННОРМА': '2' }).fields.taxUsefulLifeMonths).toBe(600)
    expect(reasons(map({ 'ДАНСРОК': '40' }))).toEqual(['ДАНСРОК rate_term_mismatch'])
    expect(reasons(map({ 'ДАНСРОК': '-1' }))).toEqual(['ДАНСРОК out_of_range'])
  })

  it('ДАНСТОЙН: the tax value', () => {
    expect(map({ 'ДАНСТОЙН': '1 499,99' }).fields.taxValue).toBe(1499.99)
  })

  it('ОБЩДАНАМ, НАЧДАНАМ, ПЕРДАНАМ, ОТПДАП: the tax schedule is kept in the properties only, whatever it holds', () => {
    const r = map({ 'ОБЩДАНАМ': 'не е число', 'НАЧДАНАМ': '?', 'ПЕРДАНАМ': '', 'ОТПДАП': '99.99.9999' })
    expect(r.problems).toEqual([])
    expect(r.fields).toEqual({ ...map().fields, params: asset({ 'ОБЩДАНАМ': 'не е число', 'НАЧДАНАМ': '?', 'ПЕРДАНАМ': '', 'ОТПДАП': '99.99.9999' }) })
  })

  it('ОТПДАТА: the write-off date, and the asset is disposed', () => {
    expect(map({ 'ОТПДАТА': '30.06.2025' }).fields).toMatchObject({ disposalDate: day(2025, 6, 30), status: 'disposed' })
    expect(map({ 'ОТПДАТА': '30.06.2025', 'НАЧИСЛ': 'НЕ' }).fields.status).toBe('disposed')
    // a date of zeros is no date
    expect(map({ 'ОТПДАТА': '00.00.0000' }).fields).toMatchObject({ status: 'active' })
    expect(map({ 'ОТПДАТА': '00.00.0000' }).fields).not.toHaveProperty('disposalDate')
    // unreadable: whether it was written off is unknown, so the status is too
    const garbled = map({ 'ОТПДАТА': '31.06.2025' })
    expect(garbled.fields).not.toHaveProperty('status')
    expect(garbled.problems).toEqual([{ key: 'ОТПДАТА', reason: 'unreadable', fields: ['disposalDate', 'status', 'currency'], value: '31.06.2025' }])
  })

  it('НАЧИСЛ: `НЕ` is an asset that is not depreciated', () => {
    for (const v of ['НЕ', 'не', ' Не ']) expect(map({ 'НАЧИСЛ': v }).fields.status).toBe('not_depreciated')
    for (const v of ['', 'ДА', 'да']) expect(map({ 'НАЧИСЛ': v }).fields.status).toBe('active')
    // nothing depreciated and no term: no useful life to speak of
    expect(map({ 'НАЧИСЛ': 'НЕ', 'СРОК': '', 'ПРОЦЕНТ': '' }).fields).toMatchObject({ status: 'not_depreciated', usefulLifeMonths: 0 })
    expect(map({ 'СРОК': '', 'ПРОЦЕНТ': '0' }).fields.usefulLifeMonths).toBe(0)
    const unknown = map({ 'НАЧИСЛ': 'може би' })
    expect(unknown.fields).not.toHaveProperty('status')
    expect(unknown.problems).toEqual([{ key: 'НАЧИСЛ', reason: 'unreadable', fields: ['status'], value: 'може би' }])
  })

  it('everything: the properties as the file lists them, in its order, empty ones included; one with no name is none', () => {
    const params = [{ key: 'Б', value: '2' }, { key: '  ', value: 'x' }, { key: 'А', value: '' }, { key: 'А.Б.', value: '1' }]
    expect(mapFixedAssetParams(params, CHART).fields.params).toEqual([{ key: 'Б', value: '2' }, { key: 'А', value: '' }, { key: 'А.Б.', value: '1' }])
  })
})

describe('reading what the file holds', () => {
  it('a number with a dot or a comma, spaces or no-break spaces between thousands, an exponent; empty and NaN are none', () => {
    const cases: [string | undefined, number | undefined][] = [
      ['1234.56', 1234.56], ['1234,56', 1234.56], ['1 234,56', 1234.56], ['1 234,56', 1234.56], ['1 234.5', 1234.5],
      ['1.234,56', 1234.56], ['1,234.56', 1234.56], ['1.234.567', 1234567], ['1,234,567.8', 1234567.8], ['12,5', 12.5],
      ['-12,5', -12.5], ['+3', 3], ['0', 0], ['-0', 0], ['.5', 0.5], ['1e-7', 1e-7], ['1,5e3', 1500], [' 42 ', 42],
      ['', undefined], ['   ', undefined], [undefined, undefined], ['NaN', undefined],
    ]
    for (const [raw, want] of cases) expect([raw, readNumber(raw).value]).toEqual([raw, want])
    for (const raw of ['abc', '1.2.3', '12.34,5', '1,2,3', '--5', ',', 'Infinity', '5 лв', '1-2']) expect([raw, readNumber(raw).bad]).toEqual([raw, 'unreadable'])
    expect(readNumber('15%', { percent: true }).value).toBe(15)
    expect(readNumber('15%').bad).toBe('unreadable')
  })

  it('a date as DD.MM.YYYY, D.M.YYYY or YYYY-MM-DD, at UTC midnight, a time after it ignored; zeros are none', () => {
    expect(readDate('01.02.2020').value).toEqual(day(2020, 2, 1))
    expect(readDate('1.2.2020').value).toEqual(day(2020, 2, 1))
    expect(readDate('29.02.2024').value).toEqual(day(2024, 2, 29))
    expect(readDate('01.02.2020 13:45:00').value).toEqual(day(2020, 2, 1))
    expect(readDate('2020-02-01').value).toEqual(day(2020, 2, 1))
    expect(readDate('01.02.2020').value!.toISOString()).toBe('2020-02-01T00:00:00.000Z')
    for (const raw of ['', '  ', undefined, '00.00.0000', '0000-00-00', '0']) expect(readDate(raw)).toEqual({})
    for (const raw of ['29.02.2023', '31.04.2024', '2020/02/01', '01-02-2020', 'вчера', '1.2.20']) expect([raw, readDate(raw).bad]).toEqual([raw, 'unreadable'])
    expect(readDate('01.01.1899').bad).toBe('out_of_range')
  })

  it('years as months: round(years × 12)', () => {
    expect([6.6667, 3.3333, 2.5, 12.5, 50, 0.0417, 1 / 24 - 0.001, 0].map(monthsOfYears)).toEqual([80, 40, 30, 150, 600, 1, 0, 0])
  })

  it('the tax category as I–VII or its digit', () => {
    expect(readTaxCategory('VI').value).toBe('6')
    expect(readTaxCategory('0').bad).toBe('out_of_range')
  })

  it('a property is found whatever its case or spaces', () => {
    const r = mapFixedAssetParams([...asset({ 'НАЧИСЛ': undefined, 'НАЧ.АМ.': undefined }), { key: 'Начисл', value: 'не' }, { key: 'НАЧ. АМ.', value: '500' }], CHART)
    expect(r.fields).toMatchObject({ status: 'not_depreciated', currentValue: 1000 })
  })
})

describe('what cannot be taken as booked', () => {
  it('a code the chart does not hold: that field and only it is left out, and the code is named', () => {
    const r = map({ 'СМЕТКА': '2049', 'КРЕДИТ': '9999' })
    expect(r.fields).not.toHaveProperty('accountId')
    expect(r.fields).not.toHaveProperty('category')
    expect(r.fields).not.toHaveProperty('accumulatedDepAccountId')
    expect(r.fields).toMatchObject({ depreciationAccountId: 'acc-603', purchasePrice: 1500, taxCategory: '4' })
    expect(r.problems).toEqual([
      { key: 'СМЕТКА', reason: 'unknown_account', fields: ['accountId', 'category'], code: '2049', value: '2049' },
      { key: 'КРЕДИТ', reason: 'unknown_account', fields: ['accumulatedDepAccountId'], code: '9999', value: '9999' },
    ])
  })

  it('an unreadable value leaves its own field out and names it; the rest of the asset is mapped', () => {
    const r = map({ 'ДАТАЕКСП': '31.02.2024' })
    expect(r.fields).not.toHaveProperty('inServiceDate')
    expect(r.fields).toEqual(Object.fromEntries(Object.entries({ ...map().fields, params: asset({ 'ДАТАЕКСП': '31.02.2024' }) }).filter(([k]) => k !== 'inServiceDate')))
    expect(r.problems).toEqual([{ key: 'ДАТАЕКСП', reason: 'unreadable', fields: ['inServiceDate'], value: '31.02.2024' }])
  })

  it('no properties: every required field is missing; only the status and the currency read from what is absent (no write-off: depreciated, in the register at the changeover)', () => {
    const r = mapFixedAssetParams([], CHART)
    expect(r.fields).toEqual({ status: 'active', currency: 'EUR' })
    expect(reasons(r)).toEqual(['СМЕТКА missing', 'ДЕБИТ missing', 'КРЕДИТ missing', 'МЕТОД missing', 'ДАТА missing', 'СТОЙНОСТ missing', 'СРОК missing'])
  })

  it('never throws, whatever it is given', () => {
    const junk: any[] = [null, undefined, 5, {}, [], 'x', { key: 5 }, { key: null, value: 1 }, { key: 'ДАТА', value: { a: 1 } }, { key: 'СТОЙНОСТ', value: 12 }]
    const r = mapFixedAssetParams(junk as any, CHART)
    expect(r.fields.purchasePrice).toBe(12)
    for (const value of ['', ' ', '∞', '1e999', '١٢٣', '\u0000', 'x'.repeat(10_000), '--', '..', '%']) {
      const params = Object.values(FIXED_ASSET_PARAMS).map(key => ({ key, value }))
      expect(() => mapFixedAssetParams(params, CHART)).not.toThrow()
    }
    expect(() => mapFixedAssetParams(undefined as any, new Map())).not.toThrow()
  })

  it('reads nothing but its arguments: the module imports no database', () => {
    const source = readFileSync(join(import.meta.dir, '../../../services/src/biz/accounting-books/fixed-asset-params.ts'), 'utf8')
    expect(source).not.toMatch(/from ['"](db|mongoose)/)
    expect([...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(m => m[1])).toEqual(['./registry.js'])
  })
})
