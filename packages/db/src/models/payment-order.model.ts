import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IPaymentOrder extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  orderNumber: string
  type: string
  contactId: Types.ObjectId
  bankAccountId: Types.ObjectId
  amount: number
  currency: string
  exchangeRate: number
  invoiceIds: Types.ObjectId[]
  reference?: string
  description?: string
  status: string
  executedAt?: Date
  journalEntryId?: Types.ObjectId
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const paymentOrderSchema = new Schema<IPaymentOrder>(
  {
    orderNumber: { type: String, required: true },
    type: { type: String, required: true, enum: ['payment', 'receipt'] },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    bankAccountId: { type: Schema.Types.ObjectId, ref: 'BankAccount', required: true },
    amount: { type: Number, required: true },
    currency: { type: String, required: true },
    exchangeRate: { type: Number, required: true, default: 1 },
    invoiceIds: [{ type: Schema.Types.ObjectId, ref: 'Invoice' }],
    reference: String,
    description: String,
    status: { type: String, required: true, default: 'draft', enum: ['draft', 'approved', 'executed', 'cancelled'] },
    executedAt: Date,
    journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

paymentOrderSchema.plugin(tenantPlugin)
paymentOrderSchema.index({ orgId: 1, orderNumber: 1 }, { unique: true })

export const PaymentOrder = model<IPaymentOrder>('PaymentOrder', paymentOrderSchema)
