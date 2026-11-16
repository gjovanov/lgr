/**
 * FR-25a §4.2: a fixed asset as its `ДА` analytic's properties (ПАРАМЕТРИ) state it, by the mapping the audit verified.
 *
 * Import-pure, with no database: the chart comes in as a map of codes, so the same function the import runs can be run
 * over the accountant's file as it is, on the PC that holds it, before anything is written anywhere.
 *
 * What it does with a value it cannot take as booked, which is never a reason to throw:
 * - an empty value is no value (`absent`): an optional field is then left out, a required one is `missing`;
 * - a value that cannot be read (a number, a date, a category, a method, a yes/no), or an account code the chart does not
 *   hold, is a problem, and the fields it would have set are left out. Each problem names those fields (`fields`), and an
 *   import keeps what an asset already holds in them: a garbled read never wipes a value the books gave before.
 *
 * ⚠ The terms are in YEARS, often fractional (100 / the rate): `СРОК` and `ДАНСРОК` become months as `round(years × 12)`.
 * The audit proved it from `rate × term ≈ 100` on every asset, and the mapping checks the same on each one
 * (`rate_term_mismatch`): a term written in months would show there at once.
 */
import { EUR_CHANGEOVER } from './registry.js'

/** The analytic root of the fixed assets. */
export const FIXED_ASSET_ROOT = 'ДА'

/** The parameters the mapping reads, as the file spells them. Every other one is kept in `params` only. */
export const FIXED_ASSET_PARAMS = {
  account: 'СМЕТКА',
  expenseAccount: 'ДЕБИТ',
  accumulatedAccount: 'КРЕДИТ',
  method: 'МЕТОД',
  date: 'ДАТА',
  value: 'СТОЙНОСТ',
  total: 'ОБЩАСТОЙНОСТ',
  rate: 'ПРОЦЕНТ',
  term: 'СРОК',
  openingDepreciation: 'НАЧ.АМ.',
  taxCategory: 'КАТ',
  inService: 'ДАТАЕКСП',
  taxRate: 'ДАННОРМА',
  taxTerm: 'ДАНСРОК',
  taxValue: 'ДАНСТОЙН',
  disposal: 'ОТПДАТА',
  accrues: 'НАЧИСЛ',
} as const

export type FixedAssetStatus = 'active' | 'disposed' | 'not_depreciated'

/** What an asset's properties state, in `FixedAsset`'s own fields. `Id` is whatever the chart map holds per code. */
export interface FixedAssetFields<Id> {
  /** `СМЕТКА`: the account the asset is booked on. */
  accountId: Id
  /** `ДЕБИТ`: the depreciation expense account. */
  depreciationAccountId: Id
  /** `КРЕДИТ`: the accumulated depreciation account. */
  accumulatedDepAccountId: Id
  /** The code of the asset's own account (`СМЕТКА`), as booked: the chart's class of the asset. */
  category: string
  /** `МЕТОД`: the one value the audit saw is linear. */
  depreciationMethod: 'straight_line'
  /** `ДАТА`. */
  purchaseDate: Date
  /** `ОБЩАСТОЙНОСТ` (the value with later additions) where it states one, else `СТОЙНОСТ`. */
  purchasePrice: number
  /**
   * The currency the properties are stated in: EUR, but for an asset written off before the euro changeover, which PlusMinus
   * left in lev. Not the purchase year's: the program converted its asset register at the changeover. Nothing is converted here.
   */
  currency: 'BGN' | 'EUR'
  /** `СРОК` (years) × 12, rounded; from `ПРОЦЕНТ` (100 / the rate) where no term is stated; 0 when nothing is depreciated. */
  usefulLifeMonths: number
  /** The price less `НАЧ.АМ.` (the book depreciation accumulated before the books start): the value the books start from. */
  currentValue: number
  /** `ОТПДАТА` set: disposed. Else `НАЧИСЛ` = `НЕ`: not depreciated. Else active. */
  status: FixedAssetStatus
  /** `ОТПДАТА`: the book write-off date. */
  disposalDate?: Date
  /** `КАТ`: the tax category, `1`–`7`. */
  taxCategory?: string
  /** `ДАТАЕКСП`. */
  inServiceDate?: Date
  /** `ДАННОРМА`, in percent. */
  taxDepreciationRate?: number
  /** `ДАНСТОЙН`. */
  taxValue?: number
  /** `ДАНСРОК` (years) × 12, rounded. */
  taxUsefulLifeMonths?: number
  /** Every property, in the file's order and spelling, empty ones too. */
  params?: { key: string; value: string }[]
}

