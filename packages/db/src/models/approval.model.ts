import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IApprovalStepConfig {
  order: number
  name: string
  approverType: string
  approverId?: Types.ObjectId
  approverRole?: string
  required: boolean
}

export interface IApprovalType extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  entityType: string
  description?: string
  steps: IApprovalStepConfig[]
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

export interface IApprovalStepResult {
  order: number
  approverId: Types.ObjectId
  decision: string
  decidedDate?: Date
  comment?: string
}

export interface IApprovalRequest extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  typeId: Types.ObjectId
  entityType: string
  entityId: Types.ObjectId
  requesterId: Types.ObjectId
  state: string
  currentStep: number
  steps: IApprovalStepResult[]
  requestedDate: Date
  decidedDate?: Date
  notes?: string
  createdAt: Date
  updatedAt: Date
}

const approvalStepConfigSchema = new Schema(
  {
    order: { type: Number, required: true },
    name: { type: String, required: true },
    approverType: {
      type: String,
      required: true,
      enum: ['user', 'role', 'manager'],
    },
    approverId: { type: Schema.Types.ObjectId, ref: 'User' },
    approverRole: String,
    required: { type: Boolean, default: true },
  },
  { _id: false },
)

const approvalTypeSchema = new Schema<IApprovalType>(
  {
    name: { type: String, required: true },
    entityType: { type: String, required: true },
    description: String,
    steps: [approvalStepConfigSchema],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
)

approvalTypeSchema.plugin(tenantPlugin)
approvalTypeSchema.index({ orgId: 1, name: 1 }, { unique: true })
approvalTypeSchema.index({ orgId: 1, entityType: 1, isActive: 1 })

export const ApprovalType = model<IApprovalType>('ApprovalType', approvalTypeSchema)

const approvalStepResultSchema = new Schema(
  {
    order: { type: Number, required: true },
    approverId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    decision: {
      type: String,
      required: true,
      enum: ['pending', 'approved', 'rejected'],
    },
    decidedDate: Date,
    comment: String,
  },
  { _id: false },
)

const approvalRequestSchema = new Schema<IApprovalRequest>(
  {
    typeId: { type: Schema.Types.ObjectId, ref: 'ApprovalType', required: true },
    entityType: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    requesterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    state: {
      type: String,
      required: true,
      default: 'pending',
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
    },
    currentStep: { type: Number, default: 0 },
    steps: [approvalStepResultSchema],
    requestedDate: { type: Date, required: true, default: Date.now },
    decidedDate: Date,
    notes: String,
  },
  { timestamps: true },
)

approvalRequestSchema.plugin(tenantPlugin)
approvalRequestSchema.index({ orgId: 1, entityType: 1, entityId: 1 })
approvalRequestSchema.index({ orgId: 1, requesterId: 1, state: 1 })
approvalRequestSchema.index({ orgId: 1, state: 1, requestedDate: -1 })
approvalRequestSchema.index({ orgId: 1, 'steps.approverId': 1, state: 1 })

export const ApprovalRequest = model<IApprovalRequest>('ApprovalRequest', approvalRequestSchema)
