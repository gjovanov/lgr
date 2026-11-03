import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

export const VAT_SIDES = ['sales', 'purchase'] as const
export const VAT_LEDGERS = ['books', 'shadow'] as const

/**
 * One row of a VAT register, the sales register (`PRODAGBI`) or the purchase register (`POKUPKI`)
 * (FR-25 §3.8, §7.1). Rows are the record of a return: its files regenerate from them, byte for byte.
 *
 * A row may be re-numbered and rewritten while its return is open, and freezes at `filed`.
 */
export interface IVatRegisterEntry extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  /** `YYYYMM`, the period it is declared in. A purchase document chooses its own (§7.1). */
  period: string
  side: (typeof VAT_SIDES)[number]
  ledger: (typeof VAT_LEDGERS)[number]
  /** 1..n within the register, by date. */
  rowNo: number
  /** `01` invoice, `03` credit note, `09` protocol, `81` sales report … (§7.1). */
  docTypeCode: string
  docNumber: string
  /** The document's calendar day, at UTC midnight. */
  docDate: Date
  partnerVat?: string
  partnerName?: string
  description?: string
  /** The annex's branch number. Blank in everything filed so far. */
  branch?: number
  /** The annex's trailing two-character code (02-27, 03-45). Blank in everything filed so far. */
  code?: string
  /**
   * Value cells by their official code (`02-10`, `03-41`), in integer cents. A blank cell has no key,
   * so a document annulled in its own period has none.
   */
  cells: Record<string, number>
  /** The document behind the row, once LGR posts forward (R3, R4). Imported rows have none. */
  source?: { orgId?: Types.ObjectId; kind?: string; id?: Types.ObjectId }
  frozen: boolean
  createdAt: Date
  updatedAt: Date
}

const vatRegisterEntrySchema = new Schema<IVatRegisterEntry>(
  {
    period: { type: String, required: true },
    side: { type: String, required: true, enum: VAT_SIDES },
    ledger: { type: String, required: true, enum: VAT_LEDGERS, default: 'books' },
    rowNo: { type: Number, required: true },
    docTypeCode: { type: String, required: true },
    docNumber: { type: String, default: '' },
    docDate: { type: Date, required: true },
    partnerVat: String,
    partnerName: String,
    description: String,
    branch: Number,
    code: String,
    cells: { type: Schema.Types.Mixed, default: {} },
    source: {
      orgId: Schema.Types.ObjectId,
      kind: String,
      id: Schema.Types.ObjectId,
    },
    frozen: { type: Boolean, required: true, default: false },
  },
  // A blank row is a row: `minimize` would drop its empty `cells`.
  { timestamps: true, minimize: false },
)

vatRegisterEntrySchema.plugin(tenantPlugin)
vatRegisterEntrySchema.index({ orgId: 1, ledger: 1, period: 1, side: 1, rowNo: 1 })
// Frozen rows are the record, so their numbers are unique. An open row's number is only a place in
// the queue until `generate` numbers the register, which is why this stops at `frozen`.
vatRegisterEntrySchema.index(
  { orgId: 1, ledger: 1, period: 1, side: 1, rowNo: 1 },
  { unique: true, name: 'vat_row_frozen_unique', partialFilterExpression: { frozen: true } },
)

replicate(vatRegisterEntrySchema, { class: 'R' })

export const VatRegisterEntry = model<IVatRegisterEntry>('VatRegisterEntry', vatRegisterEntrySchema)
