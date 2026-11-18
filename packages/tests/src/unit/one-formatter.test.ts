import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import {
  dayInZone, formatDate, formatDateTime, formatMoney, formatNumber, formatPrice, formatQuantity, intlLocale, priceDecimals, setFormatLanguage,
} from 'ui-shared/format'

/**
 * FR-31.13 / .14 (#796): one formatter for money, numbers and dates, the same on every screen.
 *
 * The table per language is the decision of FR-31 §9 (D-3 to D-5), written once. The checks over the source keep it
 * the only one: no UI file outside `ui-shared/src/format/` names a formatting locale or formats with `toLocale*` or an
 * `Intl` formatter. The allow-list is empty.
 */

const NBSP = ' '
const NNBSP = ' '
/** ICU puts a no-break space (or a narrow one) between an amount and its currency: read them as spaces. */
const plain = (s: string) => s.replace(new RegExp(`[${NBSP}${NNBSP}]`, 'g'), ' ')

describe('the formatter, per language (D-3 to D-5)', () => {
  it('intlLocale names all four, and anything else is English', () => {
    expect(['en', 'bg', 'de', 'mk', 'fr', ''].map(l => intlLocale(l))).toEqual(['en-US', 'bg-BG', 'de-DE', 'mk-MK', 'en-US', 'en-US'])
  })

  it('a date: dd.MM.yyyy in bg, de and mk (no „г."), dd/MM/yyyy in en; the first and the last day of a year', () => {
    for (const lang of ['bg', 'de', 'mk']) {
      expect(formatDate('2026-01-01', { lang })).toBe('01.01.2026')
      expect(formatDate('2026-12-31', { lang })).toBe('31.12.2026')
    }
    expect(formatDate('2026-01-01', { lang: 'en' })).toBe('01/01/2026')
    expect(formatDate('2026-12-31', { lang: 'en' })).toBe('31/12/2026')
    // A date-only string, or a day stored at midnight UTC, is that day wherever the browser is.
    expect(formatDate('2026-03-05', { lang: 'bg' })).toBe('05.03.2026')
    expect(formatDate('2026-03-05T00:00:00.000Z', { lang: 'bg' })).toBe('05.03.2026')
    expect(formatDate('', { lang: 'bg' })).toBe('')
    expect(formatDate(null, { lang: 'bg' })).toBe('')
    expect(formatDate('not a date', { lang: 'bg' })).toBe('')
  })

  it('a moment, in a zone: the day and a 24-hour time', () => {
    expect(formatDateTime('2026-12-31T22:30:00Z', { lang: 'bg', timeZone: 'Europe/Sofia' })).toBe('01.01.2027 00:30')
    expect(formatDateTime('2026-06-01T09:05:00Z', { lang: 'en', timeZone: 'UTC' })).toBe('01/06/2026 09:05')
    expect(formatDate('2026-06-01T09:05:07Z', { lang: 'de', timeZone: 'UTC', seconds: true })).toBe('01.06.2026 09:05:07')
    expect(dayInZone('2026-12-31T22:30:00Z', 'Europe/Sofia')).toBe('2027-01-01')
  })

  it('money: the amount then the currency in bg, de and mk, the currency first in en; a point for decimals', () => {
    expect(plain(formatMoney(1234.5, 'EUR', { lang: 'en' }))).toBe('€1,234.50')
    expect(plain(formatMoney(1234.5, 'EUR', { lang: 'de' }))).toBe('1 234.50 €')
    expect(plain(formatMoney(1234.5, 'EUR', { lang: 'mk' }))).toBe('1 234.50 €')
    // Bulgarian groups only from five digits on (ICU's minimum grouping).
    expect(plain(formatMoney(1234.5, 'EUR', { lang: 'bg' }))).toBe('1234.50 €')
    expect(plain(formatMoney(12345.5, 'EUR', { lang: 'bg' }))).toBe('12 345.50 €')
    expect(plain(formatMoney(0, 'EUR', { lang: 'bg' }))).toBe('0.00 €')
    expect(plain(formatMoney(-5, 'EUR', { lang: 'bg' }))).toBe('-5.00 €')
    expect(plain(formatMoney(-5, 'EUR', { lang: 'en' }))).toBe('-€5.00')
    expect(plain(formatMoney(1, 'BGN', { lang: 'bg' }))).toBe('1.00 лв.')
    // A code Intl does not know: the figure, then the code.
    expect(plain(formatMoney(1, 'XQZ1', { lang: 'en' }))).toBe('1.00 XQZ1')
  })

  it('a unit price: two decimals, more only when the stored price has more, up to five (D-5)', () => {
    expect(priceDecimals(12)).toBe(2)
    expect(priceDecimals(12.5)).toBe(2)
    expect(priceDecimals(0.0472)).toBe(4)
    expect(priceDecimals(1.234567)).toBe(5)
    expect(plain(formatPrice(12.5, 'EUR', { lang: 'bg' }))).toBe('12.50 €')
    expect(plain(formatPrice(0.0472, 'EUR', { lang: 'bg' }))).toBe('0.0472 €')
    expect(formatPrice(2000.55512, null, { lang: 'en' })).toBe('2,000.55512')
  })

  it('a number: up to two decimals, a point, no point between thousands', () => {
    expect(formatNumber(1234.5, { lang: 'de' })).toBe(`1${NBSP}234.5`)
    expect(formatNumber(1234.5, { lang: 'en' })).toBe('1,234.5')
    expect(formatNumber(0, { lang: 'bg' })).toBe('0')
    expect(formatNumber(-0.125, { lang: 'bg', decimals: 2 })).toBe('-0.13')
    expect(formatNumber('x', { lang: 'bg' })).toBe('')
    expect(formatQuantity(2.5, { lang: 'bg' })).toBe('2.5')
    expect(formatQuantity(1.2345, { lang: 'bg' })).toBe('1.235')
    expect(formatNumber(1234.5, { lang: 'en', grouping: false })).toBe('1234.5')
  })

  it('follows the app’s language when none is named', () => {
    setFormatLanguage('bg')
    expect(formatDate('2026-02-03')).toBe('03.02.2026')
    setFormatLanguage('en')
    expect(formatDate('2026-02-03')).toBe('03/02/2026')
  })
})

