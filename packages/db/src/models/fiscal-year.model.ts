import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IFiscalYear extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  startDate: Date
  endDate: Date
  status: string
  closingEntryId?: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const fiscalYearSchema = new Schema<IFiscalYear>(
  {
    name: { type: String, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    status: { type: String, required: true, default: 'open', enum: ['open', 'closed', 'locked'] },
    closingEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
  },
  { timestamps: true },
)

fiscalYearSchema.plugin(tenantPlugin)
fiscalYearSchema.index({ orgId: 1, startDate: 1 }, { unique: true })

export const FiscalYear = model<IFiscalYear>('FiscalYear', fiscalYearSchema)
