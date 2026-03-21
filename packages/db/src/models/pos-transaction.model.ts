import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IPriceStep {
  type: string
  label: string
  price: number
}

export interface IPOSTransactionLine {
  productId: Types.ObjectId
  name: string
  quantity: number
  unitPrice: number
  discount: number
  taxRate: number
  taxAmount: number
  lineTotal: number
  priceExplanation?: IPriceStep[]
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
  status: string
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
  // Fiscal / SUPTO fields
  unpNumber?: string
  fiscalReceiptNumber?: string
  fiscalDeviceNumber?: string
  printedAt?: Date
  isFiscal: boolean
  // Storno fields
  originalUNP?: string
  originalFiscalReceiptNumber?: string
  originalTransactionDate?: Date
  originalTransactionId?: Types.ObjectId
  stornoReason?: string
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
    priceExplanation: [
      {
        type: { type: String, enum: ['base', 'tag', 'contact', 'override'] },
        label: String,
        price: Number,
      },
    ],
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
      enum: ['sale', 'return', 'exchange', 'storno'],
    },
    status: {
      type: String,
      required: true,
      default: 'completed',
      enum: ['completed', 'cancelled'],
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
    // Fiscal / SUPTO fields
    unpNumber: String,
    fiscalReceiptNumber: String,
    fiscalDeviceNumber: String,
    printedAt: Date,
    isFiscal: { type: Boolean, default: false },
    // Storno fields
    originalUNP: String,
    originalFiscalReceiptNumber: String,
    originalTransactionDate: Date,
    originalTransactionId: { type: Schema.Types.ObjectId, ref: 'POSTransaction' },
    stornoReason: {
      type: String,
      enum: ['operator_error', 'customer_return', 'price_reduction', 'tax_base_reduction'],
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

posTransactionSchema.plugin(tenantPlugin)
posTransactionSchema.index({ orgId: 1, transactionNumber: 1 }, { unique: true })
posTransactionSchema.index({ orgId: 1, sessionId: 1 })
posTransactionSchema.index({ orgId: 1, createdAt: -1 })
posTransactionSchema.index({ orgId: 1, unpNumber: 1 }, { sparse: true })
posTransactionSchema.index({ orgId: 1, type: 1, createdAt: -1 })

export const POSTransaction = model<IPOSTransaction>('POSTransaction', posTransactionSchema)
