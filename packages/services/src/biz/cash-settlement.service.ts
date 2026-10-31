import { getRepos } from '../context.js'
import { eventBus } from '../events/event-bus.js'
import { logger } from '../logger/logger.js'
import { createAuditEntry } from './audit-log.service.js'
import { voidJournalEntry } from './accounting.service.js'

/**
 * A sales invoice paid at the counter — in cash or by card — is paid the moment it is issued.
 *
 * The money changed hands when the invoice was written, so there is no later collection to wait
 * for. Nothing recorded that until 2026-10: every cash invoice stayed `sent` with its whole total
 * due — 501 of them on prod, €35.7k of "receivables" nobody owed — in the aging report and in
 * every client's open balance. A card sale followed in FR-22.19 (D-3): it cost a second dialog on
 * the list row, and the method picked a second time.
 *
 * `syncCashSettlement` brings ONE issued outgoing invoice in line with that rule. Every path
 * that issues or edits one calls it: `/send`, `PUT /invoices/:id` and the import conversion
 * (`convertDraftInvoice`), which is how most invoices arrive.
 *  - Method cash or card → whatever is still outstanding becomes one payment by that method,
 *    dated the invoice's issue date and marked with the method's origin (`cash_on_issue`,
 *    `card_on_issue`), and the document is paid. An edit that raises the total tops it up; one
 *    that lowers it shrinks the automatic part.
 *  - Method changed → the automatic payments of the old method go again (their journal entries
 *    are voided): what they recorded was never received that way. When the new method is
 *    settled on issue too, it takes over what is outstanding; otherwise the status follows what
 *    is left. A payment recorded by hand is never touched.
 *  - A draft is left alone. It is not an invoice yet: it has no number, and a paid document
 *    can no longer be issued or voided. It is settled when it is issued.
 * Bank transfer and cash on delivery (наложен платеж) are deliberately not settled here: the
 * money comes later, from the bank or the courier.
 *
 * ⚠ FR-23: where LGR prints (`settings.cashRegister.requireConnectedDevice` not off) a printed
 * receipt and its payment are the settlement, and neither `/send` nor `PUT` calls this rule for a
 * document a person issues: money taken at the counter goes through the payment action, which
 * prints. The import conversion still does, in every org: another system printed that receipt.
 * Printing never lives in here, because the conversion comes through here.
 */

/** Marks the cash payments this rule records, so it can tell them from ones a person entered. */
export const CASH_ON_ISSUE = 'cash_on_issue'
/** The same, for a card payment taken at the counter (FR-22.19). */
export const CARD_ON_ISSUE = 'card_on_issue'

/** The methods paid at the counter as the invoice is written, and the origin each one's payment carries. */
export const SETTLED_ON_ISSUE: Readonly<Record<string, string>> = { cash: CASH_ON_ISSUE, card: CARD_ON_ISSUE }
const METHOD_OF_ORIGIN: Readonly<Record<string, string>> = { [CASH_ON_ISSUE]: 'cash', [CARD_ON_ISSUE]: 'card' }
const AUTO_ORIGINS = new Set(Object.keys(METHOD_OF_ORIGIN))
/** The audit field each origin's total is logged under. */
const AUDIT_FIELD: Readonly<Record<string, string>> = { [CASH_ON_ISSUE]: 'cashOnIssue', [CARD_ON_ISSUE]: 'cardOnIssue' }

/** Issued states: the document has its number and stands as a claim on the client. */
const ISSUED = ['sent', 'overdue', 'partially_paid', 'paid']

export type CashSettlementAction = 'settled' | 'adjusted' | 'unsettled' | 'none'

