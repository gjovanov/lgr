import { Schema, model, type Document, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

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
  /**
   * FR-27.4: the role the person starts with; none named is the org's default role. ⚠ FR-27 P3-9 (#529): there is no
   * legacy key (`assignRole`) any more: 0017 archived it and 0020 dropped the archive. Never add the path back.
   */
  assignRoleId?: Types.ObjectId
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
    assignRoleId: { type: Schema.Types.ObjectId, ref: 'Role' },
    expiresAt: { type: Date },
  },
  { timestamps: true },
)

inviteSchema.index({ orgId: 1, status: 1 })

replicate(inviteSchema, { class: 'G' })

export const Invite = model<IInvite>('Invite', inviteSchema)
