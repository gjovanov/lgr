/**
 * The journal entries the four ledger events owe (FR-29 slice D), one function per posting.
 *
 * Each makes its posting's entry once: with a `postingKey` (`posting-keys.ts`) an entry that already holds the key IS
 * the posting, so a job retried after a lost answer, an event handled twice and a drain on the other pod all end with
 * one entry. Each answers the entry's id, or null when there is nothing to post (the org keeps no such journal or
 * accounts, a cash sale's invoice, a quote, goods of no known cost). A failure is thrown, for the job to keep.
 *
 * Called by the posting jobs (`posting.service.ts`) and, for documents it brings in, by the fenced import (FR-20.84,
 * through `events/handlers.ts`, which re-exports them).
 */
import { isQuoteType } from 'config/constants'
import { Invoice, POSSession } from 'db/models'
import { getRepos } from '../../context.js'
import { createAuditEntry, generateCorrelationId } from '../audit-log.service.js'
import {
  createInvoiceJournalEntry,
  createPaymentJournalEntry,
  createMovementValuationEntry,
  createPOSSessionJournalEntry,
} from '../auto-journal.service.js'
import { loadPosRows } from '../cash-register/pos-union.js'
import { postingSettingsOf } from './posting-rules.js'

/** The entry that already holds this posting key, if any. */
async function postedAs(orgId: string, postingKey: string | undefined): Promise<string | null> {
  if (!postingKey) return null
  const made = await getRepos().journalEntries.findOne({ orgId, postingKey }, { select: ['_id'] })
  return made ? String(made.id) : null
}

/** An issued invoice's journal entry (`invoice.posted`). */
export async function postInvoiceJournal(payload: { orgId: string; invoiceId: string; userId: string; postingKey?: string }): Promise<string | null> {
  const r = getRepos()
  const accountingSettings = (await postingSettingsOf(payload.orgId)).accounting
  if (!accountingSettings?.defaultSaleJournalId && !accountingSettings?.defaultPurchaseJournalId) return null

  const invoice = await r.invoices.findByIdInOrg(payload.invoiceId, payload.orgId)
  if (!invoice) return null
  // #171: an invoice for a cash sale documents revenue its cash sale already carries.
  if (invoice.cashSaleRef?.cashSaleId) return null
  // An issued quote — a proforma or an offer — is not a receivable (FR-22.22): `/send` owes none, and one owed
  // anyway posts nothing.
  if (isQuoteType(invoice.type)) return null

  // A posting made before, whose link to the invoice was not written: written now, and nothing posted again.
  const made = await postedAs(payload.orgId, payload.postingKey)
  if (made) {
    if (String(invoice.journalEntryId ?? '') !== made) await r.invoices.updateInOrg(payload.invoiceId, payload.orgId, { journalEntryId: made })
    return made
  }

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
      outputVatAccountId: accountingSettings.defaultOutputVatAccountId,
      inputVatAccountId: accountingSettings.defaultInputVatAccountId,
    },
    { journalId },
    accountingSettings.autoPostInvoiceEntries ?? false,
    r,
    { postingKey: payload.postingKey },
  )
  if (!je) return null

  await r.invoices.updateInOrg(payload.invoiceId, payload.orgId, { journalEntryId: je.id })

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
  return String(je.id)
}

/**
 * A closed till session's journal entry (`pos.session.closed`). A session that has one (`journalEntryId`) gets no
 * second.
 */
export async function postPosSessionJournal(payload: { orgId: string; sessionId: string; userId: string; postingKey?: string }): Promise<string | null> {
  const r = getRepos()
  const accountingSettings = (await postingSettingsOf(payload.orgId)).accounting
  if (!accountingSettings?.defaultSaleJournalId) return null

  const session = await r.posSessions.findByIdInOrg(payload.sessionId, payload.orgId)
  if (!session) return null
  // ⚠ Read from the model: the repository's session does not carry its entry.
  const linked = await POSSession.findOne({ _id: payload.sessionId, orgId: payload.orgId }, { journalEntryId: 1 }).lean().exec()
  if (linked?.journalEntryId) return String(linked.journalEntryId)
  const made = await postedAs(payload.orgId, payload.postingKey)
  if (made) {
    await POSSession.updateOne({ _id: payload.sessionId, orgId: payload.orgId }, { $set: { journalEntryId: made } }).exec()
    return made
  }

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
      outputVatAccountId: accountingSettings.defaultOutputVatAccountId,
      cashOverShortAccountId: accountingSettings.cashOverShortAccountId,
    },
    { journalId: accountingSettings.defaultSaleJournalId },
    accountingSettings.autoPostInvoiceEntries ?? false,
    r,
    { postingKey: payload.postingKey },
  )
  if (!result) return null

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
  return String(result.journalEntry.id)
}

