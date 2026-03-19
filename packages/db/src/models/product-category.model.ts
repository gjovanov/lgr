import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IProductCategory extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  description?: string
  icon?: string
  color?: string
  parentId?: Types.ObjectId
  sortOrder: number
  isActive: boolean
  isSystem: boolean
  createdAt: Date
  updatedAt: Date
}

const productCategorySchema = new Schema<IProductCategory>(
  {
    name: { type: String, required: true },
    description: String,
    icon: String,
    color: String,
    parentId: { type: Schema.Types.ObjectId, ref: 'ProductCategory' },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true },
)

productCategorySchema.plugin(tenantPlugin)
productCategorySchema.index({ orgId: 1, name: 1 }, { unique: true })
productCategorySchema.index({ orgId: 1, sortOrder: 1 })
productCategorySchema.index({ name: 'text' })

export const ProductCategory = model<IProductCategory>('ProductCategory', productCategorySchema)
