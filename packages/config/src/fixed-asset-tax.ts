/**
 * FR-25a §3.4: a fixed asset as the asset screens show it and the fixed-asset routes save it. Its tax side (ЗКПО), which
 * runs beside the book depreciation on its own schedule, and the rule that keeps an asset of the books as booked.
 *
 * The books import makes an asset of each `ДА` analytic (`services/biz/accounting-books/fixed-asset-register.ts`), marked
 * `sourceModule: 'plusminus'` + `importKey`. Such an asset is as booked, read-only for everyone: the next import would
 * overwrite an edit. An asset kept in LGR may carry the same tax side, and these are the rules it is saved by, the same
 * on both sides of the wire.
 *
 * Import-pure: the fixed-asset routes, the asset screens and their tests read it.
 */
import { BOOKS_SOURCE_MODULE } from './journal-header'

// ── Where an asset comes from ───────────────────────────────────────────────────────────────────

/**
 * An asset the books import made: as booked, read-only for everyone. Any other is kept in LGR. The rule of
 * `fixed-asset-register.ts#isImportedAsset`, which this package cannot import (`unit/fixed-asset-tax.test.ts` holds the
 * two equal).
 */
export function isImportedAsset(asset: { sourceModule?: unknown; importKey?: unknown } | null | undefined): boolean {
  return !!asset && asset.sourceModule === BOOKS_SOURCE_MODULE && typeof asset.importKey === 'string'
}

/**
 * The code a change to an asset of the books is refused with: the one the analytics and the chart answer
 * (`analytics-query.ts#AS_BOOKED`, held equal by the test).
 */
export const ASSET_AS_BOOKED = 'books_as_booked'

// ── Statuses and methods ────────────────────────────────────────────────────────────────────────

/** `fixed-asset.model.ts`'s statuses, in its order (held equal by the test). `not_depreciated`: `НАЧИСЛ` = `НЕ`. */
export const FIXED_ASSET_STATUSES = ['active', 'disposed', 'fully_depreciated', 'not_depreciated'] as const
export type FixedAssetStatus = (typeof FIXED_ASSET_STATUSES)[number]

/** `fixed-asset.model.ts`'s depreciation methods (held equal by the test). */
export const DEPRECIATION_METHODS = ['straight_line', 'declining_balance', 'units_of_production'] as const

// ── The tax categories (ЗКПО, чл. 55) ───────────────────────────────────────────────────────────

export interface TaxCategory {
  /** As the accountant's file keys it and the asset stores it: `1`–`7`. */
  code: string
  /** As the law and the forms write it: I–VII. */
  roman: string
  /**
   * The statutory maximum yearly rate, in percent. None for VI, whose rate is 100 % over the term of the limitation
   * (`LIMITED_TERM_MAX_RATE` at most).
   */
  maxRate?: number
}

export const TAX_CATEGORIES: readonly TaxCategory[] = [
  { code: '1', roman: 'I', maxRate: 4 },
  { code: '2', roman: 'II', maxRate: 30 },
  { code: '3', roman: 'III', maxRate: 10 },
  { code: '4', roman: 'IV', maxRate: 50 },
  { code: '5', roman: 'V', maxRate: 25 },
  { code: '6', roman: 'VI' },
  { code: '7', roman: 'VII', maxRate: 15 },
]

/** Category VI: 100 % over the term of the limitation, never above a third. */
export const LIMITED_TERM_MAX_RATE = 100 / 3

const round2 = (n: number) => Math.round(n * 100) / 100

/** A category as stored (`1`–`7`), from the stored text or a number; undefined for anything else. */
export function taxCategoryCode(value: unknown): string | undefined {
  const s = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  return TAX_CATEGORIES.some(c => c.code === s) ? s : undefined
}

export function taxCategoryOf(value: unknown): TaxCategory | undefined {
  const code = taxCategoryCode(value)
  return TAX_CATEGORIES.find(c => c.code === code)
}

/** I–VII for a category, or undefined. */
export function taxCategoryRoman(value: unknown): string | undefined {
  return taxCategoryOf(value)?.roman
}

const positive = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)

/**
 * The statutory maximum yearly rate of a category, rounded to cents of a percent. For VI it comes from the term
 * (`termMonths`), and there is none without one.
 */
export function statutoryTaxRate(category: unknown, termMonths?: unknown): number | undefined {
  const c = taxCategoryOf(category)
  if (!c) return undefined
  if (c.maxRate !== undefined) return c.maxRate
  const months = positive(termMonths)
  return months ? round2(Math.min(1200 / months, LIMITED_TERM_MAX_RATE)) : undefined
}

