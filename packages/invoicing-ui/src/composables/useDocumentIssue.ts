import { ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { createIdempotentAction } from 'ui-shared/composables/idempotency'
import { receiptRefusalMessage } from 'ui-shared/cash-register/receipt-refusal'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAppStore } from '../store/app.store'
import {
  checkStock,
  confirmsPaymentOnIssue,
  createTransfers as createTransferMovements,
  dispatchOverlapOf,
  ISSUED_KEY,
  issuedReceiptNotice,
  prepareIssue,
  sendIssue,
  type DispatchOverlap,
  type StockCheck,
  type StockCheckLine,
} from './document-issue'

export { stockCheckLines, checksStockOnIssue, confirmsPaymentOnIssue, ISSUED_KEY } from './document-issue'

/**
 * Issuing a document, and the stock check in front of it (FR-22.17): the list's „Изпрати" and the
 * document form's „Издай" share this. The requests are `./document-issue`; this adds the transfer
 * dialog's state, the idempotent `/send`, and the messages.
 */

/** The availability check and the transfer dialog it can open (the cash-sale form's pre-create check too). */
export function useStockTransfer() {
  const appStore = useAppStore()
  const open = ref(false)
  const shortfalls = ref<any[]>([])
  const proposals = ref<any[]>([])
  const allResolvable = ref(false)
  const confirming = ref(false)

  /** Open the dialog on an availability answer that came back short. */
  function show(check: StockCheck) {
    shortfalls.value = check.shortfalls
    proposals.value = check.proposals
    allResolvable.value = check.allResolvable
    open.value = true
  }

  /** Ask; when a warehouse is short, open the dialog with the answer and say so (false). */
  async function check(lines: StockCheckLine[]): Promise<boolean> {
    const answer = await checkStock(httpClient, appStore.orgUrl(), lines)
    if (answer.sufficient) return true
    show(answer)
    return false
  }

  /** The transfer movements the confirmed dialog asks for; the document confirms them as it issues. */
  function createTransfers(confirmed: any[]): Promise<string[]> {
    return createTransferMovements(httpClient, appStore.orgUrl(), confirmed)
  }

  return { open, shortfalls, proposals, allResolvable, confirming, show, check, createTransfers }
}

/**
 * 'cancelled': the person said No to the payment method; the document stays a draft, with nothing to report.
 * 'question': the invoice may be for goods a stock note already delivered, and the dialog is open (FR-22.61b).
 * 'linked': it was linked to that note and took the note's lines, so it stays a draft for the person to read.
 */
export type IssueOutcome = 'issued' | 'transfer' | 'failed' | 'cancelled' | 'question' | 'linked'

/** The question in front of issuing an outgoing invoice (`IssuePaymentConfirmDialog`): its number and stored method. */
export interface PaymentConfirmAsk {
  number: string
  method: string | null
}

export interface UseDocumentIssueOptions {
  /** A spinner to run while the document is read, checked and issued (the list's table). */
  loading?: Ref<boolean>
  /** After every issue (the list refreshes). */
  onIssued?: (invoice: any, type: string) => Promise<void> | void
  /** FR-22.61b: the question was answered by linking the invoice to a stock note. It changed: read it again. */
  onLinked?: (id: string) => Promise<void> | void
}

