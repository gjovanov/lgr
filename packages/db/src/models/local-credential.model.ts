import { Schema, model, type Document, type Types } from 'mongoose'

/**
 * A person's credential for THIS master (FR-20.40, plan step P1-5): a till PIN of at least six
 * digits, or a local password for an outage. It never leaves the node.
 *
 * ⚠ What this is NOT:
 * - not an Identity field: an Identity travels in every backup bundle of the person's orgs
 *   (`backup-bundle.service.ts#PEOPLE_MODEL`), and FR-20.21 says no backup holds a local
 *   credential. With no `orgId`, `tenantCollections()` never bundles this collection;
 * - not tenant data: no `tenantPlugin`. A person has one PIN per master, whatever orgs it homes;
 * - not a lockout: `failures` and `nextAttemptAt` slow guessing down and never stop it (trap 32:
 *   a PIN that locks lets anyone at a till lock every operator out for the length of an outage).
 *
 * `tvAtSet` is the person's `tokenVersion` when it was set. A later bump (a password change, a
 * sign-out everywhere) invalidates it, so the next sign-in must use the password.
 *
 * `source: 'lgrai'` (FR-20.40, plan step P2-4c): the person set it on lgrai.app, for `forOrgId`,
 * and the credential feed delivered it; that feed may also take it away. A row without a source was
 * set on this master, and the feed never removes one.
 *
 * ⚠ `forOrgId`, never `orgId`: a model with an `orgId` path is org data to the backup bundle
 * (`tenantCollections()`), and FR-20.21 says no backup holds a local credential.
 */
export type LocalCredentialKind = 'pin' | 'password'

export interface ILocalCredential extends Document {
  identityId: Types.ObjectId
  kind: LocalCredentialKind
  /** argon2id (`Bun.password.hash`). */
  verifier: string
  tvAtSet: number
  failures: number
  nextAttemptAt?: Date
  setAt: Date
  source?: 'lgrai'
  /** The org it was set for on lgrai.app (`source: 'lgrai'` only). */
  forOrgId?: Types.ObjectId
}

const localCredentialSchema = new Schema<ILocalCredential>(
  {
    identityId: { type: Schema.Types.ObjectId, ref: 'Identity', required: true },
    kind: { type: String, required: true, enum: ['pin', 'password'] },
    verifier: { type: String, required: true, select: false },
    tvAtSet: { type: Number, required: true, default: 0 },
    failures: { type: Number, required: true, default: 0 },
    nextAttemptAt: Date,
    setAt: { type: Date, required: true, default: Date.now },
    source: { type: String, enum: ['lgrai'] },
    forOrgId: { type: Schema.Types.ObjectId, ref: 'Org' },
  },
  { collection: 'local_credentials' },
)

localCredentialSchema.index({ identityId: 1, kind: 1 }, { unique: true })

export const LocalCredential = model<ILocalCredential>('LocalCredential', localCredentialSchema)
