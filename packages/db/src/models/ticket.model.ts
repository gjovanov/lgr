import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface ITicket extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string                     // TICKET-2026-00001
  description: string
  channelSource: string            // email, form, chat, phone, manual
  partnerId?: Types.ObjectId       // Customer
  assigneeId?: Types.ObjectId      // Agent
  teamId?: Types.ObjectId
  stageName: string
  state: string                    // new, in_progress, on_hold, resolved, closed
  priority: string                 // low, normal, high, urgent
  slaDeadline?: Date
  slaStatus: string                // on_track, at_risk, breached
  tags?: string[]
  categoryId?: Types.ObjectId
  rating?: number                  // 1-5
  ratingComment?: string
  totalHours: number
  roomId?: string                  // Roomler-AI room
  relatedEntityType?: string
  relatedEntityId?: Types.ObjectId
  firstResponseDate?: Date
  resolutionDate?: Date
  closedDate?: Date
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const ticketSchema = new Schema<ITicket>(
  {
    name: { type: String, required: true },
    description: { type: String, default: '' },
    channelSource: {
      type: String,
      default: 'manual',
      enum: ['email', 'form', 'chat', 'phone', 'manual'],
    },
    partnerId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    assigneeId: { type: Schema.Types.ObjectId, ref: 'User' },
    teamId: { type: Schema.Types.ObjectId, ref: 'HelpdeskTeam' },
    stageName: { type: String, required: true, default: 'New' },
    state: {
      type: String,
      required: true,
      default: 'new',
      enum: ['new', 'in_progress', 'on_hold', 'resolved', 'closed'],
    },
    priority: {
      type: String,
      default: 'normal',
      enum: ['low', 'normal', 'high', 'urgent'],
    },
    slaDeadline: Date,
    slaStatus: {
      type: String,
      default: 'on_track',
      enum: ['on_track', 'at_risk', 'breached'],
    },
    tags: [String],
    categoryId: { type: Schema.Types.ObjectId },
    rating: { type: Number, min: 1, max: 5 },
    ratingComment: String,
    totalHours: { type: Number, default: 0 },
    roomId: String,
    relatedEntityType: String,
    relatedEntityId: { type: Schema.Types.ObjectId },
    firstResponseDate: Date,
    resolutionDate: Date,
    closedDate: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

ticketSchema.plugin(tenantPlugin)
ticketSchema.index({ orgId: 1, name: 1 }, { unique: true })
ticketSchema.index({ orgId: 1, state: 1, slaDeadline: 1 })
ticketSchema.index({ orgId: 1, assigneeId: 1, state: 1 })
ticketSchema.index({ orgId: 1, teamId: 1, state: 1 })
ticketSchema.index({ orgId: 1, partnerId: 1 })
ticketSchema.index({ orgId: 1, priority: 1, state: 1 })
ticketSchema.index({ orgId: 1, slaStatus: 1 })
ticketSchema.index({ orgId: 1, tags: 1 })
ticketSchema.index({ name: 'text', description: 'text' })

export const Ticket = model<ITicket>('Ticket', ticketSchema)