export type FixedAssetField = keyof FixedAssetFields<unknown>

export type FixedAssetProblemReason =
  /** A property a required field needs is absent or empty. */
  | 'missing'
  /** Not a number, a date, a category or a yes/no that can be read. */
  | 'unreadable'
  /** Read, and impossible: a category outside 1–7, a rate outside 0–100, a negative term, a date outside 1900–2100. */
  | 'out_of_range'
  /** An account code the org's chart does not hold. */
  | 'unknown_account'
  /** A depreciation method other than the linear one. */
  | 'unknown_method'
  /** Kept as the file says, and worth a look: the rate × the term in years is not 100. */
  | 'rate_term_mismatch'
  /** Kept as the file says, and worth a look: the value with later additions is below the value. */
  | 'total_below_value'
  /** Kept as the file says, and worth a look: the opening depreciation is above the value. */
  | 'opening_above_value'

export interface FixedAssetProblem {
  /** The property, as the mapping spells it. */
  key: string
  reason: FixedAssetProblemReason
  /** The fields this leaves unknown: an import keeps what an asset already holds in them. Empty for a remark. */
  fields: FixedAssetField[]
  /** `unknown_account` only: the code the file names (a code is no one's data). */
  code?: string
  /** The value as the file has it, for the caller's own eyes. An import's answer never carries it. */
  value?: string
}

export interface FixedAssetMapping<Id> {
  fields: Partial<FixedAssetFields<Id>>
  problems: FixedAssetProblem[]
}

/** A read value: `{}` absent, `{ value }` read, `{ bad }` there and not readable (or not possible). */
type Read<T> = { value?: T; bad?: 'unreadable' | 'out_of_range' }

const keyOf = (key: string) => key.toLocaleUpperCase('bg').replace(/\s+/g, '')

/**
 * A number as PlusMinus or a person may write it: a dot or a comma as the decimal separator, spaces, no-break spaces or
 * the other separator between thousands, a sign, an exponent (`1e-7`, as a database number prints). Empty and `NaN`
 * (PlusMinus's own "no value") are absent. One separator alone is the decimal one: `1,234` is 1.234, as it reads in Bulgarian.
 */
export function readNumber(raw: string | undefined, opts: { percent?: boolean } = {}): Read<number> {
  const text = String(raw ?? '').trim()
  if (!text || /^nan$/i.test(text)) return {}
  let s = text.replace(/\s/g, '')
  if (opts.percent) s = s.replace(/%$/, '')
  const m = /^([+-]?)(\d[\d.,]*|[.,]\d+)(?:[eE]([+-]?\d+))?$/.exec(s)
  if (!m) return { bad: 'unreadable' }
  const digits = normalizedDigits(m[2])
  if (digits === null) return { bad: 'unreadable' }
  const n = Number(`${m[1]}${digits}${m[3] !== undefined ? `e${m[3]}` : ''}`)
  return Number.isFinite(n) ? { value: n === 0 ? 0 : n } : { bad: 'unreadable' }
}

/** `1.234,56`, `1,234.56`, `1.234.567`, `12,5` as plain digits with a dot. Null when the separators make no number. */
function normalizedDigits(d: string): string | null {
  const commas = d.split(',').length - 1
  const dots = d.split('.').length - 1
  if (commas && dots) {
    // Both: the later one is the decimal separator, and the other one only groups thousands before it.
    const decimal = d.lastIndexOf(',') > d.lastIndexOf('.') ? ',' : '.'
    const thousands = decimal === ',' ? '.' : ','
    if ((decimal === ',' ? commas : dots) > 1) return null
    const [whole, fraction] = d.split(decimal)
    if (!groupedThousands(whole, thousands)) return null
    return `${whole.split(thousands).join('')}.${fraction}`
  }
  if (commas + dots > 1) {
    // One kind, several times: it can only be grouping thousands.
    const sep = commas ? ',' : '.'
    return groupedThousands(d, sep) ? d.split(sep).join('') : null
  }
  return d.replace(',', '.')
}

/** `1.234.567`: one to three digits, then groups of exactly three. */
const groupedThousands = (whole: string, sep: string) => {
  const groups = whole.split(sep)
  return /^\d{1,3}$/.test(groups[0]) && groups.slice(1).every(g => /^\d{3}$/.test(g))
}

