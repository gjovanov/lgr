import { Schema, model, type Document, type Types } from 'mongoose'

/**
 * FR-13.11 (#24) — one row per org per kind per day the per-org backup ran.
 *
 * ⚠ The unique `{orgId, kind, date}` index IS the lock, exactly as `DigestRun`'s is. There is
 * still no cron library, no queue and no lease primitive in this codebase, and FR-13 does not
 * add one: the scheduler claims a day by INSERTING this document, the first writer wins and
 * everyone else takes E11000 and stands down. Correct across restarts and across pods.
 *
 * ⚠ Two dates are in play and conflating them is the same bug FR-11 called out: a run is
 * CLAIMED under the day it executes (`date`) and COVERS the window ending then
 * (`coversFrom`/`coversTo`). `date` is a `YYYY-MM-DD` string in the ORG's timezone —
 * deliberately not a Date, because the whole point is "one per local calendar day".
 *
 * No `tenantPlugin`: the scheduler queries across orgs and there is no request context.
 */

export interface IBackupRunCollection {
  name: string
  count: number
  /** SHA-256 over that collection's NDJSON section, as written into the bundle. */
  sha256: string
  bytes: number
}

export interface IBackupRun extends Document {
  orgId: Types.ObjectId
  /** `full` is the whole org. `delta` is reserved — see backup-bundle.service.ts. */
  kind: 'full' | 'delta'
  /** Org-local `YYYY-MM-DD` the run was CLAIMED under. */
  date: string
  status: 'running' | 'completed' | 'failed'
  reason?: string
  /** Where the artifact landed, relative to UPLOAD_DIR. Absent until it exists. */
  path?: string
  filename?: string
  bytes?: number
  /** SHA-256 over the COMPRESSED artifact — the manifest cannot contain its own hash. */
  sha256?: string
  collections: IBackupRunCollection[]
  documentCount: number
  coversFrom?: Date
  coversTo?: Date
  /** Whether the daily mail carried the payload, and if not, why not (FR-13.18). */
  emailed?: boolean
  emailSkippedReason?: string
  startedAt: Date
  completedAt?: Date
  durationMs?: number
  createdAt: Date
  updatedAt: Date
}

const backupRunSchema = new Schema<IBackupRun>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    kind: { type: String, required: true, enum: ['full', 'delta'], default: 'full' },
    date: { type: String, required: true },
    status: { type: String, required: true, default: 'running', enum: ['running', 'completed', 'failed'] },
    reason: String,
    path: String,
    filename: String,
    bytes: Number,
    sha256: String,
    collections: [
      {
        name: { type: String, required: true },
        count: { type: Number, required: true },
        sha256: { type: String, required: true },
        bytes: { type: Number, required: true },
      },
    ],
    documentCount: { type: Number, default: 0 },
    coversFrom: Date,
    coversTo: Date,
    emailed: Boolean,
    emailSkippedReason: String,
    startedAt: { type: Date, required: true, default: Date.now },
    completedAt: Date,
    durationMs: Number,
  },
  { timestamps: true },
)

/** The claim. Nothing else enforces "once per org per kind per day". */
backupRunSchema.index({ orgId: 1, kind: 1, date: 1 }, { unique: true })
/** The history endpoint reads newest-first per org. */
backupRunSchema.index({ orgId: 1, startedAt: -1 })

export const BackupRun = model<IBackupRun>('BackupRun', backupRunSchema)
