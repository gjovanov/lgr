/**
 * PlusMinus `/mobile` `document()` JSON (header + lines) → `DocumentExtraction`.
 *
 * No OCR, no AI: PlusMinus's own structured data IS the extraction. Field mapping confirmed
 * 2026-10-28 against a real sample (`header.docNumber` `3000101649`, pulled live by
 * `pull-plusminus-api`) cross-checked byte-for-byte against that exact invoice, already
 * correctly imported into LGR via the OCR path:
 *   - `header.sum` / `header.vat` are copied VERBATIM as gross/VAT totals — the existing OCR
 *     path already stores these lev figures directly under currency 'EUR', exchangeRate 1
 *     (no BGN→EUR conversion happens anywhere in this pipeline for this org).
 *   - `header.placeOfIssue` matches the printed "Място на сделката:" exactly.
 *   - `header.paymentMethod`: "1" → cash, "2" → bank_transfer (confirmed against one live
 *     invoice of each). Codes for card/check are unconfirmed — left unmapped rather than guessed.
 *   - `header.createdBy` (e.g. "kasa 2") is a TILL id, not a person — confirmed it does NOT
 *     match the "Prepared by" name real invoices show ("Николета Тачева" / "Елена Додова" seen
 *     on two different real documents, neither matching their own `createdBy`). Not usable.
 *
 * `placeOfTransaction` / `paymentMethod` / `terms` / `preparedBy` are NOT fields of
 * `DocumentExtraction` — `mapInvoiceExtraction` derives all four from the free-text `rawText`
 * parameter via `parse-text.ts`'s regexes, never from the extraction object. Rather than
 * duplicating that regex logic here, `buildSyntheticRawText` below hands those same, unchanged
 * functions a small deterministic text blob built from fields we actually have (plus the legal
 * boilerplate, which is invariant and was copied verbatim off a real printed invoice) — so the
 * existing parsers do the work, unchanged.
 *
 * Deliberately NOT handled here (left for the caller to triage before calling this at all):
 *   - Credit/debit notes. PlusMinus's JSON has no confirmed structural signal distinguishing a
 *     Кредитно/Дебитно известие from a plain invoice (only the printed PDF title does, per
 *     memory). A document whose header.sum is negative — the printed tell for a note — should be
 *     skipped by the caller rather than mapped as a malformed plain invoice.
 *   - Counterparty ЕИК/VAT/address/city: not present in PlusMinus's invoice header (only a name).
 *     `matchContact`'s existing name-only fallback tier handles this the same way it already does
 *     when the OCR/AI path also fails to read an ЕИК.
 */
import type { DocumentExtraction, ExtractedLineItem, Party } from './types.js'

export interface PlusMinusLine {
  name?: string
  item?: string
  no?: string | number
  quantity?: string | number
  price?: string | number
  sum?: string | number
  measure?: string
  [key: string]: any
}

export interface PlusMinusHeader {
  docNumber?: string
  docDate?: string
  partner?: string
  sum?: string | number
  vat?: string | number
  vatRate?: string | number
  vatPercent?: string | number
  placeOfIssue?: string
  paymentMethod?: string | number
  paymentType?: string | number
  doc?: string
  comment?: string
  [key: string]: any
}

export interface PlusMinusDocument {
  date?: string
  num?: string
  header: PlusMinusHeader
  lines: PlusMinusLine[]
}

/** The org's own identity, needed so `detectDirection` resolves 'outgoing' with no uncertainty. */
export interface OrgIdentity {
  name: string
  eik: string
  vatNumber?: string
  address?: string
  city?: string
}

const num = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** `"20261026"` → `"2026-10-26"`. */
function pmDate(v: string | undefined): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(v || '')
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined
}

