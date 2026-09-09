/**
 * What is this document, and which way does it point?
 *
 * Two independent questions:
 *  - `detectDocKind(rawText)` — which legacy PlusMinus document the text came from, by its
 *    printed header. Drives which extraction profile the OCR sidecar uses and which mapper
 *    the engine runs.
 *  - `detectDirection(org, ext)` — for invoices only: is the org the ДОСТАВЧИК (→ outgoing
 *    sale) or the ПОЛУЧАТЕЛ (→ incoming bill)? Decided by matching the org's ЕИК against
 *    the extracted parties.
 */
import type { DocKind, DocumentExtraction, Party } from './types.js'

export const clean = (v: unknown): string => (v == null ? '' : String(v)).trim()
export const digits = (v: unknown): string => clean(v).replace(/\D/g, '')
export const num = (v: unknown, d = 0): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/**
 * Header signatures of the five legacy document kinds. Order matters: the correction
 * variant of a стокова разписка is recognised before the plain one, and ФАКТУРА is
 * checked last because delivery notes often quote an invoice number in their body.
 */
const KIND_PATTERNS: Array<{ kind: DocKind; test: RegExp }> = [
  // stokrazp printed as "Тип на документа: 2000 КОРЕКЦИЯ" — quantities may be negative
  { kind: 'correction', test: /2000\s+КОРЕКЦИЯ/i },
  // искане за отпускане на материали (sklisk) — internal write-off
  { kind: 'issue_note', test: /ИСКАНЕ\s*(?:\r?\n|\s)*За\s+отпускане|За\s+отпускане\s+на\s+материали/i },
  // складова разписка (sklrazp) — store-to-store transfer
  { kind: 'transfer_note', test: /СКЛАДОВА\s+РАЗПИСКА/i },
  // стокова разписка (stokrazp) — goods receipt
  { kind: 'goods_receipt', test: /СТОКОВА\s+РАЗПИСКА/i },
  { kind: 'invoice', test: /ФАКТУРА|ИНВОЙС|INVOICE/i },
]

/**
 * Best-effort document kind from the extracted text. `unknown` when nothing matches —
 * callers fall back to the target's default kind rather than guessing.
 */
export function detectDocKind(rawText: string): DocKind {
  const text = rawText || ''
  for (const { kind, test } of KIND_PATTERNS) {
    if (test.test(text)) return kind
  }
  return 'unknown'
}

/** Kinds that map onto a StockMovement rather than an Invoice. */
export const MOVEMENT_KINDS: DocKind[] = ['goods_receipt', 'correction', 'transfer_note', 'issue_note', 'store_operations']

export function isMovementKind(kind: DocKind): boolean {
  return MOVEMENT_KINDS.includes(kind)
}

/** Does a party's ЕИК/VAT match the org's tax number? (compare on digits, tolerating a BG prefix). */
export function partyIsOrg(orgEik: string, p: Party): boolean {
  if (!orgEik) return false
  return digits(p?.company_id) === orgEik || digits(p?.vat_id) === orgEik
}

export interface Direction {
  direction: 'outgoing' | 'incoming'
  counterparty: Party
  contactType: 'customer' | 'supplier'
  uncertain: boolean
}

export function detectDirection(org: any, ext: DocumentExtraction): Direction {
  const orgEik = digits(org?.taxNumber) || digits(org?.vatNumber)
  const sup = ext.supplier || {}
  const cust = ext.customer || {}
  if (partyIsOrg(orgEik, sup)) return { direction: 'outgoing', counterparty: cust, contactType: 'customer', uncertain: false }
  if (partyIsOrg(orgEik, cust)) return { direction: 'incoming', counterparty: sup, contactType: 'supplier', uncertain: false }
  // Fallback: assume it's one of our own sales invoices, flag for review.
  return { direction: 'outgoing', counterparty: cust, contactType: 'customer', uncertain: true }
}

/**
 * Кредитно / Дебитно известие — a credit or debit note.
 *
 * PlusMinus exports these as `invoicem_*.pdf` and numbers them in the SAME series as the sales
 * invoices, so neither the file name nor the document number distinguishes one from a фактура —
 * only the printed title does. Missed, a credit note lands as an invoice whose every amount is
 * negative: the stock happens to come out right (a dispatch of −N adds N back) but the document
 * is the wrong type, so it never appears among the credit notes, and `auto-journal` — which
 * applies `sign = -1` for a credit note — would post it twice-negated once accounting is wired.
 */
const NOTE_TITLES: Array<{ type: 'credit_note' | 'debit_note'; test: RegExp }> = [
  { type: 'credit_note', test: /Кредитно\s+извест/i },
  { type: 'debit_note', test: /Дебитно\s+извест/i },
]

/** `'credit_note'` / `'debit_note'` when the document titles itself one, else null. */
export function detectNoteType(rawText: string): 'credit_note' | 'debit_note' | null {
  const text = rawText || ''
  for (const { type, test } of NOTE_TITLES) if (test.test(text)) return type
  return null
}

/**
 * The document a note corrects, from the „Известие към:" block. The number and its date sit on
 * the line BELOW the label (`Известие към: -ФЕ` / `3000100972/08.09.2026`), so this is anchored on
 * the label and then scans forward rather than matching within one line.
 */
export function parseNoteReference(rawText: string): string | undefined {
  const lines = (rawText || '').split('\n')
  const at = lines.findIndex(l => /Известие\s+към/i.test(l))
  if (at < 0) return undefined
  for (const l of lines.slice(at, at + 4)) {
    const m = /(\d{6,})\s*\/\s*\d{1,2}\.\d{1,2}\.\d{4}/.exec(l)
    if (m) return m[1]
  }
  return undefined
}
