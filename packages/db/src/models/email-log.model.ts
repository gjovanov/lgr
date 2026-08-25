import { Schema, model, type Document, type Types } from 'mongoose'

export interface IEmailLog extends Document {
  _id: Types.ObjectId
  creatorId?: Types.ObjectId
  orgId?: Types.ObjectId
  from: string
  to: string
  subject: string
  body: string
  /** FR-10.3: failures are logged too — a log with only successes hides the interesting half. */
  status?: 'sent' | 'failed'
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
    body: { type: String, required: true },
    status: { type: String, enum: ['sent', 'failed'], default: 'sent' },
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

export const EmailLog = model<IEmailLog>('EmailLog', emailLogSchema)
