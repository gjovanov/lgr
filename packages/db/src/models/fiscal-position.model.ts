import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IFiscalPositionTaxMap {
  sourceTaxRate: number
  destinationTaxRate: number
  destinationAccountId?: Types.ObjectId
}

export interface IFiscalPosition extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  autoApply: boolean
  country?: string
  taxMaps: IFiscalPositionTaxMap[]
  isActive: boolean
  deactivatedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const taxMapSchema = new Schema<IFiscalPositionTaxMap>(
  {
    sourceTaxRate: { type: Number, required: true },
    destinationTaxRate: { type: Number, required: true },
    destinationAccountId: { type: Schema.Types.ObjectId, ref: 'Account' },
  },
  { _id: false },
)

const fiscalPositionSchema = new Schema<IFiscalPosition>(
  {
    name: { type: String, required: true },
    autoApply: { type: Boolean, default: false },
    country: String,
    taxMaps: [taxMapSchema],
    isActive: { type: Boolean, default: true },
    deactivatedAt: Date,
  },
  { timestamps: true },
)

fiscalPositionSchema.plugin(tenantPlugin)
fiscalPositionSchema.index({ orgId: 1, name: 1 }, { unique: true })

export const FiscalPosition = model<IFiscalPosition>('FiscalPosition', fiscalPositionSchema)
