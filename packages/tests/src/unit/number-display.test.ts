import { describe, it, expect } from 'bun:test'
import { numberFormat, withDecimalPoint } from 'ui-shared/composables/number-display'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import { parseTyped } from 'ui-shared/composables/price-precision'

/**
 * Owner, 2026-11-12: a decimal is typed with a point or a comma, and SHOWN with a point in every interface language.
 * The locale keeps its currency symbol and where it goes; a locale that groups with a point groups with a no-break space.
 */

const NBSP = ' '

describe('numbers are shown with a decimal point in every interface language', () => {
  it('a currency amount', () => {
    expect(formatCurrency(1234.5, 'EUR', 'en-US')).toBe('€1,234.50')
    expect(formatCurrency(1234.5, 'EUR', 'bg-BG')).toBe(`1234.50${NBSP}€`)
    // de and mk group thousands with a point: it becomes a no-break space, so the only point is the decimal one.
    expect(formatCurrency(1234.5, 'EUR', 'de-DE')).toBe(`1${NBSP}234.50${NBSP}€`)
    expect(formatCurrency(1234.5, 'EUR', 'mk-MK')).toBe(`1${NBSP}234.50${NBSP}€`)
  })

  it('a negative amount keeps its sign, and a price keeps its four decimals', () => {
    expect(formatCurrency(-12.5, 'EUR', 'bg-BG')).toBe(`-12.50${NBSP}€`)
    expect(numberFormat('bg-BG', { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(0.0472)).toBe('0.0472')
  })

  it('a quantity, and a whole number has no decimal point at all', () => {
    expect(numberFormat('bg-BG', { maximumFractionDigits: 3 }).format(2.5)).toBe('2.5')
    expect(numberFormat('de-DE', { maximumFractionDigits: 3 }).format(12)).toBe('12')
    expect(numberFormat('de-DE').format(1234567)).toBe(`1${NBSP}234${NBSP}567`)
  })

  it('English is unchanged: its decimal is a point already and its group a comma', () => {
    const f = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 })
    expect(withDecimalPoint(f, 1234567.891)).toBe(f.format(1234567.891))
  })
})

describe('a typed decimal reads the same with a point or a comma', () => {
  it('12,5 and 12.5', () => {
    expect(parseTyped('12,5')).toBe(12.5)
    expect(parseTyped('12.5')).toBe(12.5)
    expect(parseTyped(' 0,0472 ')).toBe(0.0472)
    expect(parseTyped('')).toBeNull()
    expect(parseTyped('abc')).toBeNull()
  })
})
