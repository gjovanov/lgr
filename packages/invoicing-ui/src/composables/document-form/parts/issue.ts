/**
 * FR-32.22 (#797): issuing the document and its money. The issuer (the stock check, the transfer and payment questions
 * in front of `/send`), why an issue was refused — at the top and on the lines it is about — and the payment and the
 * fiscal receipts of an issued document (FR-23). `useDocumentForm#issueFromForm` is what issues from the form.
 */
import { ref, computed, watch } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { createIdempotentAction } from 'ui-shared/composables/idempotency'
import { receiptRefusalMessage } from 'ui-shared/cash-register/receipt-refusal'
import { useDocumentIssue } from '../../useDocumentIssue'
import { shortageMatches, shortageQuantity, type LineShortage } from '../../document-issue'
import type { FormState } from './state'
import type { FormLoad } from './load'

export function useFormIssue(s: FormState, load: FormLoad) {
  const { config, t, route, showSuccess, showError, form, invoiceData, orgUrl } = s
  const { loadDocument } = load

  // ── issue (FR-22.17 / .18) ──
  // FR-22.61b: an invoice the question linked to its stock note is another document than the form holds: read again.
  const issuer = useDocumentIssue({ onLinked: async () => { await loadDocument() } })
  const issuing = ref(false)
  const issuingWithPrint = ref(false)
  /** Why the document is still a draft after it was asked to be issued (FR-22 §5.2). */
  const issueError = issuer.lastError
  /** FR-23: issued, and its receipt did not print. The Pay action takes the money again, when it is there to take. */
  const receiptError = issuer.lastReceiptError

  // ── FR-31.8: a refusal about an article is marked on its lines ──
  /** What `lineRefusalOf` matches a line against: the quantity the matching lines held when the refusal came. */
  const refusedLines = ref<{ shortage: LineShortage; quantity: number }[]>([])
  watch(issuer.lastShortages, (shortages) => {
    refusedLines.value = shortages.map(shortage => ({ shortage, quantity: shortageQuantity(shortage, form.lines) }))
  })
  /**
   * Why the last issue was refused, said on the line it is about (FR-31.8), or ''. It goes with the refusal at the top
   * (closed, or the next attempt), and from a line whose article, warehouse or quantity has since been changed.
   */
  function lineRefusalOf(line: any): string {
    if (!issueError.value) return ''
    const hit = refusedLines.value.find(r => shortageMatches(r.shortage, line) && shortageQuantity(r.shortage, form.lines) === r.quantity)
    return hit ? t('invoicing.lineRefusal.short', { available: hit.shortage.available, requested: hit.shortage.requested }) : ''
  }
  const receiptTakesPayment = issuer.lastReceiptTakesPayment

  // ── a payment on the document (FR-23) ──
  const paymentDialog = ref(false)
  /** What the payment dialog reads off the document it pays. */
  const payableDoc = computed(() => (invoiceData.value
    ? { ...invoiceData.value, _id: String(route.params.id), type: config.apiType, direction: config.direction }
    : null))
  async function onPaymentRecorded() {
    receiptError.value = ''
    await loadDocument()
  }

  // ── the receipt of a cash-on-delivery invoice (FR-23) ──
  /** It did not print as the invoice was issued. The money is the courier's, so the receipt prints alone. */
  const deliveryReceiptDue = computed(() => !!invoiceData.value?.receiptToPrint)
  /** A receipt nothing can prove: this document waits for someone to settle it in the journal. */
  const receiptInDoubt = computed<{ id: string; number: string } | null>(() => invoiceData.value?.receiptInDoubt ?? null)
  // FR-23: the fiscal documents that moved this document's money, each a way to its page.
  const paymentReceipts = computed<{ id: string; number: string; amount: number; state?: string }[]>(() => invoiceData.value?.paymentReceipts ?? [])
  const printingReceipt = ref(false)
  const deliveryReceipt = createIdempotentAction()
  async function printDeliveryReceipt() {
    if (printingReceipt.value) return
    const id = String(route.params.id)
    printingReceipt.value = true
    try {
      const { data } = await deliveryReceipt.run({ id }, headers => httpClient.post(`${orgUrl()}/invoices/${id}/receipt`, {}, { headers }))
      receiptError.value = ''
      if (data?.receiptError) showError(t('cashRegister.receipt.issuedUnknown', { reason: data.receiptError }))
      else showSuccess(t('cashRegister.receipt.deliveryPrinted', { number: data?.receipt?.number }))
    } catch (e: any) {
      receiptError.value = receiptRefusalMessage(t, e, t('common.operationFailed'))
      showError(receiptError.value)
    } finally {
      printingReceipt.value = false
    }
    await loadDocument()
  }

  return {
    issuer, issuing, issuingWithPrint, issueError, receiptError, lineRefusalOf, receiptTakesPayment,
    paymentDialog, payableDoc, onPaymentRecorded, deliveryReceiptDue, receiptInDoubt, paymentReceipts,
    printingReceipt, printDeliveryReceipt,
  }
}

export type FormIssue = ReturnType<typeof useFormIssue>
