import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IFiscalPeriod extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  fiscalYearId: Types.ObjectId
  name: string
  number: number
  startDate: Date
  endDate: Date
  status: string
  createdAt: Date
  updatedAt: Date
}

const fiscalPeriodSchema = new Schema<IFiscalPeriod>(
  {
    fiscalYearId: { type: Schema.Types.ObjectId, ref: 'FiscalYear', required: true },
    name: { type: String, required: true },
    number: { type: Number, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    status: { type: String, required: true, default: 'open', enum: ['open', 'closed', 'locked'] },
  },
  { timestamps: true },
)

fiscalPeriodSchema.plugin(tenantPlugin)
fiscalPeriodSchema.index({ orgId: 1, fiscalYearId: 1, number: 1 }, { unique: true })

export const FiscalPeriod = model<IFiscalPeriod>('FiscalPeriod', fiscalPeriodSchema)
