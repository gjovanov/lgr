import { Schema, model, type Document, type Types } from 'mongoose'

/**
 * A person's credential for an org's ON-PREM server, as lgrai.app keeps it (FR-20.40, plan step
 * P2-4c): a local password for an outage, or a till PIN. The person sets it on their account here,
 * before the org moves too (§8's onboarding day), and global delivers it to the org's master sealed
 * to that master's seal key (`onprem-credentials.service.ts`).
 *
 * - **Only a verifier** (argon2id, `Bun.password.hash`), never the secret. Global keeps it so that a
 *   replacement master can receive it again, and for nothing else.
 * - ⚠ **NODE STATE** (`home/node-state.ts`): no `tenantPlugin`, though it carries an `orgId`.
 *   FR-20.21: no backup holds a local credential, and global writes these for an org whose home is
 *   a master, which the home write guard would refuse for org data.
 * - **A removal is a tombstone** (`removedAt`, no `verifier`), so the credential feed can tell the
 *   master; it expires after 30 days, and a master's daily full pass catches anything older.
 * - `tvAtSet` is the person's `tokenVersion` when it was set. A password change or a sign-out
 *   everywhere moves the person past it, and the credential stops working, here and on the master.
 */
export type OnpremCredentialKind = 'pin' | 'password'

export interface IOnpremCredential extends Document {
  identityId: Types.ObjectId
  orgId: Types.ObjectId
  kind: OnpremCredentialKind
  /** argon2id. Absent on a tombstone. */
  verifier?: string
  tvAtSet: number
  setAt: Date
  removedAt?: Date
  updatedAt: Date
}

const onpremCredentialSchema = new Schema<IOnpremCredential>(
  {
    identityId: { type: Schema.Types.ObjectId, ref: 'Identity', required: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    kind: { type: String, required: true, enum: ['pin', 'password'] },
    verifier: { type: String, select: false },
    tvAtSet: { type: Number, required: true, default: 0 },
    setAt: { type: Date, required: true, default: Date.now },
    removedAt: Date,
  },
  { timestamps: { createdAt: false, updatedAt: true }, collection: 'onprem_credentials' },
)

onpremCredentialSchema.index({ identityId: 1, orgId: 1, kind: 1 }, { unique: true })
// The credential feed: a master's orgs, in change order.
onpremCredentialSchema.index({ orgId: 1, updatedAt: 1, _id: 1 })
onpremCredentialSchema.index({ removedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 })

export const OnpremCredential = model<IOnpremCredential>('OnpremCredential', onpremCredentialSchema)
