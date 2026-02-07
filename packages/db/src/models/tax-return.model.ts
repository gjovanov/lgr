import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface ITaxReturnLine {
  description: string
  taxableAmount: number
  taxRate: number
  taxAmount: number
  accountId: Types.ObjectId
}

export interface ITaxReturn extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  type: string
  period: {
    from: Date
    to: Date
  }
  status: string
  totalTax: number
  totalInput: number
  totalOutput: number
  netPayable: number
  lines: ITaxReturnLine[]
  filedAt?: Date
  filedBy?: Types.ObjectId
  attachments: Types.ObjectId[]
  createdAt: Date
  updatedAt: Date
}

const taxReturnLineSchema = new Schema<ITaxReturnLine>(
  {
    description: { type: String, required: true },
    taxableAmount: { type: Number, required: true },
    taxRate: { type: Number, required: true },
    taxAmount: { type: Number, required: true },
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
  },
  { _id: false },
)

const taxReturnSchema = new Schema<ITaxReturn>(
  {
    type: {
      type: String,
      required: true,
      enum: ['vat', 'income_tax', 'corporate_tax', 'payroll_tax'],
    },
    period: {
      from: { type: Date, required: true },
      to: { type: Date, required: true },
    },
    status: {
      type: String,
      required: true,
      default: 'draft',
      enum: ['draft', 'filed', 'paid'],
    },
    totalTax: { type: Number, required: true, default: 0 },
    totalInput: { type: Number, required: true, default: 0 },
    totalOutput: { type: Number, required: true, default: 0 },
    netPayable: { type: Number, required: true, default: 0 },
    lines: [taxReturnLineSchema],
    filedAt: Date,
    filedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    attachments: [{ type: Schema.Types.ObjectId, ref: 'File' }],
  },
  { timestamps: true },
)

taxReturnSchema.plugin(tenantPlugin)
taxReturnSchema.index({ orgId: 1, type: 1, 'period.from': -1 })

export const TaxReturn = model<ITaxReturn>('TaxReturn', taxReturnSchema)
