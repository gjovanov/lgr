import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

export interface IOwnRecordsConfig {
  sales?: boolean
  purchase?: boolean
  project?: boolean
  helpdesk?: boolean
  crm?: boolean
  payroll?: boolean
  hr?: boolean
  documents?: boolean
  subscriptions?: boolean
  planning?: boolean
  fleet?: boolean
  erp?: boolean
}

export interface IPermissionSet extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  description?: string
  permissions: string[]
  ownRecordsOnly: IOwnRecordsConfig
  isDefault: boolean              // auto-assigned to new users
  isAdmin: boolean                // bypass all permission checks
  isSystem: boolean               // cannot be deleted (seeded by system)
  createdAt: Date
  updatedAt: Date
}

const ownRecordsConfigSchema = new Schema(
  {
    sales: { type: Boolean, default: false },
    purchase: { type: Boolean, default: false },
    project: { type: Boolean, default: false },
    helpdesk: { type: Boolean, default: false },
    crm: { type: Boolean, default: false },
    payroll: { type: Boolean, default: false },
    hr: { type: Boolean, default: false },
    documents: { type: Boolean, default: false },
    subscriptions: { type: Boolean, default: false },
    planning: { type: Boolean, default: false },
    fleet: { type: Boolean, default: false },
    erp: { type: Boolean, default: false },
  },
  { _id: false },
)

const permissionSetSchema = new Schema<IPermissionSet>(
  {
    name: { type: String, required: true },
    description: String,
    permissions: [{ type: String }],
    ownRecordsOnly: { type: ownRecordsConfigSchema, default: () => ({}) },
    isDefault: { type: Boolean, default: false },
    isAdmin: { type: Boolean, default: false },
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true },
)

permissionSetSchema.plugin(tenantPlugin)
permissionSetSchema.index({ orgId: 1, name: 1 }, { unique: true })
permissionSetSchema.index({ orgId: 1, isDefault: 1 })

replicate(permissionSetSchema, { class: 'R' })

export const PermissionSet = model<IPermissionSet>('PermissionSet', permissionSetSchema)
