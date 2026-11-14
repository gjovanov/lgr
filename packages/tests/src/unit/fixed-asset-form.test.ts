import { describe, it, expect } from 'bun:test'
import { BOOKS_IMPORT } from 'db/models'
import en from '../../../ui-shared/src/locales/en.json'
import bg from '../../../ui-shared/src/locales/bg.json'
import de from '../../../ui-shared/src/locales/de.json'
import mk from '../../../ui-shared/src/locales/mk.json'
import { FIXED_ASSET_STATUSES, TAX_CATEGORIES, TAX_PROBLEM_CODES } from 'config/fixed-asset-tax'
import {
  analyticLinks, assetCurrency, bookPlan, emptyForm, fixedAssetFilters, formOf, isImportedAsset, payloadOf, rateAfterCategoryChange,
  refusalKey, statusColor, statusLabelKey, taxErrorKey, taxFieldProblems, taxHints, taxValueAfterCategoryChange, type FixedAssetForm,
} from '../../../accounting-ui/src/views/accounting/fixed-asset-form'

/** FR-25a §3.4: the fixed-asset screens as data, without a browser. Made-up assets throughout. */

const form = (over: Partial<FixedAssetForm> = {}): FixedAssetForm => ({
  ...emptyForm(),
  code: 'FA-1', name: 'Машина', purchaseDate: '2025-03-10', purchasePrice: 1500, usefulLifeYears: 5,
  accountId: 'a1', depreciationAccountId: 'a2', accumulatedDepAccountId: 'a3',
  ...over,
})

describe('reading an asset into the form', () => {
  it('reads the book side as the form always has, and the tax side by its rules', () => {
    const f = formOf({
      code: 'ДА:Машина А', name: 'Машина А', category: '204', purchaseDate: '2024-03-15T00:00:00.000Z', purchasePrice: 1200,
      usefulLifeMonths: 80, depreciationMethod: 'straight_line', status: 'not_depreciated', accountId: 'a1',
      taxCategory: '2', taxDepreciationRate: 30, taxUsefulLifeMonths: 40, taxValue: 1200, inServiceDate: '2024-04-01T00:00:00.000Z',
    })
    expect(f).toMatchObject({
      purchaseDate: '2024-03-15', usefulLifeYears: 6.67, status: 'not_depreciated',
      taxCategory: '2', taxDepreciationRate: 30, taxUsefulLifeMonths: 40, taxValue: 1200, inServiceDate: '2024-04-01',
    })
  })

  it('reads an asset with no tax side as none', () => {
    expect(formOf({ code: 'X', purchaseDate: '2025-01-01T00:00:00.000Z' })).toMatchObject({
      taxCategory: null, taxDepreciationRate: null, taxUsefulLifeMonths: null, taxValue: null, inServiceDate: '', usefulLifeYears: 5,
    })
    expect(formOf({ taxCategory: 'VIII' }).taxCategory).toBeNull()
  })
})

describe('what the form sends', () => {
  it('sends a new asset\'s value and the org\'s currency, and an edit neither', () => {
    const created = payloadOf(form(), { isEdit: false, currency: 'EUR' })
    expect(created).toMatchObject({ usefulLifeMonths: 60, currentValue: 1500, currency: 'EUR', depreciationMethod: 'straight_line' })
    const edited = payloadOf(form(), { isEdit: true, currency: 'EUR' })
    expect('currentValue' in edited).toBe(false)
    expect('currency' in edited).toBe(false)
  })

  it('sends the tax side, a cleared field as null', () => {
    expect(payloadOf(form(), { isEdit: true })).toMatchObject({
      taxCategory: null, taxDepreciationRate: null, taxUsefulLifeMonths: null, taxValue: null, inServiceDate: null,
    })
    const typed = payloadOf(form({ taxCategory: '4', taxDepreciationRate: 50, taxUsefulLifeMonths: 24, taxValue: 0, inServiceDate: '2025-04-01' }), { isEdit: true })
    expect(typed).toMatchObject({ taxCategory: '4', taxDepreciationRate: 50, taxUsefulLifeMonths: 24, taxValue: 0, inServiceDate: '2025-04-01' })
    // An emptied number input holds '': none.
    expect(payloadOf(form({ taxValue: '' as any }), { isEdit: true }).taxValue).toBeNull()
  })
})

