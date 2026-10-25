import { Schema, model, type Document, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * Global DIN ↔ ISO/EN fastener-standard reference catalog (org-independent —
 * no tenantPlugin, like ExchangeRate). Source of truth is the committed
 * scripts/data/din-catalog.json (165 rows in 12 Bulgarian categories),
 * loaded via scripts/seed-din-catalog.ts. Consumed by scripts/assign-din-tags.ts
 * for product tagging + recategorization.
 */
export interface IDinCatalog extends Document {
  _id: Types.ObjectId
  din: string // canonical designation, e.g. "DIN 933", "DIN 7504-K"
  baseNumber: string // digits only, e.g. "933", "7504"
  variant?: string // suffix after the dash, e.g. "K", "A", "1"
  iso: string[] // product-standard equivalents, e.g. ["ISO 4017"]
  en: string[] // e.g. ["EN 14399-4"]
  equivalentRaw: string // the catalog's "ISO / EN еквивалент" column verbatim
  description: string // Bulgarian description
  note: string // "Бележка" column
  categoryIndex: number // 1..12
  category: string // Bulgarian category name (= ProductCategory.name)
  createdAt: Date
  updatedAt: Date
}

const dinCatalogSchema = new Schema<IDinCatalog>(
  {
    din: { type: String, required: true },
    baseNumber: { type: String, required: true },
    variant: String,
    iso: { type: [String], default: [] },
    en: { type: [String], default: [] },
    equivalentRaw: { type: String, default: '' },
    description: { type: String, default: '' },
    note: { type: String, default: '' },
    categoryIndex: { type: Number, required: true, min: 1 },
    category: { type: String, required: true },
  },
  { timestamps: true, collection: 'din_catalog' },
)

dinCatalogSchema.index({ din: 1 }, { unique: true })
dinCatalogSchema.index({ baseNumber: 1 })
dinCatalogSchema.index({ categoryIndex: 1 })

replicate(dinCatalogSchema, { class: 'G' })

export const DinCatalog = model<IDinCatalog>('DinCatalog', dinCatalogSchema)
