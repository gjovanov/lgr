import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IAccount extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  code: string
  name: string
  type: string
  subType: string
  parentId?: Types.ObjectId
  currency?: string
  description?: string
  isSystem: boolean
  isActive: boolean
  balance: number
  tags?: string[]
  createdAt: Date
  updatedAt: Date
}

const accountSchema = new Schema<IAccount>(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, required: true, enum: ['asset', 'liability', 'equity', 'revenue', 'expense'] },
    subType: { type: String, required: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'Account' },
    currency: String,
    description: String,
    isSystem: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    balance: { type: Number, default: 0 },
    tags: [String],
  },
  { timestamps: true },
)

accountSchema.plugin(tenantPlugin)
accountSchema.index({ orgId: 1, code: 1 }, { unique: true })
accountSchema.index({ orgId: 1, type: 1 })
accountSchema.index({ orgId: 1, parentId: 1 })

export const Account = model<IAccount>('Account', accountSchema)
