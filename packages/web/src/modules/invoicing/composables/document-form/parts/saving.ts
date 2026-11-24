/**
 * FR-32.22 (#797): saving the document — the payload, the validation every save, issue and print asks first, the save
 * itself (which keeps the user on the document), and the two actions that save and then go on: a bill's „Запази и
 * получи" and a quote's conversion.
 */
import { ref } from 'vue'
import { convertQuote, createDocument, receiveBill, updateDocument, type DocumentBody } from '../../../api/documents'
import { createIdempotentAction } from 'ui-shared/composables/idempotency'
import { flushPriceLookups } from 'ui-shared/composables/price-lookups'
import { stockRefusalMessage } from 'ui-shared/composables/stock-refusals'
import { upsertAmountInWords } from 'config/amount-in-words'
import { receiptRefusalKey, receiptRefusalMessage } from 'ui-shared/cash-register/receipt-refusal'
import { receiptOverlapOf, type ReceiptOverlap } from '../../receipt-overlap'
import { buildPayload as buildPayloadPure, buildProductUpdates, type DocumentFormState } from '../document-payload'
import type { BeforeCreateResult, UseDocumentFormOptions } from '../types'
import type { FormState } from './state'
import type { FormTotals } from './totals'
import type { FormLines } from './lines'
import type { FormLoad } from './load'

