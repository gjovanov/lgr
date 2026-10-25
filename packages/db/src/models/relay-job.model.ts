import { Schema, model, type Document, type Types } from 'mongoose'

/**
 * FR-20.59 (plan step P2-6b) — a document a master asked lgrai.app to read for it: text out of a
 * PDF, an AI draft of a document, or AI line matching. Global only.
 *
 * Reading takes from seconds to minutes (a draft runs a model, up to 300 s), longer than a request
 * through the ingress may stay open. So the master POSTs the job and polls for it. `_id` is
 * `<nodeId>:<requestId>`: a master that re-posts the same request (its answer was lost, or global
 * restarted mid-job) gets the same job, never a second model run for one document.
 *
 * - The INPUT is never kept: a PDF or a document's text stays only as long as the call.
 * - `leaseUntil`: a running job past it was lost with the process that ran it; the master's next
 *   poll is told so, and its re-post runs it again.
 * - Counted per node and kind for the daily caps (`config.relay.documentsPerDay`); kept two days.
 *
 * ⚠ NODE STATE (`home/node-state.ts`), never the org's data.
 */
export type RelayJobOp = 'extract' | 'draft' | 'match-lines'

export interface IRelayJob extends Omit<Document, '_id'> {
  _id: string
  nodeId: string
  orgId: Types.ObjectId
  op: RelayJobOp
  state: 'running' | 'done' | 'failed'
  result?: unknown
  error?: string
  leaseUntil: Date
  createdAt: Date
  doneAt?: Date
}

const relayJobSchema = new Schema<IRelayJob>(
  {
    _id: { type: String, required: true, maxlength: 140 },
    nodeId: { type: String, required: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    op: { type: String, enum: ['extract', 'draft', 'match-lines'], required: true },
    state: { type: String, enum: ['running', 'done', 'failed'], required: true },
    result: { type: Schema.Types.Mixed },
    error: String,
    leaseUntil: { type: Date, required: true },
    createdAt: { type: Date, required: true, default: Date.now },
    doneAt: Date,
  },
  { collection: 'relay_jobs', minimize: false },
)

/** The daily caps count a node's jobs of one kind. */
relayJobSchema.index({ nodeId: 1, op: 1, createdAt: 1 })
relayJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2 * 24 * 3600 })

export const RelayJob = model<IRelayJob>('RelayJob', relayJobSchema)
