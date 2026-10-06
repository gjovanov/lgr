import { Schema, model, type Document, type Types } from 'mongoose'

/**
 * A one-time link sent by email (multi-org sign-in, Phase 4): today, a password reset.
 *
 * Global like `Identity` (no `tenantPlugin`, no `orgId`): it belongs to a person, not an org.
 *
 * ⚠ Only the SHA-256 of the token is stored. The token itself exists in the email and nowhere
 * else, so a database read (a backup, an ops script, a leak) yields nothing that resets anyone's
 * password. Redemption is a conditional `findOneAndUpdate` on `usedAt: null` (the `OAuthHandoff`
 * pattern), so two simultaneous redeems of one link cannot both succeed.
 */
export type AuthTokenPurpose = 'password_reset'

export interface IAuthToken extends Document {
  _id: Types.ObjectId
  purpose: AuthTokenPurpose
  identityId: Types.ObjectId
  /** SHA-256 (hex) of the token in the link. */
  tokenHash: string
  expiresAt: Date
  /** Set when the link is used. Single use is enforced against this, not against deletion. */
  usedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

const authTokenSchema = new Schema<IAuthToken>(
  {
    purpose: { type: String, enum: ['password_reset'], required: true },
    identityId: { type: Schema.Types.ObjectId, ref: 'Identity', required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'auth_tokens' },
)

// The TTL reaper keeps the collection small; it is NOT the expiry check (it runs about once a
// minute), which the redeem makes itself by comparing `expiresAt`.
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
authTokenSchema.index({ identityId: 1, purpose: 1, createdAt: -1 })

export const AuthToken = model<IAuthToken>('AuthToken', authTokenSchema)
