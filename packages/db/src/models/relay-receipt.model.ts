import { Schema, model, type Document, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * FR-20.59, FR-20.86 (plan step P2-6) — what global relayed for a master, per `(node, outbox id)`:
 * the dedupe that lets a master retry an item whose answer never arrived without sending it twice,
 * and the count the per-server rate limits read. Global only. Kept {@link RELAY_RECEIPT_KEEP_DAYS} days:
 * longer than a master keeps an item queued (`outbox-worker.ts`, 45 days, past FR-20.60's 30-day
 * outage), so a retry after a month without the uplink still finds the receipt (AC 27). Migration
 * 0021 lengthens the window on a collection made when it was 7 days.
 *
 * A receipt is written BEFORE the send (`sending`) and marked `sent` after it. A failed send removes
 * it, so the master's retry goes out. One still `sending` after 10 minutes is a send whose outcome
 * nobody knows (a crash mid-call): it answers as sent, uncertain, rather than risk a second copy.
 *
 * ⚠ NODE STATE (`home/node-state.ts`), never the org's data.
 */
export interface IRelayReceipt extends Omit<Document, '_id'> {
  _id: string
  nodeId: string
  orgId: Types.ObjectId
  kind: 'mail'
  state: 'sending' | 'sent'
  at: Date
}

const relayReceiptSchema = new Schema<IRelayReceipt>(
  {
    _id: { type: String, required: true, maxlength: 260 },
    nodeId: { type: String, required: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    kind: { type: String, enum: ['mail'], required: true },
    state: { type: String, enum: ['sending', 'sent'], required: true },
    at: { type: Date, required: true },
  },
  { collection: 'relay_receipts' },
)

/** How long a receipt is kept: the dedupe window. ⚠ Longer than the outbox's `GIVE_UP_DAYS`. */
export const RELAY_RECEIPT_KEEP_DAYS = 60

/** The rate limits count a node's sends in the last hour and day. */
relayReceiptSchema.index({ nodeId: 1, at: 1 })
/** The dedupe window. */
relayReceiptSchema.index({ at: 1 }, { expireAfterSeconds: RELAY_RECEIPT_KEEP_DAYS * 24 * 3600 })

replicate(relayReceiptSchema, { class: 'N' })

export const RelayReceipt = model<IRelayReceipt>('RelayReceipt', relayReceiptSchema)
