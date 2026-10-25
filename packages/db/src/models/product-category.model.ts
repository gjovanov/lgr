import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { loweredFieldsPlugin } from '../plugins/lowered-fields.plugin.js'
import { replicate } from '../replication/declare.js'

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
  deactivatedAt?: Date
  isSystem: boolean
  nameLower?: string
  descriptionLower?: string
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
    deactivatedAt: Date,
    isSystem: { type: Boolean, default: false },
    nameLower: { type: String, index: true },
    descriptionLower: String,
  },
  { timestamps: true },
)

productCategorySchema.plugin(tenantPlugin)
productCategorySchema.plugin(loweredFieldsPlugin, {
  fields: { name: 'nameLower', description: 'descriptionLower' },
})
productCategorySchema.index({ orgId: 1, name: 1 }, { unique: true })
productCategorySchema.index({ orgId: 1, sortOrder: 1 })
productCategorySchema.index({ name: 'text' })

replicate(productCategorySchema, { class: 'R' })

export const ProductCategory = model<IProductCategory>('ProductCategory', productCategorySchema)
