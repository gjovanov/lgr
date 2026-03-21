import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IKitchenOrderLine {
  productId: Types.ObjectId
  productName: string
  quantity: number
  notes?: string
  state: string                   // pending, preparing, ready, served
}

export interface IKitchenOrder extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  posTransactionId: Types.ObjectId
  tableNumber?: number
  state: string                   // pending, in_progress, ready, served, cancelled
  lines: IKitchenOrderLine[]
  priority: string                // normal, rush
  notes?: string
  createdAt: Date
  updatedAt: Date
}

const kitchenLineSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    notes: String,
    state: { type: String, default: 'pending', enum: ['pending', 'preparing', 'ready', 'served'] },
  },
  { _id: false },
)

const kitchenOrderSchema = new Schema<IKitchenOrder>(
  {
    posTransactionId: { type: Schema.Types.ObjectId, ref: 'POSTransaction', required: true },
    tableNumber: Number,
    state: { type: String, default: 'pending', enum: ['pending', 'in_progress', 'ready', 'served', 'cancelled'] },
    lines: [kitchenLineSchema],
    priority: { type: String, default: 'normal', enum: ['normal', 'rush'] },
    notes: String,
  },
  { timestamps: true },
)

kitchenOrderSchema.plugin(tenantPlugin)
kitchenOrderSchema.index({ orgId: 1, state: 1 })
kitchenOrderSchema.index({ orgId: 1, posTransactionId: 1 })

export const KitchenOrder = model<IKitchenOrder>('KitchenOrder', kitchenOrderSchema)
