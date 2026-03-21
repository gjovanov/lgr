import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IJobPosition extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  departmentId: Types.ObjectId
  description: string
  requirements?: string
  salaryMin?: number
  salaryMax?: number
  salaryCurrency: string
  state: string
  publishedDate?: Date
  closingDate?: Date
  expectedHires: number
  hiredCount: number
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const jobPositionSchema = new Schema<IJobPosition>(
  {
    name: { type: String, required: true },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    description: { type: String, required: true },
    requirements: String,
    salaryMin: Number,
    salaryMax: Number,
    salaryCurrency: { type: String, default: 'EUR' },
    state: {
      type: String,
      required: true,
      default: 'draft',
      enum: ['draft', 'published', 'closed', 'cancelled'],
    },
    publishedDate: Date,
    closingDate: Date,
    expectedHires: { type: Number, required: true, default: 1 },
    hiredCount: { type: Number, required: true, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    isActive: { type: Boolean, default: true },
    deactivatedAt: Date,
  },
  { timestamps: true },
)

jobPositionSchema.plugin(tenantPlugin)
jobPositionSchema.index({ orgId: 1, departmentId: 1 })
jobPositionSchema.index({ orgId: 1, state: 1 })

export const JobPosition = model<IJobPosition>('JobPosition', jobPositionSchema)
