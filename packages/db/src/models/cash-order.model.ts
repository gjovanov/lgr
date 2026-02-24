import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface ICashOrder extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  orderNumber: string
  type: string
  contactId?: Types.ObjectId
  amount: number
  currency: string
  description: string
  accountId: Types.ObjectId
  counterAccountId: Types.ObjectId
  journalEntryId?: Types.ObjectId
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const cashOrderSchema = new Schema<ICashOrder>(
  {
    orderNumber: { type: String, required: true },
    type: { type: String, required: true, enum: ['receipt', 'disbursement'] },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'EUR' },
    description: { type: String, required: true },
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
    counterAccountId: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
    journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

cashOrderSchema.plugin(tenantPlugin)
cashOrderSchema.index({ orgId: 1, orderNumber: 1 }, { unique: true })

export const CashOrder = model<ICashOrder>('CashOrder', cashOrderSchema)
