import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

export interface IPOSPaymentMethod extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  code: string
  type: string
  journalId?: Types.ObjectId
  isCashCount: boolean
  isActive: boolean
  deactivatedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const posPaymentMethodSchema = new Schema<IPOSPaymentMethod>(
  {
    name: { type: String, required: true },
    code: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['cash', 'card', 'mobile', 'voucher', 'bank'],
    },
    journalId: { type: Schema.Types.ObjectId, ref: 'Journal' },
    isCashCount: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    deactivatedAt: Date,
  },
  { timestamps: true },
)

posPaymentMethodSchema.plugin(tenantPlugin)
posPaymentMethodSchema.index({ orgId: 1, code: 1 }, { unique: true })

replicate(posPaymentMethodSchema, { class: 'R' })

export const POSPaymentMethod = model<IPOSPaymentMethod>('POSPaymentMethod', posPaymentMethodSchema)
