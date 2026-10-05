import { Schema, model, type Document, type Types } from 'mongoose'

/**
 * Who set an identity's password, which decides who may change it and whether it may reach a second
 * organisation:
 *   - `self`   the person did: registration, a self-service change, a reset by email;
 *   - `admin`  an org admin did, so that admin knows it;
 *   - `legacy` the identity migration carried it over from a per-org `User`, and nobody can say who
 *     chose it. Treated like `admin` wherever that matters.
 */
export type PasswordSetBy = 'self' | 'admin' | 'legacy'

export interface IIdentityProvider {
  provider: string
  providerId: string
  /**
   * Whether this link was made on a provider-VERIFIED email or by the person signing in through it.
   * Links the migration copied from per-org users are `false`: before S-20 an unverified provider
   * email was enough to link, so an old link proves nothing until a sign-in re-confirms it.
   */
  verified: boolean
  linkedAt: Date
}

/**
 * A person: one sign-in for every organisation they belong to (the multi-org sign-in).
 *
 * Each org's `User` document stays the person's MEMBERSHIP there — role, permission sets, operator
 * code, role history, per-org username — and points here through `User.identityId`. What lives
 * here is what is the PERSON's rather than any org's: the sign-in email, the password, the OAuth
 * links and the profile.
 *
 * Global on purpose: no `tenantPlugin`, no `orgId` path. Per-org backups therefore skip it
 * (`backup-bundle.service.ts#tenantCollections`), as they skip `orgs`, and a per-org restore assumes
 * both exist.
 */
export interface IIdentity extends Document {
  _id: Types.ObjectId
  /** Lowercased and trimmed; unique. The sign-in identifier and where a reset link goes. */
  email: string
  emailVerified: boolean
  emailVerifiedAt?: Date
  /** argon2id (`Bun.password`). `select: false`, so no projection forgetting it leaks it (S-14). */
  password?: string
  passwordSetBy?: PasswordSetBy
  /** The org whose admin set it, when `passwordSetBy` is `admin`. */
  passwordSetByOrgId?: Types.ObjectId
  passwordChangedAt?: Date
  /** Bumped on a password change or reset; a session carrying an older one is refused. */
  tokenVersion: number
  oauthProviders: IIdentityProvider[]
  firstName: string
  middleName?: string
  lastName: string
  avatar?: string
  /** `false` while a self-registration waits for its activation email. */
  isActive: boolean
  /** The org this person last chose. Only their own sign-ins and switches set it. */
  lastOrgId?: Types.ObjectId
  lastLoginAt?: Date
  /** Set by `scripts/migrate-identities.ts`: which run created this, from which users (rollback). */
  migration?: {
    runId: string
    sourceUserIds: Types.ObjectId[]
  }
  createdAt: Date
  updatedAt: Date
}

const identitySchema = new Schema<IIdentity>(
  {
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    emailVerified: { type: Boolean, required: true, default: false },
    emailVerifiedAt: { type: Date },
    password: { type: String, select: false },
    passwordSetBy: { type: String, enum: ['self', 'admin', 'legacy'] },
    passwordSetByOrgId: { type: Schema.Types.ObjectId, ref: 'Org' },
    passwordChangedAt: { type: Date },
    tokenVersion: { type: Number, required: true, default: 0 },
    oauthProviders: [
      {
        _id: false,
        provider: { type: String, required: true },
        providerId: { type: String, required: true },
        verified: { type: Boolean, required: true, default: false },
        linkedAt: { type: Date, required: true, default: () => new Date() },
      },
    ],
    firstName: { type: String, required: true },
    middleName: { type: String },
    lastName: { type: String, required: true },
    avatar: { type: String },
    isActive: { type: Boolean, required: true, default: true },
    lastOrgId: { type: Schema.Types.ObjectId, ref: 'Org' },
    lastLoginAt: { type: Date },
    migration: {
      runId: { type: String },
      sourceUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    },
  },
  { timestamps: true, collection: 'identities' },
)

// One identity per provider account. Partial, so identities with no links (password-only) do not
// all collide on a missing key.
identitySchema.index(
  { 'oauthProviders.provider': 1, 'oauthProviders.providerId': 1 },
  { unique: true, partialFilterExpression: { 'oauthProviders.providerId': { $exists: true } } },
)
identitySchema.index({ 'migration.runId': 1 }, { sparse: true })

export const Identity = model<IIdentity>('Identity', identitySchema)
