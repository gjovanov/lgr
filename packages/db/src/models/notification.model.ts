import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface INotification extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  userId: Types.ObjectId
  type: string
  title: string
  message: string
  module: string
  entityType?: string
  entityId?: Types.ObjectId
  read: boolean
  readAt?: Date
  createdAt: Date
}

const notificationSchema = new Schema<INotification>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, required: true, enum: ['info', 'success', 'warning', 'error'] },
  title: { type: String, required: true },
  message: { type: String, required: true },
  module: { type: String, required: true },
  entityType: String,
  entityId: Schema.Types.ObjectId,
  read: { type: Boolean, default: false },
  readAt: Date,
  createdAt: { type: Date, default: Date.now },
})

notificationSchema.plugin(tenantPlugin)
notificationSchema.index({ orgId: 1, userId: 1, read: 1, createdAt: -1 })

export const Notification = model<INotification>('Notification', notificationSchema)
