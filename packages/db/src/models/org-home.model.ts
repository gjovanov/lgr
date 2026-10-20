import { Schema, model, type Document, type Types } from 'mongoose'

/**
 * Where an org's data is written: its HOME (FR-20.3, plan step P0b-2).
 *
 * Every org has exactly one home, the node that writes its data and allocates its numbers:
 * `global` (the cloud) or an on-prem master, by its node id. **No row means `global`, epoch 0** —
 * every org today. Nothing is backfilled.
 *
 * ⚠ What this is NOT:
 * - not `Org.settings` (FR-20 trap 16): settings are edited by org admins and restored by bundles;
 * - not in a backup bundle: `backup-bundle.service.ts` excludes it, so a Replace restore can never
 *   rewrite who is home;
 * - not tenant data: no `tenantPlugin`. It is node state about an org.
 *
 * The row changes only through a move (FR-20 §5.9, plan P3), and every change increments `epoch`.
 */
export type OrgHomeState = 'active' | 'freezing' | 'frozen' | 'fenced' | 'hold'

export interface IOrgHome extends Document {
  orgId: Types.ObjectId
  /** `global`, or the node id of the master that is home. */
  home: string
  epoch: number
  state: OrgHomeState
  since: Date
  changedBy?: string
}

const orgHomeSchema = new Schema<IOrgHome>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    home: { type: String, required: true },
    epoch: { type: Number, required: true, default: 0 },
    state: { type: String, required: true, default: 'active', enum: ['active', 'freezing', 'frozen', 'fenced', 'hold'] },
    since: { type: Date, required: true, default: Date.now },
    changedBy: String,
  },
  { collection: 'org_homes' },
)
orgHomeSchema.index({ orgId: 1 }, { unique: true })

export const OrgHome = model<IOrgHome>('OrgHome', orgHomeSchema)
