/**
 * FR-25: the vocabulary of the imported books, in one table. Document types, analytic roots and the
 * shape of an account are data here, so no other file spells `-ФЕ` or `СТОКИ` (FR-25 §11).
 *
 * The codes are PlusMinus's own, from the accountant's install: `salesDocs` and `purchasesDocs` in
 * its settings, plus what the journal of a whole year was seen to hold. A code that is not here is
 * still imported as booked, and the answer lists it (`unknownDocTypes`).
 *
 * Import-pure: the CLI and the unit tests read this without booting anything.
 */
import type { AnalyticKind } from 'db/models/accounting-analytic.model'

/** A bank document's comment names the invoices it pays; a sales document's number says whose it is. */
export type DocFamily = 'sales' | 'purchase' | 'vat' | 'bank' | 'stock' | 'payroll' | 'other'

export interface DocTypeDef {
  code: string
  family: DocFamily
}

export const DOC_TYPES: readonly DocTypeDef[] = [
  { code: '-Ф', family: 'sales' },
  { code: '-ФЕ', family: 'sales' },
  { code: '-ФЕА', family: 'sales' },
  { code: '-ФИ', family: 'sales' },
  { code: '-ФИЕ', family: 'sales' },
  { code: '-ФА', family: 'sales' },
  { code: 'КП', family: 'sales' },
  { code: 'НА', family: 'sales' },
  { code: 'ПЗИ', family: 'sales' },
  { code: '+Ф', family: 'purchase' },
  { code: '+ФЕ', family: 'purchase' },
  { code: '+ФЕИ', family: 'purchase' },
  { code: '+ФЕА', family: 'purchase' },
  { code: '+МД', family: 'purchase' },
  { code: 'МД', family: 'purchase' },
  { code: 'ПЗП', family: 'purchase' },
  { code: '-П', family: 'vat' },
  { code: 'П79', family: 'vat' },
  { code: '-ПЛН', family: 'vat' },
  { code: '+ББ', family: 'bank' },
  { code: '-ББ', family: 'bank' },
  { code: 'ББ', family: 'bank' },
  { code: '+БВ', family: 'bank' },
  { code: '-БВ', family: 'bank' },
  { code: 'СИ', family: 'stock' },
  { code: 'СТ', family: 'stock' },
  { code: 'СР', family: 'stock' },
  { code: 'ЗАП', family: 'payroll' },
  { code: 'ЗП', family: 'payroll' },
]

const DOC_TYPE_BY_CODE = new Map(DOC_TYPES.map(d => [d.code, d]))

export function docTypeDef(code: string | undefined): DocTypeDef | undefined {
  return code ? DOC_TYPE_BY_CODE.get(code) : undefined
}

/**
 * What a bank line's comment settles: `-ФЕ 123,-ФЕ 124` in the journal. Every token is matched whole
 * against the registry: `-ФЕ` is a prefix of `-ФЕА` and the two are different documents. What is not
 * an invoice reference (`Такса`, a date, a bare number) names nothing.
 */
export function settlesOf(comment: string | undefined): { docType: string; docNumber: string }[] {
  if (!comment) return []
  const out: { docType: string; docNumber: string }[] = []
  for (const token of comment.split(',')) {
    const m = /^\s*(\S+?)\s*(\d+)\s*$/.exec(token)
    if (m && DOC_TYPE_BY_CODE.has(m[1])) out.push({ docType: m[1], docNumber: m[2] })
  }
  return out
}

export interface AnalyticRootDef {
  /** The path's first segment, as PlusMinus writes it. */
  root: string
  kind: AnalyticKind
  /** Its lines carry stock: quantities are shown for it, and its accounts are quantitative. */
  quantitative?: boolean
  /** Names the counterparty of a document. */
  partner?: boolean
  /** The word for it in the reports' filter (`reports.accountingBooks.roots.*`). */
  labelKey: string
}

