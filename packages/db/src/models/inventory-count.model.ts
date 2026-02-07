import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IInventoryCountLine {
  productId: Types.ObjectId
  systemQuantity: number
  countedQuantity: number
  variance: number
  varianceCost: number
  notes?: string
}

export interface IInventoryCount extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  countNumber: string
  warehouseId: Types.ObjectId
  date: Date
  status: string
  type: string
  lines: IInventoryCountLine[]
  adjustmentMovementId?: Types.ObjectId
  completedBy?: Types.ObjectId
  completedAt?: Date
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const inventoryCountSchema = new Schema<IInventoryCount>(
  {
    countNumber: { type: String, required: true },
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    date: { type: Date, required: true },
    status: { type: String, required: true, default: 'in_progress', enum: ['in_progress', 'completed', 'cancelled'] },
    type: { type: String, required: true, enum: ['full', 'partial', 'cycle'] },
    lines: [
      {
        productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
        systemQuantity: { type: Number, required: true },
        countedQuantity: { type: Number, required: true },
        variance: { type: Number, required: true },
        varianceCost: { type: Number, required: true },
        notes: String,
      },
    ],
    adjustmentMovementId: { type: Schema.Types.ObjectId, ref: 'StockMovement' },
    completedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    completedAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

inventoryCountSchema.plugin(tenantPlugin)
inventoryCountSchema.index({ orgId: 1, warehouseId: 1, date: -1 })

export const InventoryCount = model<IInventoryCount>('InventoryCount', inventoryCountSchema)
