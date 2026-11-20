import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

/**
 * What an operation of a rule books (FR-25 §3.7): the net of the lines the rule is for, the document's VAT, the cost of
 * its goods (per goods group, at the books' average), or what was paid in cash as it was issued.
 */
export const POSTING_AMOUNTS = ['net', 'vat', 'cost', 'paid'] as const
export type PostingAmount = (typeof POSTING_AMOUNTS)[number]

/** Which lines a rule is for: goods (a product that is not a service) or services. Unset: the document as a whole. */
export const POSTING_LINE_KINDS = ['goods', 'service'] as const
export type PostingLineKind = (typeof POSTING_LINE_KINDS)[number]

/** `seed` as LGR wrote it; `accountant` once the accountant changed it. A seed run never touches an existing rule. */
export const POSTING_RULE_SOURCES = ['seed', 'accountant'] as const

/**
 * One operation, as the books book it: a debit and a credit account (codes of the org's own chart, never ids), what the
 * amount is, and the analytic on each side. An analytic is `contact` (the document's partner, under the rule's
 * `partnerRoot`) or `group` (the goods group of the lines, `ProductGroupMap`). Anything else is refused, not guessed.
 */
export interface IPostingRuleOperation {
  debit: string
  credit: string
  amount: PostingAmount
  analyticDebit?: string
  analyticCredit?: string
  /** One operation per goods group, carrying the group's quantity on both lines (`D702 K304[group]`). */
  perGroup?: boolean
}

export interface IPostingRuleMatch {
  /** The LGR document it is for: an `Invoice` type (`invoice`, `debit_note`, `credit_note`). */
  docKind: string
  direction: 'outgoing' | 'incoming'
  lineKind?: PostingLineKind
  /** For what was paid this way as the document was issued: its payments at the counter on its business day. */
  paymentMethod?: string
}

/**
 * FR-25 §3.7: how one kind of LGR document is booked, as data. The patterns the accountant's journal shows (§1.4), seeded
 * per org that keeps books (`services/biz/accounting-books/posting-rule-seed.ts`) and the accountant's to change: nothing
 * in the posting code names an account. The rules that match one document are applied together, and each amount the
 * document has must be carried by exactly one of their operations, or the document is not posted (it waits, counted).
 *
 * ⚠ A correction is the document's own sign, never the rule's: a credit note books the same operations, negative, on the
 * same sides (§1.4).
 */
export interface IPostingRule extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  /** Stable, unique per org: what a seed run recognises a rule by. */
  code: string
  label: string
  isActive: boolean
  match: IPostingRuleMatch
  /** The books' document type the entry carries (`-ФЕ`), from `accounting-books/registry.ts`. */
  docType: string
  /** The analytic root `contact` resolves under (`КЛИЕНТИ`). */
  partnerRoot?: string
  operations: IPostingRuleOperation[]
  /** The VAT register row the document makes: its register and its type (`01`, `02`, `03`). */
  vat?: { register: 'sales' | 'purchase'; docTypeCode: string; vatKind?: string }
  source: (typeof POSTING_RULE_SOURCES)[number]
  updatedBy?: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const analyticSpec = { type: String, maxlength: 300 }

const postingRuleSchema = new Schema<IPostingRule>(
  {
    code: { type: String, required: true, maxlength: 80 },
    label: { type: String, required: true, maxlength: 200 },
    isActive: { type: Boolean, required: true, default: true },
    match: {
      type: new Schema({
        docKind: { type: String, required: true },
        direction: { type: String, required: true, enum: ['outgoing', 'incoming'] },
        lineKind: { type: String, enum: POSTING_LINE_KINDS },
        paymentMethod: String,
      }, { _id: false }),
      required: true,
    },
    docType: { type: String, required: true, maxlength: 20 },
    partnerRoot: { type: String, maxlength: 100 },
    operations: {
      type: [new Schema({
        debit: { type: String, required: true, maxlength: 10 },
        credit: { type: String, required: true, maxlength: 10 },
        amount: { type: String, required: true, enum: POSTING_AMOUNTS },
        analyticDebit: analyticSpec,
        analyticCredit: analyticSpec,
        perGroup: Boolean,
      }, { _id: false })],
      required: true,
    },
    vat: {
      type: new Schema({
        register: { type: String, required: true, enum: ['sales', 'purchase'] },
        docTypeCode: { type: String, required: true, maxlength: 2 },
        vatKind: String,
      }, { _id: false }),
      default: undefined,
    },
    source: { type: String, required: true, enum: POSTING_RULE_SOURCES, default: 'seed' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
)

postingRuleSchema.plugin(tenantPlugin)
// One rule per code: of two seed runs at once, the second inserts nothing.
postingRuleSchema.index({ orgId: 1, code: 1 }, { unique: true })

replicate(postingRuleSchema, { class: 'R' })

export const PostingRule = model<IPostingRule>('PostingRule', postingRuleSchema)
