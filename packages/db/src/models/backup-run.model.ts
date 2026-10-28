import { Schema, model, type Document, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

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

/**
 * FR-13.59 (#24) — one row per off-site destination this run tried.
 *
 * ⚠ Recorded even when it FAILED, and that is the point. Before this the only evidence that a
 * bundle had (or had not) left the cluster was a log line, which is the same shape of silence
 * FR-13 exists to eliminate. `status` distinguishes four states that mean different things to
 * an operator, and only `reached` means a copy exists.
 */
export interface IBackupDestination {
  name: string
  /** ⚠ `reconsent_required` is separate from `failed`: it never fixes itself on a retry. */
  status: 'reached' | 'failed' | 'skipped' | 'reconsent_required'
  at: Date
  reason?: string
  /** The provider's id for the uploaded object, so a later verification can fetch it. */
  remoteId?: string
  filename?: string
  bytes?: number
  /** SHA-256 over the SEALED artifact as uploaded — not the local bundle's own hash. */
  sha256?: string
  /** Whether the artifact was read BACK and re-hashed. Undefined means it was not checked. */
  verified?: boolean
  prunedCount?: number
}

export interface IBackupRun extends Document {
  orgId: Types.ObjectId
  /** `full` is the whole org. `delta` is reserved — see backup-bundle.service.ts. */
  kind: 'full' | 'delta'
  /**
   * FR-13.29 (#24) — whether a human asked for this run, which the claim key cannot express.
   *
   * ⚠ Only two values, and the two that are missing are the interesting part. FR-13.34's
   * pre-restore SAFETY bundle and FR-13.30's UPLOADED bundle are deliberately not
   * `BackupRun`s: this collection's unique `{orgId, kind, date}` index IS the nightly claim,
   * so a safety bundle taken on a day the scheduler already ran has nowhere to sit, and
   * forcing one in would either collide or silently overwrite the night's row. Both live on
   * `RestoreRun` instead, where they belong to the restore that produced them.
   *
   * Absent on rows written before this field existed, which are all scheduled runs.
   */
  source?: 'scheduled' | 'manual'
  /**
   * Which claim this row competes for. `'scheduled'` for every run that owns the org-day —
   * the nightly one and an explicitly forced re-run of it; a value unique to the run for one
   * that owns only itself.
   *
   * ⚠ This exists because the claim and the artifact are not the same thing, and conflating
   * them cost four bundles. The unique index below IS the nightly lock, keyed on
   * `{orgId, kind, date}` — and `kind` is the full-vs-delta axis, which a manual create can
   * only ever be `full`. So every manual create for one org on one day resolved to the SAME
   * row and upserted over the last: the files were all written (the filename suffix saw to
   * that) and all but the most recent were left with no row pointing at them, invisible to
   * the history endpoint and unreachable by `runId` for a restore.
   *
   * ⚠ Worse than invisible, in one ordering. `backupTick` skips an org whose row for today
   * has a `completedAt`, so a manual `data` bundle taken in the morning marked the day done
   * and the night's SCHEDULED run never happened — a rows-only artifact silently standing in
   * for the full one nobody noticed was missing.
   *
   * Scoping the claim to `'scheduled'` keeps the lock exactly as strong as it was for the
   * runs that need it, and stops manual bundles from being in the auction at all.
   *
   * Absent on rows written before this field existed, which are all scheduled runs. They stay
   * unique under the compound index because they were already unique without this component.
   */
  claimKey?: string
  /**
   * FR-13.29 — `data` is Mongo rows only; `full` also carries the org's `docs/` bytes in a
   * sidecar artifact. Absent means `data`, which is what every run before this field was.
   */
  variant?: 'data' | 'full'
  /** The sidecar written for a `full` variant: `<UPLOAD_DIR>/<orgId>/backups/<filesFilename>`. */
  filesFilename?: string
  filesBytes?: number
  filesSha256?: string
  filesCount?: number
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
  /**
   * Off-site destinations attempted, and what happened (FR-13.59).
   *
   * ⚠ Absent or empty on a run that produced a bundle and shipped it NOWHERE — which is a
   * complete backup by Layer 2's own definition and no backup at all by FR-13's, since the
   * artifact then sits on the same node-local hostPath as the live database.
   */
  destinations?: IBackupDestination[]
  /**
   * The row outlived its artifact: retention kept N newer generations and removed this one.
   * The history and the audit trail stay; `/download` answers 410 rather than pretending.
   */
  artifactPruned?: boolean
  /**
   * How many times this org-day has been attempted.
   *
   * ⚠ A failed run deliberately leaves `completedAt` unset so the next tick can retry it —
   * otherwise one transient failure silently costs the org its whole night. This counter is
   * what keeps that retry from becoming an infinite loop on a deterministic failure, and it
   * is what the digest reports as "failed N times today".
   */
  attempts?: number
  startedAt: Date
  /**
   * Set only when a run SUCCEEDS. ⚠ A failed run leaves this null on purpose so the day stays
   * claimable — see the catch block in `backup-runner.service.ts`. Use `failedAt` to tell
   * "never finished" from "finished badly".
   */
  completedAt?: Date
  /** When the last failed attempt gave up. Independent of `completedAt`, which stays null. */
  failedAt?: Date
  durationMs?: number
  createdAt: Date
  updatedAt: Date
}

const backupRunSchema = new Schema<IBackupRun>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    kind: { type: String, required: true, enum: ['full', 'delta'], default: 'full' },
    source: { type: String, enum: ['scheduled', 'manual'] },
    claimKey: { type: String, default: 'scheduled' },
    variant: { type: String, enum: ['data', 'full'] },
    filesFilename: String,
    filesBytes: Number,
    filesSha256: String,
    filesCount: Number,
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
    destinations: [
      {
        name: { type: String, required: true },
        status: { type: String, required: true, enum: ['reached', 'failed', 'skipped', 'reconsent_required'] },
        at: { type: Date, required: true },
        reason: String,
        remoteId: String,
        filename: String,
        bytes: Number,
        sha256: String,
        verified: Boolean,
        prunedCount: Number,
      },
    ],
    artifactPruned: Boolean,
    attempts: { type: Number, default: 0 },
    startedAt: { type: Date, required: true, default: Date.now },
    completedAt: Date,
    failedAt: Date,
    durationMs: Number,
  },
  { timestamps: true },
)

/**
 * The claim. Nothing else enforces "once per org per kind per day per claimant".
 *
 * ⚠ Mongoose CREATES this index but never drops the `{orgId, kind, date}` one it replaces,
 * and while that older index survives it still rejects the second manual row of a day — the
 * exact bug `claimKey` exists to fix, still in force on any database that has ever run the
 * previous version. `scripts/migrate-backup-claim-key.ts` drops it; a fresh database needs
 * nothing.
 */
backupRunSchema.index({ orgId: 1, kind: 1, date: 1, claimKey: 1 }, { unique: true })
/** The history endpoint reads newest-first per org. */
backupRunSchema.index({ orgId: 1, startedAt: -1 })

replicate(backupRunSchema, { class: 'N' })

export const BackupRun = model<IBackupRun>('BackupRun', backupRunSchema)
