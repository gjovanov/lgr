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
