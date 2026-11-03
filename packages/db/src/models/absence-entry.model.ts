import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

/**
 * FR-25 §3.10: where a month's day codes come from.
 *
 * ⚠ Sick leave is health data. The code and the document are in `detail`, one sealed JSON
 * (`AbsenceDetail` in `services/biz/payroll/bg/absence.ts`). Dates and the day count stay in clear,
 * and alone they say a person was away, not why. Routes send `absenceView`, an allow-list.
 */
export interface IAbsenceEntry extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  employeeId: Types.ObjectId
  contractId?: Types.ObjectId
  from: Date
  to: Date
  workingDays: number
  detail?: string
  createdAt: Date
  updatedAt: Date
}

const absenceEntrySchema = new Schema<IAbsenceEntry>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    contractId: { type: Schema.Types.ObjectId, ref: 'EmploymentContract' },
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    workingDays: { type: Number, required: true },
    detail: String,
  },
  { timestamps: true },
)

absenceEntrySchema.plugin(tenantPlugin)
absenceEntrySchema.index({ orgId: 1, employeeId: 1, from: 1 })

replicate(absenceEntrySchema, { class: 'R' })

export const AbsenceEntry = model<IAbsenceEntry>('AbsenceEntry', absenceEntrySchema)
