import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

/**
 * FR-25 §3.2: an analytic of the books (аналитичен признак). PlusMinus keeps them as paths with a
 * root (`СТОКИ:БОЛТОВЕ`, `РАЗХОДИ:УСЛУГИ:Наем`), and `path` is the path exactly as booked, double
 * spaces included: two paths that differ by a space are two rows in the accountant's trial balance.
 *
 * ⚠ An analytic under `СТОКИ:` is an accounting group, not a product (FR-25 §1.3).
 */
export const ANALYTIC_KINDS = [
  'goods_group', 'material', 'product', 'service', 'customer', 'supplier', 'partner',
  'bank_account', 'expense', 'income', 'settlement', 'personnel', 'fixed_asset', 'equity', 'other',
] as const
export type AnalyticKind = (typeof ANALYTIC_KINDS)[number]

export interface IAccountingAnalytic extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  path: string
  root: string
  parentId?: Types.ObjectId
  name: string
  /** Mirrors `name` in the `bg` locale: Cyrillic through a Mongo `$regex` from Bun is broken. */
  nameLower: string
  kind: AnalyticKind
  unit?: string
  contactId?: Types.ObjectId
  bankAccountId?: Types.ObjectId
  fixedAssetId?: Types.ObjectId
  /** The analytic's own properties as the accountant's file lists them (ПАРАМЕТРИ), in file order. A list of pairs, not a map: some names carry dots. Never for ПЕРСОНАЛ. */
  params?: { key: string; value: string }[]
  isActive: boolean
  deactivatedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const accountingAnalyticSchema = new Schema<IAccountingAnalytic>(
  {
    path: { type: String, required: true },
    root: { type: String, required: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'AccountingAnalytic' },
    name: { type: String, required: true },
    nameLower: { type: String, required: true },
    kind: { type: String, required: true, enum: ANALYTIC_KINDS, default: 'other' },
    unit: String,
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    bankAccountId: { type: Schema.Types.ObjectId, ref: 'BankAccount' },
    fixedAssetId: { type: Schema.Types.ObjectId, ref: 'FixedAsset' },
    /** The analytic's own properties as the accountant's file lists them (ПАРАМЕТРИ), in file order. A list of pairs, not a map: some names carry dots. Never for ПЕРСОНАЛ. */
    params: { type: [new Schema({ key: { type: String, required: true }, value: { type: String, default: '' } }, { _id: false })], default: undefined },
    isActive: { type: Boolean, default: true },
    deactivatedAt: Date,
  },
  { timestamps: true },
)

accountingAnalyticSchema.plugin(tenantPlugin)
accountingAnalyticSchema.index({ orgId: 1, path: 1 }, { unique: true })
accountingAnalyticSchema.index({ orgId: 1, root: 1, nameLower: 1 })

replicate(accountingAnalyticSchema, { class: 'R' })

export const AccountingAnalytic = model<IAccountingAnalytic>('AccountingAnalytic', accountingAnalyticSchema)
