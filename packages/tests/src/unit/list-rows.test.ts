import { describe, it, expect } from 'bun:test'
import { LIST_CEILING, LIST_FIELDS, LIST_ROW_EXCLUDES, listProjection, pageUnderCeiling } from 'config/list-rows'
import { ALL_ROWS, LARGEST_PAGE_SIZE, offersAll, pageSizeFromUrl, pageSizeOptions } from 'ui-shared/composables/page-sizes'
import { ALLOWED_PAGE_SIZES } from 'ui-shared/composables/useListQueryState'
import { takeHandedDocument, handOverDocument } from '../../../web/src/modules/invoicing/composables/document-form/document-preread'

// FR-30 slice B (#795): rows, a ceiling, "All" in the browser, a document read once.

describe('FR-30.8: the ceiling of a page', () => {
  it('"All" and any size above the ceiling read the ceiling; a page within it is read as asked', () => {
    expect(LIST_CEILING).toBe(1000)
    expect(pageUnderCeiling(0)).toEqual({ take: 1000, asked: Infinity })
    expect(pageUnderCeiling(-1)).toEqual({ take: 1000, asked: Infinity })
    expect(pageUnderCeiling(Number.NaN)).toEqual({ take: 1000, asked: Infinity })
    expect(pageUnderCeiling(5000)).toEqual({ take: 1000, asked: 5000 })
    expect(pageUnderCeiling(1000)).toEqual({ take: 1000, asked: 1000 })
    expect(pageUnderCeiling(25)).toEqual({ take: 25, asked: 25 })
  })

  it('a reader that needs every row says so, and is not cut', () => {
    expect(pageUnderCeiling(0, true)).toEqual({ take: Infinity, asked: Infinity })
    expect(pageUnderCeiling(5000, true)).toEqual({ take: 5000, asked: 5000 })
  })
})

describe('FR-30.7: a list\'s rows', () => {
  it('only `fields=list` asks for them; anything else is the whole document', () => {
    expect(LIST_FIELDS).toBe('list')
    expect(listProjection('invoices', 'list')).toEqual({ lines: 0 })
    expect(listProjection('invoices', undefined)).toBeUndefined()
    expect(listProjection('invoices', 'all')).toBeUndefined()
    // A list whose row is its document asks for nothing narrower.
    expect(listProjection('stockLevels', 'list')).toBeUndefined()
  })

  it('every projection excludes, so a field a grid reads that nobody listed is still sent', () => {
    for (const [list, p] of Object.entries(LIST_ROW_EXCLUDES)) {
      expect({ list, values: [...new Set(Object.values(p))] }).toEqual({ list, values: Object.keys(p).length ? [0] : [] })
    }
  })
})

describe('FR-30.9: "All" in the browser', () => {
  it('a remembered or bookmarked "All" opens at the largest page; another size the control offers is kept', () => {
    expect(ALLOWED_PAGE_SIZES).toEqual([10, 25, 50, 100, -1])
    expect(pageSizeFromUrl(ALL_ROWS, ALLOWED_PAGE_SIZES)).toBe(LARGEST_PAGE_SIZE)
    expect(LARGEST_PAGE_SIZE).toBe(100)
    expect(pageSizeFromUrl(25, ALLOWED_PAGE_SIZES)).toBe(25)
    expect(pageSizeFromUrl(7, ALLOWED_PAGE_SIZES)).toBeUndefined()
  })

  it('"All" is offered while the total is within the ceiling, and not above it', () => {
    const options = [{ value: 10, title: '10' }, { value: 100, title: '100' }, { value: -1, title: 'All' }]
    expect(offersAll(0)).toBe(true)
    expect(offersAll(LIST_CEILING)).toBe(true)
    expect(offersAll(LIST_CEILING + 1)).toBe(false)
    expect(pageSizeOptions(options, 900).map((o) => o.value)).toEqual([10, 100, -1])
    expect(pageSizeOptions(options, 23_050).map((o) => o.value)).toEqual([10, 100])
    expect(pageSizeOptions([10, 25, -1], 5000)).toEqual([10, 25])
  })
})

describe('FR-30.10: a document is read once as it opens', () => {
  it('what the view read is handed to the form once', () => {
    handOverDocument('d1', { invoice: { _id: 'd1' } })
    expect(takeHandedDocument('d1')).toEqual({ invoice: { _id: 'd1' } })
    // Taken: a later load (after a save) reads the document as stored then.
    expect(takeHandedDocument('d1')).toBeNull()
    expect(takeHandedDocument('never')).toBeNull()
  })
})
