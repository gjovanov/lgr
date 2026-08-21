/** Structured invoice extraction shape (adapted from Starling extraction/schema.py). */

export interface Party {
  name?: string | null
  company_id?: string | null // ЕИК / БУЛСТАТ (registration number, no prefix)
  vat_id?: string | null // ИН по ДДС (with country prefix, e.g. BG112500982)
  address?: string | null
  city?: string | null
  iban?: string | null
}

export interface LineItem {
  description: string
  quantity?: number | null
  unit?: string | null
  unit_price?: number | null
  vat_rate?: number | null // percentage, e.g. 20
  total?: number | null
  /**
   * Extra price columns a стокова разписка prints per item, keyed by their exact header:
   * "Цена" (supplier cost) plus the sale tiers "Цена 1".."Цена 10". Absent on invoices.
   */
  prices?: Record<string, number> | null
}

/** Which legacy document the text came from. Selects the extraction profile and the mapper. */
export type DocKind =
  | 'invoice'
  | 'goods_receipt'
  | 'correction'
  | 'transfer_note'
  | 'issue_note'

/** Extraction profile = which instruction set (skill) drives the model. */
export type Profile = 'invoice' | 'goods_receipt' | 'stock_note'

export interface InvoiceExtraction {
  document_number?: string | null
  issue_date?: string | null // ISO 8601 YYYY-MM-DD
  due_date?: string | null
  currency?: string | null // ISO 4217, e.g. EUR / BGN
  exchange_rate?: number | null // e.g. 1.95583 when EUR invoice quotes лв
  supplier: Party
  customer: Party
  line_items: LineItem[]
  net_total?: number | null
  vat_total?: number | null
  gross_total?: number | null
  payment_terms?: string | null
  notes?: string | null
  // ── stock-note extras (absent on invoices) ──
  doc_kind?: DocKind | null
  /** Source store as printed (складова разписка / искане). */
  warehouse_from?: string | null
  /** Destination store as printed (стокова разписка). */
  warehouse_to?: string | null
  /** True for a "2000 КОРЕКЦИЯ" стокова разписка, whose quantities may be negative. */
  correction?: boolean | null
}

export interface ValidationCheck {
  check: string
  status: 'pass' | 'fail' | 'warn' | 'skip'
  details: string
}

export interface ValidationResult {
  status: 'valid' | 'needs_review'
  checks: ValidationCheck[]
}

export interface ExtractResult {
  text: string
  method: 'native' | 'tesseract'
  pages: number
}

export interface DraftResult {
  extraction: InvoiceExtraction
  validation: ValidationResult
  model: string
  engine: 'claude-code' | 'api'
  /** Which instruction set produced this extraction. */
  profile: Profile
}

export const EMPTY_PARTY: Party = { name: null, company_id: null, vat_id: null, address: null, iban: null }
