import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IProjectStage {
  name: string
  sequence: number
  fold: boolean
}

export interface IProject extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  description?: string
  partnerId?: Types.ObjectId      // Client
  state: string                    // active, on_hold, done, cancelled
  dateStart?: Date
  dateEnd?: Date
  managerId: Types.ObjectId
  memberIds: Types.ObjectId[]
  stages: IProjectStage[]
  color?: string
  tags?: string[]
  budgetPlanned: number
  budgetSpent: number
  revenueExpected: number
  revenueInvoiced: number
  isFavorite: boolean
  salesOrderId?: Types.ObjectId
  roomId?: string                  // Roomler-AI room
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const projectStageSchema = new Schema(
  {
    name: { type: String, required: true },
    sequence: { type: Number, required: true },
    fold: { type: Boolean, default: false },
  },
  { _id: false },
)

const projectSchema = new Schema<IProject>(
  {
    name: { type: String, required: true },
    description: String,
    partnerId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    state: {
      type: String,
      required: true,
      default: 'active',
      enum: ['active', 'on_hold', 'done', 'cancelled'],
    },
    dateStart: Date,
    dateEnd: Date,
    managerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    memberIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    stages: {
      type: [projectStageSchema],
      default: [
        { name: 'To Do', sequence: 1, fold: false },
        { name: 'In Progress', sequence: 2, fold: false },
        { name: 'Done', sequence: 3, fold: true },
      ],
    },
    color: String,
    tags: [String],
    budgetPlanned: { type: Number, default: 0 },
    budgetSpent: { type: Number, default: 0 },
    revenueExpected: { type: Number, default: 0 },
    revenueInvoiced: { type: Number, default: 0 },
    isFavorite: { type: Boolean, default: false },
    salesOrderId: { type: Schema.Types.ObjectId, ref: 'SalesOrder' },
    roomId: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

projectSchema.plugin(tenantPlugin)
projectSchema.index({ orgId: 1, name: 1 })
projectSchema.index({ orgId: 1, state: 1 })
projectSchema.index({ orgId: 1, managerId: 1 })
projectSchema.index({ orgId: 1, partnerId: 1 })
projectSchema.index({ orgId: 1, memberIds: 1 })
projectSchema.index({ orgId: 1, tags: 1 })
projectSchema.index({ name: 'text', description: 'text' })

export const Project = model<IProject>('Project', projectSchema)
