import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

export interface IPaymentTermLine {
  type: string
  value: number
  days: number
  dayOfMonth?: number
  earlyDiscountPercent?: number
  earlyDiscountDays?: number
}

export interface IPaymentTerm extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  description?: string
  lines: IPaymentTermLine[]
  isActive: boolean
  deactivatedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const paymentTermLineSchema = new Schema<IPaymentTermLine>(
  {
    type: {
      type: String,
      required: true,
      enum: ['balance', 'percent', 'fixed'],
    },
    value: { type: Number, required: true },
    days: { type: Number, required: true, default: 0 },
    dayOfMonth: Number,
    earlyDiscountPercent: Number,
    earlyDiscountDays: Number,
  },
  { _id: false },
)

const paymentTermSchema = new Schema<IPaymentTerm>(
  {
    name: { type: String, required: true },
    description: String,
    lines: [paymentTermLineSchema],
    isActive: { type: Boolean, default: true },
    deactivatedAt: Date,
  },
  { timestamps: true },
)

paymentTermSchema.plugin(tenantPlugin)
paymentTermSchema.index({ orgId: 1, name: 1 }, { unique: true })

replicate(paymentTermSchema, { class: 'R' })

export const PaymentTerm = model<IPaymentTerm>('PaymentTerm', paymentTermSchema)
