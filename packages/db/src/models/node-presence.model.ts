import { Schema, model, type Document, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * Which process holds a registered master's uplink socket, per channel (FR-20.52, plan step P2-2a).
 * Global only, global's own state: no tenant plugin, no org.
 *
 * ⚠ One row per `(nodeId, channel)`, and the unique index is what detects a clone (FR-20.8,
 * FR-20.51). The same supervisor reconnecting carries the same `bootNonce` and takes its own row
 * over; a second LIVE connection with another `bootNonce` cannot insert one, and that is the alarm.
 */

export const UPLINK_CHANNELS = ['interactive', 'bulk'] as const
export type UplinkChannel = (typeof UPLINK_CHANNELS)[number]

export interface INodePresence extends Document {
  _id: Types.ObjectId
  nodeId: string
  channel: UplinkChannel
  /** This socket, among every socket of every pod. */
  connId: string
  /** The supervisor's per-boot nonce: the same across its reconnects, never across machines. */
  bootNonce: string
  /** Which global process holds the socket (its hostname), for the status page. */
  podId: string
  connectedAt: Date
  heartbeatAt: Date
  /** Set when a second live connection with another boot nonce tried to take this one's place. */
  clone?: { bootNonce: string; at: Date }
  createdAt: Date
}

const presenceSchema = new Schema<INodePresence>(
  {
    nodeId: { type: String, required: true },
    channel: { type: String, enum: UPLINK_CHANNELS, required: true },
    connId: { type: String, required: true },
    bootNonce: { type: String, required: true },
    podId: { type: String, required: true },
    connectedAt: { type: Date, required: true },
    heartbeatAt: { type: Date, required: true },
    clone: { bootNonce: String, at: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'node_presence' },
)

presenceSchema.index({ nodeId: 1, channel: 1 }, { unique: true })
/** A floor, not the liveness rule (75 s, checked by date): a row a crashed pod left goes in 5 minutes. */
presenceSchema.index({ heartbeatAt: 1 }, { expireAfterSeconds: 300 })

replicate(presenceSchema, { class: 'N' })

export const NodePresence = model<INodePresence>('NodePresence', presenceSchema)
