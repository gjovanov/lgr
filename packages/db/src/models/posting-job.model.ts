import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

/**
 * FR-29.15 (§2.5, D-4) — a journal entry that a business event OWES, stored with the state change that owes it.
 *
 * The four events of the ledger (`invoice.posted`, `payment.recorded`, `stock.movement.confirmed`,
 * `pos.session.closed`) used to reach their journal entry only through the in-process event bus: a handler that
 * threw, or a process that stopped between the commit and the handler, left an issued document with no entry and one
 * log line. Now the document's own transaction writes this row; the process tries it right after the commit, and the
 * `postings` scheduler retries what is still queued (`services/biz/postings/posting.service.ts`).
 *
 * - `postingKey` is `<event>:<source>` (`config/posting-keys`), unique per org here AND on `JournalEntry.postingKey`:
 *   the job is owed once, and its entry exists once, whoever drains it, on whichever pod.
 * - `queued` → `done`, or after `POSTING_MAX_ATTEMPTS` failures `failed`, which stays until an accountant asks again.
 * - An organization that does not post owes nothing and gets no row (`owesPosting`).
 *
 * The org's data: it moves with the org (a bundle, a move), and a restored row that was drained already finds its
 * entry by the key.
 */
export type PostingEvent = 'invoice.posted' | 'payment.recorded' | 'stock.movement.confirmed' | 'pos.session.closed'
export type PostingState = 'queued' | 'done' | 'failed'

export interface IPostingJob extends Document {
  orgId: Types.ObjectId
  postingKey: string
  event: PostingEvent
  /** The document the entry is for: an invoice (and a payment on it), a movement or a till session. */
  invoiceId?: Types.ObjectId
  /** A payment row's own id (`payments[]._id`), for a payment no receipt took. */
  paymentId?: string
  /** The receipt that took a payment at the counter (FR-23), which its payment row carries. */
  receiptId?: Types.ObjectId
  movementId?: Types.ObjectId
  sessionId?: Types.ObjectId
  /** Who made the state change, for the entry's audit row. */
  userId?: Types.ObjectId
  state: PostingState
  attempts: number
  /** When the drain may try it next: a growing delay after each failure. */
  nextAttemptAt: Date
  /** A drain holds it until then, so two pods never run one job at the same moment. */
  leaseUntil?: Date
  /** The last failure, in the server's words (never a figure of the document). */
  lastError?: string
  /** The entry it made; absent when there was nothing to post (no accounts set, a total of 0). */
  journalEntryId?: Types.ObjectId
  doneAt?: Date
  createdAt: Date
  updatedAt: Date
}

const postingJobSchema = new Schema<IPostingJob>(
  {
    postingKey: { type: String, required: true, maxlength: 200 },
    event: { type: String, enum: ['invoice.posted', 'payment.recorded', 'stock.movement.confirmed', 'pos.session.closed'], required: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    paymentId: String,
    receiptId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    movementId: { type: Schema.Types.ObjectId, ref: 'StockMovement' },
    sessionId: { type: Schema.Types.ObjectId, ref: 'POSSession' },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    state: { type: String, enum: ['queued', 'done', 'failed'], required: true, default: 'queued' },
    attempts: { type: Number, required: true, default: 0 },
    nextAttemptAt: { type: Date, required: true, default: Date.now },
    leaseUntil: Date,
    lastError: { type: String, maxlength: 500 },
    journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
    doneAt: Date,
  },
  { timestamps: true, collection: 'postingjobs' },
)

postingJobSchema.plugin(tenantPlugin)
// One owed posting per key: a second insert for the same event and document is the first one.
postingJobSchema.index({ orgId: 1, postingKey: 1 }, { unique: true })
// The drain: what is queued and due, across the orgs homed here.
postingJobSchema.index({ state: 1, nextAttemptAt: 1 })
// The accountant's list and the counts: an org's open postings.
postingJobSchema.index({ orgId: 1, state: 1, createdAt: -1 })

replicate(postingJobSchema, { class: 'R' })

export const PostingJob = model<IPostingJob>('PostingJob', postingJobSchema)
