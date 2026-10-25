import { Schema, model, type Document, type Types } from 'mongoose'

/**
 * FR-20.59, FR-20.86 (plan step P2-6) — what global relayed for a master, per `(node, outbox id)`:
 * the dedupe that lets a master retry an item whose answer never arrived without sending it twice,
 * and the count the per-server rate limits read. Global only. Kept 7 days.
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

/** The rate limits count a node's sends in the last hour and day. */
relayReceiptSchema.index({ nodeId: 1, at: 1 })
/** The 7-day dedupe window. */
relayReceiptSchema.index({ at: 1 }, { expireAfterSeconds: 7 * 24 * 3600 })

export const RelayReceipt = model<IRelayReceipt>('RelayReceipt', relayReceiptSchema)
