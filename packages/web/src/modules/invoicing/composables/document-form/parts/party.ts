/**
 * FR-32.22 (#797): the document's party and the documents it draws on. The contact (picked, searched, created, and
 * its billing address), the invoice a note corrects, the reference lists the pickers read (contacts, warehouses,
 * invoices), and what a new document starts as: a copy (`?copyOf=`), a note opened from its invoice
 * (`?relatedInvoiceId=`), or an article (`?productId=`).
 */
import { ref, watch } from 'vue'
import { getDocument, listDocuments, type DocumentContact, type DocumentListParams } from '../../../api/documents'
import { getContact, listContacts } from '../../../api/contacts'
import { getProduct } from '../../../api/products'
import { listWarehouses } from '../../../api/warehouses'
import { reportError } from 'ui-shared/composables/report-error'
import { linesFromRelatedInvoice, copyOfDocument, noteFromInvoice } from '../document-payload'
import type { FormState, Line } from './state'
import type { FormLines } from './lines'
import type { FormPricing } from './pricing'
import type { FormProductUpdate } from './product-update'
import type { FormProducts } from './products'

export function useFormParty(s: FormState, lines: FormLines, pricing: FormPricing, gr: FormProductUpdate, products: FormProducts) {
  const { config, isEdit, form, contacts, warehouses, invoices, loadingContacts, selectedContact, emptyLine } = s
  const { syncDocLevelFromLines } = lines
  const { priceOptionsCache, docPriceKey, useLastPrice, reResolveLinePrices } = pricing
  const { seedUnseededLines } = gr
  const { onProductSelected } = products

  // ── contact change (R6: re-resolve for ALL types; invoice also captures billing) ──
  function captureBilling(contactId: string) {
    const contact = contacts.value.find((c: any) => c._id === contactId)
    if (!contact || !contact.addresses || contact.addresses.length === 0) return
    const billingAddr =
      contact.addresses.find((a: any) => a.type === 'billing' && a.isDefault) ||
      contact.addresses.find((a: any) => a.type === 'billing') ||
      contact.addresses.find((a: any) => a.isDefault) ||
      contact.addresses[0]
    if (billingAddr) {
      form.billingAddress.street = billingAddr.street || ''
      form.billingAddress.city = billingAddr.city || ''
      form.billingAddress.state = billingAddr.state || ''
      form.billingAddress.postalCode = billingAddr.postalCode || ''
      form.billingAddress.country = billingAddr.country || ''
    }
  }

  function onContactChange(contactId?: string) {
    const id = contactId ?? form.contactId
    if (config.captureBillingAddress && id) captureBilling(id)
    // Tag and contact prices differ per contact: options fetched for the previous one are stale.
    priceOptionsCache.clear()
    if (config.reResolveOnChange || docPriceKey.value || useLastPrice.value) void reResolveLinePrices()
    // Narrow the related-invoice candidates to the newly chosen contact.
    if (config.showRelatedInvoice) void fetchInvoices() // reference data, never rejects
  }

  /** The contact the create dialog made: the route's answer (`ContactAutocompleteWithCreate`), named by its `_id`. */
  function onContactCreated(contact: { _id: string }) {
    contacts.value.push(contact)
    form.contactId = contact._id
    onContactChange(form.contactId)
  }

  // ── related-invoice autofill (credit / debit) ──
  /** The invoice `prefillFromInvoice` already copied: the watcher below must not copy it again. */
  let prefilledFrom = ''
  if (config.relatedInvoiceAutofill) {
    watch(
      () => form.relatedInvoiceId,
      async (newId) => {
        if (!newId || isEdit.value) return
        if (newId === prefilledFrom) {
          prefilledFrom = ''
          return
        }
        try {
          const { invoice } = await getDocument(newId)
          if (invoice.lines?.length) {
            form.lines = linesFromRelatedInvoice(invoice.lines)
            // The doc-level tax-rate / warehouse controls show what the copied lines carry.
            syncDocLevelFromLines()
          }
        } catch (e) { reportError(e) }
      },
    )
  }

  /**
   * FR-22.21: a note opened from the invoice it corrects (`?relatedInvoiceId=` — „Кредитно
   * известие" / „Дебитно известие" on the invoice) starts as that invoice: its customer, the
   * invoice itself, its currency and method, and its lines as they were sold. The user then keeps
   * what is returned or charged. The customer is set without `onContactChange`, whose price
   * re-resolution would replace the prices the invoice charged.
   */
  async function prefillFromInvoice(id: string) {
    try {
      const { invoice } = await getDocument(id)
      const note = noteFromInvoice(invoice)
      form.contactId = note.contactId
      await ensureSelectedContactLoaded(invoice.contactId)
      if (note.currency) form.currency = note.currency
      form.exchangeRate = note.exchangeRate
      if (note.paymentMethod) form.paymentMethod = note.paymentMethod
      form.lines = note.lines as Line[]
      prefilledFrom = note.relatedInvoiceId
      if (!invoices.value.some((i: any) => i._id === note.relatedInvoiceId)) {
        invoices.value = [invoice, ...invoices.value]
      }
      form.relatedInvoiceId = note.relatedInvoiceId
      syncDocLevelFromLines()
      // The related-invoice candidates narrow to this customer, as a pick of the customer does.
      void fetchInvoices()
    } catch {
      /* The user picks the invoice by hand, as before. */
    }
  }

  /**
   * FR-22.24 — „Копирай" (`?copyOf=`): a new draft that starts as another document of this form
   * (`copyOfDocument` says what comes along). Dated today, numbered when it is saved. A copied
   * note keeps the invoice it corrects, and its own lines rather than that invoice's.
   */
  async function prefillFromCopy(id: string) {
    try {
      const { invoice: source } = await getDocument(id)
      const copy = copyOfDocument(source)
      form.contactId = copy.contactId
      await ensureSelectedContactLoaded(source.contactId)
      if (copy.currency) form.currency = copy.currency
      form.exchangeRate = copy.exchangeRate
      if (config.paymentMethodMode !== 'fixed') form.paymentMethod = copy.paymentMethod
      form.notes = copy.notes
      form.terms = copy.terms
      form.footer = copy.footer
      form.reason = copy.reason
      form.tags = copy.tags
      if (copy.placeOfTransaction) form.placeOfTransaction = copy.placeOfTransaction
      if (config.captureBillingAddress && copy.billingAddress) form.billingAddress = { ...copy.billingAddress } as any
      form.lines = [...(copy.lines as Line[]), emptyLine()]
      if (config.showRelatedInvoice && copy.relatedInvoiceId) {
        prefilledFrom = copy.relatedInvoiceId
        form.relatedInvoiceId = copy.relatedInvoiceId
        await ensureSelectedRelatedInvoiceLoaded(copy.relatedInvoiceId)
      }
      syncDocLevelFromLines()
      await seedUnseededLines()
    } catch {
      /* A blank form, as „Нов" opens. */
    }
  }

  /**
   * FR-22.47 — „Продай" on an article (`?productId=`): a new document whose first line is that
   * article, filled through `onProductSelected` exactly as picking it on the line fills it: its
   * unit and VAT, the price the pricing chain resolves (the purchase price on a purchase document,
   * B-10), the document-wide and last-customer prices when those are on, and the next blank line.
   * It runs after the form's own defaults, so the line sits in the document's warehouse. An article
   * that cannot be read leaves the blank form „Нов" opens.
   */
  async function prefillFromProduct(id: string) {
    try {
      const { product } = await getProduct(encodeURIComponent(id))
      const line = form.lines[0]
      if (!line) return
      line.productId = product._id
      line.description = product.name
      await onProductSelected(0, product)
    } catch {
      /* A blank form, as „Нов" opens. */
    }
  }

  // ── data loading ──
  async function fetchContacts(search?: string) {
    loadingContacts.value = true
    try {
      // FR-22.25: this document's side first, the most recently used at the top — customers on
      // an outgoing document, suppliers on an incoming one.
      const params: Record<string, any> = {
        ...(config.contactFetchParams || {}),
        size: 20,
        prefer: config.direction === 'incoming' ? 'supplier' : 'customer',
        // FR-30.7: the picker's rows: the party block's addresses and tax numbers, without the notes and mirrors.
        fields: 'list',
        // FR-30.12: a type-ahead shows no total, so nothing is counted.
        count: 'none',
      }
      if (search) params.search = search
      contacts.value = (await listContacts(params)).contacts
      // A filtered result may drop the currently selected contact — keep it resolvable.
      if (form.contactId) await ensureSelectedContactLoaded(form.contactId)
    } catch { /* Reference data: a refusal leaves the choice empty, and the HTTP client says a network failure or a 5xx. */ } finally {
      loadingContacts.value = false
    }
  }

  let contactSearchTimer: ReturnType<typeof setTimeout> | null = null
  function onContactSearch(text: string) {
    // Vuetify echoes the selected item's title into the search box — not a user query.
    if (selectedContact.value && text === selectedContact.value.companyName) return
    if (contactSearchTimer) clearTimeout(contactSearchTimer)
    contactSearchTimer = setTimeout(() => fetchContacts(text || undefined), 300)
  }

  // ── contact picker dialog (wide server-searched table, mirrors the product picker) ──
  const contactPickerOpen = ref(false)
  /** A row of the wide picker (`ContactPickerDialog`): the list route's contact, named by its `_id`. */
  function onContactPicked(c: { _id: string }) {
    const id = c._id
    if (!contacts.value.some((x: any) => x._id === id)) contacts.value = [c, ...contacts.value]
    form.contactId = id
    onContactChange(id)
  }

  /** Ensure the invoice's selected contact is in the picker list even when it falls outside the
   * (paginated / type-filtered) contact fetch — otherwise the autocomplete shows the raw id and the
   * party block shows "—". Fetches the full contact (with addresses + tax numbers) by id. */
  async function ensureSelectedContactLoaded(rawContactId: DocumentContact | string | undefined) {
    // A document's read names its contact; the form holds the id.
    const id = typeof rawContactId === 'object' ? rawContactId._id : rawContactId
    if (!id) return
    if (contacts.value.some((c: any) => c._id === id)) return
    try {
      const { contact } = await getContact(id)
      contacts.value = [contact, ...contacts.value]
    } catch {
      // Fallback to the invoice's populated contact (name only) so the picker isn't blank.
      if (typeof rawContactId === 'object' && rawContactId.companyName) contacts.value = [rawContactId, ...contacts.value]
    }
  }

  async function fetchWarehouses() {
    try {
      // The endpoint paginates with size=10 by default — request all for the per-line DDL.
      warehouses.value = (await listWarehouses({ size: 1000 })).warehouses
    } catch { /* Reference data: a refusal leaves the choice empty, and the HTTP client says a network failure or a 5xx. */ }
  }

  /**
   * Server-searched candidates for the related-invoice picker (credit/debit notes).
   * Only issued invoices from the SAME side qualify (mirrors the backend 422 rules), and
   * the list narrows to the chosen contact once one is selected.
   */
  async function fetchInvoices(search?: string) {
    try {
      const params: DocumentListParams = {
        type: 'invoice',
        direction: config.direction,
        status: 'sent,received,partially_paid,paid,overdue',
        size: 20,
      }
      if (search) params.search = search
      if (form.contactId) params.contactId = form.contactId
      invoices.value = (await listDocuments(params)).invoices
      // A filtered result may drop the currently selected invoice — keep it resolvable.
      if (form.relatedInvoiceId) await ensureSelectedRelatedInvoiceLoaded(form.relatedInvoiceId)
    } catch { /* Reference data: a refusal leaves the choice empty, and the HTTP client says a network failure or a 5xx. */ }
  }

  let relatedSearchTimer: ReturnType<typeof setTimeout> | null = null
  function onRelatedInvoiceSearch(text: string) {
    // Vuetify echoes the selected item's title into the search box — not a user query.
    const selected = invoices.value.find((i: any) => i._id === form.relatedInvoiceId)
    if (selected && text === selected.invoiceNumber) return
    if (relatedSearchTimer) clearTimeout(relatedSearchTimer)
    relatedSearchTimer = setTimeout(() => fetchInvoices(text || undefined), 300)
  }

  async function ensureSelectedRelatedInvoiceLoaded(id: string) {
    if (!id || invoices.value.some((i: any) => i._id === id)) return
    try {
      const { invoice } = await getDocument(id)
      invoices.value = [invoice, ...invoices.value]
    } catch { /* The list keeps what it had: the picked id stays on the form. */ }
  }

  return {
    onContactChange, onContactCreated, prefillFromInvoice, prefillFromCopy, prefillFromProduct,
    fetchContacts, onContactSearch, contactPickerOpen, onContactPicked, ensureSelectedContactLoaded,
    fetchWarehouses, fetchInvoices, onRelatedInvoiceSearch, ensureSelectedRelatedInvoiceLoaded,
  }
}

export type FormParty = ReturnType<typeof useFormParty>