/** A real calendar day at UTC midnight, or null. */
function utcDay(year: number, month: number, day: number): Date | null {
  const d = new Date(Date.UTC(year, month - 1, day))
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d : null
}

/**
 * `DD.MM.YYYY` (how every date of the file is written), a day or a month of one digit, or `YYYY-MM-DD`, a time after it
 * ignored, as the day at UTC midnight. A date of zeros (`00.00.0000`) is no date.
 */
export function readDate(raw: string | undefined): Read<Date> {
  const s = String(raw ?? '').trim()
  if (!s || /^0+([./-]0+){0,2}$/.test(s)) return {}
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T].*)?$/.exec(s)
  const iso = dotted ? null : /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(s)
  if (!dotted && !iso) return { bad: 'unreadable' }
  const [year, month, day] = dotted ? [dotted[3], dotted[2], dotted[1]].map(Number) : [iso![1], iso![2], iso![3]].map(Number)
  const date = utcDay(year, month, day)
  if (!date) return { bad: 'unreadable' }
  if (year < 1900 || year > 2100) return { bad: 'out_of_range' }
  return { value: date }
}

const ROMAN: Readonly<Record<string, number>> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7 }

/** `КАТ`: the tax category `1`–`7` (I–VII), as the digit. */
export function readTaxCategory(raw: string | undefined): Read<string> {
  const s = String(raw ?? '').trim()
  if (!s) return {}
  const roman = ROMAN[s.toUpperCase()]
  if (roman) return { value: String(roman) }
  const n = readNumber(s)
  if (n.bad || n.value === undefined || !Number.isInteger(n.value)) return { bad: 'unreadable' }
  return n.value >= 1 && n.value <= 7 ? { value: String(n.value) } : { bad: 'out_of_range' }
}

/** `МЕТОД`: the linear method, however it is spelled. Anything else is another method, which is not guessed at. */
const LINEAR = /^(лин|linear|straight)/

/** `НАЧИСЛ`: whether the asset is depreciated. `НЕ` is the "no" the audit saw; an empty value is the program's yes. */
const NO = new Set(['НЕ', 'Н', 'NO', 'N', 'FALSE', '0'])
const YES = new Set(['ДА', 'Д', 'YES', 'Y', 'TRUE', '1'])

function readAccrues(raw: string | undefined): Read<boolean> {
  const s = String(raw ?? '').trim().toLocaleUpperCase('bg')
  if (!s) return {}
  if (NO.has(s)) return { value: false }
  if (YES.has(s)) return { value: true }
  return { bad: 'unreadable' }
}

/** An account by its code, as the chart holds it; a code with its name after it (`204 - Машини`) by its code. */
function accountOf<Id>(raw: string, chart: ReadonlyMap<string, Id>): { id: Id; code: string } | null {
  const code = raw.trim()
  if (chart.has(code)) return { id: chart.get(code)!, code }
  const lead = /^(\d{3,4})(?![\d])/.exec(code)?.[1]
  return lead && chart.has(lead) ? { id: chart.get(lead)!, code: lead } : null
}

/** Months from a term in years: `round(years × 12)`. */
export const monthsOfYears = (years: number) => Math.round(years * 12)

/** Float noise off a difference of two booked amounts (`100.1 − 33.37`), and no more than that. */
const tidy = (n: number) => Number(n.toFixed(10))

/** The rate × the term, which the audit found to be 100 on every asset, off by more than a rounded term explains. */
const mismatched = (rate: number | undefined, years: number | undefined) =>
  rate !== undefined && years !== undefined && rate > 0 && years > 0 && Math.abs(rate * years - 100) > 1

/**
 * FR-25a §4.2: what a `ДА` analytic's properties make of its fixed asset. Never throws, and reads nothing but its
 * arguments: `chartByCode` is the org's chart, each code to whatever the caller wants back as the account (an id).
 *
 * ```ts
 * const chart = new Map(accounts.map(a => [a.code, a._id]))
 * const { fields, problems } = mapFixedAssetParams(analytic.params ?? [], chart)
 * ```
 */
