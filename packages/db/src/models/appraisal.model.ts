import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IAppraisalAnswer {
  question: string
  answer: string
  rating?: number
}

export interface IAppraisalGoal {
  description: string
  status: string
}

export interface IAppraisal extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  employeeId: Types.ObjectId
  reviewerId: Types.ObjectId
  state: string
  dateScheduled: Date
  dateCompleted?: Date
  selfEvaluation: IAppraisalAnswer[]
  managerEvaluation: IAppraisalAnswer[]
  overallRating: number
  goals: IAppraisalGoal[]
  nextAppraisalDate?: Date
  notes?: string
  createdAt: Date
  updatedAt: Date
}

const appraisalAnswerSchema = new Schema<IAppraisalAnswer>(
  {
    question: { type: String, required: true },
    answer: { type: String, required: true },
    rating: Number,
  },
  { _id: false },
)

const appraisalGoalSchema = new Schema<IAppraisalGoal>(
  {
    description: { type: String, required: true },
    status: {
      type: String,
      required: true,
      default: 'not_started',
      enum: ['not_started', 'in_progress', 'achieved', 'missed'],
    },
  },
  { _id: false },
)

const appraisalSchema = new Schema<IAppraisal>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    reviewerId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    state: {
      type: String,
      required: true,
      default: 'draft',
      enum: ['draft', 'scheduled', 'in_progress', 'completed', 'cancelled'],
    },
    dateScheduled: { type: Date, required: true },
    dateCompleted: Date,
    selfEvaluation: [appraisalAnswerSchema],
    managerEvaluation: [appraisalAnswerSchema],
    overallRating: { type: Number, default: 0 },
    goals: [appraisalGoalSchema],
    nextAppraisalDate: Date,
    notes: String,
  },
  { timestamps: true },
)

appraisalSchema.plugin(tenantPlugin)
appraisalSchema.index({ orgId: 1, employeeId: 1 })
appraisalSchema.index({ orgId: 1, reviewerId: 1 })
appraisalSchema.index({ orgId: 1, state: 1 })

export const Appraisal = model<IAppraisal>('Appraisal', appraisalSchema)
