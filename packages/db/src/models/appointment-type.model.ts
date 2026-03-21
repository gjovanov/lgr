import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IAppointmentQuestion {
  label: string
  type: string
  required: boolean
  options?: string[]
}

export interface IAppointmentType extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  duration: number
  assigneeIds: Types.ObjectId[]
  location: string
  autoConfirm: boolean
  reminderMinutes: number[]
  customQuestions: IAppointmentQuestion[]
  isPublic: boolean
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

const appointmentQuestionSchema = new Schema(
  {
    label: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['text', 'textarea', 'select', 'checkbox', 'radio'],
    },
    required: { type: Boolean, default: false },
    options: [String],
  },
  { _id: false },
)

const appointmentTypeSchema = new Schema<IAppointmentType>(
  {
    name: { type: String, required: true },
    duration: { type: Number, required: true, min: 5 },
    assigneeIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    location: { type: String, default: '' },
    autoConfirm: { type: Boolean, default: false },
    reminderMinutes: [Number],
    customQuestions: [appointmentQuestionSchema],
    isPublic: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
)

appointmentTypeSchema.plugin(tenantPlugin)
appointmentTypeSchema.index({ orgId: 1, name: 1 }, { unique: true })
appointmentTypeSchema.index({ orgId: 1, isActive: 1, isPublic: 1 })

export const AppointmentType = model<IAppointmentType>('AppointmentType', appointmentTypeSchema)
