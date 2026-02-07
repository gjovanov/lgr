import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IProductDimensions {
  length: number
  width: number
  height: number
  unit: string
}

export interface IProductCustomPrice {
  contactId: Types.ObjectId
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
  variants?: IProductVariant[]
  tags?: string[]
  isActive: boolean
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
    type: { type: String, required: true, enum: ['goods', 'service', 'raw_material', 'finished_product'] },
    unit: { type: String, required: true },
    purchasePrice: { type: Number, default: 0 },
    sellingPrice: { type: Number, default: 0 },
    currency: { type: String, required: true },
    taxRate: { type: Number, required: true },
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
        contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
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
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
)

productSchema.plugin(tenantPlugin)
productSchema.index({ orgId: 1, sku: 1 }, { unique: true })
productSchema.index({ orgId: 1, barcode: 1 })
productSchema.index({ orgId: 1, category: 1 })
productSchema.index({ orgId: 1, name: 'text' })

export const Product = model<IProduct>('Product', productSchema)
