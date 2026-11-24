/**
 * DocumentTypeConfig — the single source of per-document-type variation that drives the
 * unified invoicing document form (DocumentForm.vue + useDocumentForm + the pure
 * document-payload module).
 *
 * IMPORTANT design split:
 *   - `docType`  → the UI / line-column persistence key (e.g. 'purchase_invoice').
 *   - `apiType` + `direction` → the backend payload identity (e.g. type 'invoice',
 *     direction 'incoming').
 * Conflating these corrupts either the column-picker storage key or the server payload,
 * so they are intentionally kept separate (Pillar A, R10).
 *
 * Everything under `payload`, `totals` and `line` is consumed by the PURE
 * `document-payload.ts` module (no Vue). The rest drives the Vue components/composable.
 */

/** UI / line-column persistence key — matches ui-shared `InvoiceDocType`. */
export type DocType =
  | 'invoice'
  | 'purchase_invoice'
  | 'proforma'
  | 'offer'
  | 'credit_note'
  | 'debit_note'
  | 'purchase_credit_note'
  | 'purchase_debit_note'
  | 'cash_sale'

export type Direction = 'outgoing' | 'incoming'

/** One step in the status pipeline shown in the form header. */
export interface StatusStep {
  /** i18n key, e.g. 'invoicing.status.draft'. */
  i18n: string
  /** Invoice statuses that make this step "current". First matching step wins; if none
   *  match, the first step (index 0) is treated as current. */
  match: string[]
}

/** Whitelisted line keys + numeric strategy (consumed by the pure payload module). */
export interface LineConfig {
  /** Emit a `discount` key and apply discount-aware tax math. */
  hasDiscount: boolean
  /** Emit an `accountId` key (sales invoice only). */
  hasAccountId: boolean
  /** Emit `unit || 'pcs'` (true) vs the raw `unit` value (false → sales invoice). */
  unitFallback: boolean
}

/** Which aggregate totals reach the payload + which discount row shows in the UI. */
export interface TotalsConfig {
  /** Render the discount row in the totals card. */
  showDiscountRow: boolean
  /** Emit a top-level `discountTotal` (sales invoice and the credit/debit notes). */
  emitDiscountTotal: boolean
  /** Emit a top-level `taxTotal` (sales invoice only). */
  emitTaxTotal: boolean
  /** Emit a top-level `totalBase` = round(total * exchangeRate) (sales invoice only). */
  emitTotalBase: boolean
}

/** Drives the pure `buildPayload`. Captures every per-type field-emission quirk so the
 *  unified builder reproduces today's bytes exactly. */
export interface PayloadConfig {
  /** Also emit a legacy `date` key (credit/debit/cash sale persist both `date` + `issueDate`). */
  emitDateField: boolean
  /** Emit `issueDate` (every type does). */
  emitIssueDate: boolean
  /** Emit `dueDate`. */
  emitDueDate: boolean
  /** Fall back `dueDate` → `issueDate` when empty (sales invoice only). */
  dueDateFallbackToIssue: boolean
  /** Emit the validity date `validUntil` (the quotes: proforma, offer) — as `dueDate`, where the model keeps it. */
  emitValidUntil: boolean
  /** Emit `supplierInvoiceNumber` (purchase only). */
  emitSupplierInvoiceNumber: boolean
  /** Emit `relatedInvoiceId` (credit/debit only). */
  emitRelatedInvoiceId: boolean
  /** Emit the `billingAddress` block (sales invoice only). */
  emitBillingAddress: boolean
  /** Emit `paymentMethod` (every type except sales invoice, which intentionally omits it). */
  emitPaymentMethod: boolean
  /** Coerce empty `contactId` → undefined so it drops on the wire (cash sale only). */
  contactIdOmitEmpty: boolean
  /** Apply `exchangeRate || 1` (sales invoice only). */
  exchangeRateFallback: boolean
  /** Free-text fields to emit, in order. */
  textFields: Array<'notes' | 'terms' | 'footer' | 'reason'>
  /** Coerce empty text fields → undefined so they drop on the wire (sales invoice only).
   *  The five spread-style forms keep empty strings as-is. */
  omitEmptyText: boolean
}

export interface DocumentTypeConfig {
  // ── identity ──
  /** UI / line-column key. */
  docType: DocType
  /** Backend `type`. */
  apiType: string
  /** Backend `direction`. */
  direction: Direction

  // ── routing / labels ──
  titleNewKey: string
  titleEditKey: string
  backTo: string
  backLabelKey?: string
  listRouteName: string
  notesEntityType: string
  pendingEntityType: string
  pendingIcon: string
  /** Snackbar success i18n key. */
  successKey: string

  // ── party ──
  /** Also the type a contact created from the party picker starts as: a supplier on a bill. */
  partyRole: 'customer' | 'supplier'
  partyRequired: boolean
  partyLabelKey: string
  /** Extra query params for the contact fetch (e.g. { type: 'supplier' }). */
  contactFetchParams?: Record<string, string>
  /** Capture the contact's billing address into the form on contact change (sales invoice). */
  captureBillingAddress: boolean
  /** Re-resolve every line's price on contact change. R6: now TRUE for all types. */
  reResolveOnChange: boolean

