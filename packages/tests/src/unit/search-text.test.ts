import { describe, it, expect } from 'bun:test'
import { foldSearchText, HOMOGLYPH_PAIRS, homoglyphPattern, searchKeywords, searchTextMatcher } from 'config/search-text'
import { buildProductSearchFilter, buildSearchFilter, PRODUCT_SEARCH_FIELD } from 'services/biz/search.utils'
import { joinedValue } from 'db/plugins/search-field'

/**
 * FR-33.2 (#933): one matcher for a typed search, in `config/search-text`. The server's product filter turns a word into
 * a pattern of look-alike classes; the stock count's line filter folds both sides to one letter. Both read the same
 * pairs, and this holds them to the same answers on a fixed word list.
 */

/** Articles as the server holds them: the fields, and the lowered mirrors `loweredFieldsPlugin` keeps. */
const ARTICLES = [
  { name: 'Болт М8х20 DIN 933', sku: 'PRD-0042', barcode: '3800123456789' }, // Cyrillic М and х
  { name: 'Болт M8x20 DIN 933 ZN', sku: 'PRD-0043', barcode: '3800123456796' }, // Latin M and x
  { name: 'Шайба М10 DIN 125', sku: 'РК-100', barcode: '' }, // a Cyrillic SKU
  { name: 'Гайка M8 DIN 934', sku: 'pk-200', barcode: '4006209000017' },
  { name: 'Анкер ТЕХНО 10x80', sku: 'ANK-1080', barcode: '' },
].map((a) => ({
  ...a,
  nameLower: a.name.toLocaleLowerCase('bg'),
  skuLower: a.sku.toLocaleLowerCase('bg'),
  barcodeLower: a.barcode.toLocaleLowerCase('bg'),
}))

const QUERIES = [
  'м8х20', 'm8x20', 'M8X20', 'М8Х20', 'болт', 'бoлт', 'БОЛТ din 933', 'din 933 zn', 'рк-100', 'pk-100', 'РК', 'pk',
  '380012', '3800123456796', 'шайба m10', 'гайка м8', 'техно', 'texho', 'TEXHO 10х80', 'xyz', 'болт 934', 'a', 'а',
  '  болт   м8  ', 'ank-1080', 'анк',
]

/** The few operators the search filters use, as MongoDB reads them. */
function matchesFilter(filter: Record<string, any>, doc: Record<string, any>): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$and') return (cond as Record<string, any>[]).every((f) => matchesFilter(f, doc))
    if (key === '$or') return (cond as Record<string, any>[]).some((f) => matchesFilter(f, doc))
    if (cond && typeof cond === 'object' && '$regex' in cond) {
      const value = doc[key]
      return typeof value === 'string' && new RegExp(cond.$regex, cond.$options ?? '').test(value)
    }
    throw new Error(`no reading of ${key} in this test`)
  })
}

const LOWERED = { name: 'nameLower', sku: 'skuLower', barcode: 'barcodeLower' }
const serverFinds = (q: string, a: (typeof ARTICLES)[number]) =>
  matchesFilter(buildSearchFilter(q, ['name', 'sku', 'barcode'], { lowered: LOWERED, homoglyphs: true }), a)
const joinedFinds = (q: string, a: (typeof ARTICLES)[number]) =>
  matchesFilter(buildProductSearchFilter(q, { complete: true }), {
    [PRODUCT_SEARCH_FIELD]: joinedValue(a, ['nameLower', 'skuLower', 'barcodeLower']),
  })
const screenFinds = (q: string, a: (typeof ARTICLES)[number]) => searchTextMatcher(q)!(`${a.name} ${a.sku} ${a.barcode}`)

describe('the search text matcher (FR-33.2)', () => {
  it('reads each look-alike pair as one letter, in either alphabet and either case', () => {
    expect(HOMOGLYPH_PAIRS).toHaveLength(12)
    for (const [lat, cyr] of HOMOGLYPH_PAIRS) {
      expect(foldSearchText(cyr)).toBe(lat)
      expect(foldSearchText(cyr.toLocaleUpperCase('bg'))).toBe(lat)
      expect(foldSearchText(lat.toUpperCase())).toBe(lat)
      expect(homoglyphPattern(lat)).toBe(`[${lat}${cyr}]`)
      expect(homoglyphPattern(cyr)).toBe(`[${lat}${cyr}]`)
    }
    // A letter with no look-alike stays itself.
    expect(foldSearchText('Шайба')).toBe('шaйбa')
  })

  it('needs every word, in any order', () => {
    expect(searchKeywords('  болт   м8  ')).toEqual(['болт', 'м8'])
    const m = searchTextMatcher('933 болт')!
    expect(m('Болт M8x20 DIN 933')).toBe(true)
    expect(m('Болт M8x20 DIN 934')).toBe(false)
  })

  it('an empty search tests nothing', () => {
    expect(searchTextMatcher('')).toBeNull()
    expect(searchTextMatcher('   ')).toBeNull()
    expect(searchTextMatcher(null)).toBeNull()
  })

  it('finds a Cyrillic name typed with Latin look-alikes, and the other way round', () => {
    expect(ARTICLES.filter((a) => screenFinds('m8x20', a)).map((a) => a.sku)).toEqual(['PRD-0042', 'PRD-0043'])
    expect(ARTICLES.filter((a) => screenFinds('pk-100', a)).map((a) => a.sku)).toEqual(['РК-100'])
    expect(ARTICLES.filter((a) => screenFinds('texho', a)).map((a) => a.sku)).toEqual(['ANK-1080'])
    expect(ARTICLES.filter((a) => screenFinds('380012', a)).map((a) => a.sku)).toEqual(['PRD-0042', 'PRD-0043'])
  })

  it('answers as the server’s product filter does, on every word and article of the list', () => {
    for (const q of QUERIES) {
      for (const a of ARTICLES) {
        const server = serverFinds(q, a)
        expect({ q, sku: a.sku, screen: screenFinds(q, a) }).toEqual({ q, sku: a.sku, screen: server })
        expect({ q, sku: a.sku, joined: joinedFinds(q, a) }).toEqual({ q, sku: a.sku, joined: server })
      }
    }
  })
})
