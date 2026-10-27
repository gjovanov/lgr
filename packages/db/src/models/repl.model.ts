import { Schema, model, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * A master's capture of its own writes (FR-20.61, plan step P3-1b, Part A.5.1): what the mirror on
 * lgrai.app will be sent. Node-local, all three: the journal of a master is never anyone else's, and
 * no org bundle carries it (`NODE_STATE_MODELS`).
 *
 * - `repl_journal`: ONE row per document, its latest change, keyed `{orgId, coll, docId}`. Not an
 *   append log: a page carries the document as it is when the page is made (FR-20.64), so only the
 *   order of changes is kept, as each org's `seq`.
 * - `repl_orgs`: per org, whether it is captured, its `seq` counter, and when it was seeded.
 * - `repl_engine`: the singleton the tailer runs under: the lease, the resume token saved with each
 *   batch, and the journal epoch, which goes up by one when history is lost (FR-20.61).
 */

export interface IReplJournal {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  coll: string
  /** The document's `_id`: an ObjectId, or a string for the few models keyed by one. */
  docId: unknown
  seq: number
  op: 'upsert' | 'delete'
  /** The top-level fields an update touched; empty for an insert, a replace or a seed. */
  changedFields: string[]
  /** When the change was committed (the change event's cluster time); the seed's own time for a seed. */
  clusterTime: Date
  journalEpoch: number
  updatedAt: Date
}

const journalSchema = new Schema<IReplJournal>(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    coll: { type: String, required: true, maxlength: 100 },
    docId: { type: Schema.Types.Mixed, required: true },
    seq: { type: Number, required: true },
    op: { type: String, enum: ['upsert', 'delete'], required: true },
    changedFields: { type: [String], default: [] },
    clusterTime: { type: Date, required: true },
    journalEpoch: { type: Number, required: true },
  },
  { timestamps: { createdAt: false, updatedAt: true }, collection: 'repl_journal', minimize: false },
)
journalSchema.index({ orgId: 1, coll: 1, docId: 1 }, { unique: true })
journalSchema.index({ orgId: 1, seq: 1 })
// ⚠ A delete is routed by its pre-image or, without one, by the row it already has (FR-20.61).
journalSchema.index({ coll: 1, docId: 1 })

replicate(journalSchema, { class: 'N' })

export const ReplJournal = model<IReplJournal>('ReplJournal', journalSchema)

export interface IReplOrg {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  enabled: boolean
  /** The last seq handed out: the next change of this org is `seq + 1`. */
  seq: number
  /** When every existing document was last journaled: the first enable, or the latest history loss. */
  seededAt?: Date
  seededEpoch?: number
  /**
   * The pages this master built (FR-20.64), newest last: where each ends and the chain hash after it.
   * ⚠ Only ever its own. Global tells the master its watermark and hash, and the master continues
   * only from a page it finds here: a restored, reverted or cloned master does not have the page
   * global holds, so it cannot continue that chain (FR-20.51). The newest 32 are kept, and always
   * the one global last said it stands on (P3-7): retries while global cannot apply must not push it out.
   */
  pages: Array<{ toSeq: number; hash: string; at: Date }>
  /**
   * FR-20.51, FR-20.71 (P3-7): this database cannot continue lgrai.app's copy of the org: the mirror
   * holds pages it never built (`mirror_ahead`), or refuses its history (`instance_changed`,
   * `stale_journal`, `diverged`). Set ONCE, at the first sign, and legal numbering locks with it;
   * kept until the org is re-seeded from the mirror, so a sign seen again after a person recorded the
   * numbers never locks again. ⚠ A database restored with an older copy of this row has none: the
   * restore is then seen afresh, which is what it is.
   */
  wentBack?: { at: Date; reason: string; detail?: string }
  /**
   * FR-20.70 (P3-7): the journal epoch at which lgrai.app's copy was last made equal to this one. Set
   * at the org's first seeding; after lost history the epoch moves past it, and the reconcile runs
   * until it catches up. Absent means 1, the epoch every master starts at.
   */
  reconciledEpoch?: number
  /**
   * The reconcile under way: lgrai.app's ids of the org, asked for page by page and journaled again
   * here, each as it is now or as gone. `after` is where the next page starts (absent: from the
   * beginning), so a restart goes on from there.
   */
  reconcile?: { journalEpoch: number; coll?: string; after?: unknown; asked: number; startedAt: Date }
  updatedAt: Date
}

const orgSchema = new Schema<IReplOrg>(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    enabled: { type: Boolean, default: true },
    seq: { type: Number, default: 0 },
    seededAt: Date,
    seededEpoch: Number,
    pages: { type: [{ _id: false, toSeq: Number, hash: String, at: Date }], default: [] },
    wentBack: { type: new Schema({ at: Date, reason: String, detail: String }, { _id: false }), default: undefined },
    reconciledEpoch: Number,
    reconcile: {
      type: new Schema({ journalEpoch: Number, coll: String, after: Schema.Types.Mixed, asked: Number, startedAt: Date }, { _id: false }),
      default: undefined,
    },
  },
  { timestamps: { createdAt: false, updatedAt: true }, collection: 'repl_orgs' },
)
orgSchema.index({ orgId: 1 }, { unique: true })

replicate(orgSchema, { class: 'N' })

export const ReplOrg = model<IReplOrg>('ReplOrg', orgSchema)

export interface IReplEngine {
  _id: string
  /** Who tails: one process per master (`<pid>@<host>:<start>`), renewed every 5 s, gone after 15. */
  holder?: string
  heartbeatAt?: Date
  /** The change stream's resume token, saved in the same transaction as the batch it ends. */
  resumeToken?: unknown
  journalEpoch: number
  /** Why the epoch last went up. */
  epochReason?: string
  epochAt?: Date
  lastBatchAt?: Date
  lastEventAt?: Date
  updatedAt: Date
}

const engineSchema = new Schema<IReplEngine>(
  {
    _id: { type: String, required: true },
    holder: String,
    heartbeatAt: Date,
    resumeToken: Schema.Types.Mixed,
    journalEpoch: { type: Number, default: 1 },
    epochReason: String,
    epochAt: Date,
    lastBatchAt: Date,
    lastEventAt: Date,
  },
  { timestamps: { createdAt: false, updatedAt: true }, collection: 'repl_engine', minimize: false },
)

replicate(engineSchema, { class: 'N' })

export const ReplEngine = model<IReplEngine>('ReplEngine', engineSchema)
