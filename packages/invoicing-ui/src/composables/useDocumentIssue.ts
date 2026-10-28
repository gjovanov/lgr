import { ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { createIdempotentAction } from 'ui-shared/composables/idempotency'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAppStore } from '../store/app.store'
import {
  checkStock,
  createTransfers as createTransferMovements,
  ISSUED_KEY,
  prepareIssue,
  sendIssue,
  type StockCheck,
  type StockCheckLine,
} from './document-issue'

export { stockCheckLines, checksStockOnIssue, ISSUED_KEY } from './document-issue'

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

export type IssueOutcome = 'issued' | 'transfer' | 'failed'

export interface UseDocumentIssueOptions {
  /** A spinner to run while the document is read, checked and issued (the list's table). */
  loading?: Ref<boolean>
  /** After every issue (the list refreshes). */
  onIssued?: (invoice: any, type: string) => Promise<void> | void
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

  /** The document waiting on the transfer dialog, and what its caller does once it is issued. */
  let pending: { id: string; type: string; then?: (invoice: any) => Promise<void> | void } | null = null

  // The dialog was closed without confirming: the document stays a draft, and says why.
  watch(transfer.open, (open) => {
    if (open || !pending || transfer.confirming.value) return
    pending = null
    lastError.value = t('invoicing.issueFlow.notIssuedStock')
  })

  async function finish(invoice: any, type: string, then?: (invoice: any) => Promise<void> | void) {
    lastError.value = ''
    await opts.onIssued?.(invoice, type)
    await then?.(invoice)
  }

  function failed(e: any): IssueOutcome {
    lastError.value = e?.response?.data?.message || t('common.operationFailed')
    showError(lastError.value)
    return 'failed'
  }

  /**
   * Issue `doc`. 'transfer': a warehouse is short and the transfer dialog is open — confirming it
   * (`confirmTransfers`) issues the document and runs `then`; closing it leaves the draft.
   */
  async function issue(doc: { _id: string; type?: string }, then?: (invoice: any) => Promise<void> | void): Promise<IssueOutcome> {
    const loading = opts.loading
    if (loading) loading.value = true
    try {
      const { invoice, check } = await prepareIssue(httpClient, appStore.orgUrl(), doc._id)
      const type = doc.type || invoice.type
      if (check) {
        // Show transfer dialog
        transfer.show(check)
        pending = { id: doc._id, type, then }
        if (loading) loading.value = false
        return 'transfer'
      }
      // Stock sufficient — send directly. #155: an unanswered attempt keeps its key, so issuing
      // again returns that issue — never a second dispatch or number.
      const issued = await issueAttempt.run({ id: doc._id }, headers => sendIssue(httpClient, appStore.orgUrl(), doc._id, {}, headers))
      showSuccess(t(ISSUED_KEY[type] || ISSUED_KEY.invoice))
      await finish(issued, type, then)
      return 'issued'
    } catch (e: any) {
      return failed(e)
    } finally {
      if (loading) loading.value = false
    }
  }

  /** The transfer dialog confirmed: create the transfers, then issue with them (backend confirms them first). */
  async function confirmTransfers(confirmed: any[]): Promise<IssueOutcome> {
    if (!pending) return 'failed'
    const { id, type, then } = pending
    transfer.confirming.value = true
    try {
      // Create transfer movements
      const transferIds = await transfer.createTransfers(confirmed)
      // Send invoice with pending transfer IDs (backend confirms transfers first)
      const sendBody = { pendingTransferIds: transferIds }
      const issued = await issueAttempt.run({ id, ...sendBody }, headers => sendIssue(httpClient, appStore.orgUrl(), id, sendBody, headers))
      showSuccess(t(ISSUED_KEY[type] || ISSUED_KEY.invoice))
      pending = null
      transfer.open.value = false
      await finish(issued, type, then)
      return 'issued'
    } catch (e: any) {
      return failed(e)
    } finally {
      transfer.confirming.value = false
    }
  }

  return { transfer, issue, confirmTransfers, lastError }
}
