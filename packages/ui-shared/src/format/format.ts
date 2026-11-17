import { shallowRef } from 'vue'
import { withDecimalPoint } from '../composables/number-display'

/**
 * The one formatter (FR-31.13, #796): money, numbers and dates, the same on every screen.
 *
 * Every screen formats through these. No other UI source names a formatting locale (`'bg-BG'`) or calls
 * `toLocaleString` / `toLocaleDateString` / `Intl.NumberFormat` / `Intl.DateTimeFormat`: `unit/one-formatter.test.ts`
 * fails on one, with an empty allow-list. What each language looks like is decided here, once (FR-31 §9):
 *
 * - D-3, a date: `dd.MM.yyyy` in Bulgarian, German and Macedonian (without the „г." Bulgarian formatting adds),
 *   `dd/MM/yyyy` in English. With a time: `dd.MM.yyyy HH:mm`, 24 hours in every language.
 * - D-4, money: each language's own convention: the amount and then the currency in bg, de and mk, the currency first
 *   in en. The decimal separator is a point in every language (owner, 2026-11-12, `number-display.ts`), and a language
 *   that groups thousands with a point groups them with a no-break space.
 * - D-5, a unit price: two decimals, more only when the stored price has more, up to five (`formatPrice`).
 *
 * The language is the app's (`setFormatLanguage`, which `plugins/i18n#declareLanguage` calls on every change); each
 * function takes another one in `opts.lang`. `unit/one-formatter.test.ts` holds the table per language.
 */

export type FormatLanguage = 'en' | 'bg' | 'de' | 'mk'

const LOCALES: Record<FormatLanguage, string> = { en: 'en-US', bg: 'bg-BG', de: 'de-DE', mk: 'mk-MK' }

/** The app's language, reactive: a screen formatted with it is drawn again when it changes. */
const language = shallowRef<FormatLanguage>('en')

export function setFormatLanguage(lang: string | null | undefined): void {
  language.value = known(lang)
}

function known(lang: string | null | undefined): FormatLanguage {
  const base = String(lang || '').slice(0, 2).toLowerCase()
  return (base in LOCALES ? base : 'en') as FormatLanguage
}

/** The formatting locale of the app's language (or of `lang`), for all four: `bg` → `bg-BG`. */
export function intlLocale(lang?: string | null): string {
  return LOCALES[known(lang ?? language.value)]
}

export interface NumberOpts {
  lang?: string | null
  /** Exactly this many decimals. */
  decimals?: number
  minDecimals?: number
  maxDecimals?: number
  /** Thousands grouped (default) or not. */
  grouping?: boolean
}

function digits(opts: NumberOpts, dflt: { min: number; max: number }): { minimumFractionDigits: number; maximumFractionDigits: number } {
  if (opts.decimals !== undefined) return { minimumFractionDigits: opts.decimals, maximumFractionDigits: opts.decimals }
  const min = opts.minDecimals ?? Math.min(dflt.min, opts.maxDecimals ?? dflt.max)
  const max = Math.max(min, opts.maxDecimals ?? dflt.max)
  return { minimumFractionDigits: min, maximumFractionDigits: max }
}

