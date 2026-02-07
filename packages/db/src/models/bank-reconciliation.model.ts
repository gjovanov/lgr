import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IBankReconciliationItem {
  date: Date
  description: string
  amount: number
  type: string
  matched: boolean
  journalEntryId?: Types.ObjectId
  bankReference?: string
}

export interface IBankReconciliation extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  bankAccountId: Types.ObjectId
  statementDate: Date
  statementBalance: number
  bookBalance: number
  difference: number
  status: string
  items: IBankReconciliationItem[]
  reconciledBy?: Types.ObjectId
  reconciledAt?: Date
  createdAt: Date
  updatedAt: Date
}

const bankReconciliationItemSchema = new Schema<IBankReconciliationItem>(
  {
    date: { type: Date, required: true },
    description: { type: String, required: true },
    amount: { type: Number, required: true },
    type: { type: String, required: true, enum: ['deposit', 'withdrawal'] },
    matched: { type: Boolean, default: false },
    journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
    bankReference: String,
  },
  { _id: false },
)

const bankReconciliationSchema = new Schema<IBankReconciliation>(
  {
    bankAccountId: { type: Schema.Types.ObjectId, ref: 'BankAccount', required: true },
    statementDate: { type: Date, required: true },
    statementBalance: { type: Number, required: true },
    bookBalance: { type: Number, required: true },
    difference: { type: Number, required: true, default: 0 },
    status: { type: String, required: true, default: 'draft', enum: ['draft', 'completed'] },
    items: [bankReconciliationItemSchema],
    reconciledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reconciledAt: Date,
  },
  { timestamps: true },
)

bankReconciliationSchema.plugin(tenantPlugin)
bankReconciliationSchema.index({ orgId: 1, bankAccountId: 1, statementDate: -1 })

export const BankReconciliation = model<IBankReconciliation>('BankReconciliation', bankReconciliationSchema)
