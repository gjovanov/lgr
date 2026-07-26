import { describe, it, expect } from 'bun:test'
import { amountInWords, upsertAmountInWords } from 'ui-shared/composables/useAmountInWords'

describe('amountInWords', () => {
  it('bg: 23.44 EUR / base 19.53 matches the legacy format', () => {
    const s = amountInWords(23.44, 19.53, 'EUR', 'bg')
    expect(s).toBe('Словом : двадесет и три евро и 44 цента, Данъчна основа 19.53 €')
  })

  it('bg: hundreds + thousands', () => {
    expect(amountInWords(703.55, 586.29, 'EUR', 'bg')).toContain('седемстотин и три евро и 55 цента')
    expect(amountInWords(1234.00, 1028.33, 'EUR', 'bg')).toContain('хиляда двеста тридесет и четири евро и 00 цента')
    expect(amountInWords(2000, 1666.67, 'EUR', 'bg')).toContain('две хиляди евро')
  })

  it('en: spelling + cents as digits', () => {
    expect(amountInWords(23.44, 19.53, 'EUR', 'en')).toBe('In words : twenty-three euro and 44 cents, Tax base 19.53 €')
    expect(amountInWords(1234.5, 1000, 'USD', 'en')).toContain('one thousand two hundred thirty-four dollars and 50 cents')
  })

  it('de: compound numbers', () => {
    expect(amountInWords(23.44, 19.53, 'EUR', 'de')).toContain('dreiundzwanzig Euro und 44 Cent')
    expect(amountInWords(1234, 1000, 'EUR', 'de')).toContain('eintausendzweihundertvierunddreißig')
  })

  it('mk: basic', () => {
    expect(amountInWords(23.44, 19.53, 'EUR', 'mk')).toContain('дваесет и три евра и 44 центи')
  })

  it('unknown locale falls back to en', () => {
    expect(amountInWords(5, 4, 'EUR', 'fr')).toContain('In words')
  })

  it('BGN currency words', () => {
    expect(amountInWords(10.5, 8.75, 'BGN', 'bg')).toContain('лева и 50 стотинки')
  })
})

describe('upsertAmountInWords', () => {
  it('appends when notes have no existing line', () => {
    const out = upsertAmountInWords('Some note', 23.44, 19.53, 'EUR', 'bg')
    expect(out).toBe('Some note\nСловом : двадесет и три евро и 44 цента, Данъчна основа 19.53 €')
  })

  it('replaces an existing line instead of stacking on re-save', () => {
    let notes = 'Header'
    notes = upsertAmountInWords(notes, 10, 8, 'EUR', 'bg')
    notes = upsertAmountInWords(notes, 20, 16, 'EUR', 'bg')
    const wordLines = notes.split('\n').filter((l) => l.startsWith('Словом'))
    expect(wordLines.length).toBe(1)
    expect(wordLines[0]).toContain('двадесет евро')
    expect(notes.startsWith('Header')).toBe(true)
  })

  it('handles empty notes', () => {
    expect(upsertAmountInWords('', 1, 1, 'EUR', 'en')).toBe('In words : one euro and 00 cents, Tax base 1.00 €')
  })
})
