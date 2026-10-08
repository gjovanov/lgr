/**
 * Canonical contracts for the document-import engine.
 *
 * `DocumentExtraction` mirrors `packages/ocr-server/src/schema.ts` — the sidecar is a
 * separate deployable with its own package.json, so the shape is declared on both sides
 * and kept honest by a parity unit test. This copy is the authority for the app.
 *
 * `MappedInvoice` / `MappedMovement` are deliberately FORM-shaped: the same object feeds
 * the batch path (persisted as a draft) and the single-document path (merged into an open
 * form via a field diff), so a mapping is never translated twice.
 */

export interface Party {
  name?: string | null
  /** ЕИК / БУЛСТАТ (registration number, no prefix). */
  company_id?: string | null
  /** ИН по ДДС (with country prefix, e.g. BG112500982). */
  vat_id?: string | null
  address?: string | null
  city?: string | null
  iban?: string | null
}

export interface ExtractedLineItem {
  description: string
  quantity?: number | null
  unit?: string | null
  unit_price?: number | null
  /** Percentage, e.g. 20. */
  vat_rate?: number | null
  total?: number | null
  /**
   * Extra price columns a стокова разписка carries per item: the supplier cost under
   * "Цена" plus the sale tiers "Цена 1".."Цена N". Absent on invoices.
   */
  prices?: Record<string, number> | null
}

/** What kind of legacy document the text came from. Drives profile + mapping. */
export type DocKind =
  | 'invoice'          // ФАКТУРА (either direction)
  | 'goods_receipt'    // стокова разписка (stokrazp) — receipt IN
  | 'correction'       // stokrazp "2000 КОРЕКЦИЯ" — signed quantities
  | 'transfer_note'    // складова разписка (sklrazp) — transfer OUT
  | 'issue_note'       // искане за отпускане на материали (sklisk) — write-off OUT
  | 'cash_register'    // salesAnalysis (XLSX)
  | 'store_operations' // storeOperations (XLSX)
  | 'unknown'

