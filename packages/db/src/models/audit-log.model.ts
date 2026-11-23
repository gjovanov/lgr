import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

export interface IAuditLog extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  /** The person; absent on the system's entry (`actor`) and a sys-admin script's (`via`). */
  userId?: Types.ObjectId
  /**
   * FR-29.20: an entry the system wrote, a job's or an event's, with its name (`invoice.posted`, `backup`). Rows from
   * before it carry none and are read as a person's, as they always were.
   */
  actor?: { kind: 'system'; name: string }
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

/** An entry a sys-admin script wrote on the server: it names the script, not a person. */
export const isScriptVia = (via: unknown): boolean => typeof via === 'string' && via.startsWith('scripts/')

/**
 * An entry's fields, but its org: the org's trail here, and the entries global keeps for itself about an org whose
 * home is elsewhere (`GlobalAuditEntry`). A function, so each schema gets its own definitions.
 */
export function auditEntryFields() {
  return {
    // Who: a person, always, but for a sys-admin script run on the server (`via: 'scripts/<name>.ts'`), which acts as
    // nobody in the org (FR-27: `access-model.ts`, `restore-administrator.ts`). `via` names it instead.
    // FR-29.20: or the system, which names its job or event in `actor` instead.
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: function (this: any) { return !isScriptVia(this?.via) && this?.actor?.kind !== 'system' } },
    actor: {
      type: new Schema({ kind: { type: String, enum: ['system'], required: true }, name: { type: String, required: true } }, { _id: false }),
      required: false,
    },
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
  }
}

const auditLogSchema = new Schema<IAuditLog>(auditEntryFields())

auditLogSchema.plugin(tenantPlugin)
auditLogSchema.index({ orgId: 1, timestamp: -1 })
auditLogSchema.index({ orgId: 1, entityType: 1, entityId: 1 })
auditLogSchema.index({ orgId: 1, module: 1, timestamp: -1 })
auditLogSchema.index({ orgId: 1, action: 1, timestamp: -1 })
auditLogSchema.index({ orgId: 1, userId: 1, timestamp: -1 })
auditLogSchema.index({ orgId: 1, correlationId: 1 })

replicate(auditLogSchema, { class: 'R' })

export const AuditLog = model<IAuditLog>('AuditLog', auditLogSchema)
