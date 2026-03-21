import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IWorkCenter extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  code: string
  capacity: number                // units per hour
  costPerHour: number
  setupTime: number               // minutes
  cleanupTime: number             // minutes
  isActive: boolean
  notes?: string
  createdAt: Date
  updatedAt: Date
}

const workCenterSchema = new Schema<IWorkCenter>(
  {
    name: { type: String, required: true },
    code: { type: String, required: true },
    capacity: { type: Number, default: 1, min: 0 },
    costPerHour: { type: Number, default: 0, min: 0 },
    setupTime: { type: Number, default: 0, min: 0 },
    cleanupTime: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    notes: String,
  },
  { timestamps: true },
)

workCenterSchema.plugin(tenantPlugin)
workCenterSchema.index({ orgId: 1, code: 1 }, { unique: true })
workCenterSchema.index({ orgId: 1, isActive: 1 })

export const WorkCenter = model<IWorkCenter>('WorkCenter', workCenterSchema)