/** `"ПАРТНЬОРИ:БИОВЕТ АД"` / `"КЛИЕНТИ:ВАДИС - ООД"` → the bare counterparty name. */
export function stripPartnerPrefix(v: string | undefined): string {
  const s = (v || '').trim()
  const i = s.indexOf(':')
  return i >= 0 ? s.slice(i + 1).trim() : s
}

/** `"1"` → cash, `"2"` → bank_transfer. Confirmed live against one invoice of each; anything
 * else is left unmapped (never guessed) so it surfaces as a review gap instead of a wrong value.
 * Deliberately returns the bare English word: `parsePaymentMethod`'s regex (`/сметка|превод
 * |transfer/i`, `/брой|cash/i`, ...) matches these words directly, so feeding the word back
 * through `parsePaymentMethod` via the synthetic rawText (see below) reuses that function
 * unchanged rather than re-implementing its enum. */
const PAYMENT_METHOD_BY_CODE: Record<string, string> = { '1': 'cash', '2': 'bank_transfer' }

export function plusminusPaymentMethod(code: string | number | undefined): string | undefined {
  return code != null ? PAYMENT_METHOD_BY_CODE[String(code)] : undefined
}

/** The ЗДДС/ДОПК consent + no-stamp clauses, copied verbatim from a real printed invoice
 * (`invoicem_3000101637.pdf`, 2026-10-26) — invariant boilerplate, same on every invoice. */
export const INVOICE_TERMS_BOILERPLATE = [
  'Получателят е дал съгласие горепосочените лични данни да бъдат използвани от администратора на '
  + 'лични данни във връзка с изпълнението на чл. 114, ал. 1, т. 7 и т. 8 от ЗДДС и чл. 84, ал. 2 от ДОПК',
  'Съгласно чл.6, ал.1 от ЗСч., ЗДДС и ППЗДДС печат и подпис не са задължителни реквизити на фактурата.',
]

/**
 * A small deterministic text blob carrying only the labelled fields `parse-text.ts`'s regexes
 * look for — not OCR output, just enough for those UNCHANGED functions to do their job from data
 * we actually have. Lines/fields we have no reliable source for (Съставил:, Словом:, the
 * two-column Град/Адрес block) are omitted rather than guessed, so their parsers correctly return
 * undefined instead of a wrong value.
 */
export function buildSyntheticRawText(h: PlusMinusHeader): string {
  const lines: string[] = []
  if (h.placeOfIssue) lines.push(`Място на сделката: : ${h.placeOfIssue}`)
  const method = plusminusPaymentMethod(h.paymentMethod ?? h.paymentType)
  if (method) lines.push(`Плащане: ${method}`)
  lines.push(...INVOICE_TERMS_BOILERPLATE)
  return lines.join('\n')
}

export function plusminusInvoiceToExtraction(doc: PlusMinusDocument, supplier: OrgIdentity): DocumentExtraction {
  const h = doc.header || {}
  const vatRate = num(h.vatRate ?? h.vatPercent) ?? 20

  const line_items: ExtractedLineItem[] = (doc.lines || []).map(l => ({
    description: String(l.name || l.item || '').trim(),
    quantity: num(l.quantity),
    unit: l.measure || undefined,
    unit_price: num(l.price),
    vat_rate: vatRate,
    total: num(l.sum),
  }))

  const supplierParty: Party = {
    name: supplier.name,
    company_id: supplier.eik,
    vat_id: supplier.vatNumber,
    address: supplier.address,
    city: supplier.city,
  }
  const customerParty: Party = { name: stripPartnerPrefix(h.partner) }

  return {
    document_number: h.docNumber ? String(h.docNumber) : undefined,
    issue_date: pmDate(h.docDate),
    currency: 'EUR',
    exchange_rate: 1,
    supplier: supplierParty,
    customer: customerParty,
    line_items,
    vat_total: num(h.vat),
    gross_total: num(h.sum),
    payment_terms: plusminusPaymentMethod(h.paymentMethod ?? h.paymentType),
    doc_kind: 'invoice',
  }
}
