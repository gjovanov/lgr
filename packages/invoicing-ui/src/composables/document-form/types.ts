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
  /** Emit a top-level `discountTotal` (sales invoice only). */
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
  /** Emit `validUntil` (proforma only). */
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
  partyRole: 'customer' | 'supplier'
  /** 'create' → ContactAutocompleteWithCreate; 'plain' → bare v-autocomplete. */
  partyPicker: 'create' | 'plain'
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
  /** In edit mode: show Save only while draft, or always. */
  editSaveGate: 'draft-only' | 'always'
  /** Render the smart-button row from loaded data (sales invoice only). */
  showSmartButtons: boolean

  // ── cash-sale stock transfer ──
  stockTransferFlow: boolean

  // ── purchase-bill inline product updates ──
  /** Purchase bills only: enable the "with product update" toggle + GR product-master columns. */
  supportsProductUpdate?: boolean

  // ── consumed by the pure payload module ──
  totals: TotalsConfig
  line: LineConfig
  payload: PayloadConfig
}
