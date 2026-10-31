import { Schema, model, type Document, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * FR-24.45: which process holds a fiscal device right now, one row per `(orgId, deviceNumber)`.
 * Modeled on `node_presence` (FR-20.52). Node state: no tenant plugin, never in a bundle
 * (`NODE_STATE_MODELS`), never replicated (`N`).
 *
 * ⚠ The unique index is what decides `bridge_in_use` now. The in-memory socket map it replaces
 * cannot see a sibling pod's bridge, so with two pods two tabs could each hold "the" printer.
 *
 * - The holder heartbeats every 5 s; a row older than 20 s is dead, and anyone may take it over.
 * - The same principal reconnecting takes its own row over at once: the same `instanceId` for a
 *   browser tab, the same `desktopId` for a desktop. That includes a row a crashed pod left behind.
 * - A close deletes the row only while `connId` is still its own: a client that already reconnected
 *   elsewhere must not be marked offline by its old socket's late close.
 * - `evict` asks the holder to let go (a takeover or a revocation decided on another pod); the
 *   holder's next heartbeat acts on it.
 */

export const FISCAL_HOLDER_KINDS = ['user', 'desktop', 'server'] as const
export type FiscalHolderKind = (typeof FISCAL_HOLDER_KINDS)[number]

export interface IFiscalPresence extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  deviceNumber: string
  deviceId: Types.ObjectId
  /** `user` a browser tab (Web Serial), `desktop` an LGR Desktop, `server` a device this pod opened over TCP. */
  kind: FiscalHolderKind
  /** What the POS prints after "connected via": the desktop's name or the cashier's. */
  label: string
  userId?: string
  desktopId?: string
  /** A browser tab's own id (FR-24.49): the same across its reconnects and reloads, never across tabs. */
  instanceId?: string
  /** The process holding it (its hostname) and where other pods reach it (`tunnel/pod.ts`). */
  podId: string
  podAddr?: string
  /** This connection, among every connection of every pod. */
  connId: string
  connectedAt: Date
  heartbeatAt: Date
  evict?: { reason: string; at: Date }
}

const presenceSchema = new Schema<IFiscalPresence>(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    deviceNumber: { type: String, required: true },
    deviceId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: FISCAL_HOLDER_KINDS, required: true },
    label: { type: String, required: true },
    userId: { type: String },
    desktopId: { type: String },
    instanceId: { type: String },
    podId: { type: String, required: true },
    podAddr: { type: String },
    connId: { type: String, required: true },
    connectedAt: { type: Date, required: true },
    heartbeatAt: { type: Date, required: true },
    evict: { reason: String, at: Date },
  },
  { collection: 'fiscal_presence' },
)

presenceSchema.index({ orgId: 1, deviceNumber: 1 }, { unique: true })
presenceSchema.index({ desktopId: 1 }, { sparse: true })
/** A floor, not the liveness rule (20 s, checked by date): a row a crashed pod left goes in 5 minutes. */
presenceSchema.index({ heartbeatAt: 1 }, { expireAfterSeconds: 300 })

replicate(presenceSchema, { class: 'N' })

export const FiscalPresence = model<IFiscalPresence>('FiscalPresence', presenceSchema)
