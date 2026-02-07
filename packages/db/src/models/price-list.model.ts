import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IPriceListItem {
  productId: Types.ObjectId
  price: number
  minQuantity?: number
  discount?: number
}

export interface IPriceList extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  currency: string
  isDefault: boolean
  validFrom?: Date
  validTo?: Date
  items: IPriceListItem[]
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

const priceListSchema = new Schema<IPriceList>(
  {
    name: { type: String, required: true },
    currency: { type: String, required: true },
    isDefault: { type: Boolean, default: false },
    validFrom: Date,
    validTo: Date,
    items: [
      {
        productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
        price: { type: Number, required: true },
        minQuantity: Number,
        discount: Number,
      },
    ],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
)

priceListSchema.plugin(tenantPlugin)
priceListSchema.index({ orgId: 1, name: 1 }, { unique: true })

export const PriceList = model<IPriceList>('PriceList', priceListSchema)
