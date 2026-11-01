import { Invoice } from 'db/models'
import { getRepos } from '../context.js'
import { eventBus } from '../events/event-bus.js'
import { logger } from '../logger/logger.js'
import { createAuditEntry } from './audit-log.service.js'
import { voidJournalEntry } from './accounting.service.js'
import { notBeingVoided } from './invoice-payment.js'

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
 * receipt and its payment are the settlement, because money taken at the counter goes through the
 * payment action, which prints. So the caller says who settles (`settles`). `/send` does not call
 * this for a document a person issues, and `PUT` calls it with `settles: false`: an edit never adds or
 * shrinks a payment, withdraws only this rule's own rows the method no longer says, and derives
 * status and due. The import conversion settles as it always did, in every org: another system
 * printed that receipt. Printing never lives in here, because the conversion comes through here.
 *
 * ⚠ What it read is a check, and its write is what makes it hold: conditional, as a money-moving `PUT` is,
 * on the `amountPaid` it read and no hold. A payment forced between the read and an unconditional write
 * left a row of 10 on `amountPaid` 0, and the next payment took the whole total: rows of 46 on a total of
 * 36. A write that lost reads again and runs the rule once more. If that loses too the document is left
 * alone: every payment derives what is due in its own write, so it stands as the last one left it.
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
/** Something got between the read and the write. */
const LOST = Symbol('settlement lost its race')

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

export async function syncCashSettlement(orgId: string, invoiceId: string, userId: string, opts: { settles?: boolean } = {}): Promise<CashSettlementResult> {
  const first = await applySettlement(orgId, invoiceId, userId, opts)
  if (first !== LOST) return first
  const second = await applySettlement(orgId, invoiceId, userId, opts)
  if (second !== LOST) return second
  logger.warn({ orgId, invoiceId }, 'Counter settlement lost its race twice: the document is left as it stands')
  return NONE
}

async function applySettlement(orgId: string, invoiceId: string, userId: string, opts: { settles?: boolean }): Promise<CashSettlementResult | typeof LOST> {
  const settles = opts.settles !== false
  const r = getRepos()
  const inv: any = await r.invoices.findOne({ id: invoiceId, orgId } as any)
  if (!inv || inv.direction !== 'outgoing' || inv.type !== 'invoice' || !ISSUED.includes(inv.status)) return NONE
  // #171: an invoice for a cash sale was paid by that cash sale — its payment row says so, and
  // it is never this rule's to add, shrink or withdraw, whatever the sale was paid with.
  if (inv.cashSaleRef?.cashSaleId) return NONE

  const total = round2(inv.total)
  if (settles && total <= 0) return NONE
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
  if (origin && settles) {
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
  if (settles && !added && !removed) return NONE
  // Not settling, only what this rule would have kept in line where nothing prints is its business.
  if (!settles && !origin && !auto.length) return NONE

  const paid = sum(next)
  // What is owed now. A total lowered below what was taken stays paid, and that stays recorded for a
  // person to correct; with nothing paid and nothing withdrawn the status is not this rule's to move.
  const status = paid > 0 || removed ? statusFor(total, paid) : inv.status
  const amountDue = settles ? round2(total - paid) : Math.max(0, round2(total - paid))
  if (!settles && !removed && status === inv.status && amountDue === round2(inv.amountDue)) return NONE

  const withdrawn = removed > 0 && (!origin || !settles)
  const action: CashSettlementAction = withdrawn ? 'unsettled' : !settles || auto.length ? 'adjusted' : 'settled'
  const reason = withdrawn
    ? `${[...new Set(stale.map(p => METHOD_OF_ORIGIN[p.origin]))].join(', ')} payment withdrawn: method is now ${inv.paymentMethod || 'none'}`
    : settles ? `paid ${origin === CARD_ON_ISSUE ? 'by card' : 'in cash'} on issue` : 'total edited'
  const statusHistory = status === inv.status
    ? inv.statusHistory || []
    : [...(inv.statusHistory || []), { status, fromStatus: inv.status, changedAt: new Date(), changedBy: userId, reason }]
  const written = await r.invoices.updateInOrg(invoiceId, orgId, {
    ...(added || removed ? { payments: next } : {}),
    amountPaid: paid,
    amountDue,
    status,
    // Paid when the money was taken: the issue date, never the moment this ran. Not settling, that is
    // on a receipt: a total raised and lowered again is paid once more, and needs a date to say so.
    paidAt: status !== 'paid' ? null : settles ? (inv.status === 'paid' && inv.paidAt ? inv.paidAt : paymentDate(inv)) : inv.paidAt ?? new Date(),
    statusHistory,
  } as any, { 'receiptHolds.0': { $exists: false }, amountPaid: inv.amountPaid ?? null, ...notBeingVoided() })
  if (!written) return LOST
  if (!added && !removed) return { action, amount: 0 }

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
      paymentId: String(next[next.length - 1]._id),
    })
  }
  logger.info({ orgId, invoiceId, invoiceNumber: inv.invoiceNumber, method: inv.paymentMethod, action, added, removed }, 'counter settlement')
  return { action, amount: round2(added - removed) }
}

function paymentDate(inv: any): Date {
  return inv.issueDate ? new Date(inv.issueDate) : new Date()
}

function autoPayment(inv: any, amount: number, origin: string) {
  // Its own id, so that its journal entry finds this row and no other (`payment.recorded`).
  return { _id: new (Invoice.base as any).Types.ObjectId(), date: paymentDate(inv), amount, method: METHOD_OF_ORIGIN[origin], origin }
}
