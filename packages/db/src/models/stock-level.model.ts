import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IStockLevel extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  productId: Types.ObjectId
  warehouseId: Types.ObjectId
  quantity: number
  reservedQuantity: number
  availableQuantity: number
  avgCost: number
  lastCountDate?: Date
  createdAt: Date
  updatedAt: Date
}

const stockLevelSchema = new Schema<IStockLevel>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    quantity: { type: Number, required: true, default: 0 },
    reservedQuantity: { type: Number, default: 0 },
    availableQuantity: { type: Number, required: true, default: 0 },
    avgCost: { type: Number, required: true, default: 0 },
    lastCountDate: Date,
  },
  { timestamps: true },
)

stockLevelSchema.plugin(tenantPlugin)
stockLevelSchema.index({ orgId: 1, productId: 1, warehouseId: 1 }, { unique: true })

export const StockLevel = model<IStockLevel>('StockLevel', stockLevelSchema)
