import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { loweredFieldsPlugin } from '../plugins/lowered-fields.plugin.js'
import { replicate } from '../replication/declare.js'

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

export interface IProductPriceTier {
  name: string
  percent: number
  finalPrice: number
  manualOverride: boolean
  contactIds?: Types.ObjectId[]
  tags?: string[]
  minQuantity?: number
  validFrom?: Date
  validTo?: Date
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
  priceTiers: IProductPriceTier[]
  variants?: IProductVariant[]
  tags?: string[]
  costingMethod?: string
  standardCost?: number
  isActive: boolean
  deactivatedAt?: Date
  nameLower?: string
  skuLower?: string
  barcodeLower?: string
  descriptionLower?: string
  categoryLower?: string
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
    priceTiers: {
      type: [
        {
          _id: false,
          name: { type: String, required: true },
          percent: { type: Number, default: 0 },
          finalPrice: { type: Number, required: true, min: 0 },
          manualOverride: { type: Boolean, default: false },
          contactIds: [{ type: Schema.Types.ObjectId, ref: 'Contact' }],
          tags: [String],
          minQuantity: Number,
          validFrom: Date,
          validTo: Date,
        },
      ],
      default: [],
      validate: {
        validator: (arr: unknown[]) => !arr || arr.length <= 13,
        message: 'priceTiers exceeds maximum of 13 slots',
      },
    },
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
    nameLower: { type: String, index: true },
    skuLower: { type: String, index: true },
    barcodeLower: { type: String, index: true },
    descriptionLower: String,
    categoryLower: { type: String, index: true },
  },
  { timestamps: true },
)

productSchema.plugin(tenantPlugin)
productSchema.plugin(loweredFieldsPlugin, {
  fields: {
    name: 'nameLower',
    sku: 'skuLower',
    barcode: 'barcodeLower',
    description: 'descriptionLower',
    category: 'categoryLower',
  },
})
productSchema.index({ orgId: 1, sku: 1 }, { unique: true })
productSchema.index({ orgId: 1, barcode: 1 })
productSchema.index({ orgId: 1, category: 1 })
productSchema.index({ orgId: 1, categoryId: 1 })
productSchema.index({ name: 'text', sku: 'text', barcode: 'text', description: 'text', category: 'text' })
productSchema.index({ orgId: 1, tags: 1 })
productSchema.index({ orgId: 1, 'priceTiers.tags': 1 })
productSchema.index({ orgId: 1, 'priceTiers.contactIds': 1 })

replicate(productSchema, { class: 'R' })

export const Product = model<IProduct>('Product', productSchema)