// ── Reading what a person gave ──────────────────────────────────────────────────────────────────

export const TAX_FIELDS = ['taxCategory', 'taxDepreciationRate', 'taxUsefulLifeMonths', 'taxValue', 'inServiceDate'] as const
export type TaxField = (typeof TAX_FIELDS)[number]

export const TAX_PROBLEM_CODES = [
  'tax_category_invalid', 'tax_rate_invalid', 'tax_months_invalid', 'tax_value_invalid', 'in_service_date_invalid',
  'in_service_before_purchase',
] as const
export type TaxProblemCode = (typeof TAX_PROBLEM_CODES)[number]

export interface TaxProblem {
  field: TaxField
  code: TaxProblemCode
}

const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && !v.trim())

/**
 * A calendar day, `YYYY-MM-DD`: a date input's own, or the UTC day of a stored date (an asset's days are stored at UTC
 * midnight). Undefined for anything that is not a real day: `2026-02-31` is none.
 */
export function dayOf(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString().slice(0, 10)
  if (typeof value !== 'string') return undefined
  const s = value.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})(T.*)?$/.exec(s)
  if (!m) return undefined
  if (m[4]) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10)
  }
  const [y, mo, da] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
  const d = new Date(0)
  d.setUTCFullYear(y, mo, da)
  return d.getUTCFullYear() === y && d.getUTCMonth() === mo && d.getUTCDate() === da ? s.slice(0, 10) : undefined
}

export type TaxFieldReading =
  | { value: string | number }
  | { cleared: true }
  | { problem: TaxProblemCode }

/**
 * One tax field as a person gave it: the value to store, cleared (null, an empty text), or what is wrong with it.
 * - `taxCategory`: `1`–`7` (a number is read as its digit);
 * - `taxDepreciationRate`: a percent, 0–100;
 * - `taxUsefulLifeMonths`: whole months, 0 or more;
 * - `taxValue`: money, 0 or more;
 * - `inServiceDate`: a day, stored as `YYYY-MM-DD` (UTC midnight).
 */
export function readTaxField(field: TaxField, value: unknown): TaxFieldReading {
  if (blank(value)) return { cleared: true }
  switch (field) {
    case 'taxCategory': {
      const code = taxCategoryCode(value)
      return code ? { value: code } : { problem: 'tax_category_invalid' }
    }
    case 'taxDepreciationRate':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? { value } : { problem: 'tax_rate_invalid' }
    case 'taxUsefulLifeMonths':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? { value } : { problem: 'tax_months_invalid' }
    case 'taxValue':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? { value } : { problem: 'tax_value_invalid' }
    case 'inServiceDate': {
      const day = dayOf(value)
      return day ? { value: day } : { problem: 'in_service_date_invalid' }
    }
  }
}

export interface TaxUpdate {
  set: Partial<Record<TaxField, string | number>>
  /** The fields a person cleared: removed, never stored as an empty value. */
  unset: TaxField[]
  problems: TaxProblem[]
}

/** The tax fields a body names, as an update writes them. A field the body leaves out is not touched. */
export function taxUpdateOf(input: Partial<Record<string, unknown>>): TaxUpdate {
  const out: TaxUpdate = { set: {}, unset: [], problems: [] }
  for (const field of TAX_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field) || input[field] === undefined) continue
    const read = readTaxField(field, input[field])
    if ('problem' in read) out.problems.push({ field, code: read.problem })
    else if ('cleared' in read) out.unset.push(field)
    else out.set[field] = read.value
  }
  return out
}

/** Put into service before it was bought: two days, compared as days. False while either is missing. */
export function inServiceBeforePurchase(inService: unknown, purchase: unknown): boolean {
  const a = dayOf(inService)
  const b = dayOf(purchase)
  return !!a && !!b && a < b
}

// ── Hints: never a refusal ──────────────────────────────────────────────────────────────────────

/**
 * Whether a rate and a term disagree: the rate × the term in years is 100 off by more than 1, as the books import reads
 * it (`fixed-asset-params.ts#mismatched`). False while either is missing or 0. A hint: the books always agree, and a
 * person may have reasons.
 */
export function rateTermMismatch(rate: unknown, months: unknown): boolean {
  const r = positive(rate)
  const m = positive(months)
  return !!r && !!m && Math.abs(r * (m / 12) - 100) > 1
}

