import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IProjectMilestone extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  projectId: Types.ObjectId
  name: string
  deadline: Date
  isReached: boolean
  reachedDate?: Date
  salesOrderLineIndex?: number    // For milestone-based invoicing
  createdAt: Date
  updatedAt: Date
}

const projectMilestoneSchema = new Schema<IProjectMilestone>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    name: { type: String, required: true },
    deadline: { type: Date, required: true },
    isReached: { type: Boolean, default: false },
    reachedDate: Date,
    salesOrderLineIndex: Number,
  },
  { timestamps: true },
)

projectMilestoneSchema.plugin(tenantPlugin)
projectMilestoneSchema.index({ orgId: 1, projectId: 1 })
projectMilestoneSchema.index({ orgId: 1, deadline: 1, isReached: 1 })

export const ProjectMilestone = model<IProjectMilestone>('ProjectMilestone', projectMilestoneSchema)
