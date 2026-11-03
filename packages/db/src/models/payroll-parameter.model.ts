import { Schema, model, type Document, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * FR-25 §3.10: one dated value of the law: a rate, a threshold, the holiday calendar, an annex's
 * table. Global reference data, like `ExchangeRate`: no `orgId`, and no tenant may change it.
 *
 * `effectiveFrom` is a calendar date, `YYYY-MM-DD`: the law's periods start on a day, in no time zone.
 * A rate is looked up by date, never by year (`services/biz/payroll/bg/parameters.ts`).
 */
export interface IPayrollParameter extends Document {
  _id: Types.ObjectId
  key: string
  effectiveFrom: string
  value: unknown
  currency?: string
  source: string
  createdAt: Date
  updatedAt: Date
}

const payrollParameterSchema = new Schema<IPayrollParameter>(
  {
    key: { type: String, required: true },
    effectiveFrom: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    value: { type: Schema.Types.Mixed, required: true },
    currency: String,
    source: { type: String, required: true },
  },
  { timestamps: true },
)

payrollParameterSchema.index({ key: 1, effectiveFrom: 1 }, { unique: true })

replicate(payrollParameterSchema, { class: 'G' })

export const PayrollParameter = model<IPayrollParameter>('PayrollParameter', payrollParameterSchema)
