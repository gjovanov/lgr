import { Schema, model, type Document, type Types } from 'mongoose'

export type InviteStatus = 'active' | 'expired' | 'revoked' | 'exhausted'

export interface IInvite extends Document {
  _id: Types.ObjectId
  code: string
  orgId: Types.ObjectId
  inviterId: Types.ObjectId
  targetEmail?: string
  maxUses?: number
  useCount: number
  status: InviteStatus
  assignRole: string
  expiresAt?: Date
  createdAt: Date
  updatedAt: Date
}

const inviteSchema = new Schema<IInvite>(
  {
    code: { type: String, required: true, unique: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    inviterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    targetEmail: { type: String },
    maxUses: { type: Number },
    useCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['active', 'expired', 'revoked', 'exhausted'],
      default: 'active',
    },
    assignRole: { type: String, default: 'member' },
    expiresAt: { type: Date },
  },
  { timestamps: true },
)

inviteSchema.index({ orgId: 1, status: 1 })

export const Invite = model<IInvite>('Invite', inviteSchema)
