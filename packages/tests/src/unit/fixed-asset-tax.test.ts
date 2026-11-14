import { describe, it, expect } from 'bun:test'
import {
  ASSET_AS_BOOKED, DEPRECIATION_METHODS, FIXED_ASSET_STATUSES, LIMITED_TERM_MAX_RATE, TAX_CATEGORIES, TAX_FIELDS,
  aboveStatutoryRate, dayOf, inServiceBeforePurchase, isImportedAsset, rateTermMismatch, rateTermProduct, readTaxField,
  statutoryTaxRate, taxCategoryCode, taxCategoryRoman, taxSchedule, taxUpdateOf, yearsOfMonths,
} from 'config/fixed-asset-tax'
import { BOOKS_IMPORT, FixedAsset } from 'db/models'
import { AS_BOOKED } from 'services/biz/accounting-books/analytics-query'
import { isImportedAsset as importsOwn } from 'services/biz/accounting-books/fixed-asset-register'
import { readTaxCategory } from 'services/biz/accounting-books/fixed-asset-params'

/** FR-25a §3.4: a fixed asset's tax side, as the routes save it and the screens show it. Made-up amounts throughout. */

const sum = (rows: { amount: number }[]) => Math.round(rows.reduce((s, r) => s + r.amount * 100, 0)) / 100

describe('the vocabulary mirrors the model and the books import', () => {
  it('has the model\'s statuses and methods, in its order', () => {
    expect([...FIXED_ASSET_STATUSES]).toEqual((FixedAsset.schema.path('status') as any).enumValues)
    expect([...DEPRECIATION_METHODS]).toEqual((FixedAsset.schema.path('depreciationMethod') as any).enumValues)
  })

  it('names an asset of the books as the import does, and refuses with the analytics\' code', () => {
    const samples = [
      { sourceModule: BOOKS_IMPORT, importKey: 'analytic|ДА:Машина' },
      { sourceModule: BOOKS_IMPORT },
      { sourceModule: 'manual', importKey: 'analytic|ДА:Машина' },
      { importKey: 'analytic|ДА:Машина' },
      {},
    ]
    for (const s of samples) expect(isImportedAsset(s)).toBe(importsOwn(s))
    expect(isImportedAsset(samples[0])).toBe(true)
    expect(isImportedAsset(null)).toBe(false)
    expect(ASSET_AS_BOOKED).toBe(AS_BOOKED)
  })

  it('stores the categories the import reads (1-7), I to VII', () => {
    expect(TAX_CATEGORIES.map(c => c.code)).toEqual(['1', '2', '3', '4', '5', '6', '7'])
    for (const c of TAX_CATEGORIES) {
      expect(readTaxCategory(c.code).value).toBe(c.code)
      expect(readTaxCategory(c.roman).value).toBe(c.code)
    }
  })
})

describe('the categories and their statutory rates (ЗКПО чл. 55)', () => {
  it('reads a category from its stored digit or a number', () => {
    expect(taxCategoryCode('4')).toBe('4')
    expect(taxCategoryCode(' 4 ')).toBe('4')
    expect(taxCategoryCode(4)).toBe('4')
    for (const bad of ['0', '8', 'IV', 4.5, '', null, undefined]) expect(taxCategoryCode(bad)).toBeUndefined()
    expect(taxCategoryRoman('7')).toBe('VII')
  })

  it('gives each category its maximum yearly rate', () => {
    expect(TAX_CATEGORIES.map(c => statutoryTaxRate(c.code))).toEqual([4, 30, 10, 50, 25, undefined, 15])
  })

  it('takes category VI\'s from the term: 100 % over it, a third at most', () => {
    expect(statutoryTaxRate('6', 60)).toBe(20)
    expect(statutoryTaxRate('6', 48)).toBe(25)
    expect(statutoryTaxRate('6', 24)).toBe(Math.round(LIMITED_TERM_MAX_RATE * 100) / 100)
    expect(statutoryTaxRate('6')).toBeUndefined()
    expect(statutoryTaxRate('6', 0)).toBeUndefined()
  })

  it('says when a rate is above its category\'s maximum', () => {
    expect(aboveStatutoryRate('2', 30)).toBe(false)
    expect(aboveStatutoryRate('2', 30.5)).toBe(true)
    expect(aboveStatutoryRate('2', 20)).toBe(false)
    expect(aboveStatutoryRate('6', 25, 60)).toBe(true)
    expect(aboveStatutoryRate(null, 99)).toBe(false)
  })
})

