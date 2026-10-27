import { Schema, model, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * What a FENCED master did after the cutoff, as it reached global (FR-20.84, plan step P3-6e): the
 * export of everything its journal captured above the promotion's `fenceCutoff`, which global keeps
 * for a person to review and, later, to import through the audited import.
 *
 * - **One per promotion** (`moveId`): the master builds it once it has fenced itself, and sends it in
 *   chunks, each at the offset global holds (`received`), so a cut link resumes where it stopped.
 * - **The bytes** live at `<UPLOAD_DIR>/<orgId>/docs/fenced/fenced-<moveId>.ndjson.zst`: under
 *   `docs/`, so the org's own backups carry them, and kept for good. ⚠ The export is the evidence the
 *   audited import keeps (Прил. 42: full, unchanged, with source and time): it is never discarded,
 *   whatever its state.
 * - **Checked when whole**: its sha256 against what the master said, then every section against the
 *   trailer's digests. A bundle that fails either is `refused`, and kept.
 *
 * Global's own, outside every replicated document (class N): no page writes it, no backup carries it.
 */
export const FENCED_EXPORT_STATES = ['receiving', 'received', 'refused'] as const
export type FencedExportState = (typeof FENCED_EXPORT_STATES)[number]

export interface FencedLegalDoc {
  coll: string
  id: string
  number?: string
  type?: string
  direction?: string
  status?: string
  issueDate?: Date
  total?: number
  currency?: string
}

export interface IFencedExport {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  /** The promotion it answers. */
  moveId: Types.ObjectId
  /** The master that was replaced, and sent it. */
  nodeId: string
  state: FencedExportState
  /** The whole bundle's size and sha256, as the master said with its first chunk. */
  size: number
  sha256: string
  /** Bytes held so far: where the master's next chunk starts. */
  received: number
  /** What the bundle says of itself, once whole and checked. */
  cutoff?: number
  journalEpoch?: number
  head?: number
  exportedAt?: Date
  summary?: {
    documents: number
    deleted: number
    files: number
    /** Documents per collection. */
    byColl: Record<string, number>
    /** The sales and invoices in it, by number: what the review lists and the import brings in. */
    legal: FencedLegalDoc[]
  }
  error?: string
  receivedAt?: Date
  /**
   * The audited import (P3-6e, second half): asked for by a person, run by global's tick in batches
   * under a lease, resumed by whichever process holds it next.
   */
  import?: {
    state: 'requested' | 'running' | 'done'
    requestedBy: Types.ObjectId
    requestedAt: Date
    leaseUntil?: Date
    startedAt?: Date
    doneAt?: Date
    /** Per outcome and reason, how many documents. */
    counts?: Record<string, number>
    error?: string
  }
  createdAt: Date
  updatedAt: Date
}

const fencedExportSchema = new Schema<IFencedExport>(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    moveId: { type: Schema.Types.ObjectId, required: true },
    nodeId: { type: String, required: true, maxlength: 80 },
    state: { type: String, enum: FENCED_EXPORT_STATES, required: true, default: 'receiving' },
    size: { type: Number, required: true, min: 1 },
    sha256: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    received: { type: Number, default: 0, min: 0 },
    cutoff: Number,
    journalEpoch: Number,
    head: Number,
    exportedAt: Date,
    summary: { type: Schema.Types.Mixed },
    error: { type: String, maxlength: 2000 },
    receivedAt: Date,
    import: {
      state: { type: String, enum: ['requested', 'running', 'done'] },
      requestedBy: Schema.Types.ObjectId,
      requestedAt: Date,
      leaseUntil: Date,
      startedAt: Date,
      doneAt: Date,
      counts: { type: Schema.Types.Mixed },
      error: { type: String, maxlength: 2000 },
    },
  },
  { timestamps: true, collection: 'fenced_exports' },
)
fencedExportSchema.index({ moveId: 1 }, { unique: true })
fencedExportSchema.index({ orgId: 1, createdAt: -1 })

replicate(fencedExportSchema, { class: 'N' })

export const FencedExport = model<IFencedExport>('FencedExport', fencedExportSchema)
