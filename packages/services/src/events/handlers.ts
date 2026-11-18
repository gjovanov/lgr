/**
 * Cross-module event handlers.
 * Register these at startup after service context is initialized.
 *
 * FR-29 slice D: the four ledger events no longer make their journal entry here and forget it. Each is a POSTING
 * (`biz/postings/posting-rules.ts` lists them and their keys): the state change's transaction writes the job that owes
 * it, and the handler below runs that job at once (`settlePosting`). A posting is made once per key
 * (`JournalEntry.postingKey`), so an event handled twice, a retry and the drain on another pod leave one entry. What
 * the event bus still carries beyond the ledger is for notifications and cache drops, which nothing here does.
 *
 * Their own postings, and nothing else:
 * - `invoice.posted` → the issued document's entry, `invoice.posted:<invoiceId>`;
 * - `payment.recorded` → that payment row's entry, `payment.recorded:<invoiceId>:<paymentId | receipt:<receiptId>>`;
 * - `stock.movement.confirmed` → the movement's valuation, `stock.movement.confirmed:<movementId>`;
 * - `pos.session.closed` → the session's entry, `pos.session.closed:<sessionId>`.
 * A void's reversal is the void's, not a handler's, and carries no key.
 */
import { eventBus } from './event-bus.js'
import { settlePosting } from '../biz/postings/posting.service.js'
import { logger } from '../logger/logger.js'

/**
 * The postings themselves, one per event. Exported here too, as before, for the fenced import (FR-20.84), which
 * awaits the same posting for each document it brings in.
 */
export { postInvoiceJournal, postPaymentJournal, postPosSessionJournal, postMovementValuation } from '../biz/postings/post-entries.js'

let _registered = false
export function registerEventHandlers(): void {
  if (_registered) {
    logger.warn('Event handlers already registered — skipping')
    return
  }
  _registered = true

  // ── Invoice Posted → its journal entry ──
  eventBus.on('invoice.posted', async payload => { await settlePosting(payload.orgId, {
    event: 'invoice.posted', invoiceId: payload.invoiceId, userId: payload.userId,
  }) })

  // ── Payment Recorded → that payment's journal entry ──
  eventBus.on('payment.recorded', async payload => { await settlePosting(payload.orgId, {
    event: 'payment.recorded', invoiceId: payload.invoiceId, userId: payload.userId,
    ...(payload.paymentId ? { paymentId: payload.paymentId } : { receiptId: payload.receiptId }),
  }) })

  // ── Stock Movement Confirmed → its valuation entry ──
  eventBus.on('stock.movement.confirmed', async payload => { await settlePosting(payload.orgId, {
    event: 'stock.movement.confirmed', movementId: payload.movementId, movementType: payload.type,
  }) })

  // ── POS Session Closed → the session's journal entry (FR-21.2; no batch movement since FR-21.4) ──
  eventBus.on('pos.session.closed', async payload => { await settlePosting(payload.orgId, {
    event: 'pos.session.closed', sessionId: payload.sessionId, userId: payload.userId,
  }) })

  logger.info('Cross-module event handlers registered (invoice, payment, movement, POS session)')
}

/** Reset registration guard (for tests only). */
export function resetEventHandlers(): void {
  _registered = false
  eventBus.removeAllListeners()
}
