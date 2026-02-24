import { Schema, model, type Document, type Types } from 'mongoose'

export interface IExchangeRate extends Document {
  _id: Types.ObjectId
  orgId?: Types.ObjectId
  fromCurrency: string
  toCurrency: string
  rate: number
  date: Date
  source: string
  createdAt: Date
  updatedAt: Date
}

const exchangeRateSchema = new Schema<IExchangeRate>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org' },
    fromCurrency: { type: String, required: true },
    toCurrency: { type: String, required: true },
    rate: { type: Number, required: true },
    date: { type: Date, default: Date.now },
    source: { type: String, required: true, default: 'manual', enum: ['manual', 'api'] },
  },
  { timestamps: true },
)

exchangeRateSchema.index({ orgId: 1, fromCurrency: 1, toCurrency: 1, date: -1 })

export const ExchangeRate = model<IExchangeRate>('ExchangeRate', exchangeRateSchema)
