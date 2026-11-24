/**
 * FR-32.22 (#797): where the document stands, and what that allows. Its status pipeline and number, whether it is
 * issued yet, whether it can be issued, corrected, paid, converted or attached to a cash sale, and the smart buttons to
 * what it booked. The actions the bars offer from this are `useDocumentForm#formActions`.
 */
import { ref, computed } from 'vue'
import { QUOTE_CONVERTS_TO, isQuoteType, type QuoteType } from 'config/constants'
import { appHref } from 'ui-shared/nav/navigate'
import { canOpenPage, pageById } from 'ui-shared/nav/page-registry'
import { sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import type { SmartButtonDef, StatusDef } from 'ui-shared/components/EntityFormShell.vue'
import { canRecordPayment } from '../../document-row-actions'
import type { FormState } from './state'
import type { FormLoad } from './load'

/** Statuses of a document that stands issued: a note can correct it (the API's own rule). */
const CORRECTABLE = ['sent', 'received', 'partially_paid', 'paid', 'overdue']

export function useFormStatus(s: FormState, load: FormLoad) {
  const { config, t, showSuccess, isEdit, invoiceStatus, invoiceNumber, invoiceData, peekedNumber } = s
  const { loadDocument } = load

  // ── status pipeline (i18n) ──
  // Carry the i18n KEYS (not resolved strings) so EntityFormShell resolves them in the render
  // path (`{{ $t(step) }}`) — that re-runs on locale change, unlike a pre-resolved string array
  // which only refreshes on remount.
  const statusDef = computed<StatusDef | undefined>(() => {
    if (!isEdit.value) return undefined
    const steps = config.status.map((s) => s.i18n)
    const matchIdx = config.status.findIndex((s) => s.match.includes(invoiceStatus.value))
    const idx = matchIdx >= 0 ? matchIdx : 0
    return { steps, current: steps[idx] }
  })

  /** #171: the cash sale this invoice was issued for — its lines are that sale's, so no import. */
  const cashSaleRef = computed<{ cashSaleId: string; number: string; issueDate: string } | null>(() => invoiceData.value?.cashSaleRef || null)
  /**
   * FR-21 §11: an issued sales invoice that is no cash sale's yet can be attached to the cash sale
   * of its day — for one entered before the till export brought that sale in.
   */
  const attachDialogOpen = ref(false)
  const attachable = computed(() => {
    // One that moves no stock already can only be a till day's, repaired by hand (`salesAnalysis:`).
    const marker = invoiceData.value?.stockSource?.marker
    return isEdit.value && config.docType === 'invoice' && config.direction === 'outgoing' && !cashSaleRef.value
      && ['sent', 'paid', 'partially_paid', 'overdue'].includes(invoiceStatus.value)
      && (!marker || String(marker).startsWith('salesAnalysis:'))
  })
  async function onAttached(invoice: any) {
    showSuccess(t('invoicing.cashSaleInvoice.attachDone', { number: invoice?.cashSaleRef?.number || '' }))
    await loadDocument()
  }

  /** A document the form issues itself: every outgoing one but the cash sale, issued as it is saved. */
  const issuable = config.direction === 'outgoing' && config.docType !== 'cash_sale'
  /** Not issued yet: a new document, or a draft. */
  const isDraftDoc = computed(() => !isEdit.value || invoiceStatus.value === 'draft')
  /** FR-22.21: an issued invoice can be corrected by a credit or a debit note. */
  const correctable = computed(() =>
    isEdit.value && (config.docType === 'invoice' || config.docType === 'purchase_invoice') && CORRECTABLE.includes(invoiceStatus.value),
  )
  /** FR-23: a sales document that still owes, as the lists offer it (`canRecordPayment`). A credit note owes the customer (R2). */
  const payable = computed(() =>
    isEdit.value && config.direction === 'outgoing' && (config.docType === 'invoice' || config.docType === 'debit_note' || config.docType === 'credit_note')
    && !cashSaleRef.value && canRecordPayment({ type: config.apiType, status: invoiceStatus.value, direction: config.direction }),
  )
  /**
   * FR-22.22: a quote becomes the next document once — and not after it was voided. A proforma becomes an
   * invoice; an offer a proforma or an invoice (`QUOTE_CONVERTS_TO`), each its own button.
   */
  const convertible = computed(() => isQuoteType(config.apiType) && !['converted', 'voided', 'cancelled'].includes(invoiceStatus.value))
  const convertTargets = computed(() => (convertible.value ? QUOTE_CONVERTS_TO[config.apiType as QuoteType] : []))

  /**
   * B-13: each button opens what it counts, in the app that has it. The invoicing SPA has no
   * journal-entry or movement routes, so a router `to` led nowhere; these are cross-app links.
   * What has been paid is in the totals card — a payment has no page to open.
   */
  const smartButtons = computed<SmartButtonDef[]>(() => {
    if (!config.showSmartButtons || !invoiceData.value) return []
    const btns: SmartButtonDef[] = []
    const journalEntryId = invoiceData.value.journalEntryId
    // Only for whoever opens Accounting: a Seller has no sight of it (FR-26 §2.1), and the link led them to a refusal.
    if (journalEntryId && canOpenPage(pageById('/accounting/journal-entries')!, sessionViewer())) {
      btns.push({
        label: t('invoicing.smart.journalEntry'),
        value: 1,
        icon: 'mdi-book-open-variant',
        href: appHref('accounting', `/accounting/journal-entries/${journalEntryId}/edit`),
      })
    }
    const transferIds: string[] = (invoiceData.value.pendingTransferIds || []).map(String)
    if (transferIds.length > 0) {
      btns.push({
        label: t('invoicing.smart.transfers'),
        value: transferIds.length,
        icon: 'mdi-truck-delivery',
        // A transfer records no link back to its invoice, so several open the transfers list.
        href: appHref('inventory', transferIds.length === 1 ? `/inventory/movements/${transferIds[0]}` : '/inventory/movements?type=transfer'),
      })
    }
    return btns
  })

  // R7 fix: a single number computed for the read-only field (edit shows the real number,
  // create shows the peeked next number). The legacy forms bound a non-existent
  // `form.invoiceNumber` → blank in edit mode.
  const documentNumber = computed(() => invoiceNumber.value || peekedNumber.value)

  return {
    statusDef, cashSaleRef, attachDialogOpen, attachable, onAttached, issuable, isDraftDoc, correctable, payable,
    convertible, convertTargets, smartButtons, documentNumber,
  }
}

export type FormStatus = ReturnType<typeof useFormStatus>
