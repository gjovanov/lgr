import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IApplicant extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  jobPositionId: Types.ObjectId
  name: string
  email: string
  phone?: string
  stageName: string
  source: string
  referrerId?: Types.ObjectId
  resumeFileId?: Types.ObjectId
  rating: number
  interviewDate?: Date
  notes?: string
  state: string
  salary?: number
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const applicantSchema = new Schema<IApplicant>(
  {
    jobPositionId: { type: Schema.Types.ObjectId, ref: 'JobPosition', required: true },
    name: { type: String, required: true },
    email: { type: String, required: true },
    phone: String,
    stageName: { type: String, required: true, default: 'new' },
    source: {
      type: String,
      required: true,
      enum: ['website', 'referral', 'linkedin', 'agency', 'job_board', 'other'],
    },
    referrerId: { type: Schema.Types.ObjectId, ref: 'Employee' },
    resumeFileId: { type: Schema.Types.ObjectId, ref: 'File' },
    rating: { type: Number, default: 0 },
    interviewDate: Date,
    notes: String,
    state: {
      type: String,
      required: true,
      default: 'new',
      enum: ['new', 'initial_review', 'interview', 'offer', 'hired', 'refused', 'withdrawn'],
    },
    salary: Number,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

applicantSchema.plugin(tenantPlugin)
applicantSchema.index({ orgId: 1, jobPositionId: 1 })
applicantSchema.index({ orgId: 1, state: 1 })
applicantSchema.index({ orgId: 1, email: 1 })

export const Applicant = model<IApplicant>('Applicant', applicantSchema)
