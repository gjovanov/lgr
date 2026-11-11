import { describe, it, expect } from 'bun:test'
import { cleanContactAliases, contactAliasesFit, MAX_CONTACT_ALIASES, MAX_CONTACT_ALIAS_LENGTH } from 'config/contact-aliases'

/**
 * FR-28.12 — a contact's other names („Also known as") as they are stored. One function for the form and the API,
 * so the same typing stores the same thing whichever of them cleans it. What the names are FOR is
 * `supplier-name.test.ts` (the rule) and `integration/contact-aliases.flow.test.ts` (the route and the matchers).
 */

describe('cleanContactAliases', () => {
  it('trims each name and collapses its runs of whitespace, keeping the order a person gave', () => {
    expect(cleanContactAliases(['  ТЕСТ   ТРЕЙД ', 'T+P', 'Test\tCentre\n Ltd'])).toEqual(['ТЕСТ ТРЕЙД', 'T+P', 'Test Centre Ltd'])
  })

  it('keeps a name once, whatever its case, in Cyrillic too: the first spelling stays', () => {
    expect(cleanContactAliases(['Тест', 'ТЕСТ', ' тест ', 'Tester', 'TESTER'])).toEqual(['Тест', 'Tester'])
  })

  it('drops what is empty, and what is not a string', () => {
    expect(cleanContactAliases(['', '   ', 'A', null, undefined, 7, {}, ['B']] as unknown[])).toEqual(['A'])
  })

  it('drops the contact\'s own name: it says nothing', () => {
    expect(cleanContactAliases(['ТЕСТ ТРЕЙД ЕООД', 'тест  трейд еоод', 'ТЕСТ ТРЕЙД'], ' ТЕСТ ТРЕЙД  ЕООД ')).toEqual(['ТЕСТ ТРЕЙД'])
    // The same words with other punctuation are kept: the document may print them so, and the rule reads them.
    expect(cleanContactAliases(['ТЕСТ - 04 ООД'], 'ТЕСТ-04 ООД')).toEqual(['ТЕСТ - 04 ООД'])
  })

  it('anything that is not a list is no names', () => {
    for (const v of [undefined, null, '', 'ТЕСТ', 7, {}]) expect(cleanContactAliases(v)).toEqual([])
    expect(cleanContactAliases(['A'], undefined)).toEqual(['A'])
    expect(cleanContactAliases(['A'], null)).toEqual(['A'])
  })

  it('does not change the list it is given', () => {
    const given = ['  A ', 'a']
    cleanContactAliases(given)
    expect(given).toEqual(['  A ', 'a'])
  })
})

describe('contactAliasesFit — the bounds the API refuses beyond', () => {
  it('takes up to the most names, each up to the longest', () => {
    expect(contactAliasesFit([])).toBe(true)
    expect(contactAliasesFit(Array.from({ length: MAX_CONTACT_ALIASES }, (_, i) => `n${i}`))).toBe(true)
    expect(contactAliasesFit(['x'.repeat(MAX_CONTACT_ALIAS_LENGTH)])).toBe(true)
  })

  it('refuses one name too many, or one character too long', () => {
    expect(contactAliasesFit(Array.from({ length: MAX_CONTACT_ALIASES + 1 }, (_, i) => `n${i}`))).toBe(false)
    expect(contactAliasesFit(['ok', 'x'.repeat(MAX_CONTACT_ALIAS_LENGTH + 1)])).toBe(false)
  })
})
