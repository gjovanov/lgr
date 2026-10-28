import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

/**
 * Learned per-supplier product-name mapping.
 *
 * Supplier invoices name products in their own catalogue language (DIN vs ISO
 * fastener designations, abbreviations, German/English names) which rarely matches
 * our nomenclature. Every confirmed match (import convert, manual fix in the review
 * UI) is persisted here, so subsequent imports from the same supplier resolve the
 * same wording without AI help.
 */
export interface ISupplierProductAlias extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  /** The supplier contact this alias belongs to. */
  supplierId: Types.ObjectId
  /** Original supplier wording, verbatim (for display/audit). */
  aliasText: string
  /** Normalised form used for lookups: bg-lowercased + collapsed whitespace. */
  aliasNormalized: string
  productId: Types.ObjectId
  /** Where the mapping came from: import convert, explicit user fix, or AI match. */
  source: 'import' | 'user' | 'ai'
  /** How many times this alias resolved a line. */
  hits: number
  lastUsedAt: Date
  createdAt: Date
  updatedAt: Date
}

/** Normalise supplier wording for exact-lookup: bg-lowercase + collapse whitespace runs. */
export function normalizeAlias(text: string): string {
  return (text || '').toLocaleLowerCase('bg').replace(/\s+/g, ' ').trim()
}

const aliasSchema = new Schema<ISupplierProductAlias>(
  {
    supplierId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    aliasText: { type: String, required: true },
    aliasNormalized: { type: String, required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    source: { type: String, enum: ['import', 'user', 'ai'], default: 'import' },
    hits: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
)

aliasSchema.plugin(tenantPlugin)
aliasSchema.index({ orgId: 1, supplierId: 1, aliasNormalized: 1 }, { unique: true })
aliasSchema.index({ orgId: 1, productId: 1 })

replicate(aliasSchema, { class: 'R' })

export const SupplierProductAlias = model<ISupplierProductAlias>('SupplierProductAlias', aliasSchema)