export function useDocumentIssue(opts: UseDocumentIssueOptions = {}) {
  const { t } = useI18n()
  const appStore = useAppStore()
  const { showSuccess, showError } = useSnackbar()
  const transfer = useStockTransfer()
  // #155: one Idempotency-Key per Issue attempt (ui-shared/composables/idempotency).
  const issueAttempt = createIdempotentAction()

  /**
   * Why the last issue did not happen: the server's refusal, or the shortage the dialog was closed
   * on. The form shows it on the draft (FR-22 §5.2); the list has the snackbar.
   */
  const lastError = ref('')
  /**
   * FR-23: the document was issued and its receipt did not print. The form shows why, and, when the
   * money is there to take, takes the payment again.
   */
  const lastReceiptError = ref('')
  const lastReceiptTakesPayment = ref(false)

  type Then = (invoice: any) => Promise<void> | void
  /** The document waiting on the transfer dialog, and what its caller does once it is issued. */
  let pending: { id: string; type: string; then?: Then; acknowledgeOverlap?: boolean } | null = null

  /** FR-22.61b: the question that is open (`DispatchOverlapDialog`), and the document waiting on its answer. */
  const dispatchOverlap = ref<DispatchOverlap | null>(null)
  let asked: { id: string; type?: string; then?: Then } | null = null

  function ask(overlap: DispatchOverlap, doc: { _id: string; type?: string }, then?: Then): IssueOutcome {
    asked = { id: doc._id, type: doc.type, then }
    dispatchOverlap.value = overlap
    return 'question'
  }

  // The question was closed without an answer: the document stays a draft, and says why.
  watch(dispatchOverlap, (open) => {
    if (open || !asked) return
    asked = null
    lastError.value = t('invoicing.dispatchOverlap.notIssued')
  })

  /** The payment-method question that is open, and how it is answered (`answerPayment`). */
  const paymentConfirm = ref<PaymentConfirmAsk | null>(null)
  let paymentAnswer: ((yes: boolean) => void) | null = null

  function askPayment(invoice: any): Promise<boolean> {
    paymentAnswer?.(false) // a question still open is a No: one question at a time
    paymentConfirm.value = { number: String(invoice?.invoiceNumber || ''), method: invoice?.paymentMethod || null }
    return new Promise(resolve => { paymentAnswer = resolve })
  }

  /** Yes issues the document as it is stored; No leaves it a draft. */
  function answerPayment(yes: boolean) {
    const answer = paymentAnswer
    paymentAnswer = null
    paymentConfirm.value = null
    answer?.(yes)
  }

  // The dialog was closed without confirming: the document stays a draft, and says why.
  watch(transfer.open, (open) => {
    if (open || !pending || transfer.confirming.value) return
    pending = null
    lastError.value = t('invoicing.issueFlow.notIssuedStock')
  })

  async function finish(invoice: any, type: string, then?: (invoice: any) => Promise<void> | void) {
    lastError.value = ''
    const notice = issuedReceiptNotice(invoice)
    lastReceiptError.value = notice ? t(notice.key, { reason: invoice.receiptError, amount: (Number(invoice.refunded) || 0).toFixed(2) }) : ''
    lastReceiptTakesPayment.value = !!notice?.takesPayment
    if (lastReceiptError.value) showError(lastReceiptError.value)
    await opts.onIssued?.(invoice, type)
    await then?.(invoice)
  }

  function failed(e: any): IssueOutcome {
    lastError.value = receiptRefusalMessage(t, e, t('common.operationFailed'))
    showError(lastError.value)
    return 'failed'
  }

  /**
   * Issue `doc`. 'transfer': a warehouse is short and the transfer dialog is open — confirming it
   * (`confirmTransfers`) issues the document and runs `then`; closing it leaves the draft.
   */
  async function issue(doc: { _id: string; type?: string }, then?: Then, flags: { acknowledgeOverlap?: boolean } = {}): Promise<IssueOutcome> {
    const loading = opts.loading
    if (loading) loading.value = true
    try {
      const { invoice, check, overlap } = await prepareIssue(httpClient, appStore.orgUrl(), doc._id, flags)
      const type = doc.type || invoice.type
      // FR-22.61b, before anything else is asked: its answer decides whether this invoice takes any stock at all.
      if (overlap) return ask(overlap, { _id: doc._id, type }, then)
      // Owner, 2026-11-12: an outgoing invoice is issued only once the person confirms the method it carries.
      if (confirmsPaymentOnIssue(invoice)) {
        if (loading) loading.value = false
        if (!(await askPayment(invoice))) return 'cancelled'
        if (loading) loading.value = true
      }
      if (check) {
        // Show transfer dialog
        transfer.show(check)
        pending = { id: doc._id, type, then, acknowledgeOverlap: flags.acknowledgeOverlap }
        if (loading) loading.value = false
        return 'transfer'
      }
      // Stock sufficient — send directly. #155: an unanswered attempt keeps its key, so issuing
      // again returns that issue — never a second dispatch or number.
      const sendBody = flags.acknowledgeOverlap ? { acknowledgeOverlap: true } : {}
      const issued = await issueAttempt.run({ id: doc._id, ...sendBody }, headers => sendIssue(httpClient, appStore.orgUrl(), doc._id, sendBody, headers))
      if (!issued?.receiptError) showSuccess(t(ISSUED_KEY[type] || ISSUED_KEY.invoice))
      await finish(issued, type, then)
      return 'issued'
    } catch (e: any) {
      // `/send` put the question itself: a note booked since this asked, or a check that did not answer.
      const overlap = dispatchOverlapOf(e, doc._id)
      if (overlap) return ask(overlap, doc, then)
      return failed(e)
    } finally {
      if (loading) loading.value = false
    }
  }

  /** FR-22.61b, „other goods": issue it as it is. The stock is checked now, and `/send` is told the answer. */
  async function issueDespiteOverlap(): Promise<IssueOutcome> {
    const waiting = asked
    asked = null
    dispatchOverlap.value = null
    if (!waiting) return 'failed'
    return issue({ _id: waiting.id, type: waiting.type }, waiting.then, { acknowledgeOverlap: true })
  }

  /**
   * FR-22.61b: the dialog linked the invoice to the stock note. Where the invoice kept its lines it is what the
   * person asked to issue, and it now moves no stock, so it is issued. Where the note's lines took the place of
   * its own (`replaced`), it stays a draft: the person reads the lines and prices first.
   */
  async function overlapLinked(replaced: boolean): Promise<IssueOutcome> {
    const waiting = asked
    asked = null
    dispatchOverlap.value = null
    if (!waiting) return 'failed'
    lastError.value = ''
    await opts.onLinked?.(waiting.id)
    if (replaced) {
      showSuccess(t('invoicing.linkNote.linkedCheck'))
      return 'linked'
    }
    return issue({ _id: waiting.id, type: waiting.type }, waiting.then)
  }

  /** The transfer dialog confirmed: create the transfers, then issue with them (backend confirms them first). */
  async function confirmTransfers(confirmed: any[]): Promise<IssueOutcome> {
    if (!pending) return 'failed'
    const { id, type, then, acknowledgeOverlap } = pending
    transfer.confirming.value = true
    try {
      // Create transfer movements
      const transferIds = await transfer.createTransfers(confirmed)
      // Send invoice with pending transfer IDs (backend confirms transfers first)
      const sendBody = { pendingTransferIds: transferIds, ...(acknowledgeOverlap ? { acknowledgeOverlap: true } : {}) }
      const issued = await issueAttempt.run({ id, ...sendBody }, headers => sendIssue(httpClient, appStore.orgUrl(), id, sendBody, headers))
      if (!issued?.receiptError) showSuccess(t(ISSUED_KEY[type] || ISSUED_KEY.invoice))
      pending = null
      transfer.open.value = false
      await finish(issued, type, then)
      return 'issued'
    } catch (e: any) {
      // A stock note booked while the transfers were being confirmed: the server discarded the transfers this
      // request drew up, and the answer starts the issue again.
      const overlap = dispatchOverlapOf(e, id)
      if (overlap) {
        pending = null
        transfer.open.value = false
        return ask(overlap, { _id: id, type }, then)
      }
      return failed(e)
    } finally {
      transfer.confirming.value = false
    }
  }

  return {
    transfer, issue, confirmTransfers, lastError, lastReceiptError, lastReceiptTakesPayment, paymentConfirm, answerPayment,
    dispatchOverlap, issueDespiteOverlap, overlapLinked,
  }
}
