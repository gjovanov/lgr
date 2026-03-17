import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface ICostLayer extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  productId: Types.ObjectId
  warehouseId: Types.ObjectId
  unitCost: number
  currency?: string
  exchangeRate?: number
  initialQuantity: number
  remainingQuantity: number
  batchNumber?: string
  expiryDate?: Date
  serialNumbers?: string[]
  sourceMovementId: Types.ObjectId
  sourceMovementNumber: string
  receivedAt: Date
  isExhausted: boolean
  createdAt: Date
  updatedAt: Date
}

const costLayerSchema = new Schema<ICostLayer>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    unitCost: { type: Number, required: true },
    currency: String,
    exchangeRate: Number,
    initialQuantity: { type: Number, required: true },
    remainingQuantity: { type: Number, required: true },
    batchNumber: String,
    expiryDate: Date,
    serialNumbers: [String],
    sourceMovementId: { type: Schema.Types.ObjectId, ref: 'StockMovement', required: true },
    sourceMovementNumber: { type: String, required: true },
    receivedAt: { type: Date, required: true },
    isExhausted: { type: Boolean, default: false },
  },
  { timestamps: true },
)

costLayerSchema.plugin(tenantPlugin)
// FIFO consumption: oldest non-exhausted layers first
costLayerSchema.index({ orgId: 1, productId: 1, warehouseId: 1, isExhausted: 1, receivedAt: 1 })
// LIFO consumption: newest non-exhausted layers first
costLayerSchema.index({ orgId: 1, productId: 1, warehouseId: 1, isExhausted: 1, receivedAt: -1 })
// FEFO consumption: earliest expiry first
costLayerSchema.index({ orgId: 1, productId: 1, warehouseId: 1, isExhausted: 1, expiryDate: 1 })
// Lookup by source movement
costLayerSchema.index({ orgId: 1, sourceMovementId: 1 })

export const CostLayer = model<ICostLayer>('CostLayer', costLayerSchema)