describe('reading a tax field as a person gave it', () => {
  it('takes each field\'s values, and calls null and an empty text a cleared field', () => {
    expect(readTaxField('taxCategory', '2')).toEqual({ value: '2' })
    expect(readTaxField('taxCategory', 2)).toEqual({ value: '2' })
    expect(readTaxField('taxDepreciationRate', 0)).toEqual({ value: 0 })
    expect(readTaxField('taxDepreciationRate', 100)).toEqual({ value: 100 })
    expect(readTaxField('taxUsefulLifeMonths', 0)).toEqual({ value: 0 })
    expect(readTaxField('taxValue', 0)).toEqual({ value: 0 })
    expect(readTaxField('inServiceDate', '2025-03-01')).toEqual({ value: '2025-03-01' })
    expect(readTaxField('inServiceDate', '2025-03-01T00:00:00.000Z')).toEqual({ value: '2025-03-01' })
    for (const field of TAX_FIELDS) {
      expect(readTaxField(field, null)).toEqual({ cleared: true })
      expect(readTaxField(field, '')).toEqual({ cleared: true })
    }
  })

  it('refuses what §3.4 does not allow', () => {
    expect(readTaxField('taxCategory', '8')).toEqual({ problem: 'tax_category_invalid' })
    expect(readTaxField('taxCategory', 'II')).toEqual({ problem: 'tax_category_invalid' })
    expect(readTaxField('taxDepreciationRate', -1)).toEqual({ problem: 'tax_rate_invalid' })
    expect(readTaxField('taxDepreciationRate', 100.01)).toEqual({ problem: 'tax_rate_invalid' })
    expect(readTaxField('taxDepreciationRate', '30')).toEqual({ problem: 'tax_rate_invalid' })
    expect(readTaxField('taxUsefulLifeMonths', 40.5)).toEqual({ problem: 'tax_months_invalid' })
    expect(readTaxField('taxUsefulLifeMonths', -12)).toEqual({ problem: 'tax_months_invalid' })
    expect(readTaxField('taxValue', -0.01)).toEqual({ problem: 'tax_value_invalid' })
    expect(readTaxField('inServiceDate', '2025-02-30')).toEqual({ problem: 'in_service_date_invalid' })
    expect(readTaxField('inServiceDate', 'soon')).toEqual({ problem: 'in_service_date_invalid' })
  })

  it('makes an update of the fields a body names, and leaves the others alone', () => {
    const update = taxUpdateOf({ taxCategory: 3, taxDepreciationRate: null, taxValue: -5, inServiceDate: '', name: 'not a tax field' })
    expect(update.set).toEqual({ taxCategory: '3' })
    expect(update.unset).toEqual(['taxDepreciationRate', 'inServiceDate'])
    expect(update.problems).toEqual([{ field: 'taxValue', code: 'tax_value_invalid' }])
    expect(taxUpdateOf({})).toEqual({ set: {}, unset: [], problems: [] })
    expect(taxUpdateOf({ taxCategory: undefined })).toEqual({ set: {}, unset: [], problems: [] })
  })
})

describe('days', () => {
  it('reads a date input\'s day, and the UTC day of a stored date', () => {
    expect(dayOf('2024-02-29')).toBe('2024-02-29')
    expect(dayOf('2023-02-29')).toBeUndefined()
    expect(dayOf('2026-01-15T00:00:00.000Z')).toBe('2026-01-15')
    expect(dayOf(new Date(Date.UTC(2026, 0, 15)))).toBe('2026-01-15')
    expect(dayOf(new Date('nope'))).toBeUndefined()
    expect(dayOf('15.01.2026')).toBeUndefined()
    expect(dayOf(20260115)).toBeUndefined()
  })

  it('says when an asset was put into service before it was bought', () => {
    expect(inServiceBeforePurchase('2025-02-28', '2025-03-01')).toBe(true)
    expect(inServiceBeforePurchase('2025-03-01', '2025-03-01')).toBe(false)
    expect(inServiceBeforePurchase('2025-03-01', new Date(Date.UTC(2025, 2, 1)))).toBe(false)
    expect(inServiceBeforePurchase('', '2025-03-01')).toBe(false)
    expect(inServiceBeforePurchase('2025-03-01', undefined)).toBe(false)
  })
})

describe('the rate and the term (§3.4: a hint when rate × years is not about 100)', () => {
  it('agrees within 1, as the books import reads it', () => {
    expect(rateTermMismatch(30, 40)).toBe(false)
    expect(rateTermMismatch(15, 80)).toBe(false)
    expect(rateTermMismatch(33.33, 36)).toBe(false)
    expect(rateTermMismatch(30, 48)).toBe(true)
    expect(rateTermProduct(30, 48)).toBe(120)
    expect(rateTermMismatch(30, null)).toBe(false)
    expect(rateTermMismatch(0, 40)).toBe(false)
    expect(yearsOfMonths(40)).toBe(3.33)
    expect(yearsOfMonths(-1)).toBeUndefined()
  })
})

