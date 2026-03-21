import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface ISigner {
  email: string
  name: string
  role: string
  order: number
  state: string                   // waiting, sent, signed, refused
  signedDate?: Date
  signatureData?: string          // Base64 signature image
  smsVerification: boolean
}

export interface ISignatureAuditEntry {
  action: string
  userId?: Types.ObjectId
  date: Date
  ipAddress?: string
}

export interface ISignatureRequest extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  documentId: Types.ObjectId
  state: string                   // draft, sent, partially_signed, completed, cancelled, expired
  signers: ISigner[]
  sequentialSigning: boolean
  expiryDate?: Date
  reminderIntervalDays?: number
  completedDate?: Date
  auditTrail: ISignatureAuditEntry[]
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const signerSchema = new Schema(
  {
    email: { type: String, required: true },
    name: { type: String, required: true },
    role: { type: String, default: 'Signer' },
    order: { type: Number, required: true },
    state: {
      type: String,
      default: 'waiting',
      enum: ['waiting', 'sent', 'signed', 'refused'],
    },
    signedDate: Date,
    signatureData: String,
    smsVerification: { type: Boolean, default: false },
  },
  { _id: false },
)

const auditEntrySchema = new Schema(
  {
    action: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    date: { type: Date, required: true },
    ipAddress: String,
  },
  { _id: false },
)

const signatureRequestSchema = new Schema<ISignatureRequest>(
  {
    documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
    state: {
      type: String,
      required: true,
      default: 'draft',
      enum: ['draft', 'sent', 'partially_signed', 'completed', 'cancelled', 'expired'],
    },
    signers: [signerSchema],
    sequentialSigning: { type: Boolean, default: false },
    expiryDate: Date,
    reminderIntervalDays: Number,
    completedDate: Date,
    auditTrail: [auditEntrySchema],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

signatureRequestSchema.plugin(tenantPlugin)
signatureRequestSchema.index({ orgId: 1, documentId: 1 })
signatureRequestSchema.index({ orgId: 1, state: 1 })
signatureRequestSchema.index({ orgId: 1, 'signers.email': 1 })
signatureRequestSchema.index({ orgId: 1, createdBy: 1 })

export const SignatureRequest = model<ISignatureRequest>('SignatureRequest', signatureRequestSchema)
