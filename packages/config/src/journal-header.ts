/**
 * FR-25a §3.6, §3.8: a journal entry's document header, as the API checks it and the entry form shows it.
 *
 * The books import writes the header as booked (`services/biz/accounting-books`), and an entry it wrote is read-only for
 * everyone: the next import would overwrite an edit, and a book the accountant filed must not differ from ours. An entry
 * made in LGR may carry the same header, and these are the rules it is saved by, the same on both sides of the wire.
 *
 * Import-pure: the journal routes, the entry form and their tests read it.
 */

/**
 * `sourceModule` of an entry the books import wrote. Mirrors `db/models#BOOKS_IMPORT`, which this package cannot import
 * (`unit/journal-header.test.ts` holds the two equal).
 */
export const BOOKS_SOURCE_MODULE = 'plusminus'

/** Written by the books import: as booked, and read-only for everyone. */
export function isAsBooked(entry: { sourceModule?: unknown } | null | undefined): boolean {
  return entry?.sourceModule === BOOKS_SOURCE_MODULE
}

// ── How the document is paid ─────────────────────────────────────────────────────────────────────

export type PaymentWay = 'cash' | 'bank'

/** `ПЛАЩАНЕ` as booked. Mirrors `services/biz/accounting-books/registry.ts#PAYMENT_CODES` (held equal by a test). */
export const PAYMENT_CODES: Readonly<Record<string, PaymentWay>> = { '1': 'cash', '2': 'bank' }

export const PAYMENT_WAYS: readonly PaymentWay[] = ['cash', 'bank']

export function paymentWayOf(code: unknown): PaymentWay | undefined {
  return typeof code === 'string' ? PAYMENT_CODES[code.trim()] : undefined
}

export function paymentCodeOf(way: unknown): string | undefined {
  return Object.keys(PAYMENT_CODES).find(code => PAYMENT_CODES[code] === way)
}

// ── The NRA register's document type ─────────────────────────────────────────────────────────────

/**
 * `ВИДДОК`, the only thing that tells a credit notice from an invoice of the same document type. Booked as `1`, `2`,
 * `3`, `07`, `09` or `9`, `81`; `VatRegisterEntry.docTypeCode` and `Invoice.vatDocTypeCode` hold it with two digits.
 */
export const REGISTER_DOC_TYPES = [
  { code: '01', key: 'invoice' },
  { code: '02', key: 'debitNotice' },
  { code: '03', key: 'creditNotice' },
  { code: '07', key: 'customs' },
  { code: '09', key: 'protocol' },
  { code: '81', key: 'tillReport' },
] as const

export type RegisterDocTypeKey = (typeof REGISTER_DOC_TYPES)[number]['key']

/** The two-digit code of a register type however it was booked (`1` → `01`), or undefined for none. */
export function registerDocTypeCode(value: unknown): string | undefined {
  const s = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  return /^\d{1,2}$/.test(s) ? s.padStart(2, '0') : undefined
}

/** The label key (`accounting.journalEntry.document.registerDocTypes.<key>`) of a known register type. */
export function registerDocTypeKey(value: unknown): RegisterDocTypeKey | undefined {
  const code = registerDocTypeCode(value)
  return REGISTER_DOC_TYPES.find(t => t.code === code)?.key
}

/** Every way a stored entry may spell the register type of this code (`01` → `01`, `1`): what a query asks for. */
export function registerDocTypeVariants(value: unknown): string[] {
  const code = registerDocTypeCode(value)
  if (!code) return []
  return code.startsWith('0') ? [code, code.slice(1)] : [code]
}

/** The notices: a debit and a credit notice, which must say what they correct. */
export const NOTICE_REGISTER_TYPES: readonly string[] = ['02', '03']

export function isNotice(registerDocType: unknown): boolean {
  return NOTICE_REGISTER_TYPES.includes(registerDocTypeCode(registerDocType) ?? '')
}

/** The stored spellings of the notices, for the "notices only" filter. */
export const NOTICE_REGISTER_VARIANTS: readonly string[] = NOTICE_REGISTER_TYPES.flatMap(registerDocTypeVariants)

// ── The document types ───────────────────────────────────────────────────────────────────────────

export type DocFamily = 'sales' | 'purchase' | 'vat' | 'bank' | 'stock' | 'payroll' | 'other'

/**
 * The accountant's document types by family. Mirrors `services/biz/accounting-books/registry.ts#DOC_TYPES`, which a UI
 * cannot import (a test holds the two equal). An entry made in LGR may use any other text.
 */