/** What a rate and a term make: the percent the asset is written off by over its term (100 when they agree). */
export function rateTermProduct(rate: unknown, months: unknown): number | undefined {
  const r = positive(rate)
  const m = positive(months)
  return r && m ? round2(r * (m / 12)) : undefined
}

/** A rate above its category's statutory maximum. A hint. */
export function aboveStatutoryRate(category: unknown, rate: unknown, months?: unknown): boolean {
  const max = statutoryTaxRate(category, months)
  const r = positive(rate)
  return max !== undefined && r !== undefined && r > max + 0.005
}

/** Months as years, to two places: 40 → 3.33. */
export function yearsOfMonths(months: unknown): number | undefined {
  return typeof months === 'number' && Number.isFinite(months) && months >= 0 ? round2(months / 12) : undefined
}

// ── The tax schedule ────────────────────────────────────────────────────────────────────────────

export interface TaxScheduleInput {
  taxValue?: unknown
  /** The base where no tax value is stated (§3.4: the tax value defaults to the purchase price). */
  purchasePrice?: unknown
  taxDepreciationRate?: unknown
  taxUsefulLifeMonths?: unknown
  inServiceDate?: unknown
  /** The start where no in-service date is stated. */
  purchaseDate?: unknown
  /** Written off: no tax depreciation after the end of its month. */
  disposalDate?: unknown
}

export interface TaxScheduleRow {
  year: number
  /** The months of the year the asset is depreciated in. */
  months: number
  amount: number
  accumulated: number
  /** The tax value not yet written off. */
  remaining: number
}

/** A rate of 0.5 % runs 200 years: the schedule never runs longer. */
export const TAX_SCHEDULE_MAX_YEARS = 200

const amountOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

/**
 * The tax depreciation, one row per calendar year, computed from the tax fields and never stored (the books import keeps
 * none: FR-25a §4.2). The rules it follows:
 * - the base is the tax value, else the purchase price;
 * - it starts with the month the asset was put into service (else bought), and that month counts in full;
 * - each month writes off a twelfth of the yearly rate; where the term agrees with the rate (`rateTermMismatch`), the
 *   term's months exactly, so a rounded rate (33.33 % over 3 years) leaves no cent for a year after the term;
 * - it ends when the base is written off, or with the month the asset was disposed of.
 * Amounts are in cents: each year's is what the running total reaches less what it had, so the rows add up to the base.
 */
export function taxSchedule(input: TaxScheduleInput): TaxScheduleRow[] {
  const base = amountOf(input.taxValue) ?? amountOf(input.purchasePrice)
  const baseCents = base === undefined ? 0 : Math.round(base * 100)
  const rate = positive(input.taxDepreciationRate)
  const term = positive(input.taxUsefulLifeMonths)
  const startDay = dayOf(input.inServiceDate) ?? dayOf(input.purchaseDate)
  if (!baseCents || (!rate && !term) || !startDay) return []

  // The months it takes to write the base off, and the share of it each month writes off.
  const byTerm = !!term && Number.isInteger(term) && (!rate || !rateTermMismatch(rate, term))
  const share = byTerm ? 1 / term! : rate! / 1200
  const fullMonths = byTerm ? term! : Math.ceil(1200 / rate! - 1e-9)

  const startYear = Number(startDay.slice(0, 4))
  const startMonth = Number(startDay.slice(5, 7)) - 1
  const endDay = dayOf(input.disposalDate)
  const end = endDay && endDay >= startDay.slice(0, 7) ? { year: Number(endDay.slice(0, 4)), month: Number(endDay.slice(5, 7)) - 1 } : undefined
  if (endDay && !end) return []

  const rows: TaxScheduleRow[] = []
  let monthsSoFar = 0
  let accumulated = 0
  for (let year = startYear; year < startYear + TAX_SCHEDULE_MAX_YEARS && accumulated < baseCents; year++) {
    if (end && year > end.year) break
    const first = year === startYear ? startMonth : 0
    const last = end && year === end.year ? end.month : 11
    const months = Math.min(last - first + 1, fullMonths - monthsSoFar)
    if (months <= 0) break
    monthsSoFar += months
    const reached = monthsSoFar >= fullMonths ? baseCents : Math.min(baseCents, Math.round(baseCents * share * monthsSoFar))
    rows.push({ year, months, amount: (reached - accumulated) / 100, accumulated: reached / 100, remaining: (baseCents - reached) / 100 })
    accumulated = reached
  }
  return rows
}