/**
 * One payment's journal entry (`payment.recorded`), stamped on THAT payment row: the row is found by its own id, or by
 * the receipt that took it (FR-23). A row that has an entry gets no second, and a row that is gone (an automatic
 * payment withdrawn since) owes nothing any more. The row says the amount, the method and the date.
 *
 * `auditPayment`: also the `record_payment` row on the invoice that the event handler always wrote.
 */
export async function postPaymentJournal(payload: {
  orgId: string
  invoiceId: string
  paymentId?: string
  receiptId?: string
  userId: string
  postingKey?: string
  auditPayment?: boolean
}): Promise<string | null> {
  const r = getRepos()
  const accountingSettings = (await postingSettingsOf(payload.orgId)).accounting
  if (!accountingSettings?.defaultCashJournalId && !accountingSettings?.defaultBankJournalId) return null
  // ⚠ Read raw: the repository's invoice carries its payments without their ids or entries.
  const raw: any = await Invoice.findOne({ _id: payload.invoiceId, orgId: payload.orgId }).lean().exec()
  if (!raw) return null
  const payment = (raw.payments || []).find((p: any) => payload.paymentId
    ? String(p._id) === payload.paymentId
    : !!payload.receiptId && String(p.receiptId ?? '') === payload.receiptId)
  if (!payment) return null
  if (payment.journalEntryId) return String(payment.journalEntryId)
  // ⚠ Stamped in place, on that row only: the array is never written back, which lost whatever another payment wrote
  // in between.
  const stamp = (journalEntryId: string) => Invoice.updateOne(
    { _id: payload.invoiceId, orgId: payload.orgId, 'payments._id': payment._id },
    { $set: { 'payments.$.journalEntryId': journalEntryId } },
  ).exec()
  const made = await postedAs(payload.orgId, payload.postingKey)
  if (made) {
    await stamp(made)
    return made
  }

  const invoice = { ...raw, id: String(raw._id) }
  const je = await createPaymentJournalEntry(
    payload.orgId,
    invoice,
    { amount: payment.amount, method: payment.method, date: payment.date },
    {
      receivableAccountId: accountingSettings.defaultReceivableAccountId,
      payableAccountId: accountingSettings.defaultPayableAccountId,
    },
    { journalId: payment.method === 'cash' ? accountingSettings.defaultCashJournalId : accountingSettings.defaultBankJournalId },
    accountingSettings.autoPostPaymentEntries ?? false,
    r,
    { postingKey: payload.postingKey },
  )
  if (!je) return null
  await stamp(je.id)

  const correlationId = generateCorrelationId()
  if (payload.auditPayment) {
    createAuditEntry({
      orgId: payload.orgId,
      userId: payload.userId,
      action: 'record_payment',
      module: 'invoicing',
      entityType: 'invoice',
      entityId: payload.invoiceId,
      entityName: invoice.invoiceNumber,
      correlationId,
      changes: [{ field: 'payment', oldValue: null, newValue: `${payment.method}: ${payment.amount}` }],
    })
  }
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
  return String(je.id)
}

/** A completed movement's valuation entry (`stock.movement.confirmed`). One that has an entry gets no second. */
export async function postMovementValuation(payload: { orgId: string; movementId: string; postingKey?: string }): Promise<string | null> {
  const r = getRepos()
  const movement = await r.stockMovements.findByIdInOrg(payload.movementId, payload.orgId)
  if (!movement || movement.status !== 'completed') return null
  if (movement.journalEntryId) return String(movement.journalEntryId)
  const made = await postedAs(payload.orgId, payload.postingKey)
  if (made) {
    await r.stockMovements.updateInOrg(payload.movementId, payload.orgId, { journalEntryId: made })
    return made
  }

  const je = await createMovementValuationEntry(
    payload.orgId,
    movement,
    movement.lines || [],
    movement.date || new Date(),
    r,
    { postingKey: payload.postingKey },
  )
  if (!je) return null

  createAuditEntry({
    orgId: payload.orgId,
    userId: 'system',
    action: 'auto_create',
    module: 'accounting',
    entityType: 'journal_entry',
    entityId: je.id,
    entityName: je.entryNumber,
    correlationId: generateCorrelationId(),
    changes: [{ field: 'source', oldValue: null, newValue: `movement:${movement.movementNumber}` }],
  })
  return String(je.id)
}