export function useFormSaving(s: FormState, totalsPart: FormTotals, lines: FormLines, load: FormLoad, opts: UseDocumentFormOptions) {
  const {
    config, t, route, router, appStore, feedback, showSuccess, isEdit, loading, form, baseCurrency, formRef, issueDateRef,
    grColumnsVisible, payMethodMemory, markSaved, printNote, companionNote, isDirtyNow,
  } = s
  const { totals } = totalsPart
  const { showPlaceOfDeal } = lines
  const { loadDocument } = load

  // ── persistence ──
  function buildPayload(): Record<string, any> {
    const p = buildPayloadPure(form as unknown as DocumentFormState, config)
    // A purchase bill with the switch on carries what its lines change on their products, and only
    // that: a bill saved untouched updates no product and takes the plain save path.
    if (grColumnsVisible.value) {
      const updates = buildProductUpdates(form.lines)
      if (updates.length) p.productUpdates = updates
    }
    // Auto amount-in-words ("Словом") on outgoing documents, in the user's UI language,
    // refreshed on every save (replaces any prior line, never stacks). Writes into the
    // notes field and mirrors it back onto the form so an immediate re-save is stable.
    if (config.direction === 'outgoing') {
      const key = config.notesFieldModel
      const words = upsertAmountInWords(
        (form as any)[key] || '',
        totals.value.total,
        totals.value.subtotal,
        form.currency || baseCurrency.value,
        appStore.locale,
      )
      ;(form as any)[key] = words
      p[key] = words
    }
    // Stored with the document so every later print repeats it; an empty box clears it.
    p.printNote = printNote.value.trim()
    p.companionNote = companionNote.value.trim()
    // FR-22.27: the place of deal is a field of its own on an outgoing document, so a cleared one
    // is saved as cleared (the shared builder sends it only when set).
    if (showPlaceOfDeal) p.placeOfTransaction = (form.placeOfTransaction || '').trim()
    return p
  }

  async function validate(): Promise<boolean> {
    // Every save, issue and print asks here first, so a line's price still waiting for its quantity's typing to stop
    // is looked up now (FR-31.5): what is saved is the price of the quantity on the screen.
    await flushPriceLookups()
    // The date and the form are both asked, one after the other and never short-circuited, so every
    // field that is wrong says so on the one press of Save (a bill with no supplier invoice number
    // AND no date).
    const dateErrors = issueDateRef.value ? await issueDateRef.value.validate() : []
    const main = formRef.value ? (await formRef.value.validate()).valid : true
    return dateErrors.length === 0 && main
  }

  const createAttempt = createIdempotentAction()

  /**
   * FR-22.16: saving keeps the user on the document, as stored — a new one moves onto its own edit
   * route. Save used to return to the list, so every next step (issue, print, a note) began by
   * finding the document again. A cash sale is the exception: it is issued as it is saved, and its
   * journal is where the next one starts (FR-21 owns that screen; FR-22.58 plans „Запази и нова").
   */
  const staysOnSave = config.docType !== 'cash_sale'

  /**
   * Save the payload. The document's id, or null when nothing was saved (the reason was shown).
   * `quiet`: no "saved" message — the save is a step of a longer action that reports itself.
   */
  async function persist(payload: Record<string, any>, persistOpts: { quiet?: boolean } = {}): Promise<string | null> {
    loading.value = true
    try {
      let id = route.params.id ? String(route.params.id) : ''
      const created = !isEdit.value
      if (!created) {
        await updateDocument(id, payload)
      } else {
        // #155: an unanswered save keeps its key, so saving again returns the document it made
        // (a cash sale is issued and moves stock on create) instead of making a second one.
        // `buildPayload` writes the schema's fields (`document-payload.ts`, held to the routes by its tests).
        const { invoice } = await createAttempt.run(payload, headers => createDocument(payload as DocumentBody, headers))
        id = invoice._id
      }
      markSaved()
      feedback.succeeded()
      // FR-22.26: the method a new document was saved with is where the next one starts. Editing an
      // older document changes nothing about the next.
      if (created) payMethodMemory?.write(form.paymentMethod || '')
      if (!persistOpts.quiet) showSuccess(t(config.successKey))
      if (!staysOnSave) {
        void router.push({ name: config.listRouteName })
        return id
      }
      if (String(route.params.id || '') !== id) {
        // On the saved document before anything else happens to it: should a following step fail
        // (issue, receive, print), pressing again acts on this one rather than saving a second.
        opts.onCreated?.(id)
        await router.replace({ name: `${config.listRouteName}.edit`, params: { id } })
      }
      await loadDocument()
      return id
    } catch (e: any) {
      // A receipt's refusal in its own words (FR-23); a stock refusal in the user's language (#168, FR-22.61: an
      // invoice made from a stock note keeps its quantities); any other as the server said it. Said at the top of the
      // form, where it stays until it is closed or the next save succeeds (FR-31.8).
      feedback.refused(receiptRefusalKey(e?.response?.data) ? receiptRefusalMessage(t, e, t('common.operationFailed')) : stockRefusalMessage(e, t))
      return null
    } finally {
      loading.value = false
    }
  }

  /**
   * The document as the form shows it, stored: its id, or null when it is invalid or was refused.
   * `noProductUpdates`: its lines are about to be thrown away, so what they staged for their products
   * must not reach the catalog on the way.
   */
  async function saveIfNeeded(opts: { noProductUpdates?: boolean } = {}): Promise<string | null> {
    if (isEdit.value && !isDirtyNow.value) return String(route.params.id)
    if (!(await validate())) return null
    const payload = buildPayload()
    if (opts.noProductUpdates) delete payload.productUpdates
    return persist(payload, { quiet: true })
  }

  async function onSave() {
    const ok = await validate()
    if (!ok) return
    const payload = { ...buildPayload(), ...(!isEdit.value && opts.extraPayload ? opts.extraPayload() : {}) }
    if (!isEdit.value && opts.onBeforeCreate) {
      loading.value = true
      let res: BeforeCreateResult
      try {
        res = await opts.onBeforeCreate(payload)
      } catch {
        res = { proceed: true } // mirror legacy: a failed pre-check proceeds anyway
      }
      if (!res || !res.proceed) {
        loading.value = false
        return
      }
    }
    await persist(payload)
  }

  /** Low-level create used by hooks after a suspended `onBeforeCreate` (e.g. transfer confirm). */
  async function submitCreate(extra?: Record<string, any>) {
    const payload = { ...buildPayload(), ...(opts.extraPayload ? opts.extraPayload() : {}), ...(extra || {}) }
    await persist(payload)
  }

  /**
   * FR-22.33 — „Запази и получи": save the bill, then receive it (it takes its issued number,
   * and books its goods unless it was made from receipts that already did). The user stays on
   * the bill, which now reads as received. Receiving was a list-row icon only.
   */
  const receiving = ref(false)
  /** FR-22.31c: the server asked first; `ReceiptOverlapDialog` carries the answer. */
  const receiptOverlap = ref<ReceiptOverlap | null>(null)
  async function onSaveAndReceive() {
    // The keyboard reaches a button that shows its spinner: Enter again would receive it again.
    if (receiving.value) return
    receiving.value = true
    let id: string | null = null
    try {
      if (!(await validate())) return
      // On the saved bill before receiving it: should receiving fail, pressing again receives
      // this one rather than saving a second.
      id = await persist(buildPayload(), { quiet: true })
      if (!id) return
      const { invoice: received } = await receiveBill(id)
      // A bill made from receipts books no stock: its receipts did (FR-22.31).
      feedback.succeeded()
      showSuccess(t(received.stockSource?.marker ? 'invoicing.linkDelivery.received' : 'invoicing.invoiceReceived'))
      await loadDocument()
    } catch (e: any) {
      receiptOverlap.value = id ? receiptOverlapOf(e, id) : null
      // A refusal stays on the form, and goes with the next success (FR-31.8).
      if (!receiptOverlap.value) feedback.refused(stockRefusalMessage(e, t))
      // Saved but not received: show what was saved, still a draft.
      if (route.params.id) await loadDocument()
    } finally {
      receiving.value = false
    }
  }

  /**
   * FR-22.22 — „Преобразувай във фактура" on a quote, and „Преобразувай в проформа" on an offer: what it
   * becomes opens at once, ready to be issued. The list used to stay where it was, the new invoice only a
   * link in its row. A quote that is new or edited is saved first.
   */
  const converting = ref(false)
  const convertingTo = ref<'' | 'invoice' | 'proforma'>('')
  async function onConvert(target: 'invoice' | 'proforma' = 'invoice') {
    if (converting.value) return
    converting.value = true
    convertingTo.value = target
    try {
      const id = await saveIfNeeded()
      if (!id) return
      const { invoice } = await convertQuote(id, { target })
      feedback.succeeded()
      showSuccess(t(target === 'proforma' ? 'invoicing.convertedToProforma' : 'invoicing.convertedToInvoice'))
      await router.push({ name: target === 'proforma' ? 'invoicing.proforma.edit' : 'invoicing.sales.edit', params: { id: invoice._id } })
    } catch (e: any) {
      feedback.refused(e?.response?.data?.message || t('common.operationFailed'))
    } finally {
      converting.value = false
      convertingTo.value = ''
    }
  }

  return {
    buildPayload, validate, saveIfNeeded, onSave, submitCreate, onSaveAndReceive, receiving, receiptOverlap,
    onConvert, converting, convertingTo,
  }
}

export type FormSaving = ReturnType<typeof useFormSaving>
