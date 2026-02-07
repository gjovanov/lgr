import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IPOSTransactionLine {
  productId: Types.ObjectId
  name: string
  quantity: number
  unitPrice: number
  discount: number
  taxRate: number
  taxAmount: number
  lineTotal: number
}

export interface IPOSTransactionPayment {
  method: string
  amount: number
  reference?: string
}

export interface IPOSTransaction extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  sessionId: Types.ObjectId
  transactionNumber: string
  type: string
  customerId?: Types.ObjectId
  lines: IPOSTransactionLine[]
  subtotal: number
  discountTotal: number
  taxTotal: number
  total: number
  payments: IPOSTransactionPayment[]
  changeDue: number
  invoiceId?: Types.ObjectId
  movementId?: Types.ObjectId
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const posTransactionLineSchema = new Schema<IPOSTransactionLine>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    discount: { type: Number, required: true, default: 0 },
    taxRate: { type: Number, required: true, default: 0 },
    taxAmount: { type: Number, required: true, default: 0 },
    lineTotal: { type: Number, required: true },
  },
  { _id: false },
)

const posTransactionPaymentSchema = new Schema<IPOSTransactionPayment>(
  {
    method: {
      type: String,
      required: true,
      enum: ['cash', 'card', 'mobile', 'voucher'],
    },
    amount: { type: Number, required: true },
    reference: String,
  },
  { _id: false },
)

const posTransactionSchema = new Schema<IPOSTransaction>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'POSSession', required: true },
    transactionNumber: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['sale', 'return', 'exchange'],
    },
    customerId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    lines: [posTransactionLineSchema],
    subtotal: { type: Number, required: true },
    discountTotal: { type: Number, required: true, default: 0 },
    taxTotal: { type: Number, required: true, default: 0 },
    total: { type: Number, required: true },
    payments: [posTransactionPaymentSchema],
    changeDue: { type: Number, required: true, default: 0 },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    movementId: { type: Schema.Types.ObjectId, ref: 'StockMovement' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

posTransactionSchema.plugin(tenantPlugin)
posTransactionSchema.index({ orgId: 1, transactionNumber: 1 }, { unique: true })
posTransactionSchema.index({ orgId: 1, sessionId: 1 })
posTransactionSchema.index({ orgId: 1, createdAt: -1 })

export const POSTransaction = model<IPOSTransaction>('POSTransaction', posTransactionSchema)
