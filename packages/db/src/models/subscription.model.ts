import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface ISubscriptionLine {
  productId?: Types.ObjectId
  name: string
  quantity: number
  priceUnit: number
  discount: number
  priceSubtotal: number
}

export interface ISubscription extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  partnerId: Types.ObjectId
  state: string
  lines: ISubscriptionLine[]
  recurringInterval: number
  recurringPeriod: string
  dateStart: Date
  dateEnd?: Date
  nextInvoiceDate: Date
  currency: string
  amountRecurring: number
  paymentMethod?: string
  autoRenew: boolean
  cancellationReason?: string
  cancellationDate?: Date
  invoiceIds: Types.ObjectId[]
  salesOrderId?: Types.ObjectId
  notes?: string
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const subscriptionLineSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product' },
    name: { type: String, required: true },
    quantity: { type: Number, required: true, min: 0 },
    priceUnit: { type: Number, required: true },
    discount: { type: Number, default: 0, min: 0, max: 100 },
    priceSubtotal: { type: Number, default: 0 },
  },
  { _id: false },
)

const subscriptionSchema = new Schema<ISubscription>(
  {
    name: { type: String, required: true },
    partnerId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    state: {
      type: String,
      required: true,
      default: 'draft',
      enum: ['draft', 'active', 'paused', 'cancelled', 'expired', 'closed'],
    },
    lines: [subscriptionLineSchema],
    recurringInterval: { type: Number, required: true, default: 1 },
    recurringPeriod: {
      type: String,
      required: true,
      default: 'month',
      enum: ['day', 'week', 'month', 'year'],
    },
    dateStart: { type: Date, required: true },
    dateEnd: Date,
    nextInvoiceDate: { type: Date, required: true },
    currency: { type: String, default: 'EUR' },
    amountRecurring: { type: Number, default: 0 },
    paymentMethod: String,
    autoRenew: { type: Boolean, default: true },
    cancellationReason: String,
    cancellationDate: Date,
    invoiceIds: [{ type: Schema.Types.ObjectId, ref: 'Invoice' }],
    salesOrderId: { type: Schema.Types.ObjectId, ref: 'SalesOrder' },
    notes: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

subscriptionSchema.plugin(tenantPlugin)
subscriptionSchema.index({ orgId: 1, name: 1 }, { unique: true })
subscriptionSchema.index({ orgId: 1, state: 1, nextInvoiceDate: 1 })
subscriptionSchema.index({ orgId: 1, partnerId: 1, state: 1 })
subscriptionSchema.index({ orgId: 1, createdBy: 1 })
subscriptionSchema.index({ name: 'text', notes: 'text' })

export const Subscription = model<ISubscription>('Subscription', subscriptionSchema)
