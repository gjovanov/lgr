/**
 * The unified invoicing document form: the one composable behind `DocumentForm` and `CashSaleTerminal`, for every
 * document type (`DocumentTypeConfig`).
 *
 * FR-32.22 (#797): it is built from its parts in `./parts/`, one seam each, of at most 500 lines (`unit/document-form-
 * parts.test.ts`). They are called in the order they were written when this was one file, which is the order their
 * hooks register:
 *
 *   state → totals → lines → product-update → pricing → products → party → load → status → print → saving → issue,
 *   and the form's own `onMounted` (`load.ts#mountForm`) last.
 *
 * ⚠ Keep that order. `usePendingChanges` (in `state`) registers its `onMounted` before the form's, so the clean state
 * is taken when the load resolves (FR-31 A1); the watchers of `lines`, `product-update`, `party` and `issue` were made,
 * and so run, in that order. A part reads only the parts before it.
 *
 * What stays here: the actions the bars offer, what starts a print (and „Издай и печатай"), a bill's „Складова
 * разписка", and issuing from the form. It returns what the one file returned, key for key.
 */
import { ref, computed } from 'vue'
import { useInvoicingExport } from 'ui-shared/composables/useInvoicingExport'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'
import type { PrintSettings } from '../print-settings'
import type { DocumentTypeConfig, PrintChoice, UseDocumentFormOptions } from './types'
import { COLLAPSE, IMPORT_KEY } from './form-actions'
import { useFormState } from './parts/state'
import { useFormTotals } from './parts/totals'
import { useFormLines } from './parts/lines'
import { useFormProductUpdate } from './parts/product-update'
import { useFormPricing } from './parts/pricing'
import { useFormProducts } from './parts/products'
import { useFormParty } from './parts/party'
import { useFormLoad } from './parts/load'
import { useFormStatus } from './parts/status'
import { useFormPrint } from './parts/print'
import { useFormSaving } from './parts/saving'
import { useFormIssue } from './parts/issue'

export type { BeforeCreateResult, UseDocumentFormOptions, PrintChoice } from './types'
export type { PrintSettings }