export const ANALYTIC_ROOTS: readonly AnalyticRootDef[] = [
  { root: 'СТОКИ', kind: 'goods_group', quantitative: true, labelKey: 'goods' },
  { root: 'МАТЕРИАЛИ', kind: 'material', quantitative: true, labelKey: 'materials' },
  { root: 'ПРОДУКЦИЯ', kind: 'product', quantitative: true, labelKey: 'production' },
  { root: 'УСЛУГИ', kind: 'service', labelKey: 'services' },
  { root: 'КЛИЕНТИ', kind: 'customer', partner: true, labelKey: 'customers' },
  { root: 'ДОСТАВЧИЦИ', kind: 'supplier', partner: true, labelKey: 'suppliers' },
  { root: 'ПАРТНЬОРИ', kind: 'partner', partner: true, labelKey: 'partners' },
  { root: 'БАНКОВИ СМЕТКИ', kind: 'bank_account', labelKey: 'bankAccounts' },
  { root: 'РАЗХОДИ', kind: 'expense', labelKey: 'expenses' },
  { root: 'ПРИХОДИ', kind: 'income', labelKey: 'income' },
  { root: 'РАЗЧЕТИ', kind: 'settlement', labelKey: 'settlements' },
  { root: 'ПЕРСОНАЛ', kind: 'personnel', labelKey: 'personnel' },
  { root: 'ДА', kind: 'fixed_asset', labelKey: 'fixedAssets' },
]

const ROOT_BY_NAME = new Map(ANALYTIC_ROOTS.map(r => [r.root, r]))

export function analyticRootDef(root: string | undefined): AnalyticRootDef | undefined {
  return root ? ROOT_BY_NAME.get(root) : undefined
}

/** A path's first segment. A path with no `:` is a root of its own (a few exist, `other` in kind). */
export function rootOfPath(path: string): string {
  const i = path.indexOf(':')
  return i < 0 ? path : path.slice(0, i)
}

/** `A:B:C` → `A`, `A:B`: what must exist above a path for the tree to hold. */
export function ancestorsOfPath(path: string): string[] {
  const parts = path.split(':')
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join(':'))
  return out
}

/** The last segment: the analytic's own name. */
export function nameOfPath(path: string): string {
  const i = path.lastIndexOf(':')
  return i < 0 ? path : path.slice(i + 1)
}

export const lowerBg = (s: string) => s.toLocaleLowerCase('bg')

/** The series an imported entry's number is drawn from. */
export const ENTRY_NUMBER_PREFIX = 'PM'

/**
 * FR-25a: how a document is paid (`ПЛАЩАНЕ`, which the file writes a second time as `ВИДПЛА`), by its code as booked.
 * Read off the accountant's whole journal, not guessed: a document coded `1` settles in cash on its own operations
 * (all but a handful touch the cash account, and on a sale its `paidCash` is what was paid); one coded `2` touches
 * neither cash nor a bank account itself, and its paid amount is what the bank documents linked to it paid. Bank and
 * VAT documents carry no code. A code not listed here is still stored as booked.
 */
export const PAYMENT_CODES: Readonly<Record<string, 'cash' | 'bank'>> = { '1': 'cash', '2': 'bank' }

/** The VAT accounts: what makes an operation the VAT of its document. */
export const VAT_INPUT_ACCOUNT = '4531'
export const VAT_OUTPUT_ACCOUNT = '4532'

/** Where a bank account's money is booked: the local-currency one, and the foreign-currency one. */
export const BANK_ACCOUNT_LOCAL = '503'
export const BANK_ACCOUNT_FOREIGN = '504'

/**
 * The euro changeover. Anything before it is BGN in the source, and PlusMinus converts at read time;
 * the import converts once and stores both (FR-25 §11). Divide by the full rate and round to two
 * decimals (Euro Act чл. 12–13).
 */
export const EUR_CHANGEOVER = '2026-01-01'
export const BGN_PER_EUR = 1.95583

/** Every month a period touches, in order: `2025-11`, `2025-12`, `2026-01`. */
export function monthsBetween(from: string, to: string): string[] {
  const months: string[] = []
  let year = Number(from.slice(0, 4))
  let month = Number(from.slice(5, 7))
  const last = to.slice(0, 7)
  for (;;) {
    const label = `${year}-${String(month).padStart(2, '0')}`
    if (label > last) return months
    months.push(label)
    month = month === 12 ? 1 : month + 1
    if (month === 1) year++
  }
}

