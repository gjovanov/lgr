import { Schema, model, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * A file of an org homed on a master, as global's mirror holds it (FR-20.69, plan step P3-3, Part
 * A.5.1): by its content, per org.
 *
 * The bytes live at `<UPLOAD_DIR>/<orgId>/blobs/<sha256>` once `ok`, and at `<sha256>.part` while
 * they arrive. ⚠ Never where a page says (FR-20.66): the mirrored rows name paths the master chose,
 * and global reads a mirrored org's files only by `(orgId, sha256)`.
 *
 * ⚠ **Per org, never shared across orgs.** Two orgs holding the same bytes hold two rows and two
 * files. A store shared by content would let any master learn whether some other org holds a file
 * (global would stop asking for it), and let one org's row open another org's bytes.
 *
 * Global's own, outside every replicated document (class N): no page writes it, and no backup
 * carries it.
 */
export const MIRROR_BLOB_STATES = ['wanted', 'partial', 'ok'] as const
export type MirrorBlobState = (typeof MIRROR_BLOB_STATES)[number]

export interface IMirrorBlob {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  /** Lower-case hex SHA-256 of the whole file: its name on disk, so it is checked before any use. */
  sha256: string
  /** The file's size in bytes, as the master's first chunk said. Unknown until then. */
  size?: number
  state: MirrorBlobState
  /** Bytes held so far. The master resumes from here. */
  offset: number
  /** `master` when its chunks came over the uplink; `local` when global already held the bytes from before a move. */
  source?: 'master' | 'local'
  /** The master that sent it. */
  nodeId?: string
  /** Transfers that ended in a bad file, or the master could not read it. */
  failures: number
  lastError?: { reason: string; at: Date; detail?: string }
  /** Not asked for again before this (a file the master cannot read, a transfer that keeps failing). */
  retryAt?: Date
  completedAt?: Date
  updatedAt: Date
}

const mirrorBlobSchema = new Schema<IMirrorBlob>(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    sha256: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    size: { type: Number, min: 0 },
    state: { type: String, enum: MIRROR_BLOB_STATES, required: true, default: 'wanted' },
    offset: { type: Number, default: 0, min: 0 },
    source: { type: String, enum: ['master', 'local'] },
    nodeId: { type: String, maxlength: 80 },
    failures: { type: Number, default: 0 },
    lastError: { reason: String, at: Date, detail: String },
    retryAt: Date,
    completedAt: Date,
  },
  { timestamps: { createdAt: false, updatedAt: true }, collection: 'mirror_blobs' },
)
mirrorBlobSchema.index({ orgId: 1, sha256: 1 }, { unique: true })
mirrorBlobSchema.index({ orgId: 1, state: 1 })

replicate(mirrorBlobSchema, { class: 'N' })

export const MirrorBlob = model<IMirrorBlob>('MirrorBlob', mirrorBlobSchema)