export function useDocumentForm(config: DocumentTypeConfig, opts: UseDocumentFormOptions = {}) {
  // ── the parts, in the order their hooks register (see the head of this file) ──
  const state = useFormState(config)
  const {
    t, route, router, appStore, showError, feedback, vatRates, defaultVatRate, baseCurrency, localeCode, isEdit,
    formRef, issueDateRef, loading, loadingContacts, contacts, warehouses, invoices, invoiceStatus, invoiceNumber,
    invoiceData, ledgerDialog, productPickerOpen, productPickerRowIdx, productPickerText, importDialogOpen,
    columnPickerOpen, selectedCols, availableLineColumns, activeLineColumns, lineColumnEntries, toggleCol, moveCol,
    reorderCol, selectAllCols, selectNoCols, resetColDefaults, isColActive, uomOptions, withProductUpdate,
    onWithProductUpdateChange, foreignBillCurrency, productUpdateOffered, grColumnPickerOpen, grCategories,
    grSelectedCols, grActiveColumns, grToggleCol, grSelectAllCols, grSelectNoCols, grResetColDefaults, grColumnsVisible,
    docTaxRate, docWarehouseId, form, selectedContact, paymentMethods, notesModel, markSaved, rules, orgUrl,
    printNote, companionNote, isDirtyNow,
  } = state
  const totals = useFormTotals(state)
  const { subtotal, discountTotal, taxTotal, documentTotal, taxBase, computeLineTotal, computeLineSubtotal, fmtCurrency } = totals
  const lines = useFormLines(state)
  const {
    uniformTaxRate, onDocTaxRateChange, onDocWarehouseChange, showPlaceOfDeal, isPinnedDefaultWarehouse,
    pinDefaultWarehouse, addLine, removeLine,
  } = lines
  const gr = useFormProductUpdate(state)
  const { setGRField, setGRTierPrice } = gr
  const pricing = useFormPricing(state, gr)
  const {
    resolvePriceForLine, onLinePriceChange, onLinePriceManualChange, onLinePriceSelected, docPriceEnabled, docPriceKey,
    docPriceItems, docPriceLoading, hasPricedLines, loadDocPriceChoices, applyDocPrice, lastPriceEnabled, useLastPrice,
    lastPriceLoading, onUseLastPriceChange,
  } = pricing
  const products = useFormProducts(state, pricing, gr)
  const {
    onAddLedgerLines, onProductSelected, onProductCleared, openProductPicker, existingProductIds, onProductsPicked,
    onProductPicked,
  } = products
  const party = useFormParty(state, lines, pricing, gr, products)
  const { onContactChange, onContactCreated, onContactSearch, contactPickerOpen, onContactPicked, onRelatedInvoiceSearch } = party
  const load = useFormLoad(state, lines, gr, party)
  const { applyImportedDocument, loadDocument } = load
  const {
    statusDef, cashSaleRef, attachDialogOpen, attachable, onAttached, issuable, isDraftDoc, correctable, payable,
    convertible, convertTargets, smartButtons, documentNumber,
  } = useFormStatus(state, load)
  const { showExportDialog, exportLoading, lastPrint, onExportSingle } = useFormPrint(state)

  // ── „Складова разписка": the goods a supplier bill booked ──
  /** The receipts the bill booked (`GET /invoices/:id`); the print is offered when there are some. */
  const stockReceipts = computed<Array<{ id: string; number: string; date: string; warehouseName: string }>>(
    () => (config.direction === 'incoming' && invoiceData.value?.stockMovements) || [],
  )
  const { loading: stockReceiptLoading, exportOne: exportStockReceipt } = useInvoicingExport(() => appStore.orgUrl())
  /** `StockReceiptPrintDialog`: which price the sheet shows. The action opens it; its „Печат" prints. */
  const stockReceiptDialog = ref(false)

  /** The action asks before it prints: nothing is rendered, and nothing downloaded, by opening the dialog. */
  function onPrintStockReceipt() {
    if (route.params.id && stockReceipts.value.length) stockReceiptDialog.value = true
  }

  /**
   * One section per receipt the bill booked, its prices at `priceLevel` (`config/stock-receipt-price`). It prints
   * what was booked, not what the form holds, so nothing is saved first: no edit on the form changes a receipt.
   * The dialog closes once the file is there; a refusal leaves it open, with what the server said.
   */
  async function printStockReceipt(priceLevel: string) {
    const id = route.params.id as string
    if (!id || !stockReceipts.value.length) return
    try {
      await exportStockReceipt(id, `${invoiceNumber.value || id}-stock-receipt`, 'pdf', 'detailed', undefined, appStore.locale, 'stock_receipt', undefined, { priceLevel })
      stockReceiptDialog.value = false
    } catch (e: any) {
      showError(e?.response?.data?.message || t('export.failed'))
    }
  }

  /** „Складова разписка" in the action bars: offered once the bill has booked a receipt, and not before. */
  const stockReceiptAction = computed<FormAction | null>(() => (stockReceipts.value.length
    ? {
        key: 'stock-receipt',
        label: t('invoicing.stockReceipt.print'),
        title: t('invoicing.stockReceipt.hint'),
        color: '',
        variant: 'outlined',
        icon: 'mdi-clipboard-text-outline',
        handler: onPrintStockReceipt,
        loading: stockReceiptLoading.value,
        testId: 'print-stock-receipt',
        collapse: COLLAPSE.stockReceipt,
      }
    : null))

  const {
    buildPayload, validate, saveIfNeeded, onSave, submitCreate, onSaveAndReceive, receiving, receiptOverlap, onConvert,
    converting, convertingTo,
  } = useFormSaving(state, totals, lines, load, opts)
  const {
    issuer, issuing, issuingWithPrint, issueError, receiptError, lineRefusalOf, receiptTakesPayment, paymentDialog,
    payableDoc, onPaymentRecorded, deliveryReceiptDue, receiptInDoubt, paymentReceipts, printingReceipt,
    printDeliveryReceipt,
  } = useFormIssue(state, load)

  // ── actions ──
  /**
   * Import from a file merges a document's fields into this form, for the user to save. It is offered on
   * every document not issued yet; on an issued one only where `editSaveGate` is `always` — an issued sales
   * invoice and a cash sale take no import (both bars agreed on that before they became one list).
   */
  const importAction: FormAction = {
    key: IMPORT_KEY,
    label: t('docImport.importFile'),
    color: 'secondary',
    variant: 'outlined',
    icon: 'mdi-file-upload-outline',
    collapse: COLLAPSE.import,
    // What `doc-import/target-access` asks of this form's target (#493 item 5, FR-27 acceptance 4): a bill is
    // `bills.create`, a sales document or a cash sale `sales-docs.import`.
    cap: config.direction === 'incoming' && config.apiType !== 'cash_sale' ? 'bills.create' : 'sales-docs.import',
    handler: () => { importDialogOpen.value = true },
  }

  /**
   * Save is offered in every status: a document is editable in every status (the API applies no status
   * check), and the foot of the form always offered it while the bar under the title dropped it once a sales
   * invoice was issued. The cash sale is the exception: it is issued as it is saved, on its own terminal.
   */
  const savesIssued = config.docType !== 'cash_sale'

  const formActions = computed<FormAction[]>(() => {
    const save: FormAction = { key: 'save', label: t('common.save'), color: 'primary', handler: onSave, loading: loading.value, save: true }
    const outlinedSave: FormAction = { ...save, variant: 'outlined' }
    const notes: FormAction[] = correctable.value
      ? [
          { key: 'credit-note', label: t('invoicing.docType.credit_note'), icon: 'mdi-file-undo', variant: 'outlined', handler: () => openNote('credit_note'), collapse: COLLAPSE.creditNote },
          { key: 'debit-note', label: t('invoicing.docType.debit_note'), icon: 'mdi-file-plus-outline', variant: 'outlined', handler: () => openNote('debit_note'), collapse: COLLAPSE.debitNote },
        ]
      : []
    // #171: an invoice for a cash sale keeps that sale's lines, so it takes no import; what an edit may still
    // change, the API says.
    if (cashSaleRef.value) return [save, ...notes]
    // FR-22.33: a bill that is not received yet is saved and received in one action — the
    // primary one, so it comes first; plain Save keeps a draft.
    if (config.saveAndReceive && isDraftDoc.value) {
      const receive: FormAction = {
        key: 'receive', label: t('invoicing.saveAndReceive'), color: 'primary', icon: 'mdi-package-down', handler: onSaveAndReceive, loading: receiving.value, primary: true,
      }
      return [receive, outlinedSave, importAction]
    }
    // One button per document the quote may become, each for the role that makes that document (FR-27.7).
    // The invoice is the first target: on an issued quote it is the action that finishes the job.
    const converts: FormAction[] = convertTargets.value.map((target) => ({
      key: `convert-${target}`,
      label: t(target === 'proforma' ? 'invoicing.convertToProforma' : 'invoicing.convertToInvoice'),
      icon: target === 'proforma' ? 'mdi-file-document-arrow-right-outline' : 'mdi-swap-horizontal',
      variant: 'outlined' as const,
      handler: () => onConvert(target),
      loading: convertingTo.value === target,
      disabled: !!convertingTo.value && convertingTo.value !== target,
      cap: target === 'proforma' ? 'proforma.create' : 'sales-docs.create',
    }))
    // FR-22.17/.18: a document not issued yet is issued from its own form. „Издай и печатай"
    // finishes the job, so it is the primary action and comes first. „Издай" saves first when the
    // form holds anything unsaved, and says so.
    if (issuable && isDraftDoc.value) {
      const busy = issuing.value
      return [
        { key: 'issue-print', label: t('invoicing.issueFlow.issueAndPrint'), color: 'primary', icon: 'mdi-printer-check', handler: onIssueAndPrint, loading: busy && issuingWithPrint.value, disabled: busy && !issuingWithPrint.value, primary: true, testId: 'issue-and-print' },
        { key: 'issue', label: t(isDirtyNow.value ? 'invoicing.issueFlow.saveAndIssue' : 'invoicing.issueFlow.issue'), color: 'primary', variant: 'outlined', icon: 'mdi-send-check', handler: () => issueFromForm(null), loading: busy && !issuingWithPrint.value, disabled: busy && issuingWithPrint.value },
        outlinedSave,
        // A quote not issued yet is rarely converted next: where the bar is narrow these show as their icons.
        ...converts.map((c) => ({ ...c, collapse: COLLAPSE.followUp })),
        importAction,
      ]
    }
    if (!isEdit.value) return [save, importAction]
    // Issued: what it can still change, and what follows from it.
    const issued: FormAction[] = []
    converts.forEach((c, i) => issued.push(i === 0 ? { ...c, color: 'primary', variant: 'flat', primary: true } : c))
    if (savesIssued) issued.push(issued.length ? outlinedSave : save)
    // FR-23: an issued invoice or debit note is paid from its own form too. It is how a payment
    // whose receipt failed is taken again.
    if (payable.value) {
      const refund = config.docType === 'credit_note'
      issued.push({ key: 'payment', label: t(refund ? 'invoicing.recordRefund' : 'invoicing.recordPayment'), icon: refund ? 'mdi-cash-refund' : 'mdi-cash', variant: 'outlined', handler: () => { paymentDialog.value = true } })
    }
    issued.push(...notes)
    if (attachable.value) {
      issued.push({ key: 'attach', label: t('invoicing.cashSaleInvoice.attach'), icon: 'mdi-link-variant', variant: 'outlined', handler: () => { attachDialogOpen.value = true }, collapse: COLLAPSE.followUp })
    }
    if (config.editSaveGate !== 'draft-only') issued.push(importAction)
    return issued
  })

  // ── print ──
  /**
   * FR-22.20 — „Печат": the document in one click, with the user's last settings. The options
   * dialog stays one click further away (`onPrintOptions`). #4.13: a document that is new or holds
   * unsaved edits is saved first — what prints is what is stored.
   */
  async function onPrint() {
    if (!(await saveIfNeeded())) return
    await onExportSingle({ ...lastPrint.value, companions: [] })
  }

  /**
   * What the Print dialog was opened to finish: a print of the document as it stands („Печат с настройки…"),
   * or the issue-and-print of one not issued yet („Издай и печатай"). `onPrintDialogConfirm` reads it.
   */
  const printDialogFor = ref<'print' | 'issue'>('print')

  /** „Печат…": the print options (format, columns, companion documents), after saving the same way. */
  async function onPrintOptions() {
    if (!(await saveIfNeeded())) return
    printDialogFor.value = 'print'
    showExportDialog.value = true
  }

  /**
   * „Издай и печатай": first HOW it is to print — the Print dialog, with the format, the mode, the documents
   * that go with it and the columns. Nothing has happened yet: closing the dialog saves nothing, issues
   * nothing and prints nothing. Its confirmation is what issues the document (`onPrintDialogConfirm`).
   *
   * A form that cannot be saved says so here, before it asks anything: an answer given to a dialog should not
   * be thrown away over a missing date. (What only the server can refuse — a draft with no customer is saved,
   * and not issued — is still said after the dialog, on the draft: `issueError`.)
   */
  async function onIssueAndPrint() {
    if (issuing.value) return
    if (isDirtyNow.value && !(await validate())) return
    printDialogFor.value = 'issue'
    showExportDialog.value = true
  }

  /** The Print dialog was confirmed: print with what it chose, or issue and then print that way. */
  async function onPrintDialogConfirm(o: PrintChoice) {
    if (printDialogFor.value !== 'issue') return onExportSingle(o)
    // The dialog has said what it had to; what issuing may still ask (the payment method, a transfer for a
    // warehouse that is short) is asked over the form, not over it.
    showExportDialog.value = false
    await issueFromForm(o)
  }

  /** „Печат" in the action bars: the print, and its options as the button's second half. */
  const printAction = computed<FormAction>(() => ({
    key: 'print',
    label: t('common.print'),
    color: '',
    variant: 'outlined',
    icon: 'mdi-printer',
    handler: onPrint,
    loading: exportLoading.value,
    testId: 'print-now',
    collapse: COLLAPSE.print,
    more: { icon: 'mdi-tune-variant', label: t('invoicing.issueFlow.printOptions'), handler: onPrintOptions, testId: 'print-options' },
  }))

  // ── issue (FR-22.17 / .18) ──
  /**
   * „Издай" / „Запази и издай" / „Издай и печатай": save what the form shows when it differs from
   * what is stored, then issue through the very path the list's „Изпрати" takes — the stock check,
   * the transfer dialog when a warehouse is short, `/send`. With `print` (what the Print dialog
   * chose), the issued document is printed that way, with the documents ticked to go with it; a print
   * that worked is where the next one starts. Nothing prints unless it was issued: a document that
   * could not be issued stays a draft, and the form says why.
   */
  async function issueFromForm(print: PrintChoice | null) {
    if (issuing.value) return
    issuing.value = true
    issuingWithPrint.value = !!print
    issueError.value = ''
    try {
      const id = await saveIfNeeded()
      if (!id) return
      const outcome = await issuer.issue({ _id: id, type: config.apiType }, async () => {
        await loadDocument()
        if (print) await onExportSingle(print)
      })
      // Refused: the draft as stored, with the reason on it. ('transfer': the dialog is open, and
      // confirming it issues — and prints — the document.)
      if (outcome === 'failed') await loadDocument()
    } finally {
      issuing.value = false
      issuingWithPrint.value = false
    }
  }

  /** FR-22.21: a credit or debit note for this invoice — its form opens on the invoice's customer and lines. */
  function openNote(type: 'credit_note' | 'debit_note') {
    const id = route.params.id
    if (!id) return
    void router.push({
      name: config.direction === 'incoming' ? 'invoicing.purchases.new' : 'invoicing.sales.new',
      query: { type, relatedInvoiceId: String(id) },
    })
  }

  // The form's own `onMounted`, last (see the head of this file).
  load.mountForm()

  return {
    // config passthrough
    config,
    // identity / status
    isEdit, route, invoiceStatus, invoiceNumber, invoiceData, cashSaleRef, attachDialogOpen, onAttached, documentNumber,
    statusDef,
    // collections
    contacts, warehouses, invoices, loadingContacts, selectedContact,
    // refs
    formRef, issueDateRef, loading, rules, ledgerDialog, productPickerOpen, productPickerRowIdx, productPickerText,
    existingProductIds, columnPickerOpen, importDialogOpen, applyImportedDocument,
    // form
    form, notesModel,
    // columns
    selectedCols, availableLineColumns, activeLineColumns, lineColumnEntries, toggleCol, moveCol, reorderCol,
    selectAllCols, selectNoCols, resetColDefaults, isColActive,
    // GR product-update (purchase bills)
    withProductUpdate, onWithProductUpdateChange, productUpdateOffered, foreignBillCurrency, grColumnPickerOpen,
    grColumnsVisible, grSelectedCols, grActiveColumns, grToggleCol, grSelectAllCols, grSelectNoCols, grResetColDefaults,
    grCategories, setGRField, setGRTierPrice, uomOptions, paymentMethods, vatRates, defaultVatRate,
    // totals / format
    subtotal, discountTotal, taxBase, taxTotal, documentTotal, computeLineTotal, computeLineSubtotal, uniformTaxRate,
    // doc-level single-value controls
    docTaxRate, docWarehouseId, onDocTaxRateChange, onDocWarehouseChange, pinDefaultWarehouse, isPinnedDefaultWarehouse,
    fmtCurrency, baseCurrency, localeCode,
    // actions / line ops
    formActions, smartButtons, addLine, removeLine, onAddLedgerLines, onProductSelected, onProductCleared,
    openProductPicker, onProductPicked, onProductsPicked, resolvePriceForLine, onLinePriceChange, onLinePriceManualChange,
    onLinePriceSelected,
    // one price for the whole document
    docPriceEnabled, docPriceKey, docPriceItems, docPriceLoading, hasPricedLines, loadDocPriceChoices, applyDocPrice,
    // #145: the customer's last price
    lastPriceEnabled, useLastPrice, lastPriceLoading, onUseLastPriceChange, onContactChange, onContactCreated,
    onContactSearch, contactPickerOpen, onContactPicked, onRelatedInvoiceSearch,
    // export
    showExportDialog, printNote, companionNote, exportLoading, onExportSingle,
    // FR-22.20: one click, the user's last settings; the options one click further
    lastPrint, onPrint, onPrintOptions,
    // the Print dialog: what it was opened to finish, and its answer („Издай и печатай" asks it first)
    printDialogFor, onIssueAndPrint, onPrintDialogConfirm, printAction,
    // a supplier bill's „Складова разписка": the action opens the price dialog, the dialog prints
    stockReceipts, stockReceiptLoading, stockReceiptDialog, onPrintStockReceipt, printStockReceipt, stockReceiptAction,
    // persistence
    buildPayload, onSave, submitCreate, isDirtyNow,
    // FR-22.33: save and receive; and what a linker needs to reload the bill it changed
    onSaveAndReceive, receiving, receiptOverlap, saveIfNeeded, loadDocument, markSaved,
    /** A linker that made this new document itself tells the view it is the same document (FR-22.16). */
    adoptCreated: (id: string) => opts.onCreated?.(id),
    // FR-22.17/.18: issue from the form, and the stock check in front of it
    issuable, isDraftDoc, issuing, issueFromForm, issueError, lineRefusalOf,
    // FR-31.6 / .8: what the shell says of a failed load (with Retry: `loadDocument`) and of a refused save.
    loadError: feedback.loadError,
    refusal: feedback.refusal,
    dismissRefusal: feedback.dismissRefusal,
    receiptError, receiptTakesPayment, deliveryReceiptDue, receiptInDoubt, paymentReceipts, printingReceipt,
    printDeliveryReceipt, paymentDialog, payableDoc, onPaymentRecorded,
    transfer: issuer.transfer,
    confirmTransfers: issuer.confirmTransfers,
    // Owner, 2026-11-12: the payment method an outgoing invoice is issued with, confirmed first.
    paymentConfirm: issuer.paymentConfirm,
    answerPayment: issuer.answerPayment,
    // FR-22.61b: the question before an invoice dispatches goods a stock note already delivered, and its answers.
    dispatchOverlap: issuer.dispatchOverlap,
    issueDespiteOverlap: issuer.issueDespiteOverlap,
    overlapLinked: issuer.overlapLinked,
    // FR-22.27: place of deal
    showPlaceOfDeal,
    // FR-22.21 / FR-22.22
    correctable, openNote, convertible, convertTargets, onConvert, converting, convertingTo,
    // misc
    orgUrl, appStore,
  }
}
