import { Schema, model, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * Where global's mirror of an org homed on a master is (FR-20.64–20.67, plan step P3-2a, Part A.5.1):
 * the last page applied, where the hash chain stands, and the epochs it was sent under.
 *
 * Global's own, outside every replicated document, so no page can overwrite it (FR-20.63). The master
 * is told the watermark and the chain hash (FR-20.67). ⚠ It may use that hash only to pick the page
 * it built itself that global holds, never as a `prevHash` it did not compute: a restored, reverted or
 * cloned master that adopted it would pass for the one whose history it no longer has (FR-20.51).
 */
export interface IMirrorAlarm {
  kind: string
  at: Date
  detail?: string
}

export interface IMirrorState {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  /** The master that sends it, and the home epoch, instance and journal epochs it sends under. */
  nodeId?: string
  epoch?: number
  /** The master's data instance (FR-20.71): a new one is a restore, refused until a re-seed (P3-7). */
  instanceEpoch?: string
  /** The master's journal epoch: a page of a newer one waits for a reconcile (FR-20.61, FR-20.70). */
  journalEpoch?: number
  /** The highest journal seq applied. */
  watermark: number
  /** The hash chain up to and including the last page applied; empty until the first. */
  chainHash: string
  lastPageAt?: Date
  /** Pages refused since the last one applied, and why the last one was. */
  refused: number
  lastRefusal?: { reason: string; at: Date; detail?: string }
  /** A newer journal epoch, waiting for a reconcile (P3-7). */
  reconcileRequired?: { journalEpoch: number; since: Date }
  /** What needs a person: a forged or foreign page, a broken chain, an unsanctioned membership. The newest 20. */
  alarms: IMirrorAlarm[]
  updatedAt: Date
}

const mirrorStateSchema = new Schema<IMirrorState>(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    nodeId: { type: String, maxlength: 80 },
    epoch: Number,
    instanceEpoch: { type: String, maxlength: 64 },
    journalEpoch: Number,
    watermark: { type: Number, default: 0 },
    chainHash: { type: String, default: '' },
    lastPageAt: Date,
    refused: { type: Number, default: 0 },
    lastRefusal: { reason: String, at: Date, detail: String },
    reconcileRequired: { journalEpoch: Number, since: Date },
    alarms: { type: [{ _id: false, kind: String, at: Date, detail: String }], default: [] },
  },
  { timestamps: { createdAt: false, updatedAt: true }, collection: 'mirror_state' },
)
mirrorStateSchema.index({ orgId: 1 }, { unique: true })

replicate(mirrorStateSchema, { class: 'N' })

export const MirrorState = model<IMirrorState>('MirrorState', mirrorStateSchema)
