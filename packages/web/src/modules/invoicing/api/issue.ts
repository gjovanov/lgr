import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath } from './org-path'
import {
  checkStock, createTransfers, linkDispatches, prepareIssue, sendIssue,
  type DispatchOverlap, type LinkDispatchesResult, type StockCheck, type StockCheckLine,
} from '../composables/document-issue'

/**
 * Issuing a document (`POST /invoices/:id/send`) and what is asked in front of it: the stock check and the transfers
 * (`/invoicing/stock-availability`), the stock notes it may be for (`/invoicing/sales/:id/dispatch-overlap` and
 * `/link-dispatches`, FR-22.61b).
 *
 * The requests are `composables/document-issue.ts`, which takes its client as an argument so that the integration
 * tests drive the very same functions against the real routes. These are they, with the screens' client and the tab's
 * org: a screen calls these and never the client itself.
 */

/** Whether the warehouses hold what `lines` take. */
export function checkIssueStock(lines: StockCheckLine[]): Promise<StockCheck> {
  return checkStock(httpClient, orgPath(), lines)
}

/** The document as stored, the stock it would be short of, or the stock notes it may be for (`prepareIssue`). */
export function prepareDocumentIssue(id: string, opts: { acknowledgeOverlap?: boolean } = {}): Promise<{ invoice: any; check: StockCheck | null; overlap: DispatchOverlap | null }> {
  return prepareIssue(httpClient, orgPath(), id, opts)
}

/** The transfer movements a confirmed transfer dialog asks for: their ids, which the issue confirms. */
export function createIssueTransfers(proposals: any[]): Promise<string[]> {
  return createTransfers(httpClient, orgPath(), proposals)
}

/**
 * Issues document `id`. ⚠ It may print a fiscal receipt: `headers` carries the attempt's `Idempotency-Key`, so issuing
 * again answers that issue, never a second number or dispatch (#155).
 */
export function sendDocumentIssue(id: string, body: { pendingTransferIds?: string[]; acknowledgeOverlap?: boolean }, headers: Record<string, string>): Promise<any> {
  return sendIssue(httpClient, orgPath(), id, body, headers)
}

/** FR-22.62: links draft invoice `id` to stock notes, or says how its lines differ from what they delivered. */
export function linkSaleDispatches(id: string, body: { movementIds: string[]; replaceLines?: boolean; contactId?: string }): Promise<LinkDispatchesResult> {
  return linkDispatches(httpClient, orgPath(), id, body)
}
