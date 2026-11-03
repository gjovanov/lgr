import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

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
  /** FR-25 §3.3: the side its balance normally sits on. 411 and 401 run on both. */
  balanceSide?: 'debit' | 'credit' | 'both'
  /** FR-25 §3.3: which trees of `AccountingAnalytic` its lines use. */
  analyticRoots?: string[]
  /** FR-25 §3.3: its lines carry quantities (goods, materials, production). */
  quantitative?: boolean
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
    balanceSide: { type: String, enum: ['debit', 'credit', 'both'] },
    analyticRoots: { type: [String], default: undefined },
    quantitative: Boolean,
  },
  { timestamps: true },
)

accountSchema.plugin(tenantPlugin)
accountSchema.index({ orgId: 1, code: 1 }, { unique: true })
accountSchema.index({ orgId: 1, type: 1 })
accountSchema.index({ orgId: 1, parentId: 1 })
accountSchema.index({ name: 'text', code: 'text', description: 'text' })

replicate(accountSchema, { class: 'R' })

export const Account = model<IAccount>('Account', accountSchema)
