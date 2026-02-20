import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IOrgApp extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  appId: string
  enabled: boolean
  activatedAt: Date
  activatedBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const orgAppSchema = new Schema<IOrgApp>(
  {
    appId: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    activatedAt: { type: Date, default: Date.now },
    activatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
)

orgAppSchema.plugin(tenantPlugin)
orgAppSchema.index({ orgId: 1, appId: 1 }, { unique: true })

export const OrgApp = model<IOrgApp>('OrgApp', orgAppSchema)
