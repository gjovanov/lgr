import { Schema, model, type Document as MongoDocument, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IDocumentShare {
  userId: Types.ObjectId
  permission: string // view, edit
}

export interface IDocumentVersion {
  version: number
  fileId: Types.ObjectId
  uploadedBy: Types.ObjectId
  uploadedAt: Date
  size: number
  notes?: string
}

export interface IDocument extends MongoDocument {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  workspaceId: Types.ObjectId
  folderId?: Types.ObjectId
  fileId: Types.ObjectId
  mimeType: string
  size: number
  tags?: string[]
  ownerId: Types.ObjectId
  accessLevel: string              // private, workspace, public
  sharedWith: IDocumentShare[]
  shareLink?: string
  shareLinkExpiry?: Date
  version: number
  versions: IDocumentVersion[]
  relatedEntityType?: string
  relatedEntityId?: Types.ObjectId
  isArchived: boolean
  ocrData?: Record<string, any>
  createdAt: Date
  updatedAt: Date
}

const documentShareSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    permission: { type: String, required: true, enum: ['view', 'edit'] },
  },
  { _id: false },
)

const documentVersionSchema = new Schema(
  {
    version: { type: Number, required: true },
    fileId: { type: Schema.Types.ObjectId, ref: 'File', required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    uploadedAt: { type: Date, required: true },
    size: { type: Number, required: true },
    notes: String,
  },
  { _id: false },
)

const documentSchema = new Schema<IDocument>(
  {
    name: { type: String, required: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: 'DocumentWorkspace', required: true },
    folderId: { type: Schema.Types.ObjectId, ref: 'DocumentWorkspace' },
    fileId: { type: Schema.Types.ObjectId, ref: 'File', required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    tags: [String],
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    accessLevel: {
      type: String,
      default: 'workspace',
      enum: ['private', 'workspace', 'public'],
    },
    sharedWith: [documentShareSchema],
    shareLink: String,
    shareLinkExpiry: Date,
    version: { type: Number, default: 1 },
    versions: [documentVersionSchema],
    relatedEntityType: String,
    relatedEntityId: { type: Schema.Types.ObjectId },
    isArchived: { type: Boolean, default: false },
    ocrData: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
)

documentSchema.plugin(tenantPlugin)
documentSchema.index({ orgId: 1, workspaceId: 1, isArchived: 1 })
documentSchema.index({ orgId: 1, ownerId: 1 })
documentSchema.index({ orgId: 1, tags: 1 })
documentSchema.index({ orgId: 1, relatedEntityType: 1, relatedEntityId: 1 })
documentSchema.index({ orgId: 1, 'sharedWith.userId': 1 })
documentSchema.index({ name: 'text', tags: 'text' })

export const DocumentModel = model<IDocument>('Document', documentSchema)