describe('the tax side\'s errors, as the route would refuse them', () => {
  it('has none for a valid or an empty tax side', () => {
    expect(taxFieldProblems(form())).toEqual({})
    expect(taxFieldProblems(form({ taxCategory: '2', taxDepreciationRate: 30, taxUsefulLifeMonths: 40, taxValue: 1500, inServiceDate: '2025-03-10' }))).toEqual({})
  })

  it('names each field\'s problem, and the in-service date before the purchase', () => {
    expect(taxFieldProblems(form({ taxDepreciationRate: 120, taxUsefulLifeMonths: 40.5, taxValue: -1, inServiceDate: '2025-03-09' }))).toEqual({
      taxDepreciationRate: 'tax_rate_invalid', taxUsefulLifeMonths: 'tax_months_invalid', taxValue: 'tax_value_invalid', inServiceDate: 'in_service_before_purchase',
    })
  })

  it('has words for every problem, in every language', () => {
    for (const code of TAX_PROBLEM_CODES) {
      const [, block, ...rest] = taxErrorKey(code).split('.')
      expect(rest.join('.')).toBe(`tax.errors.${code}`)
      for (const messages of [en, bg, de, mk] as any[]) expect(typeof messages.accounting[block].tax.errors[code]).toBe('string')
    }
  })
})

describe('the tax side\'s hints', () => {
  it('gives the category\'s statutory rate, says when the rate is above it, and when the rate and the term disagree', () => {
    expect(taxHints(form({ taxCategory: '2' }))).toEqual({ statutoryRate: 30, aboveStatutory: false })
    expect(taxHints(form({ taxCategory: '2', taxDepreciationRate: 40, taxUsefulLifeMonths: 30 }))).toEqual({ statutoryRate: 30, aboveStatutory: true, years: 2.5 })
    expect(taxHints(form({ taxCategory: '2', taxDepreciationRate: 30, taxUsefulLifeMonths: 48 }))).toEqual({ statutoryRate: 30, aboveStatutory: false, mismatch: 120, years: 4 })
    expect(taxHints(form({ taxCategory: '6' }))).toEqual({ statutoryRate: undefined, aboveStatutory: false })
  })

  it('defaults the rate from the category, and keeps one a person typed', () => {
    expect(rateAfterCategoryChange(null, '2', null, null)).toBe(30)
    // Still the old category's statutory rate: it follows the new category.
    expect(rateAfterCategoryChange('2', '4', 30, null)).toBe(50)
    expect(rateAfterCategoryChange('2', '4', 20, null)).toBe(20)
    expect(rateAfterCategoryChange(null, '6', null, 60)).toBe(20)
    expect(rateAfterCategoryChange(null, '6', null, null)).toBeNull()
    expect(rateAfterCategoryChange('2', null, 30, null)).toBe(30)
  })

  it('defaults the tax value to the purchase price, and keeps one stated', () => {
    expect(taxValueAfterCategoryChange(null, 1500)).toBe(1500)
    expect(taxValueAfterCategoryChange(800, 1500)).toBe(800)
    expect(taxValueAfterCategoryChange(0, 1500)).toBe(0)
    expect(taxValueAfterCategoryChange(null, 0)).toBeNull()
  })
})

describe('statuses', () => {
  it('has words for every status the model takes, not_depreciated among them, in every language', () => {
    for (const status of FIXED_ASSET_STATUSES) {
      expect(statusLabelKey(status)).toBe(`accounting.fixedAssetBooks.statuses.${status}`)
      for (const messages of [en, bg, de, mk] as any[]) expect(typeof messages.accounting.fixedAssetBooks.statuses[status]).toBe('string')
    }
    expect(statusLabelKey('sold')).toBeUndefined()
    expect(statusColor('active')).toBe('success')
    expect(statusColor('not_depreciated')).toBe('blue-grey')
    expect(statusColor('sold')).toBe('grey')
  })

  it('names every tax category in every language', () => {
    for (const c of TAX_CATEGORIES) for (const messages of [en, bg, de, mk] as any[]) {
      expect(typeof messages.accounting.fixedAssetBooks.tax.categories[c.code]).toBe('string')
    }
  })
})

