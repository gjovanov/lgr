/**
 * FR-25a §3.6: the journal entry form's Document card, as data. What the card's fields hold (text for a text input, a
 * `YYYY-MM` month, a two-digit register type), read from an entry and written back as the API takes it.
 *
 * Import-pure, beside the view: `unit/journal-header-form.test.ts` reads it.
 */
import {
  headerProblems, monthInputOf, monthOfInput, paymentWayOf, registerDocTypeCode, registerDocTypeKey,
  type HeaderProblem, type JournalHeaderField, type JournalHeaderInput,
} from 'config/journal-header'

export interface HeaderLinkForm {
  docType: string
  docNumber: string
  date: string
  amount: number | null
  amountFx: number | null
  /** The entry the link names, as the server found it. Shown, never sent. */
  entryId?: string
}

export interface HeaderForm {
  docType: string
  docNumber: string
  docDate: string
  registerDocType: string | null
  reasonRef: string
  paymentCode: string | null
  paidAmount: number | null
  paidCash: number | null
  bankOperation: string
  vatKind: string
  vatRate: number | null
  vatRule: string
  vatExemptionReason: string
  taxEventDate: string
  /** `YYYY-MM`, as a month input holds it. */
  reportingMonth: string
  protocolType: string
  customsRef: string
  links: HeaderLinkForm[]
}

export function emptyHeaderForm(): HeaderForm {
  return {
    docType: '', docNumber: '', docDate: '', registerDocType: null, reasonRef: '', paymentCode: null, paidAmount: null,
    paidCash: null, bankOperation: '', vatKind: '', vatRate: null, vatRule: '', vatExemptionReason: '', taxEventDate: '',
    reportingMonth: '', protocolType: '', customsRef: '', links: [],
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
/** A stored day (`2026-03-02T00:00:00.000Z`) as a date input holds it. */
const day = (v: unknown) => str(v).slice(0, 10)

/** The card's fields for an entry. A value no list offers stays as booked, so a read-only card shows it. */
export function headerFormOf(entry: Record<string, any> | null | undefined): HeaderForm {
  if (!entry) return emptyHeaderForm()
  return {
    docType: str(entry.docType),
    docNumber: str(entry.docNumber),
    docDate: day(entry.docDate),
    registerDocType: entry.registerDocType ? (registerDocTypeKey(entry.registerDocType) ? registerDocTypeCode(entry.registerDocType)! : str(entry.registerDocType)) : null,
    reasonRef: str(entry.reasonRef),
    paymentCode: entry.paymentCode ? str(entry.paymentCode) : null,
    paidAmount: num(entry.paidAmount),
    paidCash: num(entry.paidCash),
    bankOperation: str(entry.bankOperation),
    vatKind: str(entry.vatKind),
    vatRate: num(entry.vatRate),
    vatRule: str(entry.vatRule),
    vatExemptionReason: str(entry.vatExemptionReason),
    taxEventDate: day(entry.taxEventDate),
    reportingMonth: monthInputOf(entry.reportingMonth),
    protocolType: str(entry.protocolType),
    customsRef: str(entry.customsRef),
    links: (Array.isArray(entry.links) ? entry.links : []).map((l: any) => ({
      docType: str(l?.docType),
      docNumber: str(l?.docNumber),
      date: day(l?.date),
      amount: num(l?.amount),
      amountFx: num(l?.amountFx),
      ...(l?.entryId ? { entryId: String(l.entryId) } : {}),
    })),
  }
}

/** A number input's value: an emptied one is no number. */
const amount = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
/** A text field's value: trimmed, and `null` for an emptied one (a cleared combobox holds `null` itself). */
const textOrNull = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * The header as the API takes it: every field, and `null` for a cleared one, which the server removes. A month typed
 * that is no month is sent as typed, so the server's answer names it.
 */
export function headerPayloadOf(form: HeaderForm): Required<JournalHeaderInput> {
  const month = textOrNull(form.reportingMonth) ?? ''
  return {
    docType: textOrNull(form.docType),
    docNumber: textOrNull(form.docNumber),
    docDate: textOrNull(form.docDate),
    registerDocType: form.registerDocType ? form.registerDocType : null,
    reasonRef: textOrNull(form.reasonRef),
    paymentCode: form.paymentCode ? form.paymentCode : null,
    paidAmount: amount(form.paidAmount),
    paidCash: amount(form.paidCash),
    bankOperation: textOrNull(form.bankOperation),
    vatKind: textOrNull(form.vatKind),
    vatRate: amount(form.vatRate),
    vatRule: textOrNull(form.vatRule),
    vatExemptionReason: textOrNull(form.vatExemptionReason),
    taxEventDate: textOrNull(form.taxEventDate),
    reportingMonth: month ? (monthOfInput(month) ?? month) : null,
    protocolType: textOrNull(form.protocolType),
    customsRef: textOrNull(form.customsRef),
    links: form.links.length
      ? form.links.map(l => ({
        docType: textOrNull(l.docType) ?? '',
        docNumber: textOrNull(l.docNumber) ?? '',
        date: textOrNull(l.date),
        amount: amount(l.amount),
        amountFx: amount(l.amountFx),
      }))
      : null,
  }
}

/** The card's problems, by field (`config/journal-header.ts#headerProblems`, the rules the server answers 422 by). */
export function formProblems(form: HeaderForm): Partial<Record<JournalHeaderField, HeaderProblem['code']>> {
  const out: Partial<Record<JournalHeaderField, HeaderProblem['code']>> = {}
  for (const p of headerProblems(headerPayloadOf(form))) out[p.field] ??= p.code
  return out
}

/** Whether the entry says anything of its document: the card opens on one that does. */
export function hasHeader(entry: Record<string, any> | null | undefined): boolean {
  if (!entry) return false
  const keys = [
    'docType', 'docNumber', 'docDate', 'registerDocType', 'reasonRef', 'paymentCode', 'paidAmount', 'paidCash', 'bankOperation',
    'vatKind', 'vatRate', 'vatRule', 'vatExemptionReason', 'taxEventDate', 'reportingMonth', 'protocolType', 'customsRef', 'docTotal',
    'partnerName',
  ]
  if (keys.some(k => entry[k] !== undefined && entry[k] !== null && entry[k] !== '')) return true
  return (Array.isArray(entry.links) && entry.links.length > 0) || !!(entry.docOptions && Object.keys(entry.docOptions).length) || !!entry.source
}

/** One line for the folded card: the document and how it is paid, as far as the entry says. */
export function headerSummary(form: HeaderForm, label: (key: string) => string): string {
  const doc = [form.docType, form.docNumber].filter(Boolean).join(' ')
  const kind = registerDocTypeKey(form.registerDocType)
  const way = paymentWayOf(form.paymentCode ?? undefined)
  return [
    doc,
    kind ? label(`accounting.journalEntry.document.registerDocTypes.${kind}`) : '',
    way ? label(`accounting.paymentCodes.${way}`) : '',
    form.vatRate !== null ? `${label('accounting.journalEntry.vat.rate')} ${form.vatRate}%` : '',
  ].filter(Boolean).join(' · ')
}

/** A switch as booked: its name, and its value where it is more than "on". */
export function switchLabel(key: string, value: string): string {
  return value === 'true' || value === '1' ? key : `${key}: ${value}`
}
