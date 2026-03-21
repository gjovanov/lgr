import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IKnowledgeArticleVersion {
  content: string
  editorId: Types.ObjectId
  date: Date
}

export interface IKnowledgeArticleShare {
  userId: Types.ObjectId
  canEdit: boolean
}

export interface IKnowledgeArticle extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  content: string
  parentId?: Types.ObjectId
  authorId: Types.ObjectId
  lastEditorId: Types.ObjectId
  accessLevel: string             // private, internal, public
  sharedWith: IKnowledgeArticleShare[]
  tags?: string[]
  isFavorite: boolean
  version: number
  versions: IKnowledgeArticleVersion[]
  isPublished: boolean
  relatedEntityType?: string
  relatedEntityId?: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const versionSchema = new Schema({ content: { type: String, required: true }, editorId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, date: { type: Date, required: true } }, { _id: false })
const shareSchema = new Schema({ userId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, canEdit: { type: Boolean, default: false } }, { _id: false })

const knowledgeArticleSchema = new Schema<IKnowledgeArticle>(
  {
    name: { type: String, required: true },
    content: { type: String, default: '' },
    parentId: { type: Schema.Types.ObjectId, ref: 'KnowledgeArticle' },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    lastEditorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    accessLevel: { type: String, default: 'internal', enum: ['private', 'internal', 'public'] },
    sharedWith: [shareSchema],
    tags: [String],
    isFavorite: { type: Boolean, default: false },
    version: { type: Number, default: 1 },
    versions: [versionSchema],
    isPublished: { type: Boolean, default: false },
    relatedEntityType: String,
    relatedEntityId: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
)

knowledgeArticleSchema.plugin(tenantPlugin)
knowledgeArticleSchema.index({ orgId: 1, parentId: 1 })
knowledgeArticleSchema.index({ orgId: 1, authorId: 1 })
knowledgeArticleSchema.index({ orgId: 1, isPublished: 1, accessLevel: 1 })
knowledgeArticleSchema.index({ orgId: 1, tags: 1 })
knowledgeArticleSchema.index({ orgId: 1, relatedEntityType: 1, relatedEntityId: 1 })
knowledgeArticleSchema.index({ name: 'text', content: 'text', tags: 'text' })

export const KnowledgeArticle = model<IKnowledgeArticle>('KnowledgeArticle', knowledgeArticleSchema)
