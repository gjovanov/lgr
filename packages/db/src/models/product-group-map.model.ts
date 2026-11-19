import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

/**
 * Where a product's accounting group came from (FR-25 §6.1). `exact` and `learned` are LGR's own
 * proposals (`services/biz/accounting-books/product-groups.ts`); `accountant` is the accountant's
 * decision, which nothing automatic ever overwrites. `rule` and `ai` are reserved for the later
 * steps of §6.1.
 */
export const PRODUCT_GROUP_SOURCES = ['exact', 'learned', 'rule', 'ai', 'accountant'] as const
export type ProductGroupSource = (typeof PRODUCT_GROUP_SOURCES)[number]

/**
 * FR-25 §3.6: the accounting group a product's sales book to, an analytic under `СТОКИ:` (§1.3).
 * Not a field on `Product`: the grouping is the books' decision about a product (D5), and it lives
 * in the org that holds both since R7 (every org of a split carries the whole analytic tree, and a
 * store's products are its own). So the FR's `sourceOrgId` is gone: product, group and map are of
 * one org.
 *
 * ⚠ A row with `source: 'accountant'` or a `reviewedAt` is the accountant's: learning never changes
 * or removes it.
 */
export interface IProductGroupMap extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  productId: Types.ObjectId
  /** An analytic of kind `goods_group` of the same org. */
  analyticId: Types.ObjectId
  source: ProductGroupSource
  /** Documents whose books lines name this group for the product, in the period of the run that last set the row. */
  evidenceCount: number
  /** Documents in that period whose books lines name another group for it. */
  conflictCount: number
  /** The business day of the latest document of the evidence. */
  lastEvidenceAt?: Date
  reviewedBy?: Types.ObjectId
  reviewedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const productGroupMapSchema = new Schema<IProductGroupMap>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    analyticId: { type: Schema.Types.ObjectId, ref: 'AccountingAnalytic', required: true },
    source: { type: String, required: true, enum: PRODUCT_GROUP_SOURCES },
    evidenceCount: { type: Number, required: true, default: 0 },
    conflictCount: { type: Number, required: true, default: 0 },
    lastEvidenceAt: Date,
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
  },
  { timestamps: true },
)

productGroupMapSchema.plugin(tenantPlugin)
productGroupMapSchema.index({ orgId: 1, productId: 1 }, { unique: true })
productGroupMapSchema.index({ orgId: 1, analyticId: 1 })

replicate(productGroupMapSchema, { class: 'R' })

export const ProductGroupMap = model<IProductGroupMap>('ProductGroupMap', productGroupMapSchema)
