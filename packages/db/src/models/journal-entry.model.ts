import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

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
  /** FR-25 §3.4: one operation is two lines, a debit and a credit, sharing this number. */
  opNo?: number
  /**
   * Which side of the operation the line is on, stated rather than read off the amounts: a
   * correction is a negative amount on its side (FR-25 §1.4), and a line of 0 has no side of its own
   * while still moving a quantity.
   */
  side?: 'debit' | 'credit'
  analyticId?: Types.ObjectId
  /** As booked: an operation's quantity is on both its lines, and a negative one stays negative. */
  quantity?: number
  unit?: string
  /** The invoices a bank line pays, named in its comment. */
  settles?: { docType: string; docNumber: string }[]
  /** Whose line this is: the store, or the books org while the source does not say (FR-25 D1). */
  branchOrgId?: Types.ObjectId
  /** The currency the operation was made in. `debit`/`credit` stay in the ledger's currency. */
  fx?: { currency: string; rate?: number; amount?: number }
  /** PlusMinus's own journal (`ТРЗ`, `ДДС`, `ПРИКЛ`), where the row names one. */
  journalCode?: string
  /** The export's `Данък` column, where the row fills it. */
  taxCode?: string
}

/** Which ledger an entry is in (FR-25 §3.4). Unset reads as `books`, and every report filters on it. */
export const LEDGERS = ['books', 'shadow'] as const
export type Ledger = (typeof LEDGERS)[number]

/**
 * What a statement reads: posted, and not in the shadow ledger. A `$ne`, never `ledger: 'books'`:
 * every entry from before FR-25 has no `ledger`, and they are books.
 */
export const POSTED_BOOKS = { status: 'posted', ledger: { $ne: 'shadow' } } as const

/** `sourceModule` of an entry imported from PlusMinus (FR-25 §5). */
export const BOOKS_IMPORT = 'plusminus'

/**
 * A year's imported opening. It RESTATES what the year before ended with, so a reading that adds up
 * lines starts at the last one, and it is no turnover. Only an imported one does: an `opening` entry
 * typed by hand in any other org adds to what is there, as it always did.
 */
export const IMPORTED_OPENING = { type: 'opening', sourceModule: BOOKS_IMPORT } as const

export interface IJournalEntry extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  journalId?: Types.ObjectId
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
  /** FR-25 §3.4. */
  ledger?: Ledger
  /** The document's type (`services/biz/accounting-books/registry.ts`). Unset: an operation with no document. */
  docType?: string
  docNumber?: string
  /** `date` stays the posting date. */
  docDate?: Date
  /** The document's `Вид`, which decides the VAT register's columns. */
  vatKind?: string
  /** The document's own total, in `docCurrency`: gross, and not the sum of its operations. */
  docTotal?: number
  docVat?: number
  docCurrency?: string
  /** The customer or supplier the document is about. */
  partnerAnalyticId?: Types.ObjectId
  /** Whose document this is: the store, or the books org while the source does not say (FR-25 D1). */
  branchOrgId?: Types.ObjectId
  sourceOrgId?: Types.ObjectId
  /** The import that last wrote it. */
  importBatchId?: Types.ObjectId
  /** What a re-import of its month matches it by, and whether it changed (FR-25 §5.5). */
  importKey?: string
  importHash?: string
  createdAt: Date
  updatedAt: Date
}

const journalEntryLineSchema = new Schema<IJournalEntryLine>(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
    description: String,
    debit: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },
    currency: { type: String, default: 'EUR' },
    exchangeRate: { type: Number, required: true, default: 1 },
    baseDebit: { type: Number, required: true, default: 0 },
    baseCredit: { type: Number, required: true, default: 0 },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    projectId: { type: Schema.Types.ObjectId, ref: 'ConstructionProject' },
    costCenterId: String,
    tags: [String],
    opNo: Number,
    side: { type: String, enum: ['debit', 'credit'] },
    analyticId: { type: Schema.Types.ObjectId, ref: 'AccountingAnalytic' },
    quantity: Number,
    unit: String,
    settles: {
      type: [new Schema({ docType: { type: String, required: true }, docNumber: { type: String, required: true } }, { _id: false })],
      default: undefined,
    },
    branchOrgId: { type: Schema.Types.ObjectId, ref: 'Org' },
    fx: {
      type: new Schema({ currency: { type: String, required: true }, rate: Number, amount: Number }, { _id: false }),
      default: undefined,
    },
    journalCode: String,
    taxCode: String,
  },
  { _id: false },
)

const journalEntrySchema = new Schema<IJournalEntry>(
  {
    journalId: { type: Schema.Types.ObjectId, ref: 'Journal' },
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
    ledger: { type: String, enum: LEDGERS },
    docType: String,
    docNumber: String,
    docDate: Date,
    vatKind: String,
    docTotal: Number,
    docVat: Number,
    docCurrency: String,
    partnerAnalyticId: { type: Schema.Types.ObjectId, ref: 'AccountingAnalytic' },
    branchOrgId: { type: Schema.Types.ObjectId, ref: 'Org' },
    sourceOrgId: { type: Schema.Types.ObjectId, ref: 'Org' },
    importBatchId: Schema.Types.ObjectId,
    importKey: String,
    importHash: String,
  },
  { timestamps: true },
)

journalEntrySchema.plugin(tenantPlugin)
journalEntrySchema.index({ orgId: 1, entryNumber: 1 }, { unique: true })
journalEntrySchema.index({ orgId: 1, date: -1 })
journalEntrySchema.index({ orgId: 1, status: 1 })
journalEntrySchema.index({ orgId: 1, 'lines.accountId': 1, date: -1 })
journalEntrySchema.index({ orgId: 1, fiscalPeriodId: 1 })
// FR-25 §3.4. A year is 150k rows: the reports aggregate over these, and never load the entries.
journalEntrySchema.index({ orgId: 1, ledger: 1, date: 1 })
journalEntrySchema.index({ orgId: 1, 'lines.analyticId': 1, date: 1 })
journalEntrySchema.index({ orgId: 1, docType: 1, docNumber: 1 })
// Every balance up to a moment asks for the last imported opening, and most orgs have none.
journalEntrySchema.index({ orgId: 1, type: 1, date: -1 })
// One imported entry per key: of two imports of a month at once, the second fails instead of doubling it.
journalEntrySchema.index({ orgId: 1, importKey: 1 }, { unique: true, partialFilterExpression: { importKey: { $type: 'string' } } })

replicate(journalEntrySchema, { class: 'R' })

export const JournalEntry = model<IJournalEntry>('JournalEntry', journalEntrySchema)