export const JOURNAL_DOC_TYPES: readonly { code: string; family: DocFamily }[] = [
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

export function docFamilyOf(docType: unknown): DocFamily | undefined {
  const code = typeof docType === 'string' ? docType.trim() : ''
  return JOURNAL_DOC_TYPES.find(d => d.code === code)?.family
}

/**
 * A sales invoice: a sales document whose register type is the invoice. The register type is what tells an invoice from a
 * notice of the same document type, so a sales document without one is not taken for an invoice.
 */
export function isSalesInvoice(h: { docType?: unknown; registerDocType?: unknown }): boolean {
  return docFamilyOf(h.docType) === 'sales' && registerDocTypeCode(h.registerDocType) === '01'
}

/** The rates a document is charged at, in percent. */
export const VAT_RATES: readonly number[] = [20, 9, 0]

// ── Months ───────────────────────────────────────────────────────────────────────────────────────

const MONTH = /^\d{4}(0[1-9]|1[0-2])$/

/** `YYYYMM`, as `reportingMonth`, `Invoice.vatPeriod` and `VatRegisterEntry.period` hold a month. */
export function isMonth(value: unknown): value is string {
  return typeof value === 'string' && MONTH.test(value)
}

/** The `YYYYMM` of a day. Days are stored at UTC midnight, so it is read in UTC. */
export function monthOfDay(day: Date | string | null | undefined): string | undefined {
  if (!day) return undefined
  const d = day instanceof Date ? day : new Date(day)
  if (Number.isNaN(d.getTime())) return undefined
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** `YYYYMM` → `YYYY-MM`, the value of a month input. */
export function monthInputOf(month: unknown): string {
  return isMonth(month) ? `${month.slice(0, 4)}-${month.slice(4)}` : ''
}

/** A month input's `YYYY-MM` → `YYYYMM`; undefined for anything else. */
export function monthOfInput(value: unknown): string | undefined {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})$/.exec(value.trim()) : null
  const month = m ? `${m[1]}${m[2]}` : undefined
  return isMonth(month) ? month : undefined
}

/**
 * Reported in another month than its own: a purchase invoice declared in a later VAT return, a payroll posting of
 * another month. The month it names is compared with its own, so a month that only restates the entry's is not "other".
 */
export function isDeclaredInAnotherMonth(e: { reportingMonth?: unknown; date?: Date | string | null }): boolean {
  return isMonth(e.reportingMonth) && e.reportingMonth !== monthOfDay(e.date ?? undefined)
}

/** The month bounds of a `YYYYMM` period, at UTC midnight: `[from, to)`. */
export function monthBounds(month: string): { from: Date; to: Date } {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(4, 6))
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) }
}

// ── What is paid, and what is still open ─────────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100 || 0

/** What of the document is still to pay: its total less what is paid. Undefined for an entry with no document total. */
export function openAmountOf(e: { docTotal?: number | null; paidAmount?: number | null }): number | undefined {
  if (typeof e.docTotal !== 'number' || !Number.isFinite(e.docTotal)) return undefined
  return round2(e.docTotal - (typeof e.paidAmount === 'number' ? e.paidAmount : 0))
}

/**
 * Unpaid: a document that is paid in some way (`paymentCode`) and whose paid amount falls short of its total. Compared
 * by size, so a credit notice not yet refunded is open too. The journal list asks the same in Mongo
 * (`services/biz/journal-header.service.ts#journalListFilter`).
 */
export function isUnpaid(e: { paymentCode?: unknown; docTotal?: number | null; paidAmount?: number | null }): boolean {
  if (typeof e.paymentCode !== 'string' || !e.paymentCode) return false
  if (typeof e.docTotal !== 'number' || !Number.isFinite(e.docTotal)) return false
  const paid = typeof e.paidAmount === 'number' ? Math.abs(e.paidAmount) : 0
  return paid + 0.005 < Math.abs(e.docTotal)
}

// ── The header an entry made in LGR may carry ────────────────────────────────────────────────────

export interface JournalLinkInput {
  docType: string
  docNumber: string
  date?: string | Date | null
  amount?: number | null
  amountFx?: number | null
}

/** The header fields an LGR-native entry may set. `docOptions` and `source` are the import's alone. */
export interface JournalHeaderInput {
  docType?: string | null
  docNumber?: string | null
  docDate?: string | Date | null
  registerDocType?: string | null
  reasonRef?: string | null
  paymentCode?: string | null
  paidAmount?: number | null
  paidCash?: number | null
  bankOperation?: string | null
  vatKind?: string | null
  vatRate?: number | null
  vatRule?: string | null
  vatExemptionReason?: string | null
  taxEventDate?: string | Date | null
  reportingMonth?: string | null
  protocolType?: string | null
  customsRef?: string | null
  links?: JournalLinkInput[] | null
}

