/**
 * Cross-module event handlers.
 * Register these at startup after service context is initialized.
 */
import { eventBus } from './event-bus.js'
import { getRepos } from '../context.js'
import { createAuditEntry, generateCorrelationId } from '../biz/audit-log.service.js'
import {
  createInvoiceJournalEntry,
  createPaymentJournalEntry,
  createMovementValuationEntry,
  createPOSSessionJournalEntry,
} from '../biz/auto-journal.service.js'
import { loadPosRows } from '../biz/cash-register/pos-union.js'
import { logger } from '../logger/logger.js'

let _registered = false
export function registerEventHandlers(): void {
  if (_registered) {
    logger.warn('Event handlers already registered — skipping')
    return
  }
  _registered = true

  // ── Invoice Posted → Create Journal Entry ──
  eventBus.on('invoice.posted', async (payload) => {
    const r = getRepos()
    const org = await r.orgs.findById(payload.orgId) as any
    const accountingSettings = org?.settings?.accounting
    if (!accountingSettings?.defaultSaleJournalId && !accountingSettings?.defaultPurchaseJournalId) return

    const invoice = await r.invoices.findById(payload.invoiceId) as any
    if (!invoice) return
    // #171: an invoice for a cash sale documents revenue its cash sale already carries.
    if (invoice.cashSaleRef?.cashSaleId) return
    // An issued proforma is an offer, not a receivable (FR-22.22): `/send` announces none, and
    // one announced anyway posts nothing.
    if (invoice.type === 'proforma') return

    const isOutgoing = invoice.direction === 'outgoing'
    const journalId = isOutgoing
      ? accountingSettings.defaultSaleJournalId
      : accountingSettings.defaultPurchaseJournalId

    const je = await createInvoiceJournalEntry(
      payload.orgId,
      invoice,
      {
        receivableAccountId: accountingSettings.defaultReceivableAccountId,
        payableAccountId: accountingSettings.defaultPayableAccountId,
        revenueAccountId: accountingSettings.defaultRevenueAccountId,
        expenseAccountId: accountingSettings.defaultExpenseAccountId,
      },
      { journalId },
      accountingSettings.autoPostInvoiceEntries ?? false,
      r,
    )

    if (je) {
      await r.invoices.update(payload.invoiceId, { journalEntryId: je.id } as any)

      // Audit trail with correlation
      const correlationId = generateCorrelationId()
      createAuditEntry({
        orgId: payload.orgId,
        userId: payload.userId,
        action: 'post',
        module: 'invoicing',
        entityType: 'invoice',
        entityId: payload.invoiceId,
        entityName: invoice.invoiceNumber,
        correlationId,
      })
      createAuditEntry({
        orgId: payload.orgId,
        userId: 'system',
        action: 'auto_create',
        module: 'accounting',
        entityType: 'journal_entry',
        entityId: je.id,
        entityName: je.entryNumber,
        correlationId,
        changes: [{ field: 'source', oldValue: null, newValue: `invoice:${invoice.invoiceNumber}` }],
      })
    }
  })

  // ── Payment Recorded → Create Journal Entry ──
  eventBus.on('payment.recorded', async (payload) => {
    const r = getRepos()
    const org = await r.orgs.findById(payload.orgId) as any
    const accountingSettings = org?.settings?.accounting
    if (!accountingSettings?.defaultCashJournalId && !accountingSettings?.defaultBankJournalId) return

    const invoice = await r.invoices.findById(payload.invoiceId) as any
    if (!invoice) return

    const journalId = payload.method === 'cash'
      ? accountingSettings.defaultCashJournalId
      : accountingSettings.defaultBankJournalId

    const je = await createPaymentJournalEntry(
      payload.orgId,
      invoice,
      { amount: payload.amount, method: payload.method, date: payload.date },
      {
        receivableAccountId: accountingSettings.defaultReceivableAccountId,
        payableAccountId: accountingSettings.defaultPayableAccountId,
      },
      { journalId },
      accountingSettings.autoPostPaymentEntries ?? false,
      r,
    )

    if (je) {
      // Update the last payment entry with journalEntryId
      const payments = invoice.payments || []
      if (payments.length > 0) {
        payments[payments.length - 1].journalEntryId = je.id
        await r.invoices.update(payload.invoiceId, { payments } as any)
      }

      // Audit trail with correlation
      const correlationId = generateCorrelationId()
      createAuditEntry({
        orgId: payload.orgId,
        userId: payload.userId,
        action: 'record_payment',
        module: 'invoicing',
        entityType: 'invoice',
        entityId: payload.invoiceId,
        entityName: invoice.invoiceNumber,
        correlationId,
        changes: [{ field: 'payment', oldValue: null, newValue: `${payload.method}: ${payload.amount}` }],
      })
      createAuditEntry({
        orgId: payload.orgId,
        userId: 'system',
        action: 'auto_create',
        module: 'accounting',
        entityType: 'journal_entry',
        entityId: je.id,
        entityName: je.entryNumber,
        correlationId,
        changes: [{ field: 'source', oldValue: null, newValue: `payment:${invoice.invoiceNumber}` }],
      })
    }
  })

  // ── Stock Movement Confirmed → Create Valuation Journal Entry ──
  eventBus.on('stock.movement.confirmed', async (payload) => {
    const r = getRepos()
    const movement = await r.stockMovements.findById(payload.movementId) as any
    if (!movement) return

    const je = await createMovementValuationEntry(
      payload.orgId,
      movement,
      movement.lines || [],
      movement.date || new Date(),
      r,
    )

    if (je) {
      const correlationId = generateCorrelationId()
      createAuditEntry({
        orgId: payload.orgId,
        userId: 'system',
        action: 'auto_create',
        module: 'accounting',
        entityType: 'journal_entry',
        entityId: je.id,
        entityName: je.entryNumber,
        correlationId,
        changes: [{ field: 'source', oldValue: null, newValue: `movement:${movement.movementNumber}` }],
      })
    }
  })

  // ── POS Session Closed → the session's Journal Entry (FR-21.2; no batch movement since FR-21.4) ──
  eventBus.on('pos.session.closed', async (payload) => {
    const r = getRepos()
    const org = await r.orgs.findById(payload.orgId) as any
    const accountingSettings = org?.settings?.accounting
    if (!accountingSettings?.defaultSaleJournalId) return

    const session = await r.posSessions.findById(payload.sessionId) as any
    if (!session || session.journalEntryId) return // idempotency

    // The session's rows from both stores, each once (FR-21.8): a till sale is a POS row until
    // R2 and a cash-register document after it, and a session can span the switch.
    const rows = await loadPosRows({ orgId: payload.orgId, sessionId: payload.sessionId })

    const result = await createPOSSessionJournalEntry(
      payload.orgId,
      session,
      rows,
      {
        receivableAccountId: accountingSettings.defaultReceivableAccountId,
        revenueAccountId: accountingSettings.defaultRevenueAccountId,
        cashOverShortAccountId: accountingSettings.cashOverShortAccountId,
      },
      { journalId: accountingSettings.defaultSaleJournalId },
      accountingSettings.autoPostInvoiceEntries ?? false,
      r,
    )

    if (result) {
      const correlationId = generateCorrelationId()
      createAuditEntry({
        orgId: payload.orgId,
        userId: payload.userId,
        action: 'close',
        module: 'pos',
        entityType: 'pos_session',
        entityId: payload.sessionId,
        entityName: session.sessionNumber,
        correlationId,
      })
      createAuditEntry({
        orgId: payload.orgId,
        userId: 'system',
        action: 'auto_create',
        module: 'accounting',
        entityType: 'journal_entry',
        entityId: result.journalEntry.id,
        entityName: result.journalEntry.entryNumber,
        correlationId,
        changes: [{ field: 'source', oldValue: null, newValue: `pos_session:${session.sessionNumber}` }],
      })
    }
  })

  logger.info('Cross-module event handlers registered (invoice, payment, movement, POS session)')
}

/** Reset registration guard (for tests only). */
export function resetEventHandlers(): void {
  _registered = false
  eventBus.removeAllListeners()
}
