import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IAppointmentAnswer {
  questionLabel: string
  answer: string
}

export interface IAppointment extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  typeId: Types.ObjectId
  partnerId?: Types.ObjectId
  assigneeId: Types.ObjectId
  dateStart: Date
  dateEnd: Date
  state: string
  meetingUrl?: string
  notes?: string
  answers: IAppointmentAnswer[]
  leadId?: Types.ObjectId
  remindersSent: Date[]
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const appointmentAnswerSchema = new Schema(
  {
    questionLabel: { type: String, required: true },
    answer: { type: String, required: true },
  },
  { _id: false },
)

const appointmentSchema = new Schema<IAppointment>(
  {
    typeId: { type: Schema.Types.ObjectId, ref: 'AppointmentType', required: true },
    partnerId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    assigneeId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    dateStart: { type: Date, required: true },
    dateEnd: { type: Date, required: true },
    state: {
      type: String,
      required: true,
      default: 'scheduled',
      enum: ['scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show'],
    },
    meetingUrl: String,
    notes: String,
    answers: [appointmentAnswerSchema],
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    remindersSent: [Date],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

appointmentSchema.plugin(tenantPlugin)
appointmentSchema.index({ orgId: 1, assigneeId: 1, dateStart: 1 })
appointmentSchema.index({ orgId: 1, state: 1, dateStart: 1 })
appointmentSchema.index({ orgId: 1, typeId: 1, dateStart: 1 })
appointmentSchema.index({ orgId: 1, partnerId: 1, dateStart: 1 })
appointmentSchema.index({ orgId: 1, leadId: 1 })

export const Appointment = model<IAppointment>('Appointment', appointmentSchema)
