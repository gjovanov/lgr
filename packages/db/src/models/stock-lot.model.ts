import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

export interface IStockLot extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  productId: Types.ObjectId
  trackingType: string
  expiryDate?: Date
  notes?: string
  properties?: Record<string, any>
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

const stockLotSchema = new Schema<IStockLot>(
  {
    name: { type: String, required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    trackingType: {
      type: String,
      required: true,
      enum: ['lot', 'serial'],
    },
    expiryDate: Date,
    notes: String,
    properties: { type: Schema.Types.Mixed },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
)

stockLotSchema.plugin(tenantPlugin)
stockLotSchema.index({ orgId: 1, name: 1, productId: 1 }, { unique: true })
stockLotSchema.index({ orgId: 1, productId: 1 })

replicate(stockLotSchema, { class: 'R' })

export const StockLot = model<IStockLot>('StockLot', stockLotSchema)