  // ── header extras ──
  showSupplierInvoiceNumber: boolean
  showRelatedInvoice: boolean
  /** Auto-populate lines from the chosen related invoice (credit/debit). */
  relatedInvoiceAutofill: boolean

  // ── dates ──
  secondaryDate: 'dueDate' | 'validUntil' | 'none'
  secondaryDateLabelKey?: string
  /** Default the due date this many days out on create (credit/debit). */
  dueDateDefaultDays?: number
  /** Default validUntil this many days out on create (proforma). */
  validUntilDefaultDays?: number

  // ── payment ──
  paymentMethodMode: 'clearable' | 'fixed'
  paymentMethodDefault: string
  /**
   * What a NEW document's payment method starts as. Absent → cash (the form's long-standing
   * fallback). A supplier bill starts empty (FR-22.33): nothing says how it will be paid.
   */
  paymentMethodOnCreate?: string

  // ── pricing ──
  priceField: 'sellingPrice' | 'purchasePrice'
  /** 'combobox' → PriceCombobox (resolves tag/contact prices); 'plain' → number field. */
  priceEditor: 'combobox' | 'plain'
  /** Reset the line's discount to 0 when a product is (re)selected (legacy: proforma only). */
  resetDiscountOnProductSelect?: boolean

  // ── notes / terms UI ──
  notesFieldLabelKey: string
  /** Which form field the notes textarea binds to. */
  notesFieldModel: 'notes' | 'reason'
  showTermsField: boolean
  /** Recipient/author signature panels + place-of-transaction row (outgoing docs + cash sales). */
  showSignatureFooter?: boolean

  // ── numbering peek ──
  peekParams: Record<string, string>

  // ── status pipeline (i18n keys) ──
  status: StatusStep[]

  // ── actions ──
  /**
   * Once the document is issued: offer Import from a file only while it is a draft, or always.
   *
   * It used to gate Save as well, in the bar under the title only: the foot of the form offered Save in every
   * status, so an issued sales invoice had Save in one bar and not in the other. A document is editable in
   * every status, so both bars offer Save now (`useDocumentForm#formActions`); the cash sale is the exception,
   * issued as it is saved on its own terminal.
   */
  editSaveGate: 'draft-only' | 'always'
  /** Render the smart-button row from loaded data (sales invoice only). */
  showSmartButtons: boolean

  // ── cash-sale stock transfer ──
  stockTransferFlow: boolean

  // ── purchase-bill inline product updates ──
  /** Purchase bills only: enable the "with product update" toggle + GR product-master columns. */
  supportsProductUpdate?: boolean

  // ── a supplier bill and its goods receipts (FR-22 slice 3) ──
  /** „Запази и получи": save, then receive, in one action (FR-22.33). */
  saveAndReceive?: boolean
  /** The goods receipts the bill pays for: links, price differences, „Свържи с доставка" (FR-22.31/.32). */
  linkDelivery?: boolean
  /** The stock notes a sales invoice was made from: links, „Свържи с експедиция" (FR-22.61/.62). */
  linkStockNote?: boolean
  /** „+ Нов продукт „…"" in a line's article search (FR-22.30). */
  allowCreateProduct?: boolean

  // ── consumed by the pure payload module ──
  totals: TotalsConfig
  line: LineConfig
  payload: PayloadConfig
}

// ── what `useDocumentForm` is given, and what its Print dialog answers (FR-32.22: here, so its parts read them) ──

export interface BeforeCreateResult {
  /** true → the composable proceeds to POST; false → the hook took over (e.g. opened a dialog). */
  proceed: boolean
}

export interface UseDocumentFormOptions {
  /** Create-mode interceptor (cash sale stock check). Receives the built payload; may open a
   *  dialog and return { proceed:false } to suspend, then later call `submitCreate(extra)`. */
  onBeforeCreate?: (payload: Record<string, any>) => Promise<BeforeCreateResult> | BeforeCreateResult
  /**
   * A new document was just created as `id`, and the form is about to move onto its edit route.
   * The view keeps the form mounted for that move (`useDocumentRouteKey#adopt`): it is the same
   * document, and the form may still be issuing or printing it.
   */
  onCreated?: (id: string) => void
  /**
   * Fields the view adds to a NEW document's payload, on every create path (FR-21.31: the cash
   * sale's `receipt`, when it joins its author's open session and is to print on its device).
   */
  extraPayload?: () => Record<string, any>
}

/** How a print is to be made: what the Print dialog answers, or the user's last settings with no companion. */
export interface PrintChoice {
  format: 'xlsx' | 'pdf'
  mode: 'compact' | 'detailed'
  columns?: string[]
  companions?: string[]
}
