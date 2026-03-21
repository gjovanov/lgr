import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface ISalesOrderLine {
  productId?: Types.ObjectId
  name: string
  quantity: number
  uom: string
  priceUnit: number
  discount: number
  taxRate: number
  taxAmount: number
  priceSubtotal: number
  priceTotal: number
  qtyDelivered: number
  qtyInvoiced: number
  warehouseId?: Types.ObjectId
  scheduledDate?: Date
  priceExplanation?: { type: string; label: string; price: number }[]
}

export interface ISalesOrder extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string                    // SO-2026-00001
  state: string                   // draft, sent, confirmed, invoiced, done, cancelled
  partnerId: Types.ObjectId       // Contact (customer)
  partnerShippingId?: Types.ObjectId
  partnerInvoiceId?: Types.ObjectId
  dateOrder?: Date
  validityDate?: Date
  commitmentDate?: Date
  pricelistId?: Types.ObjectId
  currency: string
  exchangeRate: number
  lines: ISalesOrderLine[]
  amountUntaxed: number
  amountTax: number
  amountTotal: number
  invoiceStatus: string           // nothing, to_invoice, invoiced, upselling
  deliveryStatus: string          // pending, partial, full
  invoiceIds: Types.ObjectId[]
  movementIds: Types.ObjectId[]
  templateId?: Types.ObjectId
  notes?: string
  termsAndConditions?: string
  requireSignature: boolean
  requirePayment: boolean
  signedBy?: string
  signedOn?: Date
  userId: Types.ObjectId          // Salesperson
  tags?: string[]
  sentAt?: Date
  confirmedAt?: Date
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const salesOrderLineSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product' },
    name: { type: String, required: true },
    quantity: { type: Number, required: true, min: 0 },
    uom: { type: String, required: true },
    priceUnit: { type: Number, required: true },
    discount: { type: Number, default: 0, min: 0, max: 100 },
    taxRate: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    priceSubtotal: { type: Number, default: 0 },
    priceTotal: { type: Number, default: 0 },
    qtyDelivered: { type: Number, default: 0 },
    qtyInvoiced: { type: Number, default: 0 },
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse' },
    scheduledDate: Date,
    priceExplanation: [
      {
        type: { type: String, enum: ['base', 'category', 'tag', 'contact', 'override'] },
        label: String,
        price: Number,
      },
    ],
  },
  { _id: false },
)

const salesOrderSchema = new Schema<ISalesOrder>(
  {
    name: { type: String, required: true },
    state: {
      type: String,
      required: true,
      default: 'draft',
      enum: ['draft', 'sent', 'confirmed', 'invoiced', 'done', 'cancelled'],
    },
    partnerId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    partnerShippingId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    partnerInvoiceId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    dateOrder: Date,
    validityDate: Date,
    commitmentDate: Date,
    pricelistId: { type: Schema.Types.ObjectId, ref: 'PriceList' },
    currency: { type: String, default: 'EUR' },
    exchangeRate: { type: Number, default: 1 },
    lines: [salesOrderLineSchema],
    amountUntaxed: { type: Number, default: 0 },
    amountTax: { type: Number, default: 0 },
    amountTotal: { type: Number, default: 0 },
    invoiceStatus: {
      type: String,
      default: 'nothing',
      enum: ['nothing', 'to_invoice', 'invoiced', 'upselling'],
    },
    deliveryStatus: {
      type: String,
      default: 'pending',
      enum: ['pending', 'partial', 'full'],
    },
    invoiceIds: [{ type: Schema.Types.ObjectId, ref: 'Invoice' }],
    movementIds: [{ type: Schema.Types.ObjectId, ref: 'StockMovement' }],
    templateId: { type: Schema.Types.ObjectId, ref: 'QuotationTemplate' },
    notes: String,
    termsAndConditions: String,
    requireSignature: { type: Boolean, default: false },
    requirePayment: { type: Boolean, default: false },
    signedBy: String,
    signedOn: Date,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tags: [String],
    sentAt: Date,
    confirmedAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

salesOrderSchema.plugin(tenantPlugin)
salesOrderSchema.index({ orgId: 1, name: 1 }, { unique: true })
salesOrderSchema.index({ orgId: 1, state: 1, dateOrder: -1 })
salesOrderSchema.index({ orgId: 1, partnerId: 1, state: 1 })
salesOrderSchema.index({ orgId: 1, userId: 1, state: 1 })
salesOrderSchema.index({ orgId: 1, invoiceStatus: 1 })
salesOrderSchema.index({ orgId: 1, tags: 1 })
salesOrderSchema.index({ name: 'text', notes: 'text' })

export const SalesOrder = model<ISalesOrder>('SalesOrder', salesOrderSchema)
