import { Schema, model, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * A document of a master's page that global could not write into its mirror (FR-20.65, plan step
 * P3-2c): set aside, so the rest of the page applies and the org's mirror goes on, instead of the page
 * being refused or failing for ever. Global's own (node state), like `mirror_state`.
 *
 * - **Why one is set aside** (`reason`): `foreign_collision`, an id or a unique key another org holds
 *   (that org's document is never touched, FR-20.66); `write_error`, the database refused the write.
 * - **One per document**, kept `open` until a page writes the document: the master is asked to send
 *   it again with the org's page acknowledgements, ever less often (`attempts`, `retryAt`), so a
 *   conflict someone resolves heals by itself. A person sees the open ones on the Servers page.
 * - The isolation refusals of FR-20.66 (another org's row, a collection that does not replicate, a
 *   file outside the org) still refuse the whole page: those are not one document's trouble.
 */
export interface IMirrorDeadLetter {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  nodeId: string
  coll: string
  /** The document's `_id`, with its BSON type. */
  docId: unknown
  reason: 'foreign_collision' | 'write_error'
  detail?: string
  /** The page that brought it, last time. */
  page: { fromSeq: number; toSeq: number; journalEpoch: number }
  status: 'open' | 'resolved'
  /** Times it was set aside. */
  attempts: number
  /** When it may be asked for again. */
  retryAt: Date
  at: Date
  resolvedAt?: Date
  updatedAt: Date
}

const deadLetterSchema = new Schema<IMirrorDeadLetter>(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    nodeId: { type: String, required: true, maxlength: 80 },
    coll: { type: String, required: true, maxlength: 100 },
    docId: { type: Schema.Types.Mixed, required: true },
    reason: { type: String, enum: ['foreign_collision', 'write_error'], required: true },
    detail: { type: String, maxlength: 500 },
    page: { fromSeq: Number, toSeq: Number, journalEpoch: Number },
    status: { type: String, enum: ['open', 'resolved'], default: 'open' },
    attempts: { type: Number, default: 1 },
    retryAt: { type: Date, required: true },
    at: { type: Date, required: true },
    resolvedAt: Date,
  },
  { timestamps: { createdAt: false, updatedAt: true }, collection: 'mirror_dead_letters' },
)
deadLetterSchema.index({ orgId: 1, coll: 1, docId: 1 }, { unique: true })
deadLetterSchema.index({ orgId: 1, status: 1, retryAt: 1 })

replicate(deadLetterSchema, { class: 'N' })

export const MirrorDeadLetter = model<IMirrorDeadLetter>('MirrorDeadLetter', deadLetterSchema)
