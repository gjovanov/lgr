import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { loweredFieldsPlugin } from '../plugins/lowered-fields.plugin.js'

/**
 * Files app — the CANONICAL record of an uploaded source document (a PlusMinus export:
 * invoicem / stokrazp / sklrazp / sklisk / salesAnalysis / storeAvailability …). Keyed by
 * `{orgId, docType, docNumber}` so a re-upload of the same document is idempotent: it
 * versions the file on disk and re-reconciles the booking instead of creating a duplicate.
 *
 * Bytes live in the PV under `<UPLOAD_DIR>/<orgId>/docs/<docDate>/<originalName>` with prior
 * copies moved to `…/<docDate>/versions/<name>_<prevUploadIso>.<ext>`. `File` (the generic
 * metadata model) still records each physical write; `DocFile` tracks the logical document.
 */
export type DocType =
  | 'invoice'         // invoicem_*  (sales / purchase)
  | 'cash_register'   // salesAnalysis_*.xlsx
  | 'goods_receipt'   // stokrazp_*  (Доставки)
  | 'correction'      // stokrazp_*  "2000 КОРЕКЦИЯ"
  | 'transfer_note'   // sklrazp_*
  | 'issue_note'      // sklisk_*
  | 'store_operations'// storeOperations_*.xlsx
  | 'store_availability' // storeAvailability_*.xlsx (snapshot — drives the auto-diff)
  | 'proforma'          // invoiceProf_*  (never booked — archived for the record)
  | 'journal_register' // docJournalReport_*.xlsx (-ФЕ/СР/СТ registers — verification only)
  | 'unknown'

export type DocFileStatus = 'uploaded' | 'extracted' | 'analyzed' | 'committed' | 'superseded'

export interface IDocFile extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  docType: DocType
  docNumber: string
  docNumberLower?: string
  docDate: string          // YYYY-MM-DD (from the doc header, or the xlsx filename)
  originalName: string
  currentPath: string
  currentChecksum: string  // sha256 of the current canonical bytes
  version: number
  mimeType: string
  size: number
  status: DocFileStatus
  committedTarget?: 'invoice' | 'movement' | 'compare'
  committedIds: Types.ObjectId[]
  markers?: string[]          // idempotency markers of the booked movements (Phase 3 reconcile key)
  supersededBy?: string       // the document that already carried this one's content (a re-export)
  createdProductIds?: Types.ObjectId[] // products this import created — the exact rollback set
  extractedText?: string      // OCR text (Phase 2)
  compareSummary?: unknown    // last storeAvailability auto-diff summary (Phase 2)
  analysis?: unknown          // last analyze/diff result (Phase 2/3)
  fileId?: Types.ObjectId  // ref to the generic File metadata row of the current version
  uploadedBy: Types.ObjectId
  uploadedAt: Date
  isActive: boolean
  deactivatedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const docFileSchema = new Schema<IDocFile>(
  {
    docType: { type: String, required: true, index: true },
    docNumber: { type: String, required: true },
    docNumberLower: { type: String },
    docDate: { type: String, required: true, index: true },
    originalName: { type: String, required: true },
    currentPath: { type: String, required: true },
    currentChecksum: { type: String, required: true },
    version: { type: Number, default: 1 },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    status: { type: String, default: 'uploaded' },
    committedTarget: { type: String, enum: ['invoice', 'movement', 'compare'] },
    committedIds: [{ type: Schema.Types.ObjectId }],
    markers: [{ type: String }],
    supersededBy: { type: String },
    createdProductIds: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
    extractedText: { type: String },
    compareSummary: { type: Schema.Types.Mixed },
    analysis: { type: Schema.Types.Mixed },
    fileId: { type: Schema.Types.ObjectId, ref: 'File' },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    uploadedAt: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true },
    deactivatedAt: { type: Date },
  },
  { timestamps: true },
)

docFileSchema.plugin(tenantPlugin)
docFileSchema.plugin(loweredFieldsPlugin, { fields: { docNumber: 'docNumberLower' } })
// Idempotency key — one canonical record per document number within a type.
docFileSchema.index({ orgId: 1, docType: 1, docNumber: 1 }, { unique: true })
docFileSchema.index({ orgId: 1, docDate: 1, docType: 1 })
docFileSchema.index({ orgId: 1, status: 1 })

export const DocFile = model<IDocFile>('DocFile', docFileSchema)
