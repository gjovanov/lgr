import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IDepreciationEntry {
  date: Date
  amount: number
  accumulatedAmount: number
  bookValue: number
  journalEntryId?: Types.ObjectId
}

export interface IFixedAsset extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  code: string
  name: string
  description?: string
  category: string
  accountId: Types.ObjectId
  depreciationAccountId: Types.ObjectId
  accumulatedDepAccountId: Types.ObjectId
  purchaseDate: Date
  purchasePrice: number
  currency: string
  salvageValue: number
  usefulLifeMonths: number
  depreciationMethod: string
  currentValue: number
  status: string
  disposalDate?: Date
  disposalPrice?: number
  depreciationSchedule: IDepreciationEntry[]
  location?: string
  assignedTo?: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const depreciationEntrySchema = new Schema<IDepreciationEntry>(
  {
    date: { type: Date, required: true },
    amount: { type: Number, required: true },
    accumulatedAmount: { type: Number, required: true },
    bookValue: { type: Number, required: true },
    journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
  },
  { _id: false },
)

const fixedAssetSchema = new Schema<IFixedAsset>(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
    category: { type: String, required: true },
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
    depreciationAccountId: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
    accumulatedDepAccountId: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
    purchaseDate: { type: Date, required: true },
    purchasePrice: { type: Number, required: true },
    currency: { type: String, required: true },
    salvageValue: { type: Number, required: true, default: 0 },
    usefulLifeMonths: { type: Number, required: true },
    depreciationMethod: {
      type: String,
      required: true,
      enum: ['straight_line', 'declining_balance', 'units_of_production'],
    },
    currentValue: { type: Number, required: true },
    status: {
      type: String,
      required: true,
      default: 'active',
      enum: ['active', 'disposed', 'fully_depreciated'],
    },
    disposalDate: Date,
    disposalPrice: Number,
    depreciationSchedule: [depreciationEntrySchema],
    location: String,
    assignedTo: { type: Schema.Types.ObjectId, ref: 'Employee' },
  },
  { timestamps: true },
)

fixedAssetSchema.plugin(tenantPlugin)
fixedAssetSchema.index({ orgId: 1, code: 1 }, { unique: true })
fixedAssetSchema.index({ orgId: 1, category: 1 })

export const FixedAsset = model<IFixedAsset>('FixedAsset', fixedAssetSchema)
