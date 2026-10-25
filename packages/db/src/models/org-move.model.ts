import { Schema, model, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * An org changing home (FR-20.79–20.81, plan step P3-6, Part A.6.9): global's own record, step by
 * step. Node state: never in a bundle, never mirrored.
 *
 * `to_master` (P3-6a) runs preflight → freezing → copying → verifying → flipped → done, or ends
 * `aborted`. Until `flipped`, an abort unfreezes global and nothing else changed; after it, only a
 * move back or a promotion changes the home again.
 */
export type OrgMoveKind = 'to_master' | 'to_global' | 'promote'
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
  steps: IOrgMoveStep[]
  error?: string
  endedAt?: Date
  updatedAt: Date
}

const stepSchema = new Schema<IOrgMoveStep>({ name: String, at: Date, ok: Boolean, detail: String }, { _id: false })

const orgMoveSchema = new Schema<IOrgMove>(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, required: true, enum: ['to_master', 'to_global', 'promote'] },
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

replicate(orgMoveSchema, { class: 'N' })

export const OrgMove = model<IOrgMove>('OrgMove', orgMoveSchema)
