import { Schema, model, type Document, type Types } from 'mongoose'

/**
 * FR-13.31–13.37 (#24) — one row per restore ATTEMPT, including the ones that wrote nothing.
 *
 * ⚠ An Inspect is a row too, and that is load-bearing rather than tidy. FR-13.33 requires
 * Inspect to have been run and shown before any writing mode may be selected, so the apply
 * call names an `inspectionId` — this row's `_id`. Without a persisted inspection there is
 * nothing for "Inspect must have run first" to mean across two HTTP requests, two pods, or a
 * page reload.
 *
 * ⚠ No `tenantPlugin`. A restore is a system-administrator act performed AGAINST an org, and
 * remap (FR-13.32) legitimately spans two of them: the row records `manifestOrgId` — where
 * the bytes came from — separately from `orgId`, where they landed. A tenant pre-hook that
 * silently scoped these queries would hide precisely the cross-org case the operator needs to
 * see.
 *
 * The row is also the restore REPORT: every clamped sequence, every dangling file reference
 * and every rollback is recorded here, because FR-13.35 and FR-13.37 both require the
 * operator to be told what happened, and a log line is not being told.
 */

/** One collection's diff (Inspect) or outcome (Merge/Replace). */
export interface IRestoreCollectionResult {
  /** Mongoose model name, as the bundle records it. */
  name: string
  /** Documents this collection has in the bundle. */
  inBundle: number
  /** Documents the LIVE org has in it right now. */
  inLive: number
  /** In the bundle and absent from live — what a Merge would insert. */
  missing: number
  /** Present in both, `_id` for `_id`, but not byte-identical. ⚠ Merge never touches these. */
  differing: number
  /** Written by this run. Always 0 for an Inspect. */
  inserted?: number
  /** Removed by this run. Only ever non-zero for a Replace. */
  deleted?: number
  /** Skipped because live already had the `_id`. */
  skipped?: number
}

/**
 * FR-13.35 — a sequence this restore refused to move backwards, and by how much.
 *
 * ⚠ Every row here is a fiscal defect that did NOT happen. Restoring a bundle whose
 * `Sequence.lastNumber` is lower than live would reissue invoice numbers already in
 * customers' hands and break the per-family numbering continuity the NRA expects (and that
 * FR-11's digest checks). The clamp is `max(live, bundle)` and it is never optional; this
 * list exists so the operator learns the bundle was stale rather than silently benefiting.
 */
export interface IRestoreSequenceClamp {
  prefix: string
  year: number
  /** What live was at, and what the restore left it at — identical when the bundle was behind. */
  live: number
  bundle: number
  kept: number
}

