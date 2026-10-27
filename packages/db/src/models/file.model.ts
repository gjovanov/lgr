import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

export interface IFile extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  uploadedBy: Types.ObjectId
  originalName: string
  storagePath: string
  storageProvider: string
  mimeType: string
  size: number
  /** SHA-256 of the bytes, hex (FR-20.24): what a file copied to another server is checked against. */
  sha256?: string
  module: string
  entityType?: string
  entityId?: Types.ObjectId
  aiRecognition?: {
    status: string
    extractedData?: object
    confidence?: number
    processedAt?: Date
  }
  tags?: string[]
  createdAt: Date
  updatedAt: Date
}

const fileSchema = new Schema<IFile>(
  {
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    originalName: { type: String, required: true },
    storagePath: { type: String, required: true },
    storageProvider: { type: String, default: 'local' },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: String,
    module: { type: String, required: true },
    entityType: String,
    entityId: Schema.Types.ObjectId,
    aiRecognition: {
      status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'] },
      extractedData: Schema.Types.Mixed,
      confidence: Number,
      processedAt: Date,
    },
    tags: [String],
  },
  { timestamps: true },
)

fileSchema.plugin(tenantPlugin)
fileSchema.index({ orgId: 1, module: 1 })
fileSchema.index({ orgId: 1, entityType: 1, entityId: 1 })
// FR-20.69 (P3-3): a master finds the file global asks for by its content.
fileSchema.index({ orgId: 1, sha256: 1 }, { partialFilterExpression: { sha256: { $type: 'string' } } })

replicate(fileSchema, { class: 'R' })

export const File = model<IFile>('File', fileSchema)
