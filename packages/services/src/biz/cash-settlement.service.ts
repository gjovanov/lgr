import { getRepos } from '../context.js'
import { eventBus } from '../events/event-bus.js'
import { logger } from '../logger/logger.js'
import { createAuditEntry } from './audit-log.service.js'
import { voidJournalEntry } from './accounting.service.js'

/**
 * A sales invoice paid in cash is paid the moment it is issued.
 *
 * The money changed hands at the counter when the invoice was written, so there is no later
 * collection to wait for. Nothing recorded that until 2026-10: every cash invoice stayed `sent`
 * with its whole total due — 501 of them on prod, €35.7k of "receivables" nobody owed — in the
 * aging report and in every client's open balance.
 *
 * `syncCashSettlement` brings ONE issued outgoing invoice in line with that rule. Every path
 * that issues or edits one calls it: `/send`, `PUT /invoices/:id` and the import conversion
 * (`convertDraftInvoice`), which is how most invoices arrive.
 *  - Method cash → whatever is still outstanding becomes one cash payment dated the invoice's
 *    issue date and marked `origin: 'cash_on_issue'`, and the document is paid. An edit that
 *    raises the total tops it up; one that lowers it shrinks the automatic part.
 *  - Method changed away from cash → the automatic payments go again (their journal entries
 *    are voided) and the status follows what is left. A payment recorded by hand is never
 *    touched.
 *  - A draft is left alone. It is not an invoice yet: it has no number, and a paid document
 *    can no longer be issued or voided. It is settled when it is issued.
 * Cash on delivery (наложен платеж) is deliberately not cash here: the courier pays later.
 */

/** Marks the payments this rule records, so it can tell them from ones a person entered. */
export const CASH_ON_ISSUE = 'cash_on_issue'

/** Issued states: the document has its number and stands as a claim on the client. */
const ISSUED = ['sent', 'overdue', 'partially_paid', 'paid']

export type CashSettlementAction = 'settled' | 'adjusted' | 'unsettled' | 'none'

export interface CashSettlementResult {
  action: CashSettlementAction
  /** The automatic cash recorded (positive) or withdrawn (negative) by this call. */
  amount: number
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100
const sum = (ps: any[]) => round2(ps.reduce((s, p) => s + (Number(p.amount) || 0), 0))
const NONE: CashSettlementResult = { action: 'none', amount: 0 }

/** Status from the amounts, for a document whose payments just changed under it. */
function statusFor(total: number, paid: number): string {
  if (paid <= 0) return 'sent'
  return paid >= total ? 'paid' : 'partially_paid'
}

/** Void the ledger entry an automatic payment posted, whatever state it reached. */
async function retireJournalEntry(entryId: string): Promise<void> {
  const r = getRepos()
  const je: any = await r.journalEntries.findById(entryId)
  if (!je || je.status === 'voided') return
  if (je.status === 'posted') await voidJournalEntry(entryId)
  else await r.journalEntries.update(entryId, { status: 'voided' } as any)
}

export async function syncCashSettlement(orgId: string, invoiceId: string, userId: string): Promise<CashSettlementResult> {
  const r = getRepos()
  const inv: any = await r.invoices.findOne({ id: invoiceId, orgId } as any)
  if (!inv || inv.direction !== 'outgoing' || inv.type !== 'invoice' || !ISSUED.includes(inv.status)) return NONE

  const total = round2(inv.total)
  if (total <= 0) return NONE
  const payments: any[] = inv.payments || []
  const auto = payments.filter(p => p.origin === CASH_ON_ISSUE)
  const manual = payments.filter(p => p.origin !== CASH_ON_ISSUE)
  const isCash = inv.paymentMethod === 'cash'
  const outstanding = round2(total - sum(payments))

  // `added`: the automatic payment this call records. `removed`: the automatic payments it takes
  // back (their ledger entries are voided first).
  let next: any[]
  let action: CashSettlementAction
  let added = 0
  let removed = 0
  if (isCash && outstanding > 0) {
    // Issued in cash, or its total went up: the rest was taken at the counter too.
    added = outstanding
    next = [...payments, cashPayment(inv, added)]
    action = auto.length ? 'adjusted' : 'settled'
  } else if (isCash && outstanding < 0 && auto.length) {
    // The total went down after it was settled: the automatic part shrinks to what is owed.
    removed = sum(auto)
    for (const p of auto) if (p.journalEntryId) await retireJournalEntry(String(p.journalEntryId))
    added = Math.max(0, round2(total - sum(manual)))
    next = added ? [...manual, cashPayment(inv, added)] : manual
    action = 'adjusted'
  } else if (!isCash && auto.length) {
    // No longer a cash invoice: what this rule recorded was never actually received.
    removed = sum(auto)
    for (const p of auto) if (p.journalEntryId) await retireJournalEntry(String(p.journalEntryId))
    next = manual
    action = 'unsettled'
  } else {
    return NONE
  }

  const paid = sum(next)
  const status = statusFor(total, paid)
  const reason = action === 'unsettled'
    ? `cash payment withdrawn: method is now ${inv.paymentMethod || 'none'}`
    : 'paid in cash on issue'
  const statusHistory = status === inv.status
    ? inv.statusHistory || []
    : [...(inv.statusHistory || []), { status, fromStatus: inv.status, changedAt: new Date(), changedBy: userId, reason }]
  await r.invoices.update(invoiceId, {
    payments: next,
    amountPaid: paid,
    amountDue: round2(total - paid),
    status,
    // Paid when the cash was taken: the issue date, never the moment this ran.
    paidAt: status === 'paid' ? (inv.status === 'paid' && inv.paidAt ? inv.paidAt : paymentDate(inv)) : null,
    statusHistory,
  } as any)

  createAuditEntry({
    orgId, userId, action: 'record_payment', module: 'invoicing', entityType: 'invoice', entityId: invoiceId,
    entityName: inv.invoiceNumber,
    changes: [
      { field: 'cashOnIssue', oldValue: sum(auto) || null, newValue: sum(next.filter(p => p.origin === CASH_ON_ISSUE)) || null },
      { field: 'status', oldValue: inv.status, newValue: status },
    ],
  })
  if (added > 0) {
    // Same event a hand-recorded payment emits: the ledger entry, when the org keeps one.
    eventBus.emit('payment.recorded', {
      invoiceId, orgId, userId, amount: added, method: 'cash', date: paymentDate(inv).toISOString(),
    })
  }
  logger.info({ orgId, invoiceId, invoiceNumber: inv.invoiceNumber, action, added, removed }, 'cash settlement')
  return { action, amount: round2(added - removed) }
}

function paymentDate(inv: any): Date {
  return inv.issueDate ? new Date(inv.issueDate) : new Date()
}

function cashPayment(inv: any, amount: number) {
  return { date: paymentDate(inv), amount, method: 'cash', origin: CASH_ON_ISSUE }
}
