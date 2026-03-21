import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IProjectTask extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  projectId: Types.ObjectId
  name: string
  description?: string
  stageName: string               // Matches a project stage name
  state: string                    // open, in_progress, done, cancelled
  priority: string                 // low, normal, high, urgent
  assigneeIds: Types.ObjectId[]
  parentTaskId?: Types.ObjectId    // Subtask support
  dependencyIds: Types.ObjectId[]  // Task dependencies (for Gantt)
  dateDeadline?: Date
  dateStart?: Date
  dateEnd?: Date
  plannedHours: number
  effectiveHours: number           // Computed from timesheets
  remainingHours: number           // Computed: planned - effective
  milestoneId?: Types.ObjectId
  tags?: string[]
  isRecurring: boolean
  recurringInterval?: number
  recurringPeriod?: string         // day, week, month
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const projectTaskSchema = new Schema<IProjectTask>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    name: { type: String, required: true },
    description: String,
    stageName: { type: String, required: true, default: 'To Do' },
    state: {
      type: String,
      required: true,
      default: 'open',
      enum: ['open', 'in_progress', 'done', 'cancelled'],
    },
    priority: {
      type: String,
      default: 'normal',
      enum: ['low', 'normal', 'high', 'urgent'],
    },
    assigneeIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    parentTaskId: { type: Schema.Types.ObjectId, ref: 'ProjectTask' },
    dependencyIds: [{ type: Schema.Types.ObjectId, ref: 'ProjectTask' }],
    dateDeadline: Date,
    dateStart: Date,
    dateEnd: Date,
    plannedHours: { type: Number, default: 0 },
    effectiveHours: { type: Number, default: 0 },
    remainingHours: { type: Number, default: 0 },
    milestoneId: { type: Schema.Types.ObjectId, ref: 'ProjectMilestone' },
    tags: [String],
    isRecurring: { type: Boolean, default: false },
    recurringInterval: Number,
    recurringPeriod: { type: String, enum: ['day', 'week', 'month'] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

projectTaskSchema.plugin(tenantPlugin)
projectTaskSchema.index({ orgId: 1, projectId: 1, stageName: 1 })
projectTaskSchema.index({ orgId: 1, projectId: 1, state: 1 })
projectTaskSchema.index({ orgId: 1, assigneeIds: 1, state: 1 })
projectTaskSchema.index({ orgId: 1, parentTaskId: 1 })
projectTaskSchema.index({ orgId: 1, milestoneId: 1 })
projectTaskSchema.index({ orgId: 1, dateDeadline: 1 })
projectTaskSchema.index({ orgId: 1, tags: 1 })
projectTaskSchema.index({ name: 'text', description: 'text' })

export const ProjectTask = model<IProjectTask>('ProjectTask', projectTaskSchema)
