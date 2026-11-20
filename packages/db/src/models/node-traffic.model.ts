import { Schema, model, type Document } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * What a registered master sent global, per day, per link level and per channel (FR-20.54, AC 26).
 * Global only, global's own record of a node: no tenant plugin, no org.
 *
 * A row counts one kind of message: an uplink frame by its type (`ping`, `health`, a mirror `page`,
 * a tunnel's data), or a call to `/api/node/v1/*` by its route (`POST /relay/mail`). It is counted
 * when global receives it, whatever global then answered: a page global refused was still sent.
 * `carries` says what that kind of message holds, so the record answers AC 26's question, "did a
 * master linked at Control send anything but control messages?", without reading a single payload:
 * - `control`: the link itself (hello, pings, health, updates, licences, identity, org state);
 * - `mail`, `documents`: a relayed service the org turned on (FR-20.59), with the org's data in it;
 * - `mirror`, `tunnel`, `move`: the org's data at Full (pages and files, remote users, a move);
 * - `unknown`: anything not on the list, counted as data until someone says otherwise.
 *
 * ⚠ The level is the one global held for the node when the message arrived, so a server moved from
 * Full to Control keeps the two apart on the same day.
 */
export const TRAFFIC_CHANNELS = ['interactive', 'bulk', 'http'] as const
export type TrafficChannel = (typeof TRAFFIC_CHANNELS)[number]
export const TRAFFIC_CARRIES = ['control', 'mail', 'documents', 'mirror', 'tunnel', 'move', 'unknown'] as const
export type TrafficCarries = (typeof TRAFFIC_CARRIES)[number]

export interface INodeTraffic extends Omit<Document, '_id'> {
  /** `<nodeId>|<day>|<level>|<channel>|<kind>`. */
  _id: string
  nodeId: string
  /** The UTC day it arrived on, `YYYY-MM-DD`. */
  day: string
  /** The node's link level on global when it arrived. */
  level: string
  channel: TrafficChannel
  /** The frame's type, `page`, `blob`, `tun`, or the route (`POST /relay/mail`); `other` when unknown. */
  kind: string
  carries: TrafficCarries
  /** How many arrived. */
  n: number
  /** Their size as received: a frame's bytes, a request's declared body. */
  bytes: number
  firstAt: Date
  lastAt: Date
}

const nodeTrafficSchema = new Schema<INodeTraffic>(
  {
    _id: { type: String, required: true, maxlength: 200 },
    nodeId: { type: String, required: true },
    day: { type: String, required: true },
    level: { type: String, required: true },
    channel: { type: String, enum: TRAFFIC_CHANNELS, required: true },
    kind: { type: String, required: true, maxlength: 80 },
    carries: { type: String, enum: TRAFFIC_CARRIES, required: true },
    n: { type: Number, default: 0 },
    bytes: { type: Number, default: 0 },
    firstAt: { type: Date, required: true },
    lastAt: { type: Date, required: true },
  },
  { collection: 'node_traffic' },
)

nodeTrafficSchema.index({ nodeId: 1, day: 1 })
/** Kept 90 days after a row last grew. */
nodeTrafficSchema.index({ lastAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 })

replicate(nodeTrafficSchema, { class: 'N' })

export const NodeTraffic = model<INodeTraffic>('NodeTraffic', nodeTrafficSchema)
