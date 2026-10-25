import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

export interface IStockLocation extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  code?: string
  type: string
  warehouseId?: Types.ObjectId
  parentId?: Types.ObjectId
  fullPath?: string
  barcode?: string
  isScrapLocation: boolean
  isReturnLocation: boolean
  removalStrategy?: string
  isActive: boolean
  deactivatedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const stockLocationSchema = new Schema<IStockLocation>(
  {
    name: { type: String, required: true },
    code: String,
    type: {
      type: String,
      required: true,
      default: 'internal',
      enum: ['internal', 'supplier', 'customer', 'inventory_loss', 'production', 'transit', 'view'],
    },
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse' },
    parentId: { type: Schema.Types.ObjectId, ref: 'StockLocation' },
    fullPath: String,
    barcode: String,
    isScrapLocation: { type: Boolean, default: false },
    isReturnLocation: { type: Boolean, default: false },
    removalStrategy: {
      type: String,
      enum: ['fifo', 'lifo', 'fefo'],
    },
    isActive: { type: Boolean, default: true },
    deactivatedAt: Date,
  },
  { timestamps: true },
)

stockLocationSchema.plugin(tenantPlugin)
stockLocationSchema.index({ orgId: 1, warehouseId: 1 })
stockLocationSchema.index({ orgId: 1, parentId: 1 })
stockLocationSchema.index({ orgId: 1, barcode: 1 }, { sparse: true })

// Compute fullPath on save by walking the parent chain
stockLocationSchema.pre('save', async function () {
  if (this.isModified('name') || this.isModified('parentId') || this.isNew) {
    const parts: string[] = [this.name]
    let currentParentId = this.parentId
    let depth = 0
    const maxDepth = 10

    while (currentParentId && depth < maxDepth) {
      const parent = await model<IStockLocation>('StockLocation')
        .findById(currentParentId)
        .select('name parentId')
        .lean()
      if (!parent) break
      parts.unshift(parent.name)
      currentParentId = parent.parentId
      depth++
    }

    this.fullPath = parts.join(' / ')
  }
})

replicate(stockLocationSchema, { class: 'R' })

export const StockLocation = model<IStockLocation>('StockLocation', stockLocationSchema)