export interface CashSettlementResult {
  action: CashSettlementAction
  /** The automatic payment recorded (positive) or withdrawn (negative) by this call, net. */
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

async function retireAll(payments: any[]): Promise<void> {
  for (const p of payments) if (p.journalEntryId) await retireJournalEntry(String(p.journalEntryId))
}

/** For a caller that replaces automatic payments (an invoice attached to a cash sale): their entries go. */
export const retireAutomaticPayments = retireAll

export async function syncCashSettlement(orgId: string, invoiceId: string, userId: string): Promise<CashSettlementResult> {
  const r = getRepos()
  const inv: any = await r.invoices.findOne({ id: invoiceId, orgId } as any)
  if (!inv || inv.direction !== 'outgoing' || inv.type !== 'invoice' || !ISSUED.includes(inv.status)) return NONE
  // #171: an invoice for a cash sale was paid by that cash sale — its payment row says so, and
  // it is never this rule's to add, shrink or withdraw, whatever the sale was paid with.
  if (inv.cashSaleRef?.cashSaleId) return NONE

  const total = round2(inv.total)
  if (total <= 0) return NONE
  const payments: any[] = inv.payments || []
  /** The origin the invoice's method settles under; none for a method paid later. */
  const origin: string | undefined = SETTLED_ON_ISSUE[inv.paymentMethod]
  const auto = payments.filter(p => AUTO_ORIGINS.has(p.origin))
  const manual = payments.filter(p => !AUTO_ORIGINS.has(p.origin))
  // Recorded under another method than the invoice now says: never received that way.
  const stale = auto.filter(p => p.origin !== origin)
  const own = auto.filter(p => p.origin === origin)

  // `added`: the automatic payment this call records. `removed`: the automatic payments it takes
  // back (their ledger entries are voided first).
  let added = 0
  let removed = 0
  let next: any[] = [...manual, ...own]
  if (stale.length) {
    removed += sum(stale)
    await retireAll(stale)
  }
  if (origin) {
    const outstanding = round2(total - sum(next))
    if (outstanding > 0) {
      // Issued at the counter, or its total went up: the rest was taken there too.
      added = outstanding
      next = [...next, autoPayment(inv, added, origin)]
    } else if (outstanding < 0 && own.length) {
      // The total went down after it was settled: the automatic part shrinks to what is owed.
      removed += sum(own)
      await retireAll(own)
      added = Math.max(0, round2(total - sum(manual)))
      next = added ? [...manual, autoPayment(inv, added, origin)] : manual
    }
  }
  if (!added && !removed) return NONE

  const action: CashSettlementAction = !origin ? 'unsettled' : auto.length ? 'adjusted' : 'settled'
  const paid = sum(next)
  const status = statusFor(total, paid)
  const reason = !origin
    ? `${[...new Set(stale.map(p => METHOD_OF_ORIGIN[p.origin]))].join(', ')} payment withdrawn: method is now ${inv.paymentMethod || 'none'}`
    : `paid ${origin === CARD_ON_ISSUE ? 'by card' : 'in cash'} on issue`
  const statusHistory = status === inv.status
    ? inv.statusHistory || []
    : [...(inv.statusHistory || []), { status, fromStatus: inv.status, changedAt: new Date(), changedBy: userId, reason }]
  await r.invoices.update(invoiceId, {
    payments: next,
    amountPaid: paid,
    amountDue: round2(total - paid),
    status,
    // Paid when the money was taken: the issue date, never the moment this ran.
    paidAt: status === 'paid' ? (inv.status === 'paid' && inv.paidAt ? inv.paidAt : paymentDate(inv)) : null,
    statusHistory,
  } as any)

  const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = []
  for (const o of AUTO_ORIGINS) {
    const before = sum(auto.filter(p => p.origin === o))
    const after = sum(next.filter(p => p.origin === o))
    if (before !== after) changes.push({ field: AUDIT_FIELD[o], oldValue: before || null, newValue: after || null })
  }
  changes.push({ field: 'status', oldValue: inv.status, newValue: status })
  createAuditEntry({
    orgId, userId, action: 'record_payment', module: 'invoicing', entityType: 'invoice', entityId: invoiceId,
    entityName: inv.invoiceNumber, changes,
  })
  if (added > 0) {
    // Same event a hand-recorded payment emits: the ledger entry, when the org keeps one.
    eventBus.emit('payment.recorded', {
      invoiceId, orgId, userId, amount: added, method: METHOD_OF_ORIGIN[origin!], date: paymentDate(inv).toISOString(),
    })
  }
  logger.info({ orgId, invoiceId, invoiceNumber: inv.invoiceNumber, method: inv.paymentMethod, action, added, removed }, 'counter settlement')
  return { action, amount: round2(added - removed) }
}

/**
 * FR-23: an edit in an org where LGR prints. It moves no money: no payment is added, shrunk or
 * withdrawn, because that money goes through the payment action, which prints. It only says what
 * is owed now. So a total raised on a paid document leaves the rest due and payable, where a stale
 * `paid` would refuse the payment; a total lowered below what was paid stays paid, and what was
 * taken stays recorded for a person to correct.
 */
export async function syncDueAfterEdit(orgId: string, invoiceId: string, userId: string): Promise<CashSettlementResult> {
  const r = getRepos()
  const inv: any = await r.invoices.findOne({ id: invoiceId, orgId } as any)
  if (!inv || inv.direction !== 'outgoing' || inv.type !== 'invoice' || !ISSUED.includes(inv.status)) return NONE
  if (inv.cashSaleRef?.cashSaleId) return NONE
  const payments: any[] = inv.payments || []
  // What this rule would have kept in line where nothing prints; every other document as today.
  if (!SETTLED_ON_ISSUE[inv.paymentMethod] && !payments.some(p => AUTO_ORIGINS.has(p.origin))) return NONE

  const total = round2(inv.total)
  const paid = sum(payments)
  const amountDue = Math.max(0, round2(total - paid))
  const status = paid > 0 ? statusFor(total, paid) : inv.status
  if (status === inv.status && amountDue === round2(inv.amountDue)) return NONE
  await r.invoices.update(invoiceId, {
    amountPaid: paid,
    amountDue,
    status,
    paidAt: status === 'paid' ? inv.paidAt ?? null : null,
    statusHistory: status === inv.status
      ? inv.statusHistory || []
      : [...(inv.statusHistory || []), { status, fromStatus: inv.status, changedAt: new Date(), changedBy: userId, reason: 'total edited' }],
  } as any)
  return { action: 'adjusted', amount: 0 }
}

function paymentDate(inv: any): Date {
  return inv.issueDate ? new Date(inv.issueDate) : new Date()
}

function autoPayment(inv: any, amount: number, origin: string) {
  return { date: paymentDate(inv), amount, method: METHOD_OF_ORIGIN[origin], origin }
}
