import { Schema, model, type Document, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * FR-20.86 (plan step P2-6) — a master's outbound work, queued until it can leave: today the mail
 * that global sends on the master's behalf (FR-20.59). Master only.
 *
 * - **A deterministic id** where the work has one (`digest:<orgId>:<date>:<userId>`): enqueueing the
 *   same work twice keeps one item, so a re-run digest queues nothing. Ad-hoc mail gets a random one.
 * - **Each item leaves once.** Global keeps a receipt per `(node, id)` for 7 days, so an item retried
 *   after an answer that never arrived is not sent again.
 * - ⚠ NODE STATE (`home/node-state.ts`), never the org's data: restored on another node, a queued
 *   mail would leave twice.
 */
export const OUTBOX_KINDS = ['mail'] as const
export type OutboxKind = (typeof OUTBOX_KINDS)[number]
export const OUTBOX_STATES = ['queued', 'sending', 'sent', 'failed'] as const
export type OutboxState = (typeof OUTBOX_STATES)[number]

export interface IOutbox extends Omit<Document, '_id'> {
  _id: string
  orgId: Types.ObjectId
  kind: OutboxKind
  /** What the relay sends. A mail's attachments are base64 here, and capped (`config.relay`). */
  payload: Record<string, unknown>
  state: OutboxState
  attempts: number
  nextAt: Date
  /** While `sending`: a worker holds it until then. A crashed worker's item is taken again after. */
  leaseUntil?: Date
  lastError?: string
  doneAt?: Date
  createdAt: Date
  updatedAt: Date
}

const outboxSchema = new Schema<IOutbox>(
  {
    _id: { type: String, required: true, maxlength: 200 },
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    kind: { type: String, enum: OUTBOX_KINDS, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    state: { type: String, enum: OUTBOX_STATES, default: 'queued' },
    attempts: { type: Number, default: 0 },
    nextAt: { type: Date, required: true },
    leaseUntil: Date,
    lastError: { type: String, maxlength: 1000 },
    doneAt: Date,
  },
  { timestamps: true, collection: 'outbox', minimize: false },
)

outboxSchema.index({ state: 1, nextAt: 1 })

replicate(outboxSchema, { class: 'N' })

export const Outbox = model<IOutbox>('Outbox', outboxSchema)
