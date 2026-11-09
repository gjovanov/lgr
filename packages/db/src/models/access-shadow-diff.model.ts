import { Schema, model, type Document, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * FR-27 §4 step 2 (#529) — where an org in `shadow` would be answered differently by the new evaluator: one row
 * per org, day, route and answer pair, with a count (`services/biz/access/shadow.ts`).
 *
 * Counts only: a route pattern, a method, the caller's role and the two answers. No business data, no ids from
 * the URL. ⚠ `org`, not `orgId`: a diagnostic of this node, so per-org backups and the mirror leave it out.
 * Rows expire after 30 days.
 */
export interface IAccessShadowDiff extends Document {
  _id: Types.ObjectId
  org: Types.ObjectId
  day: string
  method: string
  route: string
  role: string
  legacy: 'allow' | 'refuse'
  evaluator: 'allow' | 'refuse'
  count: number
  lastAt: Date
}

const accessShadowDiffSchema = new Schema<IAccessShadowDiff>(
  {
    org: { type: Schema.Types.ObjectId, required: true },
    day: { type: String, required: true },
    method: { type: String, required: true },
    route: { type: String, required: true },
    role: { type: String, required: true },
    legacy: { type: String, enum: ['allow', 'refuse'], required: true },
    evaluator: { type: String, enum: ['allow', 'refuse'], required: true },
    count: { type: Number, required: true, default: 0 },
    lastAt: { type: Date, required: true },
  },
  { collection: 'access_shadow_diffs' },
)

accessShadowDiffSchema.index({ org: 1, day: 1, method: 1, route: 1, role: 1, legacy: 1 }, { unique: true })
accessShadowDiffSchema.index({ lastAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 })

replicate(accessShadowDiffSchema, { class: 'N' })

export const AccessShadowDiff = model<IAccessShadowDiff>('AccessShadowDiff', accessShadowDiffSchema)
