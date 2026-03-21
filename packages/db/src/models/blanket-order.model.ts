import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IBlanketOrderLine {
  productId?: Types.ObjectId
  name: string
  quantity: number
  priceUnit: number
  qtyOrdered: number
}

export interface IBlanketOrder extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  vendorId: Types.ObjectId
  state: string
  dateStart: Date
  dateEnd: Date
  currency: string
  lines: IBlanketOrderLine[]
  purchaseOrderIds: Types.ObjectId[]
  notes?: string
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const blanketOrderSchema = new Schema<IBlanketOrder>(
  {
    name: { type: String, required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    state: {
      type: String,
      required: true,
      default: 'draft',
      enum: ['draft', 'active', 'closed'],
    },
    dateStart: { type: Date, required: true },
    dateEnd: { type: Date, required: true },
    currency: { type: String, default: 'EUR' },
    lines: [
      {
        productId: { type: Schema.Types.ObjectId, ref: 'Product' },
        name: { type: String, required: true },
        quantity: { type: Number, required: true },
        priceUnit: { type: Number, required: true },
        qtyOrdered: { type: Number, default: 0 },
      },
    ],
    purchaseOrderIds: [{ type: Schema.Types.ObjectId, ref: 'PurchaseOrder' }],
    notes: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

blanketOrderSchema.plugin(tenantPlugin)
blanketOrderSchema.index({ orgId: 1, name: 1 }, { unique: true })
blanketOrderSchema.index({ orgId: 1, vendorId: 1, state: 1 })
blanketOrderSchema.index({ orgId: 1, state: 1 })

export const BlanketOrder = model<IBlanketOrder>('BlanketOrder', blanketOrderSchema)