export const JOURNAL_HEADER_FIELDS = [
  'docType', 'docNumber', 'docDate', 'registerDocType', 'reasonRef', 'paymentCode', 'paidAmount', 'paidCash',
  'bankOperation', 'vatKind', 'vatRate', 'vatRule', 'vatExemptionReason', 'taxEventDate', 'reportingMonth',
  'protocolType', 'customsRef', 'links',
] as const satisfies readonly (keyof JournalHeaderInput)[]

export type JournalHeaderField = (typeof JOURNAL_HEADER_FIELDS)[number]

/** What `headerProblems` may say of a field; the entry form words each (`accounting.journalEntry.errors.<code>`). */
export const HEADER_PROBLEM_CODES = [
  'payment_code_unknown',
  'paid_cash_exceeds_paid',
  'vat_rate_unknown',
  'exemption_reason_required',
  'register_doc_type_unknown',
  'reason_ref_required',
  'reporting_month_invalid',
  'date_invalid',
  'link_incomplete',
] as const

export type HeaderProblemCode = (typeof HEADER_PROBLEM_CODES)[number]

export interface HeaderProblem {
  field: JournalHeaderField
  code: HeaderProblemCode
}

const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && !v.trim())
const isDay = (v: unknown) => {
  if (v instanceof Date) return !Number.isNaN(v.getTime())
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(new Date(v).getTime())
}

/**
 * What is wrong with a header, field by field: nothing for a valid one. The rules of §3.6 (`paidCash` ≤ `paidAmount`;
 * the exemption ground on a sales invoice at 0 %; the reference on a notice) and the vocabulary each field is booked in.
 */
export function headerProblems(h: JournalHeaderInput): HeaderProblem[] {
  const out: HeaderProblem[] = []
  if (!blank(h.paymentCode) && !paymentWayOf(h.paymentCode)) out.push({ field: 'paymentCode', code: 'payment_code_unknown' })
  if (typeof h.paidCash === 'number' && h.paidCash > (typeof h.paidAmount === 'number' ? h.paidAmount : 0) + 0.005) {
    out.push({ field: 'paidCash', code: 'paid_cash_exceeds_paid' })
  }
  if (typeof h.vatRate === 'number' && !VAT_RATES.includes(h.vatRate)) out.push({ field: 'vatRate', code: 'vat_rate_unknown' })
  if (h.vatRate === 0 && isSalesInvoice(h) && blank(h.vatExemptionReason)) {
    out.push({ field: 'vatExemptionReason', code: 'exemption_reason_required' })
  }
  if (!blank(h.registerDocType) && !registerDocTypeKey(h.registerDocType)) {
    out.push({ field: 'registerDocType', code: 'register_doc_type_unknown' })
  }
  if (isNotice(h.registerDocType) && blank(h.reasonRef)) out.push({ field: 'reasonRef', code: 'reason_ref_required' })
  if (!blank(h.reportingMonth) && !isMonth(h.reportingMonth)) out.push({ field: 'reportingMonth', code: 'reporting_month_invalid' })
  for (const field of ['docDate', 'taxEventDate'] as const) {
    if (!blank(h[field]) && !isDay(h[field])) out.push({ field, code: 'date_invalid' })
  }
  if ((h.links ?? []).some(l => blank(l?.docType) || blank(l?.docNumber) || (!blank(l?.date) && !isDay(l?.date)))) {
    out.push({ field: 'links', code: 'link_incomplete' })
  }
  return out
}

/**
 * A header as an update writes it: what is set, and what a cleared field removes (`null`, an empty text, no links).
 * Text is trimmed, the register type is kept with two digits, days become dates. A field the input does not name is in
 * neither: an update leaves it as it is.
 */
export function headerUpdateOf(input: JournalHeaderInput): { set: Record<string, unknown>; unset: JournalHeaderField[] } {
  const set: Record<string, unknown> = {}
  const unset: JournalHeaderField[] = []
  const has = (k: JournalHeaderField) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined
  for (const field of JOURNAL_HEADER_FIELDS) {
    if (!has(field)) continue
    const value = input[field] as unknown
    if (field === 'links') {
      const links = (value as JournalLinkInput[] | null) ?? []
      if (!links.length) { unset.push(field); continue }
      set.links = links.map(l => ({
        docType: String(l.docType).trim(),
        docNumber: String(l.docNumber).trim(),
        ...(!blank(l.date) ? { date: new Date(l.date as string) } : {}),
        ...(typeof l.amount === 'number' ? { amount: l.amount } : {}),
        ...(typeof l.amountFx === 'number' ? { amountFx: l.amountFx } : {}),
      }))
    } else if (blank(value)) {
      unset.push(field)
    } else if (field === 'registerDocType') {
      set[field] = registerDocTypeCode(value) ?? String(value).trim()
    } else if (field === 'docDate' || field === 'taxEventDate') {
      set[field] = new Date(value as string)
    } else {
      set[field] = typeof value === 'string' ? value.trim() : value
    }
  }
  return { set, unset }
}

