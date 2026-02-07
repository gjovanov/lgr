import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IBankAccount extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  bankName: string
  accountNumber: string
  iban?: string
  swift?: string
  currency: string
  accountId: Types.ObjectId
  balance: number
  isDefault: boolean
  isActive: boolean
  lastReconciledDate?: Date
  createdAt: Date
  updatedAt: Date
}

const bankAccountSchema = new Schema<IBankAccount>(
  {
    name: { type: String, required: true },
    bankName: { type: String, required: true },
    accountNumber: { type: String, required: true },
    iban: String,
    swift: String,
    currency: { type: String, required: true },
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
    balance: { type: Number, default: 0 },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    lastReconciledDate: Date,
  },
  { timestamps: true },
)

bankAccountSchema.plugin(tenantPlugin)
bankAccountSchema.index({ orgId: 1, accountNumber: 1 }, { unique: true })

export const BankAccount = model<IBankAccount>('BankAccount', bankAccountSchema)
