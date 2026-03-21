import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IDocumentWorkspace extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  description?: string
  parentId?: Types.ObjectId
  color?: string
  ownerId: Types.ObjectId
  memberIds: Types.ObjectId[]
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

const documentWorkspaceSchema = new Schema<IDocumentWorkspace>(
  {
    name: { type: String, required: true },
    description: String,
    parentId: { type: Schema.Types.ObjectId, ref: 'DocumentWorkspace' },
    color: String,
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    memberIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
)

documentWorkspaceSchema.plugin(tenantPlugin)
documentWorkspaceSchema.index({ orgId: 1, name: 1 })
documentWorkspaceSchema.index({ orgId: 1, parentId: 1 })
documentWorkspaceSchema.index({ orgId: 1, ownerId: 1 })

export const DocumentWorkspace = model<IDocumentWorkspace>('DocumentWorkspace', documentWorkspaceSchema)
