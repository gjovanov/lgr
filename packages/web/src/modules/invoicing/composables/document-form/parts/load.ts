/**
 * FR-32.22 (#797): what fills the form. A stored document (`loadDocument`, the form's clean state), an imported one
 * merged into it (`applyImportedDocument`), the next number a new one would take, and the form's start on mount: the
 * reference lists, a restored draft, or a new document's defaults (and its copy, note or article).
 *
 * ⚠ `mountForm` registers the form's `onMounted`, and `useDocumentForm` calls it LAST, where the hook always was:
 * after `usePendingChanges`'s own (`state.ts`), so the clean state is taken when the load resolves (FR-31 A1).
 */
import { onMounted } from 'vue'
import { getDocument, peekNextDocumentNumber } from '../../../api/documents'
import { takeHandedDocument } from '../document-preread'
import { emptyBillingAddress, type FormState, type Line } from './state'
import type { FormLines } from './lines'
import type { FormProductUpdate } from './product-update'
import type { FormParty } from './party'

export function useFormLoad(s: FormState, lines: FormLines, gr: FormProductUpdate, party: FormParty) {
  const {
    config, t, route, showSuccess, feedback, baseCurrency, defaultVatRate, isEdit, warehouses,
    invoiceStatus, invoiceNumber, invoiceData, peekedNumber, docTaxRate, userDefaultWarehouseId, loadUserDefaultWarehouse,
    form, emptyLine, rememberedPaymentMethod, markLoaded, tryRestore, grColumnsVisible, printNote, companionNote,
    noteLoaded,
  } = s
  const { filledFormLines, syncDocLevelFromLines, onDocWarehouseChange, seedPlaceOfDeal } = lines
  const { seedUnseededLines, fetchGRCategories } = gr
  const {
    ensureSelectedContactLoaded, ensureSelectedRelatedInvoiceLoaded, fetchContacts, fetchWarehouses, fetchInvoices,
    prefillFromCopy, prefillFromInvoice, prefillFromProduct,
  } = party

  /**
   * Merge an imported document (single-file PDF import) into THIS open form.
   *
   * Nothing was persisted server-side — the user reviewed a field diff and this applies
   * the subset they kept. Three things are deliberate:
   *  - lines are built directly, never through `onProductSelected`, which would overwrite
   *    the document's own price with the catalog price and append a blank row;
   *  - every imported line is marked `loaded` so `PriceCombobox` treats its price as a
   *    historical fact instead of re-resolving it the moment a productId appears;
   *  - `syncDocLevelFromLines()` runs afterwards, or the doc-level tax-rate/warehouse
   *    controls keep showing the values from before the import.
   */
  async function applyImportedDocument(payload: {
    fields: Record<string, any>
    lines: any[]
    lineMode: 'replace' | 'append' | 'keep'
  }) {
    for (const [k, v] of Object.entries(payload.fields || {})) {
      if (v === undefined || v === null || v === '') continue
      ;(form as any)[k] = v
    }
    // The matched counterparty is rarely on the autocomplete's currently loaded page, and
    // an unloaded id renders as a blank field.
    if (payload.fields?.contactId) await ensureSelectedContactLoaded(payload.fields.contactId)

    if (payload.lineMode !== 'keep' && payload.lines?.length) {
      const mapped: Line[] = payload.lines.map((l: any) => ({
        productId: l.productId || undefined,
        description: l.description || '',
        quantity: Number(l.quantity) || 0,
        unit: l.unit || 'pcs',
        unitPrice: Number(l.unitPrice) || 0,
        discount: Number(l.discount) || 0,
        taxRate: Number(l.taxRate) || 0,
        taxAmount: Number(l.taxAmount) || 0,
        lineTotal: Number(l.lineTotal) || 0,
        accountId: undefined,
        warehouseId: l.warehouseId || undefined,
        orderRef: l.orderRef || undefined,
        // Original OCR wording — persisted, and what supplier alias learning trains on.
        sourceText: l.sourceText || undefined,
        resolvedPrice: Number(l.unitPrice) || undefined,
        productUpdate: {},
        priceTiers: [],
        loaded: true,
      }))
      const kept = payload.lineMode === 'append' ? filledFormLines() : []
      form.lines = [...kept, ...mapped, emptyLine()]
    }

    syncDocLevelFromLines()
    await seedUnseededLines()
    showSuccess(t('docImport.applied'))
  }

  async function fetchPeekedNumber() {
    try {
      peekedNumber.value = (await peekNextDocumentNumber(config.peekParams)).next
    } catch {
      /* keep empty */
    }
  }

  function mapLoadedLine(l: any): Line {
    return {
      productId: l.productId || undefined,
      description: l.description || '',
      quantity: l.quantity || 1,
      unit: l.unit || 'pcs',
      unitPrice: l.unitPrice || 0,
      discount: l.discount || 0,
      taxRate: l.taxRate || 0,
      taxAmount: l.taxAmount || 0,
      lineTotal: l.lineTotal || 0,
      accountId: l.accountId || undefined,
      warehouseId: l.warehouseId || undefined,
      priceExplanation: l.priceExplanation || undefined,
      orderRef: l.orderRef || undefined,
      sourceText: l.sourceText || undefined,
      cashSaleLineId: l.cashSaleLineId || undefined,
      resolvedPrice: l.unitPrice || undefined,
      productUpdate: {},
      priceTiers: [],
      // FR-30.10: the article's name as the document's read gave it, so the line reads no article to show it. It names
      // its article only while the line still holds that article (`ProductLineDescription#known`).
      ...(l.productId && typeof l.productName === 'string' ? { knownProduct: { id: String(l.productId), name: l.productName } } : {}),
      // Marks the line as loaded from a persisted document — the price combobox must
      // not overwrite its historical price with the currently-resolved one.
      loaded: true,
    }
  }

  /**
   * Read the document into the form. True when it was read; otherwise the form says why (`loadError`, FR-31.6): not
   * found, not allowed, or not loaded. It used to swallow the failure, and an id that did not exist showed „Edit
   * Invoice", a Draft chip, an empty form and enabled Issue and Save.
   */
  async function loadDocument(): Promise<boolean> {
    feedback.loadStarted()
    try {
      // FR-30.10: what the view read to choose this form, when it did; else the document is read here.
      const id = String(route.params.id)
      const data = takeHandedDocument<Awaited<ReturnType<typeof getDocument>>>(id) ?? (await getDocument(id))
      const inv = data.invoice
      // What was just loaded is the clean state (FR-22.13, FR-31.2), with whatever it awaits: the contact, a bill's
      // seeded lines. An edit made while it loaded stays an edit. After a save that stays on the document (FR-22.16)
      // this is the clean state again.
      await markLoaded(async () => {
        invoiceStatus.value = inv.status || 'draft'
        invoiceNumber.value = inv.invoiceNumber || ''
        invoiceData.value = inv
        // The read names the contact (`{ _id, companyName… }`), or gives the stored id when it is gone.
        form.contactId = typeof inv.contactId === 'object' ? inv.contactId._id : inv.contactId ?? ''
        // The supplier's own invoice number is stored in `reference` (the model has no `supplierInvoiceNumber`).
        form.supplierInvoiceNumber = inv.reference || ''
        form.relatedInvoiceId = inv.relatedInvoiceId || ''
        form.issueDate = inv.issueDate.split('T')[0]
        form.dueDate = inv.dueDate?.split('T')[0] || ''
        // A proforma's validity is stored as its dueDate (B-11): the model has no validUntil.
        form.validUntil = config.secondaryDate === 'validUntil' ? form.dueDate : ''
        form.currency = inv.currency || baseCurrency.value
        form.exchangeRate = inv.exchangeRate || 1
        form.paymentMethod = inv.paymentMethod || config.paymentMethodDefault
        form.notes = inv.notes || ''
        // The print note is stored with the document, so it comes back on every later print.
        printNote.value = inv.printNote || ''
        companionNote.value = inv.companionNote || ''
        form.terms = inv.terms || ''
        form.footer = inv.footer || ''
        form.reason = inv.reason || ''
        form.preparedBy = inv.preparedBy || ''
        form.placeOfTransaction = inv.placeOfTransaction || ''
        form.tags = inv.tags || []
        if (config.captureBillingAddress) {
          form.billingAddress = inv.billingAddress
            ? {
                street: inv.billingAddress.street || '',
                city: inv.billingAddress.city || '',
                state: inv.billingAddress.state || '',
                postalCode: inv.billingAddress.postalCode || '',
                country: inv.billingAddress.country || '',
              }
            : emptyBillingAddress()
        }
        form.lines = (inv.lines || []).map(mapLoadedLine)
        syncDocLevelFromLines()
        await ensureSelectedContactLoaded(inv.contactId)
        if (form.relatedInvoiceId) await ensureSelectedRelatedInvoiceLoaded(form.relatedInvoiceId)
        // A bill's lines take their product's current values before the clean state is taken:
        // seeding is loading, not an edit, and must not leave an untouched bill "unsaved".
        await seedUnseededLines()
      })
      noteLoaded()
      return true
    } catch (e) {
      feedback.loadFailed(e)
      return false
    }
  }

  /** Registers the form's `onMounted`. Called once, last, by `useDocumentForm` (see the head of this file). */
  function mountForm() {
    onMounted(async () => {
      const tasks: Promise<any>[] = [fetchContacts(), fetchWarehouses()]
      if (config.showRelatedInvoice) tasks.push(fetchInvoices())
      // The switch starts on: the category column's options are loaded as the switch would load them.
      if (grColumnsVisible.value) tasks.push(fetchGRCategories())
      await Promise.all(tasks)
      userDefaultWarehouseId.value = loadUserDefaultWarehouse()
      if (tryRestore()) {
        syncDocLevelFromLines()
        void seedUnseededLines()
        return
      }
      if (!isEdit.value) {
        // What a new document starts with (its defaults, the copy or the invoice it was opened from) is its clean state,
        // not an edit (FR-31.2).
        await markLoaded(async () => {
          // Seed doc-level controls: org default VAT rate; user default WH → org default WH.
          docTaxRate.value = defaultVatRate.value
          const userWh = userDefaultWarehouseId.value
          const candidate =
            (userWh && warehouses.value.some((w) => w._id === userWh) ? userWh : '') ||
            (warehouses.value as any[]).find((w: any) => w.isDefault)?._id ||
            null
          if (candidate) onDocWarehouseChange(candidate)
          else seedPlaceOfDeal()
          void fetchPeekedNumber() // a preview, never rejects
          // FR-22.26: how this user last paid a document of this type.
          const method = rememberedPaymentMethod()
          if (method !== null) form.paymentMethod = method
          // FR-22.24: a copy starts as its source; FR-22.21: a note opened from the invoice it
          // corrects starts as that invoice; FR-22.47: a document opened from an article starts with
          // it on the first line.
          const copyOf = String(route.query.copyOf || '')
          const relatedId = String(route.query.relatedInvoiceId || '')
          const productId = String(route.query.productId || '')
          if (copyOf) await prefillFromCopy(copyOf)
          else if (relatedId && config.relatedInvoiceAutofill) await prefillFromInvoice(relatedId)
          else if (productId) await prefillFromProduct(productId)
        })
      }
      if (isEdit.value) await loadDocument()
    })
  }

  return { applyImportedDocument, loadDocument, mountForm }
}

export type FormLoad = ReturnType<typeof useFormLoad>