describe('the grid', () => {
  it('asks the list for only what is set', () => {
    expect(fixedAssetFilters({})).toEqual({})
    expect(fixedAssetFilters({ search: '  машина ', taxCategory: '2', origin: 'imported' })).toEqual({ search: 'машина', taxCategory: '2', imported: 'true' })
    expect(fixedAssetFilters({ taxCategory: 'none', origin: 'native' })).toEqual({ taxCategory: 'none', imported: 'false' })
  })

  it('shows each asset in its own currency', () => {
    expect(assetCurrency({ currency: 'BGN' }, 'EUR')).toBe('BGN')
    expect(assetCurrency({}, 'EUR')).toBe('EUR')
    expect(assetCurrency(null, null)).toBe('EUR')
  })

  it('locks an asset of the books, the import\'s own rule', () => {
    expect(isImportedAsset({ sourceModule: BOOKS_IMPORT, importKey: 'analytic|ДА:Машина' })).toBe(true)
    expect(isImportedAsset({ sourceModule: BOOKS_IMPORT })).toBe(false)
  })
})

describe('the analytic links and the refusals', () => {
  it('links the asset\'s own analytic first, then any other that points at it, each once', () => {
    expect(analyticLinks({ analyticId: 'x1', code: 'ДА:Машина А' }, [])).toEqual([{ _id: 'x1', path: 'ДА:Машина А' }])
    expect(analyticLinks({ analyticId: 'x1', code: 'ДА:Машина А' }, [{ _id: 'x2', path: 'ДА:Друга' }, { _id: 'x1', path: 'ДА:Машина А (книги)' }])).toEqual([
      { _id: 'x1', path: 'ДА:Машина А (книги)' }, { _id: 'x2', path: 'ДА:Друга' },
    ])
    expect(analyticLinks({ code: 'FA-1' }, [{ _id: 'x3', path: 'ДА:Машина' }])).toEqual([{ _id: 'x3', path: 'ДА:Машина' }])
    expect(analyticLinks({ code: 'FA-1' }, [])).toEqual([])
  })

  it('words the server\'s refusals', () => {
    expect(refusalKey({ code: 'books_as_booked' })).toBe('accounting.fixedAssetBooks.errors.books_as_booked')
    expect(refusalKey({ code: 'fixed_asset_tax_invalid', problems: [{ code: 'in_service_before_purchase' }] })).toBe('accounting.fixedAssetBooks.tax.errors.in_service_before_purchase')
    expect(refusalKey({ code: 'server_owned_field' })).toBeUndefined()
    expect(refusalKey(null)).toBeUndefined()
    for (const messages of [en, bg, de, mk] as any[]) expect(typeof messages.accounting.fixedAssetBooks.errors.books_as_booked).toBe('string')
  })
})

describe('the book plan the form has always shown', () => {
  it('is straight-line by year from the price less the salvage value', () => {
    expect(bookPlan(1200, 200, 4)).toEqual([
      { year: 1, depreciation: 250, accumulated: 250, bookValue: 750 },
      { year: 2, depreciation: 250, accumulated: 500, bookValue: 500 },
      { year: 3, depreciation: 250, accumulated: 750, bookValue: 250 },
      { year: 4, depreciation: 250, accumulated: 1000, bookValue: 0 },
    ])
    expect(bookPlan(1000, 0, 0)).toEqual([])
    expect(bookPlan(0, 0, 5)).toEqual([])
    expect(bookPlan(1000, 0, 5000)).toHaveLength(200)
  })
})

describe('the words', () => {
  it('keeps the block apart from `accounting.fixedAsset`, which is a string in every language', () => {
    for (const messages of [en, bg, de, mk] as any[]) {
      expect(typeof messages.accounting.fixedAsset).toBe('string')
      expect(typeof messages.accounting.fixedAssetBooks).toBe('object')
    }
  })

  it('has every key of the English block in the other three', () => {
    const keys = (o: any, prefix = ''): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]))
    const want = keys((en as any).accounting.fixedAssetBooks).sort()
    for (const messages of [bg, de, mk] as any[]) expect(keys(messages.accounting.fixedAssetBooks).sort()).toEqual(want)
  })
})
