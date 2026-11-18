import { Schema, model, type Document, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

export type InviteStatus = 'active' | 'expired' | 'revoked' | 'exhausted'

/**
 * FR-27 P3-7 (#529): the legacy role key as migration 0017 found it on this invite, and when it took it off. Nothing
 * reads it: it is kept for one release and then dropped (0018). ⚠ Never in a response.
 */
export interface IInviteLegacyArchive {
  assignRole?: string
  archivedAt: Date
}

export interface IInvite extends Document {
  _id: Types.ObjectId
  code: string
  orgId: Types.ObjectId
  inviterId: Types.ObjectId
  targetEmail?: string
  maxUses?: number
  useCount: number
  status: InviteStatus
  /** The legacy role key. FR-27 P3-5 (#529): no longer written; an invite from before that names only it still works. */
  assignRole?: string
  /** FR-27.4: the role the person starts with. */
  assignRoleId?: Types.ObjectId
  expiresAt?: Date
  /** FR-27 P3-7: see {@link IInviteLegacyArchive}. Written only by migration 0017. */
  legacyArchive?: IInviteLegacyArchive
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
    // FR-27 P3-5: legacy, no longer written (no default). P3-7 archives it.
    assignRole: { type: String },
    assignRoleId: { type: Schema.Types.ObjectId, ref: 'Role' },
    expiresAt: { type: Date },
    legacyArchive: {
      type: new Schema<IInviteLegacyArchive>({ assignRole: String, archivedAt: { type: Date, required: true } }, { _id: false }),
      default: undefined,
    },
  },
  { timestamps: true },
)

inviteSchema.index({ orgId: 1, status: 1 })

replicate(inviteSchema, { class: 'G' })

export const Invite = model<IInvite>('Invite', inviteSchema)
