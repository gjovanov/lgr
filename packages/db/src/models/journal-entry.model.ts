import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IJournalEntryLine {
  accountId: Types.ObjectId
  description?: string
  debit: number
  credit: number
  currency: string
  exchangeRate: number
  baseDebit: number
  baseCredit: number
  contactId?: Types.ObjectId
  projectId?: Types.ObjectId
  costCenterId?: string
  tags?: string[]
}

export interface IJournalEntry extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  entryNumber: string
  date: Date
  fiscalPeriodId: Types.ObjectId
  description: string
  reference?: string
  type: string
  status: string
  lines: IJournalEntryLine[]
  totalDebit: number
  totalCredit: number
  attachments: Types.ObjectId[]
  sourceModule?: string
  sourceId?: Types.ObjectId
  createdBy: Types.ObjectId
  postedBy?: Types.ObjectId
  postedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const journalEntryLineSchema = new Schema<IJournalEntryLine>(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
    description: String,
    debit: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },
    currency: { type: String, required: true },
    exchangeRate: { type: Number, required: true, default: 1 },
    baseDebit: { type: Number, required: true, default: 0 },
    baseCredit: { type: Number, required: true, default: 0 },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    projectId: { type: Schema.Types.ObjectId, ref: 'ConstructionProject' },
    costCenterId: String,
    tags: [String],
  },
  { _id: false },
)

const journalEntrySchema = new Schema<IJournalEntry>(
  {
    entryNumber: { type: String, required: true },
    date: { type: Date, required: true },
    fiscalPeriodId: { type: Schema.Types.ObjectId, ref: 'FiscalPeriod', required: true },
    description: { type: String, required: true },
    reference: String,
    type: {
      type: String,
      required: true,
      default: 'standard',
      enum: ['standard', 'adjusting', 'closing', 'reversing', 'opening'],
    },
    status: {
      type: String,
      required: true,
      default: 'draft',
      enum: ['draft', 'posted', 'voided'],
    },
    lines: [journalEntryLineSchema],
    totalDebit: { type: Number, required: true, default: 0 },
    totalCredit: { type: Number, required: true, default: 0 },
    attachments: [{ type: Schema.Types.ObjectId, ref: 'File' }],
    sourceModule: String,
    sourceId: Schema.Types.ObjectId,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    postedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    postedAt: Date,
  },
  { timestamps: true },
)

journalEntrySchema.plugin(tenantPlugin)
journalEntrySchema.index({ orgId: 1, entryNumber: 1 }, { unique: true })
journalEntrySchema.index({ orgId: 1, date: -1 })
journalEntrySchema.index({ orgId: 1, status: 1 })
journalEntrySchema.index({ orgId: 1, 'lines.accountId': 1, date: -1 })
journalEntrySchema.index({ orgId: 1, fiscalPeriodId: 1 })

export const JournalEntry = model<IJournalEntry>('JournalEntry', journalEntrySchema)
