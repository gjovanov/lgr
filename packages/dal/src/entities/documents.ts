import type { TenantEntity } from '../types.js'

export interface IDocumentShare {
  userId: string
  permission: string
}

export interface IDocumentVersion {
  version: number
  fileId: string
  uploadedBy: string
  uploadedAt: Date
  size: number
  notes?: string
}

export interface IDocumentRecord extends TenantEntity {
  name: string
  workspaceId: string
  folderId?: string
  fileId: string
  mimeType: string
  size: number
  tags?: string[]
  ownerId: string
  accessLevel: string
  sharedWith: IDocumentShare[]
  shareLink?: string
  shareLinkExpiry?: Date
  version: number
  versions: IDocumentVersion[]
  relatedEntityType?: string
  relatedEntityId?: string
  isArchived: boolean
  ocrData?: Record<string, any>
}

export interface IDocumentWorkspace extends TenantEntity {
  name: string
  description?: string
  parentId?: string
  color?: string
  ownerId: string
  memberIds: string[]
  isActive: boolean
}

export interface ISigner {
  email: string
  name: string
  role: string
  order: number
  state: string
  signedDate?: Date
  signatureData?: string
  smsVerification: boolean
}

export interface ISignatureAuditEntry {
  action: string
  userId?: string
  date: Date
  ipAddress?: string
}

export interface ISignatureRequest extends TenantEntity {
  documentId: string
  state: string
  signers: ISigner[]
  sequentialSigning: boolean
  expiryDate?: Date
  reminderIntervalDays?: number
  completedDate?: Date
  auditTrail: ISignatureAuditEntry[]
  createdBy: string
}
