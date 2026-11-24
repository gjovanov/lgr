/**
 * FR-25a §3.4: the fixed-asset screens as data. The form's fields read from an asset and written back as the API takes
 * them, the tax side's errors and hints, the grid's filters, the words for a status, the book plan the form has always
 * shown. The tax side's own rules are `config/fixed-asset-tax.ts`, which the routes share.
 *
 * Import-pure, beside the views: `unit/fixed-asset-form.test.ts` reads it.
 */
import {
  ASSET_AS_BOOKED, FIXED_ASSET_STATUSES, TAX_FIELDS, aboveStatutoryRate, dayOf, inServiceBeforePurchase, isImportedAsset,
  rateTermMismatch, rateTermProduct, readTaxField, statutoryTaxRate, taxCategoryCode, yearsOfMonths,
  type TaxField, type TaxProblemCode,
} from 'config/fixed-asset-tax'

export { isImportedAsset }

/** What the form holds. The tax side's empty is none: null for a number and the category, '' for the date. */
export interface FixedAssetForm {
  code: string
  name: string
  category: string
  purchaseDate: string
  purchasePrice: number
  salvageValue: number
  depreciationMethod: string
  /** Entered in years, stored in months (#675). */
  usefulLifeYears: number
  status: string
  accountId: string
  depreciationAccountId: string
  accumulatedDepAccountId: string
  taxCategory: string | null
  taxDepreciationRate: number | null
  taxUsefulLifeMonths: number | null
  taxValue: number | null
  inServiceDate: string
}

export function emptyForm(): FixedAssetForm {
  return {
    code: '',
    name: '',
    category: '',
    purchaseDate: '',
    purchasePrice: 0,
    salvageValue: 0,
    depreciationMethod: 'straight_line',
    usefulLifeYears: 5,
    status: 'active',
    accountId: '',
    depreciationAccountId: '',
    accumulatedDepAccountId: '',
    taxCategory: null,
    taxDepreciationRate: null,
    taxUsefulLifeMonths: null,
    taxValue: null,
    inServiceDate: '',
  }
}

