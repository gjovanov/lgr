import { Schema, model, type Document, type Types } from 'mongoose'

/**
 * FR-11.4 (#21) — one row per org per org-local day the daily digest ran.
 *
 * ⚠ The unique `{orgId, date}` index IS the lock. There is no lease primitive, no queue and
 * no cron in this codebase, so the scheduler claims a day by INSERTING this document: the
 * first tick (or pod) to insert wins, everyone else takes a duplicate-key error and skips.
 * That survives restarts and generalises to replicas for free, which a module-level boolean
 * would not.
 *
 * `date` is a `YYYY-MM-DD` string in the ORG's timezone, deliberately not a Date: the whole
 * point is "one per local calendar day", and a Date would drag UTC offsets back in.
 *
 * `BackgroundTask` was considered and rejected — it requires a `userId` (this job has no
 * user) and carries a 7-day TTL (the settings card wants to show the last run indefinitely).
 *
 * No `tenantPlugin`: the scheduler queries across orgs, and there is no request context to
 * scope from.
 */

export interface IDigestRunRecipient {
  email: string
  userId?: Types.ObjectId
  ok: boolean
  error?: string
}

export interface IDigestRun extends Document {
  orgId: Types.ObjectId
  /** Org-local `YYYY-MM-DD`. */
  date: string
  status: 'running' | 'sent' | 'partial' | 'failed' | 'skipped'
  /** Why a run was skipped or failed — `email_not_configured`, `no_recipients`, … */
  reason?: string
  recipients: IDigestRunRecipient[]
  startedAt: Date
  /** Absent while the run is in flight; the stale-claim takeover keys on that. */
  completedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const digestRunSchema = new Schema<IDigestRun>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    date: { type: String, required: true },
    status: {
      type: String,
      required: true,
      default: 'running',
      enum: ['running', 'sent', 'partial', 'failed', 'skipped'],
    },
    reason: String,
    recipients: [
      {
        email: { type: String, required: true },
        userId: { type: Schema.Types.ObjectId, ref: 'User' },
        ok: { type: Boolean, required: true },
        error: String,
      },
    ],
    startedAt: { type: Date, required: true, default: Date.now },
    completedAt: Date,
  },
  { timestamps: true },
)

/** The claim. Nothing else enforces "once per day". */
digestRunSchema.index({ orgId: 1, date: 1 }, { unique: true })
/** The settings card reads the latest run per org. */
digestRunSchema.index({ orgId: 1, startedAt: -1 })

export const DigestRun = model<IDigestRun>('DigestRun', digestRunSchema)
