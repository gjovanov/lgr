import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

/** What a return is filed as. `vat` today; the payroll filings follow (FR-25 §3.10). Unset on a hand-made return. */
export const TAX_RETURN_KINDS = ['vat', 'decl1_6', 'etz', 'art73_6'] as const

export const TAX_RETURN_STATUSES = ['draft', 'generated', 'filed', 'paid', 'corrected'] as const

export interface ITaxReturnLine {
  description: string
  taxableAmount: number
  taxRate: number
  taxAmount: number
  accountId: Types.ObjectId
}

/** A file of the return. Its bytes regenerate from the frozen rows, and `sha256` is what they must equal. */
export interface ITaxReturnFile {
  name: string
  /** Set where the bytes are kept as a `File`. A VAT file has none: see `vat-return.service.ts`. */
  fileId?: Types.ObjectId
  sha256: string
  /** The file's size. */
  bytes: number
}

/** Who a VAT return names. None of it follows from the registers. */
export interface ITaxReturnDeclarant {
  vatId: string
  name: string
  filer: string
  vies?: {
    /** ⚠ An ЕГН or ЛНЧ: `select: false`, so no list or get serialises it. */
    id?: string
    name: string
    city: string
    postcode: string
    address: string
    kind: string
    companyAddress: string
  }
}

export interface ITaxReturn extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  type: string
  /** Set on a return its filing flow owns (FR-25 §3.8), which no generic route may then change. */
  kind?: (typeof TAX_RETURN_KINDS)[number]
  /** `YYYYMM`, on a return that has a `kind`. */
  periodCode?: string
  /** `DEKLAR`'s cells by official code, in integer cents. `01-33` is in hundredths. A blank cell has no key. */
  cells?: Record<string, number>
  rowCounts?: { sales: number; purchase: number }
  declarant?: ITaxReturnDeclarant
  files?: ITaxReturnFile[]
  /** Read from the filed files, or generated here. */
  source?: 'imported' | 'generated'
  /** The authority's acknowledgement: LGR never files, a person does (D7). */
  ack?: { number: string; fileId?: Types.ObjectId }
  /** On a correction, the return it replaces. */
  supersedesId?: Types.ObjectId
  period: {
    from: Date
    to: Date
  }
  status: string
  totalTax: number
  totalInput: number
  totalOutput: number
  netPayable: number
  lines: ITaxReturnLine[]
  filedAt?: Date
  filedBy?: Types.ObjectId
  attachments: Types.ObjectId[]
  createdAt: Date
  updatedAt: Date
}

const taxReturnLineSchema = new Schema<ITaxReturnLine>(
  {
    description: { type: String, required: true },
    taxableAmount: { type: Number, required: true },
    taxRate: { type: Number, required: true },
    taxAmount: { type: Number, required: true },
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
  },
  { _id: false },
)

const taxReturnSchema = new Schema<ITaxReturn>(
  {
    type: {
      type: String,
      required: true,
      enum: ['vat', 'income_tax', 'corporate_tax', 'payroll_tax'],
    },
    period: {
      from: { type: Date, required: true },
      to: { type: Date, required: true },
    },
    status: {
      type: String,
      required: true,
      default: 'draft',
      enum: TAX_RETURN_STATUSES,
    },
    kind: { type: String, enum: TAX_RETURN_KINDS },
    periodCode: String,
    cells: Schema.Types.Mixed,
    rowCounts: { sales: Number, purchase: Number },
    declarant: {
      vatId: String,
      name: String,
      filer: String,
      vies: {
        id: { type: String, select: false },
        name: String,
        city: String,
        postcode: String,
        address: String,
        kind: String,
        companyAddress: String,
      },
    },
    files: [{
      _id: false,
      name: { type: String, required: true },
      fileId: { type: Schema.Types.ObjectId, ref: 'File' },
      sha256: { type: String, required: true },
      bytes: { type: Number, required: true },
    }],
    source: { type: String, enum: ['imported', 'generated'] },
    ack: {
      number: String,
      fileId: { type: Schema.Types.ObjectId, ref: 'File' },
    },
    supersedesId: { type: Schema.Types.ObjectId, ref: 'TaxReturn' },
    totalTax: { type: Number, required: true, default: 0 },
    totalInput: { type: Number, required: true, default: 0 },
    totalOutput: { type: Number, required: true, default: 0 },
    netPayable: { type: Number, required: true, default: 0 },
    lines: [taxReturnLineSchema],
    filedAt: Date,
    filedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    attachments: [{ type: Schema.Types.ObjectId, ref: 'File' }],
  },
  { timestamps: true },
)

taxReturnSchema.plugin(tenantPlugin)
taxReturnSchema.index({ orgId: 1, type: 1, 'period.from': -1 })
// One return per period, and one per return it corrects. A hand-made return has no `kind` and is not in it.
taxReturnSchema.index(
  { orgId: 1, kind: 1, periodCode: 1, supersedesId: 1 },
  { unique: true, name: 'tax_return_period_unique', partialFilterExpression: { kind: { $exists: true } } },
)

replicate(taxReturnSchema, { class: 'R' })

export const TaxReturn = model<ITaxReturn>('TaxReturn', taxReturnSchema)
