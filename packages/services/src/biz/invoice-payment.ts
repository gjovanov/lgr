import { Invoice } from 'db/models'

/**
 * One payment on a document, in one atomic update: the route's (`POST /invoices/:id/payments`) and
 * the receipt's that took the money at the counter (FR-23).
 */

/** Half a cent: money is compared at the cent, never at floating-point precision. */
const PAYMENT_TOLERANCE = 0.005

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

/** The money the receipts printing right now are taking from this document (FR-23). */
export function heldOn(doc: { receiptHolds?: { amount?: number }[] } | null | undefined): number {
  return round2((doc?.receiptHolds || []).reduce((s, h) => s + (Number(h.amount) || 0), 0))
}

/** What a document still has to be paid: its total less what has been paid on it. */
export function outstandingOf(doc: { total?: number; amountPaid?: number }): number {
  return round2((Number(doc.total) || 0) - (Number(doc.amountPaid) || 0))
}

/** Whether `amount` pays more than the document still owes. */
export function overpays(doc: { total?: number; amountPaid?: number }, amount: number): boolean {
  return (Number(doc.amountPaid) || 0) + amount > (Number(doc.total) || 0) + PAYMENT_TOLERANCE
}

/**
 * No claim stands on the document's money (`voidingUntil`): a void's, or an attach to a cash sale's.
 * Each takes it before it moves anything and it lapses, so one that died holds nothing up for long.
 * `{ field: null }` matches a field that is missing too.
 */
export function notBeingVoided(now = new Date()): Record<string, unknown> {
  return { $or: [{ voidingUntil: null }, { voidingUntil: { $lt: now } }] }
}

/** The same, read off a document in hand: why a write with `notBeingVoided` found nothing. */
export function isBeingVoided(doc: { voidingUntil?: Date | string | null } | null | undefined, now = new Date()): boolean {
  return !!doc?.voidingUntil && new Date(doc.voidingUntil).getTime() >= now.getTime()
}

/**
 * The filter that lets a payment through only while it fits, inside the update: two payments
 * recorded at once each fit what was owed when they were read, and must not overpay it between
 * them. Money a receipt is printing for counts as taken (FR-23), so a payment recorded meanwhile
 * cannot take it too. ⚠ And no payment gets past a claim, by any method: both doors share this, so
 * of a void and a payment one gives way, and a door added later gets that for nothing.
 */
export function fitsDue(amount: number, now = new Date()): Record<string, unknown> {
  return {
    ...notBeingVoided(now),
    $expr: {
      $lte: [
        { $add: [{ $ifNull: ['$amountPaid', 0] }, { $sum: '$receiptHolds.amount' }, amount] },
        { $add: ['$total', PAYMENT_TOLERANCE] },
      ],
    },
  }
}

export interface PaymentRow {
  /** Chosen by the caller when something has to find this row later. */
  _id?: unknown
  date: Date
  amount: number
  method: string
  reference?: string
  origin?: string
  receiptId?: unknown
  clientKey?: string
  requestHash?: string
}

/**
 * ⚠ ONE atomic update: append the payment, add it to `amountPaid`, and derive `amountDue`, `status`,
 * `paidAt` and the status history from the RESULT, inside the database. Read-modify-write here lost
 * a payment whenever two were recorded at once (each wrote back the array it had read), and let a
 * retried request pay twice.
 *
 * Rounded to the cent where it is summed: 33.37 + 33.37 + 33.36 must leave nothing due, and in
 * binary it can leave 1e-14, which reads as `partially_paid` for ever.
 *
 * `releases`: the receipt whose hold this payment takes over.
 */
export function paymentPipeline(row: PaymentRow, o: { at: Date; by: string; releases?: unknown }): Record<string, unknown>[] {
  const { ObjectId } = (Invoice.base as any).Types
  // Mongoose gives array subdocuments an _id; a raw update has to do it itself.
  const payment = { _id: new ObjectId(), ...row }
  return [
    {
      $set: {
        _priorStatus: '$status',
        // $literal: a reference typed as "$…" is text, not a field path.
        payments: { $concatArrays: [{ $ifNull: ['$payments', []] }, [{ $literal: payment }]] },
        amountPaid: { $round: [{ $add: [{ $ifNull: ['$amountPaid', 0] }, row.amount] }, 2] },
        ...(o.releases
          ? { receiptHolds: { $filter: { input: { $ifNull: ['$receiptHolds', []] }, cond: { $ne: ['$$this.receiptId', o.releases] } } } }
          : {}),
      },
    },
    { $set: { amountDue: { $round: [{ $subtract: ['$total', '$amountPaid'] }, 2] } } },
    { $set: { status: { $cond: [{ $lte: ['$amountDue', 0] }, 'paid', 'partially_paid'] } } },
    {
      $set: {
        paidAt: { $cond: [{ $lte: ['$amountDue', 0] }, o.at, '$paidAt'] },
        statusHistory: {
          $cond: [
            { $ne: ['$status', '$_priorStatus'] },
            {
              $concatArrays: [
                { $ifNull: ['$statusHistory', []] },
                [{
                  status: '$status',
                  fromStatus: '$_priorStatus',
                  changedAt: o.at,
                  changedBy: new ObjectId(String(o.by)),
                  reason: { $literal: `payment ${row.amount} ${row.method}` },
                }],
              ],
            },
            '$statusHistory',
          ],
        },
        updatedAt: o.at,
      },
    },
    { $unset: '_priorStatus' },
  ]
}