describe('the tax schedule: a row per year, computed and never stored', () => {
  it('starts with the month the asset was put into service, and runs the term exactly where the rate agrees', () => {
    const rows = taxSchedule({ taxValue: 1200, taxDepreciationRate: 30, taxUsefulLifeMonths: 40, inServiceDate: '2024-04-15', purchaseDate: '2024-03-20' })
    expect(rows).toEqual([
      { year: 2024, months: 9, amount: 270, accumulated: 270, remaining: 930 },
      { year: 2025, months: 12, amount: 360, accumulated: 630, remaining: 570 },
      { year: 2026, months: 12, amount: 360, accumulated: 990, remaining: 210 },
      { year: 2027, months: 7, amount: 210, accumulated: 1200, remaining: 0 },
    ])
  })

  it('runs by the rate alone where no term is stated', () => {
    const rows = taxSchedule({ taxValue: 1000, taxDepreciationRate: 30, inServiceDate: '2024-01-31' })
    expect(rows.map(r => [r.year, r.months, r.amount])).toEqual([[2024, 12, 300], [2025, 12, 300], [2026, 12, 300], [2027, 4, 100]])
  })

  it('a rounded rate over its term leaves no cent for a year after it', () => {
    const rows = taxSchedule({ taxValue: 1000, taxDepreciationRate: 33.33, taxUsefulLifeMonths: 36, inServiceDate: '2025-01-01' })
    expect(rows.map(r => r.year)).toEqual([2025, 2026, 2027])
    expect(rows[2].remaining).toBe(0)
    expect(sum(rows)).toBe(1000)
  })

  it('follows the rate where the term disagrees with it', () => {
    const rows = taxSchedule({ taxValue: 1000, taxDepreciationRate: 50, taxUsefulLifeMonths: 60, inServiceDate: '2025-07-01' })
    expect(rows.map(r => [r.year, r.months, r.amount])).toEqual([[2025, 6, 250], [2026, 12, 500], [2027, 6, 250]])
  })

  it('takes the term alone where no rate is stated', () => {
    const rows = taxSchedule({ taxValue: 600, taxUsefulLifeMonths: 24, inServiceDate: '2025-01-01' })
    expect(rows.map(r => [r.year, r.amount])).toEqual([[2025, 300], [2026, 300]])
  })

  it('starts from the price and the purchase date where the tax side states neither', () => {
    const rows = taxSchedule({ purchasePrice: 500, taxDepreciationRate: 50, purchaseDate: '2025-01-10' })
    expect(rows.map(r => [r.year, r.amount])).toEqual([[2025, 250], [2026, 250]])
  })

  it('ends with the month the asset was disposed of', () => {
    const rows = taxSchedule({ taxValue: 1200, taxDepreciationRate: 10, inServiceDate: '2024-01-10', disposalDate: '2025-06-30' })
    expect(rows.map(r => [r.year, r.months, r.amount])).toEqual([[2024, 12, 120], [2025, 6, 60]])
    expect(rows[1].remaining).toBe(1020)
    expect(taxSchedule({ taxValue: 1200, taxDepreciationRate: 10, inServiceDate: '2024-03-10', disposalDate: '2024-01-31' })).toEqual([])
  })

  it('adds up to the base to the cent, whatever the rate', () => {
    for (const rate of [4, 10, 15, 25, 30, 33.33, 50, 100]) {
      const rows = taxSchedule({ taxValue: 1234.57, taxDepreciationRate: rate, inServiceDate: '2025-11-03' })
      expect(sum(rows)).toBe(1234.57)
      expect(rows[rows.length - 1].remaining).toBe(0)
    }
  })

  it('has no rows without a base, a rate or a term, or a start', () => {
    expect(taxSchedule({ taxValue: 0, taxDepreciationRate: 30, inServiceDate: '2025-01-01' })).toEqual([])
    expect(taxSchedule({ taxValue: 1000, taxDepreciationRate: 0, inServiceDate: '2025-01-01' })).toEqual([])
    expect(taxSchedule({ taxValue: 1000, inServiceDate: '2025-01-01' })).toEqual([])
    expect(taxSchedule({ taxValue: 1000, taxDepreciationRate: 30 })).toEqual([])
    expect(taxSchedule({})).toEqual([])
  })
})
