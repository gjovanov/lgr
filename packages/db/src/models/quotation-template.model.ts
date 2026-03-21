import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IQuotationTemplateLine {
  productId?: Types.ObjectId
  name: string
  quantity: number
  discount: number
}

export interface IQuotationTemplate extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  lines: IQuotationTemplateLine[]
  optionalProductIds: Types.ObjectId[]
  notes?: string
  termsAndConditions?: string
  validityDays: number
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

const quotationTemplateSchema = new Schema<IQuotationTemplate>(
  {
    name: { type: String, required: true },
    lines: [
      {
        productId: { type: Schema.Types.ObjectId, ref: 'Product' },
        name: { type: String, required: true },
        quantity: { type: Number, required: true, default: 1 },
        discount: { type: Number, default: 0 },
      },
    ],
    optionalProductIds: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
    notes: String,
    termsAndConditions: String,
    validityDays: { type: Number, default: 30 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
)

quotationTemplateSchema.plugin(tenantPlugin)
quotationTemplateSchema.index({ orgId: 1, name: 1 }, { unique: true })

export const QuotationTemplate = model<IQuotationTemplate>('QuotationTemplate', quotationTemplateSchema)
