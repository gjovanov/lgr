import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

/**
 * FR-25 R3 (2026-11-25): the accountant's unit cost for a goods group from a business day on. The shadow's cost of
 * sales is the group's daily average, replayed from the books (`services/biz/accounting-books/group-cost.ts`); an
 * override restates that average at the start of its day, for a write-off or another loss the average does not show.
 *
 * Kept in the HOME of a split (R7), which holds the books' opening and purchases: every org of the split costs a group
 * by its path, and a company has one average a group. `analyticId` is the home's analytic, and its path is read when the
 * replay runs, so an override follows its group.
 */
export interface IGroupCostOverride extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  /** An analytic of kind `goods_group` of the org. */
  analyticId: Types.ObjectId
  /** The business day it applies from, at UTC midnight. */
  from: Date
  /** EUR a unit of the group. */
  unitCost: number
  /** Why: the write-off, loss or revaluation it stands for. */
  reason: string
  createdBy: Types.ObjectId
  updatedBy?: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const groupCostOverrideSchema = new Schema<IGroupCostOverride>(
  {
    analyticId: { type: Schema.Types.ObjectId, ref: 'AccountingAnalytic', required: true },
    from: { type: Date, required: true },
    unitCost: { type: Number, required: true, min: 0 },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
)

groupCostOverrideSchema.plugin(tenantPlugin)
// One unit a group and day: the replay restates the average once at the start of a day.
groupCostOverrideSchema.index({ orgId: 1, analyticId: 1, from: 1 }, { unique: true })
groupCostOverrideSchema.index({ orgId: 1, from: 1 })

replicate(groupCostOverrideSchema, { class: 'R' })

export const GroupCostOverride = model<IGroupCostOverride>('GroupCostOverride', groupCostOverrideSchema)
