import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface ITag extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  type: string
  value: string
  createdAt: Date
  updatedAt: Date
}

const tagSchema = new Schema<ITag>(
  {
    type: {
      type: String,
      required: true,
      enum: ['product', 'contact', 'warehouse', 'employee', 'invoice', 'lead', 'deal'],
    },
    value: { type: String, required: true },
  },
  { timestamps: true },
)

tagSchema.plugin(tenantPlugin)
tagSchema.index({ orgId: 1, type: 1, value: 1 }, { unique: true })
tagSchema.index({ orgId: 1, type: 1 })

export const Tag = model<ITag>('Tag', tagSchema)
