import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

/**
 * FR-25 §3.10: what one line of a payslip is, per org. `pmCodes` are the element numbers the org's
 * PlusMinus used, which only an import from that org's own files fills in.
 */
export interface IPayrollElement extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  code: string
  label: string
  kind: string
  insurable: boolean
  taxable: boolean
  leaveBase: boolean
  formula?: string
  pmCodes: string[]
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

const payrollElementSchema = new Schema<IPayrollElement>(
  {
    code: { type: String, required: true },
    label: { type: String, required: true },
    kind: { type: String, required: true, enum: ['days', 'earning', 'deduction', 'employer'] },
    insurable: { type: Boolean, required: true, default: true },
    taxable: { type: Boolean, required: true, default: true },
    leaveBase: { type: Boolean, required: true, default: false },
    formula: String,
    pmCodes: [String],
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
)

payrollElementSchema.plugin(tenantPlugin)
payrollElementSchema.index({ orgId: 1, code: 1 }, { unique: true })

replicate(payrollElementSchema, { class: 'R' })

export const PayrollElement = model<IPayrollElement>('PayrollElement', payrollElementSchema)
