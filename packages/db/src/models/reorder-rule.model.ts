import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IReorderRule extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  productId: Types.ObjectId
  warehouseId: Types.ObjectId
  minQty: number
  maxQty: number
  multipleQty?: number
  leadTimeDays: number
  vendorId?: Types.ObjectId
  isActive: boolean
  lastTriggeredAt?: Date
  createdAt: Date
  updatedAt: Date
}

const reorderRuleSchema = new Schema<IReorderRule>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    minQty: { type: Number, required: true, min: 0 },
    maxQty: { type: Number, required: true, min: 0 },
    multipleQty: { type: Number, min: 1 },
    leadTimeDays: { type: Number, required: true, default: 0 },
    vendorId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    isActive: { type: Boolean, default: true },
    lastTriggeredAt: Date,
  },
  { timestamps: true },
)

reorderRuleSchema.plugin(tenantPlugin)
reorderRuleSchema.index({ orgId: 1, productId: 1, warehouseId: 1 }, { unique: true })
reorderRuleSchema.index({ orgId: 1, isActive: 1 })

export const ReorderRule = model<IReorderRule>('ReorderRule', reorderRuleSchema)
