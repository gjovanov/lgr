import { describe, it, expect } from 'bun:test'
import { unitLabel } from 'reporting/unit.i18n'
import { UOM_CODES } from 'ui-shared/composables/useProductUnits'

/**
 * gjovanov/lgr#127 — the printed forms were putting the stored code (`pcs`) in the Bulgarian
 * „Мярка" column. `unitLabel` is the server-side counterpart of `warehouse.uomShort.<code>`.
 */

describe('unitLabel', () => {
  it('resolves the canonical codes in Bulgarian the way the legacy forms printed them', () => {
    expect(unitLabel('pcs', 'bg')).toBe('БР.')
    expect(unitLabel('kg', 'bg')).toBe('КГ.')
    expect(unitLabel('m', 'bg')).toBe('М.')
    expect(unitLabel('set', 'bg')).toBe('КОМПЛ.')
  })

  it('covers every code the product form can produce, in all four locales', () => {
    for (const locale of ['en', 'bg', 'de', 'mk']) {
      for (const code of UOM_CODES) {
        expect(unitLabel(code, locale)).toBeTruthy()
      }
    }
  })

  /**
   * The #127 symptom was a Latin code sitting in a Cyrillic column, so every Bulgarian label
   * must be Cyrillic. A code the table forgets is returned verbatim and fails here.
   */
  it('leaves no Latin code in the Bulgarian column', () => {
    for (const code of UOM_CODES) {
      expect(unitLabel(code, 'bg')).not.toMatch(/[A-Za-z]/)
    }
  })

  it('resolves abbreviations that reach us from imports and hand-typed lines', () => {
    for (const raw of ['бр', 'бр.', 'БР', 'броя', 'pc', 'Pieces', 'шт']) {
      expect(unitLabel(raw, 'bg')).toBe('БР.')
    }
    expect(unitLabel('кг', 'bg')).toBe('КГ.')
    // `L` is the code; lowercase `l` is the alias that disambiguates it from litre spellings.
    expect(unitLabel('L', 'bg')).toBe('Л.')
    expect(unitLabel('l', 'bg')).toBe('Л.')
  })

  it('returns anything it does not know verbatim, and nothing for nothing', () => {
    expect(unitLabel('ролка', 'bg')).toBe('ролка')
    expect(unitLabel('', 'bg')).toBe('')
    expect(unitLabel(undefined, 'bg')).toBe('')
    expect(unitLabel(null, 'bg')).toBe('')
    expect(unitLabel('  pcs  ', 'bg')).toBe('БР.')
  })

  it('falls back to English for an unknown locale', () => {
    expect(unitLabel('pcs', 'fr')).toBe('pcs')
    expect(unitLabel('pcs')).toBe('pcs')
  })
})