export interface DocumentExtraction {
  document_number?: string | null
  /** ISO 8601 YYYY-MM-DD. */
  issue_date?: string | null
  due_date?: string | null
  /** ISO 4217, e.g. EUR / BGN. */
  currency?: string | null
  /** e.g. 1.95583 when a EUR invoice quotes лв. */
  exchange_rate?: number | null
  supplier: Party
  customer: Party
  line_items: ExtractedLineItem[]
  net_total?: number | null
  vat_total?: number | null
  gross_total?: number | null
  payment_terms?: string | null
  notes?: string | null
  // ── stock-note extras (absent on invoices) ──
  doc_kind?: DocKind | null
  /** Source store as printed on the note (сладова разписка / искане). */
  warehouse_from?: string | null
  /** Destination store as printed on the note (стокова разписка). */
  warehouse_to?: string | null
  /** True for a "2000 КОРЕКЦИЯ" stokrazp, whose quantities may be negative. */
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

export interface DraftResult {
  extraction: DocumentExtraction
  validation: ValidationResult
  model: string
  engine: string
  /** Which extraction profile the sidecar used. */
  profile?: string
}

// ── mapped output ────────────────────────────────────────────────────────────

/** How a line got its product. `null` when nothing matched (stays free-text). */
export type MatchedBy = 'alias' | 'exact' | 'ws' | 'token' | 'ai' | null

export interface MappedInvoiceLine {
  productId?: string
  description: string
  quantity: number
  unit: string
  unitPrice: number
  discount: number
  taxRate: number
  taxAmount: number
  lineTotal: number
  warehouseId?: string
  /** Original OCR wording, round-tripped verbatim — feeds supplier alias learning. */
  sourceText?: string
  orderRef?: {
    orderId?: string
    groupId?: string
    lineId?: string
    allocationId?: string
    reservationId?: string
    internalOrderId?: string
    internalOrderLineId?: string
  }
}

/** Form-shaped invoice mapping. Mirrors the invoicing `DocumentFormState` + `LineInput[]`. */
export interface MappedInvoice {
  type: string
  direction: 'outgoing' | 'incoming'
  contactId?: string
  /** Display name of the resolved counterparty — the review table and field diff show this. */
  contactName?: string
  /** The legacy/supplier document number — becomes the issued number on convert. */
  reference?: string
  /** Credit/debit note only: the legacy number of the document it corrects („Известие към:"). */
  relatedReference?: string
  issueDate?: string
  dueDate?: string
  currency: string
  exchangeRate: number
  paymentMethod?: string
  notes?: string
  terms?: string
  preparedBy?: string
  placeOfTransaction?: string
  billingAddress?: { street: string; city: string; state?: string; postalCode: string; country: string }
  lines: MappedInvoiceLine[]
  subtotal: number
  taxTotal: number
  total: number
  orderId?: string
  orderGroupId?: string
  tags: string[]
}

export interface MappedMovementLine {
  productId?: string
  productName: string
  quantity: number
  unitCost: number
  /** Staged product-master edits (goods receipts with price columns). */
  productUpdate?: Record<string, any>
  priceTiers?: Array<{ name: string; percent: number; finalPrice: number; manualOverride: boolean; contactIds?: string[]; tags?: string[] }>
  sourceText?: string
}

/** A catalog-new product a goods receipt wants to create before booking its quantity. */
export interface NewProductDraft {
  name: string
  unit: string
  cost: number
  selling?: number
  tiers: Record<string, number>
}

/** Form-shaped movement mapping. Mirrors `MovementFormView`'s `form`. */
export interface MappedMovement {
  type: 'receipt' | 'dispatch' | 'transfer' | 'adjustment' | 'return'
  date?: string
  fromWarehouseId?: string
  toWarehouseId?: string
  contactId?: string
  /** Carries the idempotency marker, e.g. "Доставки — 2026-07-27 (stokrazp:3000016107)". */
  notes: string
  /** The marker alone, for duplicate detection. */
  marker: string
  /** The source document's file stem — "stokrazp_3000016317" — persisted on the movement. */
  reference?: string
  lines: MappedMovementLine[]
  totalAmount: number
  newProducts: NewProductDraft[]
}

// ── analysis envelope ────────────────────────────────────────────────────────

export interface LineDiagnostic {
  sourceText: string
  matched: boolean
  productId?: string
  matchedBy: MatchedBy
  /** Present when the line found no product but the source carries enough to create one. */
  candidateNew?: NewProductDraft
}

export interface ContactSuggestion {
  name: string
  eik?: string
  vat?: string
  address?: string
  city?: string
  /** Set when an existing contact matched — the UI can select it rather than create. */
  existingId?: string
  existingName?: string
}

export interface DuplicateHit {
  id: string
  number: string
  status?: string
  reason: string
}

/** One analyzed source file. Returned by /analyze — nothing here is persisted. */
export interface AnalyzedDoc {
  fileId: string
  filename: string
  docKind: DocKind
  direction?: 'outgoing' | 'incoming'
  /** Direction/identity could not be established from the org's ЕИК — needs review. */
  uncertain?: boolean
  validation?: ValidationResult
  duplicate?: DuplicateHit
  mapped?: MappedInvoice | MappedMovement
  /**
   * Additional movements the same document produces. Only a "2000 КОРЕКЦИЯ" uses this: its
   * increases and decreases book as two movements, because a movement's type carries the
   * sign, not its quantities.
   */
  extraMovements?: MappedMovement[]
  /**
   * The document was read completely and has nothing to book — a PRICE-ONLY стокова разписка,
   * whose Кол column is empty throughout and whose footer is zero. Distinct from an error: there
   * is no movement because the document delivers nothing, not because it could not be read.
   */
  nothingToMove?: boolean
  /**
   * The price-only document's lines, carrying the sale prices it restates. Present with
   * `nothingToMove` on receipt-side families; the commit applies them, which is the document's
   * entire purpose. It has to travel on the analysis because there is no movement to hang it on.
   */
  priceOnly?: MappedMovementLine[]
  diagnostics: {
    perLine: LineDiagnostic[]
    contactSuggestion?: ContactSuggestion
    warnings: string[]
  }
  error?: string
}

/** Which surface an import is targeting. */
export type ImportTarget = 'sales_invoice' | 'bill' | 'cash_sale' | 'movement'
