import { Schema, model, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * An org changing home (FR-20.79–20.81, plan step P3-6, Part A.6.9): global's own record, step by
 * step. Node state: never in a bundle, never mirrored.
 *
 * `to_master` (P3-6a) runs preflight → freezing → copying → verifying → flipped → done, or ends
 * `aborted`. Until `flipped`, an abort unfreezes global and nothing else changed; after it, only a
 * move back or a promotion changes the home again.
 *
 * `to_global` (P3-6c, FR-20.80) reuses the states with the master as the one that freezes:
 * `freezing` (asked; the master freezes the org and waits until its last writes are captured),
 * `copying` (the mirror drains: pages up to the master's journal head, every file, then equal
 * digests), `verifying` (equal: global puts the files back where their rows say), then `done` (the
 * flip: global is the home again). Until the flip, an abort unfreezes the org on the master.
 *
 * `reseed` (P3-7, FR-20.71) replaces a master's copy of the org whose database went back with the
 * mirror's: `copying` (global builds the copy from its mirror; the master freezes the org, keeps what
 * it replaces, replaces it) → `verifying` (its digests equal the copy's) → `done` (the mirror's chain
 * starts again from the master's copy). The home and its epoch never change.
 */
export type OrgMoveKind = 'to_master' | 'to_global' | 'promote' | 'reseed'
export type OrgMoveState = 'freezing' | 'copying' | 'verifying' | 'flipped' | 'done' | 'aborted'
export const LIVE_MOVE_STATES: readonly OrgMoveState[] = ['freezing', 'copying', 'verifying', 'flipped']

export interface IOrgMoveStep {
  name: string
  at: Date
  ok: boolean
  detail?: string
}

export interface IOrgMove {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  kind: OrgMoveKind
  state: OrgMoveState
  /** The home it leaves and the one it goes to: `global` or a node id. */
  from: string
  to: string
  epochFrom: number
  epochTo: number
  startedBy: Types.ObjectId
  startedAt: Date
  /** When the freeze began: the copy waits twice the home cache's lifetime from here (FR-20.79). */
  frozenAt?: Date
  /** When a process took the copy's build: one that never finished is taken again after a lease. */
  buildingAt?: Date
  /** The copy global built, as the master downloads and checks it. */
  bundle?: { file: string; sha256: string; bytes: number; documents: number; people: number; credentials: number }
  files?: { file: string; sha256: string; bytes: number; count: number }
  /** Per collection, what global copied: the master's import must answer the same. */
  digests?: Record<string, { count: number; sha256: string }>
  /** People acknowledged as unable to sign in at the site, by the admin who started it. */
  allowMissing: Types.ObjectId[]
  /** `to_global`: files the master cannot send, acknowledged as left behind by the admin who started it. */
  allowMissingFiles?: boolean
  /** `to_global`: the master's journal head once frozen, which the mirror must reach. */
  head?: number
  journalEpoch?: number
  /** `to_global`: when the master first reported itself frozen and drained. */
  drainedAt?: Date
  /** `to_global`: what the move waits for now (`pages`, `files`, `digests`), and since when. */
  waiting?: { on: string; since: Date; detail?: string }
  /** `to_global`: when the digests were equal, and what putting the files back found. */
  verifiedAt?: Date
  /** `to_global`: when a process took the files' placement; one that never finished is taken again. */
  placingAt?: Date
  /**
   * `promote` (FR-20.81): what the admin attested, and what global saw: the master off or destroyed,
   * its tills disconnected, silent since `silenceSince`. The mirror holds the org up to `lossFrom`;
   * `fenceCutoff` is its watermark, which the master fences at if it ever comes back.
   */
  evidence?: { hardware: 'off' | 'destroyed'; tillsDisconnected: boolean; silenceSince?: Date; attestedAt: Date }
  lossFrom?: Date
  fenceCutoff?: number
  /**
   * `promote`: the master's journal epoch the cutoff counts in, from the mirror. A row of another
   * epoch was journaled again after a lost history, so whether global saw it is unknown: the fenced
   * export carries it (P3-6e).
   */
  fenceJournalEpoch?: number
  placed?: { placed: number; present: number; missing: number }
  /**
   * `reseed` (FR-20.71, P3-7): what the server held of the org before lgrai.app's copy replaced it,
   * kept on the server for good (`file`, under the org's `docs/`), and what of it the copy lacked:
   * documents only there, and the issued sales among them (their numbers, the first 50).
   */
  replaced?: { file: string; documents: number; onlyThere: number; sales: number; salesNumbers: string[] }
  steps: IOrgMoveStep[]
  error?: string
  endedAt?: Date
  updatedAt: Date
}

const stepSchema = new Schema<IOrgMoveStep>({ name: String, at: Date, ok: Boolean, detail: String }, { _id: false })

const orgMoveSchema = new Schema<IOrgMove>(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, required: true, enum: ['to_master', 'to_global', 'promote', 'reseed'] },
    state: { type: String, required: true, enum: ['freezing', 'copying', 'verifying', 'flipped', 'done', 'aborted'] },
    from: { type: String, required: true, maxlength: 80 },
    to: { type: String, required: true, maxlength: 80 },
    epochFrom: { type: Number, required: true },
    epochTo: { type: Number, required: true },
    startedBy: { type: Schema.Types.ObjectId, required: true },
    startedAt: { type: Date, required: true },
    frozenAt: Date,
    buildingAt: Date,
    bundle: { file: String, sha256: String, bytes: Number, documents: Number, people: Number, credentials: Number },
    files: { file: String, sha256: String, bytes: Number, count: Number },
    digests: Schema.Types.Mixed,
    allowMissing: { type: [Schema.Types.ObjectId], default: [] },
    allowMissingFiles: Boolean,
    head: Number,
    journalEpoch: Number,
    drainedAt: Date,
    waiting: { on: String, since: Date, detail: String },
    verifiedAt: Date,
    placingAt: Date,
    evidence: { hardware: { type: String, enum: ['off', 'destroyed'] }, tillsDisconnected: Boolean, silenceSince: Date, attestedAt: Date },
    lossFrom: Date,
    fenceCutoff: Number,
    fenceJournalEpoch: Number,
    placed: { placed: Number, present: Number, missing: Number },
    replaced: { type: new Schema({ file: String, documents: Number, onlyThere: Number, sales: Number, salesNumbers: [String] }, { _id: false }), default: undefined },
    steps: { type: [stepSchema], default: [] },
    error: { type: String, maxlength: 2000 },
    endedAt: Date,
  },
  { timestamps: { createdAt: false, updatedAt: true }, collection: 'org_moves' },
)
orgMoveSchema.index({ orgId: 1, startedAt: -1 })
// One live move per org: the claim is this index.
orgMoveSchema.index({ orgId: 1 }, { unique: true, partialFilterExpression: { state: { $in: [...LIVE_MOVE_STATES] } } })
orgMoveSchema.index({ to: 1, state: 1 })
// A master asks for its moves back to lgrai.app too.
orgMoveSchema.index({ from: 1, state: 1 })

replicate(orgMoveSchema, { class: 'N' })

export const OrgMove = model<IOrgMove>('OrgMove', orgMoveSchema)