export function mapFixedAssetParams<Id>(params: readonly { key: string; value: string }[], chartByCode: ReadonlyMap<string, Id>): FixedAssetMapping<Id> {
  const kept = (params ?? [])
    .filter(p => typeof p?.key === 'string' && p.key.trim())
    .map(p => ({ key: p.key, value: String(p.value ?? '') }))
  const byKey = new Map<string, string>()
  for (const p of kept) if (!byKey.has(keyOf(p.key))) byKey.set(keyOf(p.key), p.value)
  const raw = (key: string) => byKey.get(keyOf(key))

  const fields: Partial<FixedAssetFields<Id>> = {}
  const problems: FixedAssetProblem[] = []
  const problem = (key: string, reason: FixedAssetProblemReason, affected: FixedAssetField[], value?: string, code?: string) => {
    problems.push({ key, reason, fields: affected, ...(code ? { code } : {}), ...(value?.trim() ? { value } : {}) })
  }
  const P = FIXED_ASSET_PARAMS

  // The accounts. The category is the asset's own account's code: it is known exactly when that account is.
  const accounts: [string, 'accountId' | 'depreciationAccountId' | 'accumulatedDepAccountId'][] = [
    [P.account, 'accountId'], [P.expenseAccount, 'depreciationAccountId'], [P.accumulatedAccount, 'accumulatedDepAccountId'],
  ]
  for (const [key, field] of accounts) {
    const affected: FixedAssetField[] = field === 'accountId' ? [field, 'category'] : [field]
    const value = raw(key)
    if (!value?.trim()) { problem(key, 'missing', affected); continue }
    const account = accountOf(value, chartByCode)
    if (!account) { problem(key, 'unknown_account', affected, value, value.trim()); continue }
    fields[field] = account.id
    if (field === 'accountId') fields.category = account.code
  }

  const method = raw(P.method)
  if (!method?.trim()) problem(P.method, 'missing', ['depreciationMethod'])
  else if (LINEAR.test(method.trim().toLocaleLowerCase('bg'))) fields.depreciationMethod = 'straight_line'
  else problem(P.method, 'unknown_method', ['depreciationMethod'], method)

  // The dates.
  const purchase = readDate(raw(P.date))
  if (purchase.value) fields.purchaseDate = purchase.value
  else problem(P.date, purchase.bad ?? 'missing', ['purchaseDate'], raw(P.date))

  const inService = readDate(raw(P.inService))
  if (inService.value) fields.inServiceDate = inService.value
  else if (inService.bad) problem(P.inService, inService.bad, ['inServiceDate'], raw(P.inService))

  const disposal = readDate(raw(P.disposal))
  if (disposal.value) fields.disposalDate = disposal.value
  else if (disposal.bad) problem(P.disposal, disposal.bad, ['disposalDate', 'status', 'currency'], raw(P.disposal))

  // The currency the properties are stated in. PlusMinus converted its asset register to euro at the changeover: an asset
  // still in it then (not written off before) is in EUR whatever the year it was bought in, one bought later was entered in
  // EUR, and one written off before the changeover left the register unconverted and stays in lev. Read off the
  // accountant's own file, by the shape of the stored values (whole-lev amounts only among the assets written off before
  // the changeover; amounts that are round only once converted only among the others), not assumed from the purchase year.
  // A write-off date that cannot be read leaves the currency unknown: an update keeps what the asset holds.
  if (!disposal.bad) fields.currency = fields.disposalDate && fields.disposalDate.toISOString().slice(0, 10) < EUR_CHANGEOVER ? 'BGN' : 'EUR'

  // The price: the value with later additions where the file states one, else the value. A total of 0 is no total:
  // it is below any value, and nothing is added to an asset to make it worth nothing.
  const value = readNumber(raw(P.value))
  const total = readNumber(raw(P.total))
  let price: number | undefined
  if (total.bad) {
    problem(P.total, total.bad, ['purchasePrice', 'currentValue'], raw(P.total))
    if (value.bad) problem(P.value, value.bad, [], raw(P.value))
  } else if (total.value !== undefined && total.value !== 0) {
    price = total.value
    if (value.bad) problem(P.value, value.bad, [], raw(P.value))
    else if (value.value !== undefined && total.value < value.value) problem(P.total, 'total_below_value', [])
  } else if (value.bad) {
    problem(P.value, value.bad, ['purchasePrice', 'currentValue'], raw(P.value))
  } else if (value.value !== undefined || total.value !== undefined) {
    price = value.value ?? total.value
  } else {
    problem(P.value, 'missing', ['purchasePrice', 'currentValue'])
  }
  if (price !== undefined) fields.purchasePrice = price

  // What the books start from: the price less the book depreciation accumulated before them.
  const opening = readNumber(raw(P.openingDepreciation))
  if (opening.bad) problem(P.openingDepreciation, opening.bad, ['currentValue'], raw(P.openingDepreciation))
  else if (price !== undefined) {
    fields.currentValue = tidy(price - (opening.value ?? 0))
    if (fields.currentValue < 0) problem(P.openingDepreciation, 'opening_above_value', [])
  }

  // Whether it is depreciated at all, and its status.
  const accrues = readAccrues(raw(P.accrues))
  if (accrues.bad) problem(P.accrues, accrues.bad, fields.disposalDate ? [] : ['status'], raw(P.accrues))
  if (fields.disposalDate) fields.status = 'disposed'
  else if (!disposal.bad && !accrues.bad) fields.status = accrues.value === false ? 'not_depreciated' : 'active'

  // The book term, in years; the rate where no term is stated (rate × term = 100); none where nothing is depreciated.
  const rate = percentOf(raw(P.rate))
  const term = termOf(raw(P.term))
  if (rate.bad) problem(P.rate, rate.bad, term.value !== undefined ? [] : ['usefulLifeMonths'], raw(P.rate))
  if (term.bad) problem(P.term, term.bad, rate.value ? [] : ['usefulLifeMonths'], raw(P.term))
  if (term.value !== undefined) fields.usefulLifeMonths = monthsOfYears(term.value)
  else if (rate.value) fields.usefulLifeMonths = Math.round(1200 / rate.value)
  else if (!term.bad && !rate.bad && (rate.value === 0 || accrues.value === false)) fields.usefulLifeMonths = 0
  else if (!term.bad && !rate.bad) problem(P.term, 'missing', ['usefulLifeMonths'])
  if (mismatched(rate.value, term.value)) problem(P.term, 'rate_term_mismatch', [])

  // The tax side (ЗКПО). Each field is optional: an empty value leaves it out.
  const category = readTaxCategory(raw(P.taxCategory))
  if (category.value) fields.taxCategory = category.value
  else if (category.bad) problem(P.taxCategory, category.bad, ['taxCategory'], raw(P.taxCategory))

  const taxRate = percentOf(raw(P.taxRate))
  if (taxRate.value !== undefined) fields.taxDepreciationRate = taxRate.value
  else if (taxRate.bad) problem(P.taxRate, taxRate.bad, ['taxDepreciationRate'], raw(P.taxRate))

  const taxTerm = termOf(raw(P.taxTerm))
  if (taxTerm.value !== undefined) fields.taxUsefulLifeMonths = monthsOfYears(taxTerm.value)
  else if (taxTerm.bad) problem(P.taxTerm, taxTerm.bad, ['taxUsefulLifeMonths'], raw(P.taxTerm))
  if (mismatched(taxRate.value, taxTerm.value)) problem(P.taxTerm, 'rate_term_mismatch', [])

  const taxValue = readNumber(raw(P.taxValue))
  if (taxValue.value !== undefined) fields.taxValue = taxValue.value
  else if (taxValue.bad) problem(P.taxValue, taxValue.bad, ['taxValue'], raw(P.taxValue))

  if (kept.length) fields.params = kept
  return { fields, problems }
}

/**
 * What an asset is not made without: the model requires each, and none has a value of its own to fall back on. (Its book
 * value starts at its price where `НАЧ.АМ.` cannot be read, and its status at active, as LGR's own assets do.)
 */
export const FIXED_ASSET_REQUIRED: readonly FixedAssetField[] = [
  'accountId', 'depreciationAccountId', 'accumulatedDepAccountId', 'category', 'depreciationMethod', 'purchaseDate', 'purchasePrice', 'usefulLifeMonths',
]

/** Whether an import would make an asset of these fields. */
export const canMakeAsset = (fields: Partial<FixedAssetFields<unknown>>) => FIXED_ASSET_REQUIRED.every(f => fields[f] !== undefined)

/** A rate in percent: 0–100, a `%` after it allowed. */
function percentOf(raw: string | undefined): Read<number> {
  const n = readNumber(raw, { percent: true })
  return n.value !== undefined && (n.value < 0 || n.value > 100) ? { bad: 'out_of_range' } : n
}

/** A term in years: never negative. */
function termOf(raw: string | undefined): Read<number> {
  const n = readNumber(raw)
  return n.value !== undefined && n.value < 0 ? { bad: 'out_of_range' } : n
}