/** The header an update would leave: the entry's own, with the update's sets and removals applied. */
export function mergedHeader(entry: Partial<Record<JournalHeaderField, unknown>>, update: ReturnType<typeof headerUpdateOf>): JournalHeaderInput {
  const out: Record<string, unknown> = {}
  for (const field of JOURNAL_HEADER_FIELDS) if (entry[field] !== undefined && entry[field] !== null) out[field] = entry[field]
  for (const field of update.unset) delete out[field]
  return { ...out, ...update.set } as JournalHeaderInput
}

// ── Finding the entries a header names ──────────────────────────────────────────────────────────

/** A document number without its leading zeros: `0000000123` and `123` are one number (`sales-register.ts#rowKey`). */
export function bareDocNumber(n: unknown): string {
  return String(n ?? '').trim().replace(/^0+(?=.)/, '')
}

export function sameDocNumber(a: unknown, b: unknown): boolean {
  const x = bareDocNumber(a)
  return x !== '' && x === bareDocNumber(b)
}

/** Every spelling a stored number may have: as written, bare, and with the register's ten digits. What a query asks for. */
export function docNumberVariants(n: unknown): string[] {
  const raw = String(n ?? '').trim()
  if (!raw) return []
  const bare = bareDocNumber(raw)
  const out = new Set([raw, bare])
  if (/^\d{1,10}$/.test(bare)) out.add(bare.padStart(10, '0'))
  return [...out]
}

export interface EntryCandidate {
  id: string
  docType?: string
  docNumber?: string
  registerDocType?: string
  partnerAnalyticId?: string
  date?: Date | string
  docDate?: Date | string
  status?: string
  ledger?: string
}

const dayOf = (d: Date | string | null | undefined) => {
  if (!d) return ''
  const x = d instanceof Date ? d : new Date(d)
  return Number.isNaN(x.getTime()) ? '' : x.toISOString().slice(0, 10)
}

/** Of several candidates, those on the day; all of them when the day is unknown or none is on it. */
function onTheDay(candidates: EntryCandidate[], day: Date | string | null | undefined): EntryCandidate[] {
  const d = dayOf(day)
  if (!d) return candidates
  const same = candidates.filter(c => dayOf(c.docDate ?? c.date) === d)
  return same.length ? same : candidates
}

/** The one candidate left, or none: an entry is linked only when it is the only one it can be. */
const theOne = (candidates: EntryCandidate[]) => (candidates.length === 1 ? candidates[0].id : undefined)

/**
 * The entry a link names (§3.6): by its type and number and this entry's partner, since a number is unique only per
 * partner (FR-25 §11); the link's date settles a tie. Never this entry itself, never a voided one.
 */
export function pickLinkedEntry(
  link: { docType: string; docNumber: string; date?: Date | string | null },
  self: { id?: string; partnerAnalyticId?: string | null },
  candidates: EntryCandidate[],
): string | undefined {
  let found = candidates.filter(c => c.id !== self.id && c.status !== 'voided' && c.docType === link.docType && sameDocNumber(c.docNumber, link.docNumber))
  if (self.partnerAnalyticId) found = found.filter(c => !c.partnerAnalyticId || c.partnerAnalyticId === self.partnerAnalyticId)
  return theOne(onTheDay(found, link.date))
}

/**
 * The journal entry behind a VAT register row (§3.8): the row's two-digit type is the entry's register type, padded,
 * and the numbers are one number; the row's date settles a tie. The books' ledger only, never a voided entry.
 */
export function pickRegisterEntry(
  row: { docTypeCode: string; docNumber: string; docDate?: Date | string | null },
  candidates: EntryCandidate[],
): string | undefined {
  const code = registerDocTypeCode(row.docTypeCode)
  const found = candidates.filter(c => c.status !== 'voided' && c.ledger !== 'shadow' && !!code
    && registerDocTypeCode(c.registerDocType) === code && sameDocNumber(c.docNumber, row.docNumber))
  return theOne(onTheDay(found, row.docDate))
}
