import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IPurchaseOrderLine {
  productId?: Types.ObjectId
  name: string
  quantity: number
  uom: string
  priceUnit: number
  taxRate: number
  taxAmount: number
  priceSubtotal: number
  priceTotal: number
  qtyReceived: number
  qtyBilled: number
  scheduledDate?: Date
  warehouseId?: Types.ObjectId
}

export interface IPurchaseOrder extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string                    // PO-2026-00001
  state: string                   // draft, sent, to_approve, confirmed, received, billed, done, cancelled
  vendorId: Types.ObjectId        // Contact (supplier)
  dateOrder?: Date
  dateApproved?: Date
  datePlanned?: Date
  currency: string
  exchangeRate: number
  lines: IPurchaseOrderLine[]
  amountUntaxed: number
  amountTax: number
  amountTotal: number
  receiptStatus: string           // pending, partial, full
  invoiceStatus: string           // nothing, to_bill, billed
  invoiceIds: Types.ObjectId[]
  movementIds: Types.ObjectId[]
  agreementId?: Types.ObjectId
  approvalStatus?: string
  approvedBy?: Types.ObjectId
  notes?: string
  userId: Types.ObjectId          // Buyer
  tags?: string[]
  sentAt?: Date
  confirmedAt?: Date
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const purchaseOrderLineSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product' },
    name: { type: String, required: true },
    quantity: { type: Number, required: true, min: 0 },
    uom: { type: String, required: true },
    priceUnit: { type: Number, required: true },
    taxRate: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    priceSubtotal: { type: Number, default: 0 },
    priceTotal: { type: Number, default: 0 },
    qtyReceived: { type: Number, default: 0 },
    qtyBilled: { type: Number, default: 0 },
    scheduledDate: Date,
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse' },
  },
  { _id: false },
)

const purchaseOrderSchema = new Schema<IPurchaseOrder>(
  {
    name: { type: String, required: true },
    state: {
      type: String,
      required: true,
      default: 'draft',
      enum: ['draft', 'sent', 'to_approve', 'confirmed', 'received', 'billed', 'done', 'cancelled'],
    },
    vendorId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    dateOrder: Date,
    dateApproved: Date,
    datePlanned: Date,
    currency: { type: String, default: 'EUR' },
    exchangeRate: { type: Number, default: 1 },
    lines: [purchaseOrderLineSchema],
    amountUntaxed: { type: Number, default: 0 },
    amountTax: { type: Number, default: 0 },
    amountTotal: { type: Number, default: 0 },
    receiptStatus: {
      type: String,
      default: 'pending',
      enum: ['pending', 'partial', 'full'],
    },
    invoiceStatus: {
      type: String,
      default: 'nothing',
      enum: ['nothing', 'to_bill', 'billed'],
    },
    invoiceIds: [{ type: Schema.Types.ObjectId, ref: 'Invoice' }],
    movementIds: [{ type: Schema.Types.ObjectId, ref: 'StockMovement' }],
    agreementId: { type: Schema.Types.ObjectId, ref: 'BlanketOrder' },
    approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'] },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    notes: String,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tags: [String],
    sentAt: Date,
    confirmedAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

purchaseOrderSchema.plugin(tenantPlugin)
purchaseOrderSchema.index({ orgId: 1, name: 1 }, { unique: true })
purchaseOrderSchema.index({ orgId: 1, state: 1, datePlanned: -1 })
purchaseOrderSchema.index({ orgId: 1, vendorId: 1, state: 1 })
purchaseOrderSchema.index({ orgId: 1, userId: 1, state: 1 })
purchaseOrderSchema.index({ orgId: 1, receiptStatus: 1 })
purchaseOrderSchema.index({ orgId: 1, invoiceStatus: 1 })
purchaseOrderSchema.index({ orgId: 1, tags: 1 })
purchaseOrderSchema.index({ name: 'text', notes: 'text' })

export const PurchaseOrder = model<IPurchaseOrder>('PurchaseOrder', purchaseOrderSchema)
