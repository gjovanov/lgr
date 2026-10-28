import { Schema, model, type Document, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * A one-time handoff from the OAuth callback (in register mode) to the SPA's register form.
 *
 * ## Why this exists
 *
 * The callback used to redirect to `/auth/register?oauth_token=<JWT>`: an `oauth_pending` token
 * signed with the session secret, carrying the provider identity (provider, providerId, email,
 * name). The register view decoded it for the prefill and posted it back to
 * `POST /api/oauth/register-oauth`, which honoured whatever token it was sent. Two problems, the
 * same two as S-05 (`oauth-handoff.model.ts`):
 *
 * - **A credential in a URL.** It sat in the address bar, the history, the static server's access
 *   log, `Referer`, and the analytics that record the page address.
 * - **Fixation.** An attacker who started their own OAuth sign-up could send a victim
 *   `/auth/register?oauth_token=<attacker's token>`. A victim who filled in the form created an
 *   org and an admin account linked to the ATTACKER's provider identity, and the attacker could
 *   then sign in to it with that provider.
 *
 * The fix is S-05's: the claims go into this one-time record, its code goes into an httpOnly
 * cookie, and the register form reads the prefill and completes the sign-up through that cookie.
 * An attacker cannot set a cookie on our origin, so a planted register URL carries nothing.
 *
 * ## What is stored, and what is not
 *
 * `claims` holds the provider identity the callback fetched, never a signed token, and the code is
 * stored as a **SHA-256 hash**. A dump of this collection yields nothing redeemable.
 *
 * ⚠ It has to be in Mongo, not in memory: prod runs several pods, and the form's requests need not
 * reach the pod that served the callback.
 */
export interface IOAuthPendingRegistration extends Document {
  _id: Types.ObjectId
  /** SHA-256 (hex) of the code held in the browser's httpOnly cookie. */
  codeHash: string
  /** The provider identity the callback fetched. Not a token. */
  claims: {
    provider: string
    providerId: string
    email: string
    name: string
    avatarUrl?: string
    /**
     * Whether the provider vouched for `email` (`OAuthUserInfo.emailVerified`). Signing up founds a
     * person on that address, so an unverified one is refused when the sign-up completes. A record
     * from before this field reads as unverified: the person starts again.
     */
    emailVerified?: boolean
  }
  expiresAt: Date
  /**
   * Set when a sign-up completes with this record. Single use is enforced against this, not
   * against deletion. A sign-up that fails (say, a taken org slug) sets it back to null, so the
   * person can correct the form and submit again.
   */
  usedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

const oauthPendingRegistrationSchema = new Schema<IOAuthPendingRegistration>(
  {
    codeHash: { type: String, required: true, unique: true },
    claims: {
      provider: { type: String, required: true },
      providerId: { type: String, required: true },
      email: { type: String, required: true },
      name: { type: String, default: '' },
      avatarUrl: { type: String },
      emailVerified: { type: Boolean, default: false },
    },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

/**
 * ⚠ The TTL reaper is a floor, not the expiry check. Mongo runs it about once a minute, so a
 * document outlives `expiresAt` by up to that long; the service compares the date itself. The
 * index is here so nothing accumulates, and it is deliberately NOT the security boundary.
 */
oauthPendingRegistrationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

replicate(oauthPendingRegistrationSchema, { class: 'N' })

export const OAuthPendingRegistration = model<IOAuthPendingRegistration>(
  'OAuthPendingRegistration',
  oauthPendingRegistrationSchema,
)