const numberOrNull = (v: unknown): number | null => {
  if (v === '' || v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** What the form holds of a loaded asset. The book fields as the form has read them since #675. */
export function formOf(asset: Record<string, any>): FixedAssetForm {
  return {
    code: asset.code || '',
    name: asset.name || '',
    category: asset.category || '',
    purchaseDate: dayOf(asset.purchaseDate) ?? '',
    purchasePrice: asset.purchasePrice || 0,
    salvageValue: asset.salvageValue || 0,
    depreciationMethod: asset.depreciationMethod || 'straight_line',
    usefulLifeYears: asset.usefulLifeMonths ? Math.round((asset.usefulLifeMonths / 12) * 100) / 100 : 5,
    status: asset.status || 'active',
    accountId: asset.accountId || '',
    depreciationAccountId: asset.depreciationAccountId || '',
    accumulatedDepAccountId: asset.accumulatedDepAccountId || '',
    taxCategory: taxCategoryCode(asset.taxCategory) ?? null,
    taxDepreciationRate: numberOrNull(asset.taxDepreciationRate),
    taxUsefulLifeMonths: numberOrNull(asset.taxUsefulLifeMonths),
    taxValue: numberOrNull(asset.taxValue),
    inServiceDate: dayOf(asset.inServiceDate) ?? '',
  }
}

/**
 * What the route stores: the model's fields, the useful life in months (#675). A new asset's book value (`currentValue`)
 * starts at its price, and its currency is the org's; an edit leaves both as stored. The tax side (FR-25a §3.4): a
 * cleared field is sent as null, which the route removes.
 */
export function payloadOf(form: FixedAssetForm, opts: { isEdit: boolean; currency?: string }): Record<string, unknown> {
  const f = form
  return {
    code: f.code,
    name: f.name,
    category: f.category,
    purchaseDate: f.purchaseDate,
    purchasePrice: Number(f.purchasePrice) || 0,
    salvageValue: Number(f.salvageValue) || 0,
    usefulLifeMonths: Math.max(1, Math.round((Number(f.usefulLifeYears) || 0) * 12)),
    depreciationMethod: f.depreciationMethod,
    status: f.status,
    accountId: f.accountId,
    depreciationAccountId: f.depreciationAccountId,
    accumulatedDepAccountId: f.accumulatedDepAccountId,
    taxCategory: f.taxCategory || null,
    taxDepreciationRate: numberOrNull(f.taxDepreciationRate),
    taxUsefulLifeMonths: numberOrNull(f.taxUsefulLifeMonths),
    taxValue: numberOrNull(f.taxValue),
    inServiceDate: f.inServiceDate || null,
    ...(opts.isEdit ? {} : { currentValue: Number(f.purchasePrice) || 0, ...(opts.currency ? { currency: opts.currency } : {}) }),
  }
}

// ── The tax side ────────────────────────────────────────────────────────────────────────────────

/** The label key of a tax problem's words. */
export const taxErrorKey = (code: TaxProblemCode) => `accounting.fixedAssetBooks.tax.errors.${code}`

/** What the route would refuse in the form's tax side, field by field: each field's own rule, and the dates' order. */
export function taxFieldProblems(form: FixedAssetForm): Partial<Record<TaxField, TaxProblemCode>> {
  const sent = payloadOf(form, { isEdit: true })
  const out: Partial<Record<TaxField, TaxProblemCode>> = {}
  for (const field of TAX_FIELDS) {
    const read = readTaxField(field, sent[field])
    if ('problem' in read) out[field] = read.problem
  }
  if (!out.inServiceDate && inServiceBeforePurchase(sent.inServiceDate, sent.purchaseDate)) out.inServiceDate = 'in_service_before_purchase'
  return out
}

export interface TaxHints {
  /** The category's statutory maximum yearly rate, for the rate's hint. */
  statutoryRate?: number
  /** The rate is above it. */
  aboveStatutory: boolean
  /** The rate × the term in years where they disagree (§3.4: a hint when it is not about 100). */
  mismatch?: number
  /** The term in years, beside the months. */
  years?: number
}

export function taxHints(form: FixedAssetForm): TaxHints {
  const rate = numberOrNull(form.taxDepreciationRate)
  const months = numberOrNull(form.taxUsefulLifeMonths)
  return {
    statutoryRate: statutoryTaxRate(form.taxCategory, months),
    aboveStatutory: aboveStatutoryRate(form.taxCategory, rate, months),
    ...(rateTermMismatch(rate, months) ? { mismatch: rateTermProduct(rate, months) } : {}),
    ...(months !== null && months > 0 ? { years: yearsOfMonths(months) } : {}),
  }
}

/**
 * The rate after a person picks a category (§3.4: defaulted from the category's statutory rate, but editable): the new
 * category's maximum where the rate was empty or still the old category's maximum; the rate a person typed stays.
 */
export function rateAfterCategoryChange(previous: string | null, next: string | null, rate: number | null, months: number | null): number | null {
  const typed = numberOrNull(rate)
  const old = statutoryTaxRate(previous, months)
  const fresh = statutoryTaxRate(next, months)
  if (typed === null || (old !== undefined && Math.abs(typed - old) < 0.005)) return fresh ?? typed
  return typed
}

/** The tax value a category pick leaves (§3.4: it defaults to the purchase price): the price where none is stated. */
export function taxValueAfterCategoryChange(taxValue: number | null, purchasePrice: number | null): number | null {
  const held = numberOrNull(taxValue)
  if (held !== null) return held
  const price = numberOrNull(purchasePrice)
  return price !== null && price > 0 ? price : null
}

// ── Statuses ────────────────────────────────────────────────────────────────────────────────────

/** The label key of a status the model knows, or undefined (show it as stored). */
export function statusLabelKey(status: unknown): string | undefined {
  return (FIXED_ASSET_STATUSES as readonly string[]).includes(String(status)) ? `accounting.fixedAssetBooks.statuses.${status}` : undefined
}

const STATUS_COLORS: Record<string, string> = {
  active: 'success',
  disposed: 'grey',
  fully_depreciated: 'warning',
  not_depreciated: 'blue-grey',
}

export function statusColor(status: unknown): string {
  return STATUS_COLORS[String(status)] ?? 'grey'
}

// ── The grid ────────────────────────────────────────────────────────────────────────────────────

/** What the grid's filters hold. A select left empty is null. */
export interface FixedAssetFilterState {
  search?: string | null
  /** `1`–`7`, or `none`. */
  taxCategory?: string | null
  origin?: 'imported' | 'native' | null
}

/** The filters as the list takes them (`fixed-asset.service.ts#fixedAssetListFilter`): only what is set. */
export function fixedAssetFilters(state: FixedAssetFilterState): Record<string, string> {
  const out: Record<string, string> = {}
  const search = (state.search ?? '').trim()
  if (search) out.search = search
  if (state.taxCategory) out.taxCategory = state.taxCategory
  if (state.origin) out.imported = state.origin === 'imported' ? 'true' : 'false'
  return out
}

// ── Money and links ─────────────────────────────────────────────────────────────────────────────

/** The currency an asset's amounts are stated in: its own (an asset of the books written off before the euro is in lev), else the org's. */
export function assetCurrency(asset: { currency?: unknown } | null | undefined, orgCurrency?: string | null): string {
  return (typeof asset?.currency === 'string' && asset.currency) || orgCurrency || 'EUR'
}

export interface AnalyticLink {
  _id: string
  path: string
}

/**
 * The analytics the form links: the asset's own (`analyticId`, the books' `ДА` analytic it was made from) and any other
 * that points at it, each once, its own first. Named by the path where the analytics list gave it, else by the asset's
 * code, which for an asset of the books is that path.
 */
export function analyticLinks(asset: { analyticId?: unknown; code?: unknown }, pointing: readonly AnalyticLink[]): AnalyticLink[] {
  const out: AnalyticLink[] = []
  const own = typeof asset.analyticId === 'string' && asset.analyticId ? asset.analyticId : undefined
  if (own) out.push({ _id: own, path: pointing.find(a => a._id === own)?.path ?? String(asset.code ?? '') })
  for (const a of pointing) if (a._id !== own) out.push({ _id: a._id, path: a.path })
  return out
}

/** The key of a refusal's words, or undefined for a code without any (show the server's message). */
export function refusalKey(data: { code?: unknown; problems?: { code?: unknown }[] } | null | undefined): string | undefined {
  if (data?.code === ASSET_AS_BOOKED) return 'accounting.fixedAssetBooks.errors.books_as_booked'
  const first = data?.code === 'fixed_asset_tax_invalid' ? data.problems?.[0]?.code : undefined
  return typeof first === 'string' ? taxErrorKey(first as TaxProblemCode) : undefined
}

// ── The book plan ───────────────────────────────────────────────────────────────────────────────

export interface BookPlanRow {
  year: number
  depreciation: number
  accumulated: number
  bookValue: number
}

/**
 * The straight-line plan the form has always shown for an asset kept in LGR: a year at a time over the useful life, from
 * the price less the salvage value. A projection: nothing in LGR posts it.
 */
export function bookPlan(purchasePrice: unknown, salvageValue: unknown, usefulLifeYears: unknown): BookPlanRow[] {
  const cost = (Number(purchasePrice) || 0) - (Number(salvageValue) || 0)
  // A typo of a life (5000 years) draws 200 rows, not a frozen page.
  const life = Math.min(Math.round(Number(usefulLifeYears) || 0), 200)
  if (!cost || life <= 0) return []
  const annual = cost / life
  const rows: BookPlanRow[] = []
  let accumulated = 0
  for (let y = 1; y <= life; y++) {
    accumulated += annual
    rows.push({
      year: y,
      depreciation: Math.round(annual * 100) / 100,
      accumulated: Math.round(accumulated * 100) / 100,
      bookValue: Math.round((cost - accumulated) * 100) / 100,
    })
  }
  return rows
}
