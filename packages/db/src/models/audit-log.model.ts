import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

export interface IAuditLog extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  userId: Types.ObjectId
  operatorCode?: string
  action: string
  module: string
  entityType: string
  entityId: Types.ObjectId | string
  entityName?: string
  unpNumber?: string
  correlationId?: Types.ObjectId | string
  changes?: { field: string; oldValue: any; newValue: any }[]
  ipAddress?: string
  userAgent?: string
  /**
   * FR-20.48: where the entry came from on a master: `lan:<desktopId>` (a till), `lan`, `tunnel`
   * (the org's address) or `loopback` (the server's console, or its own work). Absent on lgrai.app.
   */
  via?: string
  timestamp: Date
}

const auditLogSchema = new Schema<IAuditLog>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  operatorCode: String,
  action: { type: String, required: true },
  module: { type: String, required: true },
  entityType: { type: String, required: true },
  // Mixed: usually an ObjectId, but config-style entities (sequence prefixes like
  // "CASH_SALE") audit with their string key.
  entityId: { type: Schema.Types.Mixed, required: true },
  entityName: String,
  unpNumber: String,
  correlationId: Schema.Types.ObjectId,
  changes: [{
    field: String,
    oldValue: Schema.Types.Mixed,
    newValue: Schema.Types.Mixed,
  }],
  ipAddress: String,
  userAgent: String,
  via: String,
  timestamp: { type: Date, default: Date.now },
})

auditLogSchema.plugin(tenantPlugin)
auditLogSchema.index({ orgId: 1, timestamp: -1 })
auditLogSchema.index({ orgId: 1, entityType: 1, entityId: 1 })
auditLogSchema.index({ orgId: 1, module: 1, timestamp: -1 })
auditLogSchema.index({ orgId: 1, action: 1, timestamp: -1 })
auditLogSchema.index({ orgId: 1, userId: 1, timestamp: -1 })
auditLogSchema.index({ orgId: 1, correlationId: 1 })
auditLogSchema.index({ orgId: 1, operatorCode: 1, timestamp: -1 })

replicate(auditLogSchema, { class: 'R' })

export const AuditLog = model<IAuditLog>('AuditLog', auditLogSchema)
