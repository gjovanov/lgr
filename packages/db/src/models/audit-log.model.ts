import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IAuditLog extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  userId: Types.ObjectId
  action: string
  module: string
  entityType: string
  entityId: Types.ObjectId
  changes?: { field: string; oldValue: any; newValue: any }[]
  ipAddress?: string
  userAgent?: string
  timestamp: Date
}

const auditLogSchema = new Schema<IAuditLog>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true },
  module: { type: String, required: true },
  entityType: { type: String, required: true },
  entityId: { type: Schema.Types.ObjectId, required: true },
  changes: [{
    field: String,
    oldValue: Schema.Types.Mixed,
    newValue: Schema.Types.Mixed,
  }],
  ipAddress: String,
  userAgent: String,
  timestamp: { type: Date, default: Date.now },
})

auditLogSchema.plugin(tenantPlugin)
auditLogSchema.index({ orgId: 1, timestamp: -1 })
auditLogSchema.index({ orgId: 1, entityType: 1, entityId: 1 })

export const AuditLog = model<IAuditLog>('AuditLog', auditLogSchema)