const cache = new Map<string, Intl.NumberFormat>()
function numberFormatOf(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`
  let f = cache.get(key)
  if (!f) {
    f = new Intl.NumberFormat(locale, options)
    cache.set(key, f)
  }
  return f
}

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

/** A number: up to two decimals by default, a point for the decimal separator. Not a number: ''. */
export function formatNumber(value: unknown, opts: NumberOpts = {}): string {
  const n = finite(value)
  if (n === null) return ''
  const options: Intl.NumberFormatOptions = { ...digits(opts, { min: 0, max: 2 }), useGrouping: opts.grouping !== false }
  return withDecimalPoint(numberFormatOf(intlLocale(opts.lang), options), n)
}

/** An amount of money, two decimals unless asked otherwise, the currency where the language puts it. */
export function formatMoney(value: unknown, currency?: string | null, opts: NumberOpts = {}): string {
  const n = finite(value) ?? 0
  const cur = (currency || 'EUR').toUpperCase()
  const options: Intl.NumberFormatOptions = { style: 'currency', currency: cur, ...digits(opts, { min: 2, max: 2 }) }
  try {
    return withDecimalPoint(numberFormatOf(intlLocale(opts.lang), options), n)
  } catch {
    // A currency code Intl does not know: the figure, then the code.
    return `${formatNumber(n, { ...opts, minDecimals: options.minimumFractionDigits, maxDecimals: options.maximumFractionDigits })} ${cur}`
  }
}

/** How many decimals a stored price shows (D-5): two, more only when it has more, up to five. */
export function priceDecimals(value: unknown): number {
  const n = finite(value)
  if (n === null) return 2
  for (let d = 2; d < 5; d++) {
    if (Math.abs(Math.round(n * 10 ** d) - n * 10 ** d) < 1e-6) return d
  }
  return 5
}

/** A unit price (D-5): with the currency when one is given, else the figure alone. */
export function formatPrice(value: unknown, currency?: string | null, opts: Omit<NumberOpts, 'decimals' | 'minDecimals' | 'maxDecimals'> = {}): string {
  const decimals = priceDecimals(value)
  return currency ? formatMoney(value, currency, { ...opts, decimals }) : formatNumber(value, { ...opts, decimals })
}

/** A quantity: as many decimals as it has, up to three. */
export function formatQuantity(value: unknown, opts: NumberOpts = {}): string {
  return formatNumber(value, { maxDecimals: 3, ...opts })
}

/** A number with its unit, in words (`2 hours`): the language's own. */
export function formatUnit(value: unknown, unit: string, opts: { lang?: string | null; display?: 'long' | 'short' | 'narrow' } = {}): string {
  const n = finite(value)
  if (n === null) return ''
  return numberFormatOf(intlLocale(opts.lang), { style: 'unit', unit, unitDisplay: opts.display ?? 'long' } as Intl.NumberFormatOptions).format(n)
}

/** A day with no time: `2026-11-17`, or a day stored at midnight UTC (`2026-11-17T00:00:00.000Z`, a document's date). */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.0+)?Z)?$/

/**
 * A date the way it was meant: a day (as `DATE_ONLY` reads one) is that day wherever the browser is, as the lists
 * that cut the ISO string showed it; anything else is its moment, on this browser's clock.
 */
function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string') {
    const m = DATE_ONLY.exec(value.trim())
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  }
  const d = value instanceof Date ? value : new Date(value as string | number)
  return Number.isNaN(d.getTime()) ? null : d
}

const pad = (n: number) => String(n).padStart(2, '0')

export interface DateOpts {
  lang?: string | null
  /** With the hour and minute (24 h): `dd.MM.yyyy HH:mm`. */
  time?: boolean
  /** With the seconds too. */
  seconds?: boolean
  /** The day and time in this IANA zone instead of the browser's. */
  timeZone?: string
}

/** The parts of `d` in `timeZone`, or in the browser's zone. */
function partsOf(d: Date, timeZone?: string): { y: number; mo: number; da: number; h: number; mi: number; s: number } {
  if (!timeZone) return { y: d.getFullYear(), mo: d.getMonth() + 1, da: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d)
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0)
  return { y: get('year'), mo: get('month'), da: get('day'), h: get('hour'), mi: get('minute'), s: get('second') }
}

/** A date (D-3): `dd.MM.yyyy` in bg, de and mk, `dd/MM/yyyy` in en; with `time`, `HH:mm` after it. Not a date: ''. */
export function formatDate(value: unknown, opts: DateOpts = {}): string {
  const d = toDate(value)
  if (!d) return ''
  const p = partsOf(d, opts.timeZone)
  const sep = known(opts.lang ?? language.value) === 'en' ? '/' : '.'
  const day = `${pad(p.da)}${sep}${pad(p.mo)}${sep}${p.y}`
  if (!opts.time && !opts.seconds) return day
  return `${day} ${pad(p.h)}:${pad(p.mi)}${opts.seconds ? `:${pad(p.s)}` : ''}`
}

/** A date with its time: `formatDate(value, { time: true })`. */
export function formatDateTime(value: unknown, opts: Omit<DateOpts, 'time'> = {}): string {
  return formatDate(value, { ...opts, time: true })
}

/** The calendar day of a moment in an IANA zone, as `YYYY-MM-DD` (a machine's form, for comparing days). */
export function dayInZone(value: unknown, timeZone?: string): string {
  const d = toDate(value)
  if (!d) return ''
  const p = partsOf(d, timeZone)
  return `${p.y}-${pad(p.mo)}-${pad(p.da)}`
}
