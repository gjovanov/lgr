import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IShiftTemplateEntry {
  roleId?: Types.ObjectId
  dayOfWeek: number
  startTime: string
  endTime: string
}

export interface IShiftTemplate extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  entries: IShiftTemplateEntry[]
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

const shiftTemplateEntrySchema = new Schema(
  {
    roleId: { type: Schema.Types.ObjectId },
    dayOfWeek: { type: Number, required: true, min: 0, max: 6 },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
  },
  { _id: false },
)

const shiftTemplateSchema = new Schema<IShiftTemplate>(
  {
    name: { type: String, required: true },
    entries: [shiftTemplateEntrySchema],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
)

shiftTemplateSchema.plugin(tenantPlugin)
shiftTemplateSchema.index({ orgId: 1, name: 1 }, { unique: true })
shiftTemplateSchema.index({ orgId: 1, isActive: 1 })

export const ShiftTemplate = model<IShiftTemplate>('ShiftTemplate', shiftTemplateSchema)
