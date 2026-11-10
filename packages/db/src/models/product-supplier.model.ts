import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { loweredFieldsPlugin } from '../plugins/lowered-fields.plugin.js'
import { replicate } from '../replication/declare.js'

/**
 * FR-28.9 — what a person writes about an article and one of its suppliers: whether it is the supplier to order
 * from, the supplier's own code for the article, the usual lead time, a note.
 *
 * ⚠ This is NOT the record of who sold us the article. That is read from the documents each time (received bills
 * and goods receipts, `services/biz/product-suppliers.service.ts`) and stored nowhere, so a corrected bill can
 * never leave a stale copy behind. A row here is written by a person on the article's Suppliers tab and by nothing
 * else: no bill, receipt or import ever creates, changes or deletes one. It sits beside `SupplierProductAlias`,
 * which stays what it is (the wording a supplier's bills use for an article, written by the import).
 *
 * - One row per article and supplier (`{ orgId, productId, supplierId }` is unique).
 * - `preferred` is unique per article, and the database says so: a partial unique index over the rows that are
 *   preferred. Setting another supplier preferred clears the previous one first, so there is never a moment with
 *   two (and, between the two writes, a moment with none, which falls back to the last purchase as before).
 * - `supplierSkuLower` is the Cyrillic-safe mirror of `supplierSku` that the product search matches (FR-28.10).
 *   `loweredFieldsPlugin` keeps it; the service sets it in the same write as well, because an unset of the code
 *   is an operator the plugin does not see.
 * - Replication class R, like every document of an org: the whole row travels (`db/replication/declare.ts`).
 */
export interface IProductSupplier extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  productId: Types.ObjectId
  /** The supplier contact (type `supplier` or `both`, active when it was recorded). */
  supplierId: Types.ObjectId
  preferred: boolean
  /** The supplier's own code for the article. */
  supplierSku?: string
  supplierSkuLower?: string
  leadTimeDays?: number
  note?: string
  createdAt: Date
  updatedAt: Date
}

const productSupplierSchema = new Schema<IProductSupplier>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    preferred: { type: Boolean, default: false },
    supplierSku: String,
    supplierSkuLower: String,
    leadTimeDays: { type: Number, min: 0 },
    note: String,
  },
  { timestamps: true },
)

productSupplierSchema.plugin(tenantPlugin)
productSupplierSchema.plugin(loweredFieldsPlugin, { fields: { supplierSku: 'supplierSkuLower' } })

// One row per article and supplier.
productSupplierSchema.index({ orgId: 1, productId: 1, supplierId: 1 }, { unique: true })
// At most one preferred supplier per article: a partial unique index, so two writers cannot both win.
productSupplierSchema.index(
  { orgId: 1, productId: 1 },
  { unique: true, partialFilterExpression: { preferred: true }, name: 'orgId_1_productId_1_preferred' },
)
// The supplier's side: the Products list's Supplier filter, and the articles of a supplier (FR-28.8).
productSupplierSchema.index({ orgId: 1, supplierId: 1 })
// The product search by the supplier's code (FR-28.10).
productSupplierSchema.index({ orgId: 1, supplierSkuLower: 1 }, { sparse: true })

replicate(productSupplierSchema, { class: 'R' })

export const ProductSupplier = model<IProductSupplier>('ProductSupplier', productSupplierSchema)
