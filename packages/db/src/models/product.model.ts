import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IProductDimensions {
  length: number
  width: number
  height: number
  unit: string
}

export interface IProductCustomPrice {
  name: string
  contactId: Types.ObjectId
  price: number
  minQuantity?: number
  validFrom?: Date
  validTo?: Date
}

export interface IProductTagPrice {
  name: string
  tag: string
  price: number
  minQuantity?: number
  validFrom?: Date
  validTo?: Date
}

export interface IProductCategoryPrice {
  name: string
  categoryId: Types.ObjectId
  price: number
  minQuantity?: number
  validFrom?: Date
  validTo?: Date
}

export interface IProductVariant {
  name: string
  options: string[]
}

export interface IProduct extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  sku: string
  barcode?: string
  name: string
  description?: string
  category: string
  categoryId?: Types.ObjectId
  type: string
  unit: string
  purchasePrice: number
  sellingPrice: number
  currency: string
  taxRate: number
  revenueAccountId?: Types.ObjectId
  expenseAccountId?: Types.ObjectId
  inventoryAccountId?: Types.ObjectId
  trackInventory: boolean
  minStockLevel?: number
  maxStockLevel?: number
  weight?: number
  dimensions?: IProductDimensions
  images?: string[]
  customPrices: IProductCustomPrice[]
  tagPrices: IProductTagPrice[]
  categoryPrices: IProductCategoryPrice[]
  variants?: IProductVariant[]
  tags?: string[]
  costingMethod?: string
  standardCost?: number
  isActive: boolean
  deactivatedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const productSchema = new Schema<IProduct>(
  {
    sku: { type: String, required: true },
    barcode: String,
    name: { type: String, required: true },
    description: String,
    category: { type: String, required: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'ProductCategory' },
    type: { type: String, required: true, enum: ['goods', 'service', 'raw_material', 'finished_product'] },
    unit: { type: String, required: true },
    purchasePrice: { type: Number, default: 0 },
    sellingPrice: { type: Number, default: 0 },
    currency: { type: String, default: 'EUR' },
    taxRate: { type: Number, default: 0 },
    revenueAccountId: { type: Schema.Types.ObjectId, ref: 'Account' },
    expenseAccountId: { type: Schema.Types.ObjectId, ref: 'Account' },
    inventoryAccountId: { type: Schema.Types.ObjectId, ref: 'Account' },
    trackInventory: { type: Boolean, default: true },
    minStockLevel: Number,
    maxStockLevel: Number,
    weight: Number,
    dimensions: {
      length: Number,
      width: Number,
      height: Number,
      unit: String,
    },
    images: [String],
    customPrices: [
      {
        name: { type: String, required: true },
        contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
        price: { type: Number, required: true },
        minQuantity: Number,
        validFrom: Date,
        validTo: Date,
      },
    ],
    tagPrices: [
      {
        name: { type: String, required: true },
        tag: { type: String, required: true },
        price: { type: Number, required: true },
        minQuantity: Number,
        validFrom: Date,
        validTo: Date,
      },
    ],
    categoryPrices: [
      {
        name: { type: String, required: true },
        categoryId: { type: Schema.Types.ObjectId, ref: 'ProductCategory', required: true },
        price: { type: Number, required: true },
        minQuantity: Number,
        validFrom: Date,
        validTo: Date,
      },
    ],
    variants: [
      {
        name: { type: String, required: true },
        options: [String],
      },
    ],
    tags: [String],
    costingMethod: { type: String, enum: ['wac', 'fifo', 'lifo', 'fefo', 'standard'] },
    standardCost: Number,
    isActive: { type: Boolean, default: true },
    deactivatedAt: Date,
  },
  { timestamps: true },
)

productSchema.plugin(tenantPlugin)
productSchema.index({ orgId: 1, sku: 1 }, { unique: true })
productSchema.index({ orgId: 1, barcode: 1 })
productSchema.index({ orgId: 1, category: 1 })
productSchema.index({ orgId: 1, categoryId: 1 })
productSchema.index({ name: 'text', sku: 'text', barcode: 'text', description: 'text', category: 'text' })
productSchema.index({ orgId: 1, tags: 1 })

export const Product = model<IProduct>('Product', productSchema)