/** The currency the books were kept in on a day. */
export function ledgerCurrencyOn(isoDate: string): 'BGN' | 'EUR' {
  return isoDate < EUR_CHANGEOVER ? 'BGN' : 'EUR'
}

/** Half away from zero, so a correction of −x rounds to −round(x), and exact in the binary sense. */
export function roundCents(x: number): number {
  const scaled = x * 100
  const nudged = scaled + (scaled >= 0 ? 1e-7 : -1e-7)
  const out = (nudged >= 0 ? Math.floor(nudged + 0.5) : Math.ceil(nudged - 0.5)) / 100
  return out === 0 ? 0 : out
}

/** The amount in the base currency, as a line stores it. */
export function baseAmount(amount: number, currency: 'BGN' | 'EUR'): number {
  return roundCents(currency === 'BGN' ? amount / BGN_PER_EUR : amount)
}

/** `baseDebit = debit × exchangeRate`, as `auto-journal.service.ts#buildLine` has it. */
export function exchangeRateOf(currency: 'BGN' | 'EUR'): number {
  return currency === 'BGN' ? 1 / BGN_PER_EUR : 1
}

export interface AccountShape {
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
  subType: string
  balanceSide: 'debit' | 'credit' | 'both'
}

/**
 * What an account is, from its first digits (FR-25 §3.3): a chart's code says it, and the export has
 * no other column for it. Settlement accounts run on both sides, and a credit balance on 411 is an
 * ordinary thing. Correspondence and every report read the lines, never this.
 */
export function accountShapeOf(code: string): AccountShape {
  const two = code.slice(0, 2)
  const three = code.slice(0, 3)
  switch (code[0]) {
    case '1':
      if (three === '123') return { type: 'equity', subType: 'retained_earnings', balanceSide: 'both' }
      if (two === '12') return { type: 'equity', subType: 'retained_earnings', balanceSide: 'credit' }
      if (three === '152' || three === '153' || three === '159') return { type: 'liability', subType: 'long_term_liability', balanceSide: 'credit' }
      if (two === '15' || two === '16' || two === '17') return { type: 'liability', subType: 'current_liability', balanceSide: 'credit' }
      return { type: 'equity', subType: 'owner_equity', balanceSide: 'credit' }
    case '2':
      // 241x is accumulated depreciation: an asset's account with a credit balance.
      return { type: 'asset', subType: 'fixed_asset', balanceSide: two === '24' ? 'credit' : 'debit' }
    case '3':
    case '5':
      return { type: 'asset', subType: 'current_asset', balanceSide: 'debit' }
    case '4':
      // Advances to suppliers, and what customers and others owe.
      if (three === '402' || three === '411' || three === '492' || three === '498') return { type: 'asset', subType: 'current_asset', balanceSide: 'both' }
      return { type: 'liability', subType: 'current_liability', balanceSide: 'both' }
    case '6':
      if (two === '62' || two === '69') return { type: 'expense', subType: 'other_expense', balanceSide: 'debit' }
      return { type: 'expense', subType: 'operating_expense', balanceSide: 'debit' }
    case '7':
      if (two === '70') return { type: 'revenue', subType: 'operating_revenue', balanceSide: 'credit' }
      return { type: 'revenue', subType: 'other_revenue', balanceSide: 'credit' }
    default:
      // 98x and 99x: off the balance sheet, active and passive.
      return code.startsWith('99')
        ? { type: 'liability', subType: 'other_liability', balanceSide: 'credit' }
        : { type: 'asset', subType: 'other_asset', balanceSide: 'debit' }
  }
}

/** A chart row worth keeping: a 3 or 4 digit code with a name. PlusMinus accumulates others. */
export function chartJunkReason(code: string, name: string): string | null {
  if (!/^\d{3,4}$/.test(code)) return 'code'
  if (!name.trim()) return 'name'
  return null
}
