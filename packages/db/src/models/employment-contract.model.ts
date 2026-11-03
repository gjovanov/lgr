import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

export interface IEmploymentAmendment {
  number?: string
  date: Date
  effectiveFrom: Date
  position?: string
  kid?: string
  nkpd?: string
  /** A change the law made, with or without a paper: the 2026-01-01 conversion to euro. */
  byLaw?: boolean
}

export interface IEmploymentTermination {
  date: Date
  /** The code of the basis, as on ЕТЗ. */
  basis?: string
  orderNumber?: string
  usedLeaveDays?: number
  /** `ГГММДД`, as ЕТЗ carries them. */
  experience?: string
  noExperience?: string
}

/**
 * FR-25 §3.10: one employment and its annexes.
 *
 * ⚠ Pay is in `pay`, one sealed JSON (`EmploymentPay` in `services/biz/payroll/bg/contract-pay.ts`):
 * every salary this contract has had and the compensations at its end. Dates, position and codes
 * stay in clear. Routes send `contractView`, an allow-list.
 */
export interface IEmploymentContract extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  employeeId: Types.ObjectId
  number?: string
  date: Date
  /** The contract's basis code (`contracttype` on ЕТЗ). */
  type?: string
  ekatte?: string
  startDate?: Date
  endDate?: Date
  position?: string
  nkpd?: string
  kid?: string
  laborCategory?: string
  qualificationGroup?: number
  /** The row of Annex 1 for the employer's main activity: обр. 1's field 30. */
  mainActivityRow?: number
  /** The 'вид осигурен' code on обр. 1. Anything but `01` is refused by the engine (D11). */
  socialSecurityType: string
  healthSecurityType?: string
  hoursPerDay: number
  daysPerWeek: number
  statutoryHours: number
  payKind: string
  currency: string
  annualLeaveDays?: number
  /** Data only: the class supplement is an input (FR-25 §6.4, РКС № 17/2026). */
  classPercent?: number
  experienceAtStart?: { years: number; months: number; days: number }
  amendments: IEmploymentAmendment[]
  termination?: IEmploymentTermination
  pay?: string
  /** Where this row came from, so that an import replaces only what an import wrote. */
  source: string
  createdAt: Date
  updatedAt: Date
}

const employmentContractSchema = new Schema<IEmploymentContract>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    number: String,
    date: { type: Date, required: true },
    type: String,
    ekatte: String,
    startDate: Date,
    endDate: Date,
    position: String,
    nkpd: String,
    kid: String,
    laborCategory: String,
    qualificationGroup: Number,
    mainActivityRow: Number,
    socialSecurityType: { type: String, required: true, default: '01' },
    healthSecurityType: String,
    hoursPerDay: { type: Number, required: true, default: 8 },
    daysPerWeek: { type: Number, required: true, default: 5 },
    statutoryHours: { type: Number, required: true, default: 8 },
    payKind: { type: String, required: true, default: 'monthly', enum: ['monthly', 'hourly'] },
    currency: { type: String, required: true, default: 'EUR' },
    annualLeaveDays: Number,
    classPercent: Number,
    experienceAtStart: {
      _id: false,
      years: Number,
      months: Number,
      days: Number,
    },
    amendments: [
      {
        _id: false,
        number: String,
        date: { type: Date, required: true },
        effectiveFrom: { type: Date, required: true },
        position: String,
        kid: String,
        nkpd: String,
        byLaw: Boolean,
      },
    ],
    termination: {
      _id: false,
      date: Date,
      basis: String,
      orderNumber: String,
      usedLeaveDays: Number,
      experience: String,
      noExperience: String,
    },
    pay: String,
    source: { type: String, required: true, default: 'manual', enum: ['manual', 'import'] },
  },
  { timestamps: true },
)

employmentContractSchema.plugin(tenantPlugin)
employmentContractSchema.index({ orgId: 1, employeeId: 1, date: 1 })

replicate(employmentContractSchema, { class: 'R' })

export const EmploymentContract = model<IEmploymentContract>('EmploymentContract', employmentContractSchema)
