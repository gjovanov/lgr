import type { DocType, DocumentTypeConfig } from './types'

/**
 * DOCUMENT_CONFIGS — the per-type variation matrix (Pillar A). Each entry fully
 * determines how the unified DocumentForm renders, loads, resolves prices, builds its
 * payload, and gates its actions.
 *
 * R6 (approved): `reResolveOnChange: true` for ALL types — on contact change every line
 * price is re-resolved. Sales invoice ADDITIONALLY captures the billing address.
 */

// ── status pipelines (i18n keys) ──
const S = {
  draft: { i18n: 'invoicing.status.draft', match: ['draft'] },
  // sales: draft → sent → paid (legacy mapped 'received' → 'Sent' too).
  sentSales: { i18n: 'invoicing.status.sent', match: ['sent', 'received'] },
  paid: { i18n: 'invoicing.status.paid', match: ['paid', 'partially_paid'] },
  received: { i18n: 'invoicing.status.received', match: ['received'] },
  paidPurchase: { i18n: 'invoicing.status.paid', match: ['paid', 'partially_paid'] },
  sent: { i18n: 'invoicing.status.sent', match: ['sent'] },
  converted: { i18n: 'invoicing.status.converted', match: ['converted'] },
  completed: { i18n: 'invoicing.status.completed', match: ['completed', 'paid'] },
}

