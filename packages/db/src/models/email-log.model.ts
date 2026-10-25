import { Schema, model, type Document, type Types } from 'mongoose'

export interface IEmailLog extends Document {
  _id: Types.ObjectId
  creatorId?: Types.ObjectId
  orgId?: Types.ObjectId
  from: string
  to: string
  subject: string
  /**
   * FR-13.43 (#24) — OPTIONAL, because retention strips it after 90 days and keeps the row.
   *
   * ⚠ Was `required: true`. It cannot stay that way: `$unset`ing a required path leaves a
   * document that fails validation on the next `save()` of an unrelated field, so the row
   * would be readable and unwritable — the FR-10.6 double-click guard reads these rows, and
   * a status update on one would start throwing a year after the row was written.
   *
   * Absent means "stripped by retention", not "never had one" — every writer sets it.
   */
  body?: string
  /**
   * FR-10.3: failures are logged too — a log with only successes hides the interesting half.
   * FR-20.86: on a master a mail is `queued` until global has sent it, and never said to be sent
   * before (FR-10's honesty rule).
   */
  status?: 'queued' | 'sent' | 'failed'
  /** On a master: the outbox item that carries it (FR-20.86). */
  outboxId?: string
  error?: string
  /** What triggered the send, so a log row can be traced back to its document. */
  entityType?: string
  entityId?: Types.ObjectId
  /** Names only — attachment CONTENT is never stored. */
  attachmentNames?: string[]
  createdAt: Date
  updatedAt: Date
}

const emailLogSchema = new Schema<IEmailLog>(
  {
    creatorId: { type: Schema.Types.ObjectId, ref: 'User' },
    orgId: { type: Schema.Types.ObjectId, ref: 'Org' },
    from: { type: String, required: true },
    to: { type: String, required: true },
    subject: { type: String, required: true },
    body: { type: String },
    status: { type: String, enum: ['queued', 'sent', 'failed'], default: 'sent' },
    outboxId: String,
    error: String,
    entityType: String,
    entityId: { type: Schema.Types.ObjectId },
    attachmentNames: [String],
  },
  { timestamps: true },
)

emailLogSchema.index({ to: 1, createdAt: -1 })
// "Has this document been emailed, and did it work?" — the FR-10.6 double-click guard and
// the form's last-sent indicator both read this way.
emailLogSchema.index({ orgId: 1, entityType: 1, entityId: 1, createdAt: -1 })
/** FR-11.13 (#21): the digest's "failed emails yesterday" section. */
emailLogSchema.index({ orgId: 1, status: 1, createdAt: -1 })
/**
 * FR-13.43 (#24): the retention sweep, which is the one query here that is NOT per-org — it
 * asks "what in this whole collection is older than a cutoff". Every other index leads with
 * `orgId` or `to` and cannot serve that, so without this the sweep is a full collection scan
 * on the largest non-fiscal collection, every tick, forever.
 */
emailLogSchema.index({ createdAt: 1 })

export const EmailLog = model<IEmailLog>('EmailLog', emailLogSchema)
