import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IProjectTimesheet extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  employeeId: Types.ObjectId
  projectId: Types.ObjectId
  taskId?: Types.ObjectId
  date: Date
  hours: number
  description?: string
  unitAmount: number              // Cost = hours × employee hourly rate
  externalId?: string
  externalSource?: string         // 'tickytack' | 'jira'
  createdAt: Date
  updatedAt: Date
}

const projectTimesheetSchema = new Schema<IProjectTimesheet>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    taskId: { type: Schema.Types.ObjectId, ref: 'ProjectTask' },
    date: { type: Date, required: true },
    hours: { type: Number, required: true, min: 0 },
    description: String,
    unitAmount: { type: Number, default: 0 },
    externalId: String,
    externalSource: String,
  },
  { timestamps: true },
)

projectTimesheetSchema.plugin(tenantPlugin)
projectTimesheetSchema.index({ orgId: 1, employeeId: 1, date: -1 })
projectTimesheetSchema.index({ orgId: 1, projectId: 1, date: -1 })
projectTimesheetSchema.index({ orgId: 1, taskId: 1, date: -1 })
projectTimesheetSchema.index({ orgId: 1, externalId: 1 })

export const ProjectTimesheet = model<IProjectTimesheet>('ProjectTimesheet', projectTimesheetSchema)