export const DOCUMENT_CONFIGS: Record<DocType, DocumentTypeConfig> = {
  // ──────────────────────────────────────────────────────────────────────────────
  invoice: {
    docType: 'invoice',
    apiType: 'invoice',
    direction: 'outgoing',

    titleNewKey: 'invoicing.newInvoice',
    titleEditKey: 'invoicing.editInvoice',
    backTo: '/invoices',
    backLabelKey: 'nav.invoices',
    listRouteName: 'invoicing.sales',
    notesEntityType: 'invoice',
    pendingEntityType: 'salesInvoice',
    pendingIcon: 'mdi-receipt-text-outline',
    successKey: 'common.savedSuccessfully',

    partyRole: 'customer',
    partyPicker: 'create',
    partyRequired: true,
    partyLabelKey: 'invoicing.client',
    captureBillingAddress: true,
    reResolveOnChange: true,

    showSupplierInvoiceNumber: false,
    showRelatedInvoice: false,
    relatedInvoiceAutofill: false,

    secondaryDate: 'dueDate',
    secondaryDateLabelKey: 'invoicing.dueDate',

    paymentMethodMode: 'clearable',
    paymentMethodDefault: '',

    priceField: 'sellingPrice',
    priceEditor: 'combobox',

    notesFieldLabelKey: 'invoicing.notes',
    notesFieldModel: 'notes',
    showTermsField: true,
    showSignatureFooter: true,

    peekParams: { type: 'invoice', direction: 'outgoing', status: 'draft' },

    status: [S.draft, S.sentSales, S.paid],

    editSaveGate: 'draft-only',
    showSmartButtons: true,

    stockTransferFlow: false,

    totals: { showDiscountRow: true, emitDiscountTotal: true, emitTaxTotal: true, emitTotalBase: true },
    line: { hasDiscount: true, hasAccountId: true, unitFallback: false },
    payload: {
      emitDateField: false,
      emitIssueDate: true,
      emitDueDate: true,
      dueDateFallbackToIssue: true,
      emitValidUntil: false,
      emitSupplierInvoiceNumber: false,
      emitRelatedInvoiceId: false,
      emitBillingAddress: true,
      emitPaymentMethod: true,
      contactIdOmitEmpty: false,
      exchangeRateFallback: true,
      textFields: ['notes', 'terms', 'footer'],
      omitEmptyText: true,
    },
  },

  // ──────────────────────────────────────────────────────────────────────────────
  purchase_invoice: {
    docType: 'purchase_invoice',
    apiType: 'invoice',
    direction: 'incoming',

    titleNewKey: 'invoicing.newPurchaseInvoice',
    titleEditKey: 'invoicing.editPurchaseInvoice',
    backTo: '/bills',
    backLabelKey: 'nav.bills',
    listRouteName: 'invoicing.purchases',
    notesEntityType: 'purchaseInvoice',
    pendingEntityType: 'purchaseInvoice',
    pendingIcon: 'mdi-receipt-text',
    successKey: 'common.savedSuccessfully',

    partyRole: 'supplier',
    partyPicker: 'plain',
    partyRequired: true,
    partyLabelKey: 'invoicing.supplier',
    contactFetchParams: { type: 'supplier' },
    captureBillingAddress: false,
    reResolveOnChange: true,

    showSupplierInvoiceNumber: true,
    showRelatedInvoice: false,
    relatedInvoiceAutofill: false,

    secondaryDate: 'dueDate',
    secondaryDateLabelKey: 'invoicing.dueDate',

    paymentMethodMode: 'clearable',
    paymentMethodDefault: '',

    priceField: 'purchasePrice',
    priceEditor: 'plain',

    notesFieldLabelKey: 'invoicing.reason',
    notesFieldModel: 'notes',
    showTermsField: false,

    peekParams: { type: 'invoice', direction: 'incoming', status: 'draft' },

    status: [S.draft, S.received, S.paidPurchase],

    editSaveGate: 'always',
    showSmartButtons: false,

    stockTransferFlow: false,
    supportsProductUpdate: true,

    totals: { showDiscountRow: false, emitDiscountTotal: false, emitTaxTotal: false, emitTotalBase: false },
    line: { hasDiscount: false, hasAccountId: false, unitFallback: true },
    payload: {
      emitDateField: false,
      emitIssueDate: true,
      emitDueDate: true,
      dueDateFallbackToIssue: false,
      emitValidUntil: false,
      emitSupplierInvoiceNumber: true,
      emitRelatedInvoiceId: false,
      emitBillingAddress: false,
      emitPaymentMethod: true,
      contactIdOmitEmpty: false,
      exchangeRateFallback: false,
      textFields: ['notes'],
      omitEmptyText: false,
    },
  },

  // ──────────────────────────────────────────────────────────────────────────────
  proforma: {
    docType: 'proforma',
    apiType: 'proforma',
    direction: 'outgoing',

    titleNewKey: 'invoicing.newProformaInvoice',
    titleEditKey: 'invoicing.editProformaInvoice',
    backTo: '/proforma',
    backLabelKey: 'nav.proforma',
    listRouteName: 'invoicing.proforma',
    notesEntityType: 'proformaInvoice',
    pendingEntityType: 'proformaInvoice',
    pendingIcon: 'mdi-file-document-outline',
    successKey: 'common.savedSuccessfully',

    partyRole: 'customer',
    partyPicker: 'plain',
    partyRequired: true,
    partyLabelKey: 'invoicing.client',
    captureBillingAddress: false,
    reResolveOnChange: true,

    showSupplierInvoiceNumber: false,
    showRelatedInvoice: false,
    relatedInvoiceAutofill: false,

    secondaryDate: 'validUntil',
    secondaryDateLabelKey: 'invoicing.dueDate',
    validUntilDefaultDays: 30,

    paymentMethodMode: 'clearable',
    paymentMethodDefault: '',

    priceField: 'sellingPrice',
    priceEditor: 'combobox',
    resetDiscountOnProductSelect: true,

    notesFieldLabelKey: 'invoicing.notes',
    notesFieldModel: 'notes',
    showTermsField: true,
    showSignatureFooter: true,

    peekParams: { type: 'proforma', direction: 'outgoing', status: 'draft' },

    status: [S.draft, S.sent, S.converted],

    editSaveGate: 'always',
    showSmartButtons: false,

    stockTransferFlow: false,

    totals: { showDiscountRow: true, emitDiscountTotal: false, emitTaxTotal: false, emitTotalBase: false },
    line: { hasDiscount: true, hasAccountId: false, unitFallback: true },
    payload: {
      emitDateField: false,
      emitIssueDate: true,
      emitDueDate: false,
      dueDateFallbackToIssue: false,
      emitValidUntil: true,
      emitSupplierInvoiceNumber: false,
      emitRelatedInvoiceId: false,
      emitBillingAddress: false,
      emitPaymentMethod: true,
      contactIdOmitEmpty: false,
      exchangeRateFallback: false,
      textFields: ['notes', 'terms'],
      omitEmptyText: false,
    },
  },

  // ──────────────────────────────────────────────────────────────────────────────
  credit_note: {
    docType: 'credit_note',
    apiType: 'credit_note',
    direction: 'outgoing',

    titleNewKey: 'invoicing.newCreditNote',
    titleEditKey: 'invoicing.editCreditNote',
    backTo: '/credit-notes',
    backLabelKey: 'nav.creditNotes',
    listRouteName: 'invoicing.credit-notes',
    notesEntityType: 'creditNote',
    pendingEntityType: 'creditNote',
    pendingIcon: 'mdi-file-undo',
    successKey: 'common.savedSuccessfully',

    partyRole: 'customer',
    partyPicker: 'create',
    partyRequired: true,
    partyLabelKey: 'invoicing.client',
    captureBillingAddress: false,
    reResolveOnChange: true,

    showSupplierInvoiceNumber: false,
    showRelatedInvoice: true,
    relatedInvoiceAutofill: true,

    secondaryDate: 'dueDate',
    secondaryDateLabelKey: 'invoicing.dueDate',
    dueDateDefaultDays: 30,

    paymentMethodMode: 'clearable',
    paymentMethodDefault: '',

    priceField: 'sellingPrice',
    priceEditor: 'plain',

    notesFieldLabelKey: 'invoicing.reason',
    notesFieldModel: 'reason',
    showTermsField: false,
    showSignatureFooter: true,

    peekParams: { type: 'credit_note', direction: 'outgoing', status: 'draft' },

    status: [S.draft, S.sent, S.paid],

    editSaveGate: 'always',
    showSmartButtons: false,

    stockTransferFlow: false,

    totals: { showDiscountRow: false, emitDiscountTotal: false, emitTaxTotal: false, emitTotalBase: false },
    line: { hasDiscount: false, hasAccountId: false, unitFallback: true },
    payload: {
      emitDateField: true,
      emitIssueDate: true,
      emitDueDate: true,
      dueDateFallbackToIssue: false,
      emitValidUntil: false,
      emitSupplierInvoiceNumber: false,
      emitRelatedInvoiceId: true,
      emitBillingAddress: false,
      emitPaymentMethod: true,
      contactIdOmitEmpty: false,
      exchangeRateFallback: false,
      textFields: ['reason'],
      omitEmptyText: false,
    },
  },

  // ──────────────────────────────────────────────────────────────────────────────
  debit_note: {
    docType: 'debit_note',
    apiType: 'debit_note',
    direction: 'outgoing',

    titleNewKey: 'invoicing.newDebitNote',
    titleEditKey: 'invoicing.editDebitNote',
    backTo: '/debit-notes',
    backLabelKey: 'nav.debitNotes',
    listRouteName: 'invoicing.debit-notes',
    notesEntityType: 'debitNote',
    pendingEntityType: 'debitNote',
    pendingIcon: 'mdi-file-plus-outline',
    successKey: 'common.savedSuccessfully',

    partyRole: 'customer',
    partyPicker: 'create',
    partyRequired: true,
    partyLabelKey: 'invoicing.client',
    captureBillingAddress: false,
    reResolveOnChange: true,

    showSupplierInvoiceNumber: false,
    showRelatedInvoice: true,
    relatedInvoiceAutofill: true,

    secondaryDate: 'dueDate',
    secondaryDateLabelKey: 'invoicing.dueDate',
    dueDateDefaultDays: 30,

    paymentMethodMode: 'clearable',
    paymentMethodDefault: '',

    priceField: 'sellingPrice',
    priceEditor: 'combobox',

    notesFieldLabelKey: 'invoicing.reason',
    notesFieldModel: 'reason',
    showTermsField: false,
    showSignatureFooter: true,

    peekParams: { type: 'debit_note', direction: 'outgoing', status: 'draft' },

    status: [S.draft, S.sent, S.paid],

    editSaveGate: 'always',
    showSmartButtons: false,

    stockTransferFlow: false,

    totals: { showDiscountRow: false, emitDiscountTotal: false, emitTaxTotal: false, emitTotalBase: false },
    line: { hasDiscount: false, hasAccountId: false, unitFallback: true },
    payload: {
      emitDateField: true,
      emitIssueDate: true,
      emitDueDate: true,
      dueDateFallbackToIssue: false,
      emitValidUntil: false,
      emitSupplierInvoiceNumber: false,
      emitRelatedInvoiceId: true,
      emitBillingAddress: false,
      emitPaymentMethod: true,
      contactIdOmitEmpty: false,
      exchangeRateFallback: false,
      textFields: ['reason'],
      omitEmptyText: false,
    },
  },

  // ──────────────────────────────────────────────────────────────────────────────
  cash_sale: {
    docType: 'cash_sale',
    apiType: 'cash_sale',
    direction: 'outgoing',

    titleNewKey: 'invoicing.newCashSale',
    titleEditKey: 'invoicing.editCashSale',
    backTo: '/cash-sales',
    backLabelKey: 'nav.cashSales',
    listRouteName: 'invoicing.cash-sales',
    notesEntityType: 'cashSale',
    pendingEntityType: 'cashSale',
    pendingIcon: 'mdi-cash-register',
    successKey: 'invoicing.cashSaleCreated',

    partyRole: 'customer',
    partyPicker: 'create',
    partyRequired: false,
    partyLabelKey: 'invoicing.client',
    captureBillingAddress: false,
    reResolveOnChange: true,

    showSupplierInvoiceNumber: false,
    showRelatedInvoice: false,
    relatedInvoiceAutofill: false,

    secondaryDate: 'none',

    paymentMethodMode: 'fixed',
    paymentMethodDefault: 'cash',

    priceField: 'sellingPrice',
    priceEditor: 'combobox',

    notesFieldLabelKey: 'invoicing.notes',
    notesFieldModel: 'notes',
    showTermsField: false,
    showSignatureFooter: true,

    peekParams: { type: 'cash_sale', direction: 'outgoing' },

    status: [S.draft, S.completed],

    editSaveGate: 'draft-only',
    showSmartButtons: false,

    stockTransferFlow: true,

    totals: { showDiscountRow: false, emitDiscountTotal: false, emitTaxTotal: false, emitTotalBase: false },
    line: { hasDiscount: false, hasAccountId: false, unitFallback: true },
    payload: {
      emitDateField: true,
      emitIssueDate: true,
      emitDueDate: false,
      dueDateFallbackToIssue: false,
      emitValidUntil: false,
      emitSupplierInvoiceNumber: false,
      emitRelatedInvoiceId: false,
      emitBillingAddress: false,
      emitPaymentMethod: true,
      contactIdOmitEmpty: true,
      exchangeRateFallback: false,
      textFields: ['notes'],
      omitEmptyText: false,
    },
  },
}
