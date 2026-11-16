import type { IInvoice, IStockMovement } from 'dal/entities'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'
import { createInvoiceStockMovement } from './invoicing.service.js'
import { getNextInvoiceNumber } from './invoice-numbering.service.js'
import { inTransaction } from './transaction.js'
import { announceMovementConfirmed } from './warehouse.service.js'

/**
 * Issuing a document: `/send` (an invoice, a note, a quote, a bill issued there) and `/receive` (a
 * bill). FR-29 slice B, #794.
 *
 * The two routes keep their own checks, questions and claims (`/send`'s lease and idempotency key,
 * `/receive`'s), and what follows the issue (events, the audit row, prices carried forward, the
 * order). Between the two sits this: ONE transaction that books the stock, draws the number and
 * writes the status, so a document is issued with its goods moved, or is the draft it was.
 *
 * Before, `/send` booked, drew and wrote one after the other, and `/receive` drew and wrote first and
 * booked after. A booking that failed half way left `/send`'s draft movement behind, which the retry
 * skipped ("a movement with this id exists"), so the invoice was issued with its goods unmoved, and
 * moved twice once somebody confirmed that draft (§1.2). A `/receive` whose booking failed left a
 * received bill with its stock half booked, and nothing could retry it.
 */

/** The request no longer holds the draft it is issuing (its claim lapsed and another took it, or it left draft). */
export class IssueLostError extends Error {
  readonly code = 'issue_lost'
  constructor(readonly draftNumber?: string) {
    super(`${draftNumber || 'This document'} is no longer the draft this request was issuing`)
  }
}

/**
 * Booking the document's stock failed: `failure` is what the booking threw (a refusal of the stock, a
 * cost layer, a movement being confirmed from the list). Kept apart from a failure of the number or
 * the status write, because each route answers it as it always has.
 */
export class IssueStockError extends Error {
  constructor(readonly failure: any) {
    super(failure?.message ?? String(failure))
  }
}

function statusEntry(toStatus: string, fromStatus: string | undefined, userId: string) {
  return { status: toStatus, fromStatus, changedAt: new Date(), changedBy: userId }
}

export interface IssueRequest {
  orgId: string
  /** The draft, as the route read it before its claim. */
  invoice: IInvoice
  userId: string
  /** What it becomes: `sent`, `received`, or `paid` (an invoice for a cash sale). */
  status: string
  /**
   * What on the document shows that this request still holds it (its lease, as written by its claim).
   * The status is written only while the document is a draft and this holds.
   */
  heldBy: Record<string, unknown>
  /** Further fields the route writes with the status (its lease's end, a receipt's tender, …). */
  fields?: Record<string, unknown>
  /** Migration imports dispatch goods not yet in stock. */
  allowNegative?: boolean
}

export interface IssueResult {
  invoice: IInvoice
  issuedNumber: string
  draftNumber: string
  /** The movements this issue booked (none when a completed one stood from an earlier attempt). */
  movements: IStockMovement[]
}

/**
 * Issue a claimed draft (FR-29.8):
 *
 * 1. the stock, joined (`confirmMovement`'s `session`). FR-29.9: what an earlier attempt left is
 *    finished: a completed movement of the document stands for its warehouse, a draft one is removed
 *    and booked afresh (`resume`);
 * 2. the number, LAST, so a failed issue draws none and the counter is held for a moment (FR-29.11,
 *    D-3). Two issues at once meet on the counter; the later one runs again after the first commits;
 * 3. the status, the number and its history, only while the draft is still this request's.
 *
 * After the commit, the movements' `stock.movement.confirmed` (FR-29.7). The rest is the route's.
 *
 * Throws `IssueStockError` when the booking failed, `IssueLostError` when the claim was lost, or what
 * the number or the write threw. Whatever it throws, nothing of it is stored: the route releases its
 * claim, and the document is the draft it was, with its draft number (FR-29.10).
 */
export async function issueDocument(req: IssueRequest): Promise<IssueResult> {
  const { orgId, invoice, userId, status } = req
  const id = String(invoice.id)
  const draftNumber = String(invoice.invoiceNumber ?? '')
  const r = getRepos()

  let phase: 'stock' | 'number' = 'stock'
  let done: { issuedNumber: string; movements: IStockMovement[] }
  try {
    done = await inTransaction(async session => {
      phase = 'stock'
      const movements = await createInvoiceStockMovement(invoice, userId, r, { session, resume: true, allowNegative: req.allowNegative })

      phase = 'number'
      const issuedNumber = await getNextInvoiceNumber(orgId, invoice.direction as string, invoice.type as string, { session })
      const statusHistory = [...((invoice as any).statusHistory || []), statusEntry(status, invoice.status, userId)]
      const numberHistory = [...((invoice as any).numberHistory || []), { number: issuedNumber, allocatedAt: new Date(), status }]
      const written = await r.invoices.updateInOrg(id, orgId, {
        status,
        sentAt: new Date(),
        statusHistory,
        invoiceNumber: issuedNumber,
        draftNumber,
        numberHistory,
        ...req.fields,
      } as any, { status: 'draft', ...req.heldBy }, { session })
      if (!written) throw new IssueLostError(draftNumber)
      return { issuedNumber, movements }
    })
  } catch (e) {
    if (phase === 'stock') throw new IssueStockError(e)
    throw e
  }

  for (const m of done.movements) announceMovementConfirmed(m)
  const issued = await r.invoices.findByIdInOrg(id, orgId)
  logger.info({ invoiceId: id, status, movements: done.movements.length }, 'Document issued')
  return { invoice: issued!, issuedNumber: done.issuedNumber, draftNumber, movements: done.movements }
}