const PACKAGES = resolve(import.meta.dir, '../../..')
const FORMATTER = 'ui-shared/src/format/'
// The formatter's own helper, which it imports.
const OF_THE_FORMATTER = ['ui-shared/src/composables/number-display.ts']

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.(ts|vue)$/.test(name)) yield path
  }
}

function uiFiles(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = []
  for (const pkg of readdirSync(PACKAGES)) {
    if (!(pkg.endsWith('-ui') || pkg === 'ui-shared' || pkg === 'ui-shell' || pkg === 'web')) continue
    for (const file of sources(join(PACKAGES, pkg, 'src'))) {
      const rel = relative(PACKAGES, file).replace(/\\/g, '/')
      if (rel.startsWith(FORMATTER) || OF_THE_FORMATTER.includes(rel)) continue
      out.push({ rel, text: readFileSync(file, 'utf8') })
    }
  }
  return out
}

describe('one formatter over the source (FR-31.13; the allow-list is empty)', () => {
  const files = uiFiles()

  it('scans the UI', () => {
    expect(files.length).toBeGreaterThan(300)
  })

  it('no UI source names a formatting locale', () => {
    const offenders = files.filter(f => /['"`](en|bg|de|mk)-[A-Z]{2}['"`]/.test(f.text)).map(f => f.rel)
    expect(offenders).toEqual([])
  })

  it('no UI source formats with toLocale* or an Intl formatter of its own', () => {
    const offenders = files
      .filter(f => /\.toLocale(String|DateString|TimeString)\(|new Intl\.(NumberFormat|DateTimeFormat)\b|\bnumberFormat\(/.test(f.text))
      .map(f => f.rel)
    expect(offenders).toEqual([])
  })
})
