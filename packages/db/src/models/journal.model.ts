import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

export interface IJournal extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  code: string
  type: string
  defaultDebitAccountId?: Types.ObjectId
  defaultCreditAccountId?: Types.ObjectId
  bankAccountId?: Types.ObjectId
  currency?: string
  sequencePrefix?: string
  isActive: boolean
  deactivatedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const journalSchema = new Schema<IJournal>(
  {
    name: { type: String, required: true },
    code: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['sale', 'purchase', 'cash', 'bank', 'general'],
    },
    defaultDebitAccountId: { type: Schema.Types.ObjectId, ref: 'Account' },
    defaultCreditAccountId: { type: Schema.Types.ObjectId, ref: 'Account' },
    bankAccountId: { type: Schema.Types.ObjectId, ref: 'BankAccount' },
    currency: String,
    sequencePrefix: String,
    isActive: { type: Boolean, default: true },
    deactivatedAt: Date,
  },
  { timestamps: true },
)

journalSchema.plugin(tenantPlugin)
journalSchema.index({ orgId: 1, code: 1 }, { unique: true })
journalSchema.index({ orgId: 1, type: 1 })

replicate(journalSchema, { class: 'R' })

export const Journal = model<IJournal>('Journal', journalSchema)
