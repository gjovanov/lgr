import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

/** A line of the bank's statement: imported from a statement file, or entered by hand where there is none (#675). */
export interface IBankReconciliationItem {
  _id?: Types.ObjectId
  date: Date
  description: string
  amount: number
  type: string
  matched: boolean
  journalEntryId?: Types.ObjectId
  bankReference?: string
  /** Where the line came from: a statement file, or a person. */
  source?: 'import' | 'manual'
}

/** A ledger line, by its journal entry and its place among the entry's lines (journal lines carry no id). */
export interface IReconciliationLedgerRef {
  journalEntryId: Types.ObjectId
  line: number
}

/** Bank lines and ledger lines matched together: their amounts agree. */
export interface IReconciliationMatch {
  _id?: Types.ObjectId
  bankItemIds: Types.ObjectId[]
  ledger: IReconciliationLedgerRef[]
}

export interface IBankReconciliation extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  bankAccountId: Types.ObjectId
  statementDate: Date
  statementBalance: number
  bookBalance: number
  difference: number
  status: string
  items: IBankReconciliationItem[]
  matches: IReconciliationMatch[]
  reconciledBy?: Types.ObjectId
  reconciledAt?: Date
  createdAt: Date
  updatedAt: Date
}

const bankReconciliationItemSchema = new Schema<IBankReconciliationItem>(
  {
    date: { type: Date, required: true },
    description: { type: String, required: true },
    amount: { type: Number, required: true },
    type: { type: String, required: true, enum: ['deposit', 'withdrawal'] },
    matched: { type: Boolean, default: false },
    journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
    bankReference: String,
    source: { type: String, enum: ['import', 'manual'] },
  },
  // #675: a line has an id, so a person can match it, unmatch it or delete it.
)

const reconciliationMatchSchema = new Schema<IReconciliationMatch>({
  bankItemIds: [{ type: Schema.Types.ObjectId }],
  ledger: [new Schema<IReconciliationLedgerRef>({
    journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry', required: true },
    line: { type: Number, required: true },
  }, { _id: false })],
})

const bankReconciliationSchema = new Schema<IBankReconciliation>(
  {
    bankAccountId: { type: Schema.Types.ObjectId, ref: 'BankAccount', required: true },
    statementDate: { type: Date, required: true },
    statementBalance: { type: Number, required: true },
    bookBalance: { type: Number, required: true },
    difference: { type: Number, required: true, default: 0 },
    status: { type: String, required: true, default: 'draft', enum: ['draft', 'completed'] },
    items: [bankReconciliationItemSchema],
    matches: [reconciliationMatchSchema],
    reconciledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reconciledAt: Date,
  },
  { timestamps: true },
)

bankReconciliationSchema.plugin(tenantPlugin)
bankReconciliationSchema.index({ orgId: 1, bankAccountId: 1, statementDate: -1 })

replicate(bankReconciliationSchema, { class: 'R' })

export const BankReconciliation = model<IBankReconciliation>('BankReconciliation', bankReconciliationSchema)