export interface IRestoreRun extends Document {
  _id: Types.ObjectId
  /** The org being restored INTO. */
  orgId: Types.ObjectId
  /** The org the bundle was taken FROM. Differs from `orgId` only on a remap (FR-13.32). */
  manifestOrgId?: string
  mode: 'inspect' | 'merge' | 'replace'
  status: 'running' | 'completed' | 'failed' | 'rolled_back'
  /** Where the bytes came from. `upload` bundles live in a staging directory, not the org's. */
  source: { type: 'run' | 'path' | 'upload'; runId?: string; path?: string; filename?: string }
  /** SHA-256 over the compressed artifact, as verified before any write (FR-13.31). */
  bundleSha256?: string
  bundleDate?: string
  bundleKind?: string
  /** The image tag that PRODUCED the bundle. A bundle newer than the running code is refused. */
  bundleAppImageTag?: string
  runningAppImageTag?: string
  /** The Inspect this apply was authorised by (FR-13.33). Absent on an Inspect itself. */
  inspectionId?: Types.ObjectId
  /** True when the operator asked for `orgId` rewriting; a cross-org restore is refused without it. */
  remap?: boolean
  collections: IRestoreCollectionResult[]
  documentsInserted: number
  documentsDeleted: number
  sequenceClamps: IRestoreSequenceClamp[]
  /**
   * FR-13.37 — `DocFile` rows restored whose bytes are not on the PV.
   *
   * A `data` bundle carries rows, never files. Restoring one reinstates the document INDEX
   * without the documents, and saying so plainly is a requirement: the UI must not let an
   * operator believe the PDFs came back.
   */
  danglingFiles: string[]
  danglingFileCount: number
  /**
   * FR-13.34 — the mandatory pre-restore safety bundle, recorded HERE rather than as a
   * `BackupRun`.
   *
   * ⚠ It cannot be a `BackupRun`: that collection's unique `{orgId, kind, date}` index is the
   * nightly claim, so a safety bundle taken on a day the scheduler has already run would
   * collide with, or overwrite, the night's own row. It also should not be pruned by the
   * nightly retention, which is why it is written to `backups/safety/` — a subdirectory
   * `pruneBundles` does not walk. It is the copy an operator wants MOST after a restore goes
   * wrong, and generation counting knows nothing about that.
   *
   * `safetyPath` is relative to `UPLOAD_DIR`, matching `BackupRun.path`.
   */
  safetyPath?: string
  safetyFilename?: string
  safetyBytes?: number
  safetyDocumentCount?: number
  safetySha256?: string
  /** Set when a part-way failure was undone from the safety bundle (FR-13.34). */
  rolledBack?: boolean
  rollbackDetail?: string
  /** Non-fatal observations: an older bundle, a `differing` count Merge left alone, and so on. */
  warnings: string[]
  error?: string
  /** Who did it. A restore always has a human actor — the scheduler never restores. */
  actorUserId?: Types.ObjectId
  actorEmail?: string
  startedAt: Date
  completedAt?: Date
  durationMs?: number
  createdAt: Date
  updatedAt: Date
}

const collectionResultSchema = new Schema<IRestoreCollectionResult>(
  {
    name: { type: String, required: true },
    inBundle: { type: Number, default: 0 },
    inLive: { type: Number, default: 0 },
    missing: { type: Number, default: 0 },
    differing: { type: Number, default: 0 },
    inserted: Number,
    deleted: Number,
    skipped: Number,
  },
  { _id: false },
)

const sequenceClampSchema = new Schema<IRestoreSequenceClamp>(
  {
    prefix: { type: String, required: true },
    year: { type: Number, required: true },
    live: { type: Number, required: true },
    bundle: { type: Number, required: true },
    kept: { type: Number, required: true },
  },
  { _id: false },
)

const restoreRunSchema = new Schema<IRestoreRun>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    manifestOrgId: String,
    mode: { type: String, required: true, enum: ['inspect', 'merge', 'replace'] },
    status: { type: String, required: true, default: 'running', enum: ['running', 'completed', 'failed', 'rolled_back'] },
    source: {
      type: { type: String, required: true, enum: ['run', 'path', 'upload'] },
      runId: String,
      path: String,
      filename: String,
    },
    bundleSha256: String,
    bundleDate: String,
    bundleKind: String,
    bundleAppImageTag: String,
    runningAppImageTag: String,
    inspectionId: { type: Schema.Types.ObjectId, ref: 'RestoreRun' },
    remap: Boolean,
    collections: [collectionResultSchema],
    documentsInserted: { type: Number, default: 0 },
    documentsDeleted: { type: Number, default: 0 },
    sequenceClamps: [sequenceClampSchema],
    // Capped where it is written, not here — the operator needs a sample and a count, not a
    // list that can hold 737k paths.
    danglingFiles: [String],
    danglingFileCount: { type: Number, default: 0 },
    safetyPath: String,
    safetyFilename: String,
    safetyBytes: Number,
    safetyDocumentCount: Number,
    safetySha256: String,
    rolledBack: Boolean,
    rollbackDetail: String,
    warnings: [String],
    error: String,
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorEmail: String,
    startedAt: { type: Date, required: true, default: Date.now },
    completedAt: Date,
    durationMs: Number,
  },
  { timestamps: true },
)

/** The screen and the digest both read newest-first per org. */
restoreRunSchema.index({ orgId: 1, startedAt: -1 })

export const RestoreRun = model<IRestoreRun>('RestoreRun', restoreRunSchema)
