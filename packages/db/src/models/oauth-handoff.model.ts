import { Schema, model, type Document, type Types } from 'mongoose'

/**
 * A one-time handoff from the OAuth callback to the SPA that finishes the sign-in.
 *
 * ## Why this exists
 *
 * The callback used to redirect to `/auth/oauth-callback?token=<JWT>`, and the view stored
 * whatever `?token=` it was handed, unvalidated. So
 * `https://lgrai.app/auth/oauth-callback?token=<attacker's JWT>` signed the visitor into the
 * attacker's account — the same login fixation FR-14.24 closed for the cross-SPA handoff, still
 * open here precisely because this route had to be EXEMPTED from that gate (it owns the
 * `token` parameter's other meaning).
 *
 * The fix is FR-14.14's principle: no credential in a URL. The callback stores the claims here
 * and puts a random code in an **httpOnly cookie**; the SPA posts nothing and the server reads
 * the code from that cookie. An attacker cannot set a cookie on our origin, so there is no
 * longer anything to plant — the vector is removed, not narrowed.
 *
 * ## What is stored, and what is not
 *
 * `payload` holds the **claims** the callback assembled (a `UserTokenized`), never a signed
 * token. So no bearer credential is at rest, and the JWT is minted fresh at redeem with a full
 * TTL rather than one that started counting down at the redirect.
 *
 * The code is stored as a **SHA-256 hash**. A dump of this collection yields nothing redeemable.
 *
 * ⚠ It has to be in Mongo, not in memory: prod runs several pods, and the redeem POST need not
 * reach the pod that served the callback GET.
 */
export interface IOAuthHandoff extends Document {
  _id: Types.ObjectId
  /** SHA-256 (hex) of the code held in the browser's httpOnly cookie. */
  codeHash: string
  userId: Types.ObjectId
  orgId: Types.ObjectId
  /** The `UserTokenized` claims to sign at redeem. Not a token. */
  payload: Record<string, unknown>
  expiresAt: Date
  /** Set on redemption. Single use is enforced against this, not against deletion. */
  usedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const oauthHandoffSchema = new Schema<IOAuthHandoff>(
  {
    codeHash: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
  },
  { timestamps: true },
)

/**
 * ⚠ The TTL reaper is a floor, not the expiry check. Mongo runs it about once a minute, so a
 * document outlives `expiresAt` by up to that long; `redeemLoginHandoff` compares the date
 * itself. The index is here so nothing accumulates, and it is deliberately NOT the security
 * boundary.
 */
oauthHandoffSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const OAuthHandoff = model<IOAuthHandoff>('OAuthHandoff', oauthHandoffSchema)
