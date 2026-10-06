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
  /** The membership an org session is for. Absent on an identity-only handoff. */
  userId?: Types.ObjectId
  orgId?: Types.ObjectId
  /**
   * Multi-org (Phase 2): a sign-in that proved WHO the person is without landing in an org. The
   * payload is then identity-only claims, and the redeem re-checks the person, not a membership.
   */
  identityId?: Types.ObjectId
  /** The claims to sign at redeem: a session's, or identity-only ones. Not a token. */
  payload: Record<string, unknown>
  expiresAt: Date
  /** Set on redemption. Single use is enforced against this, not against deletion. */
  usedAt?: Date
  /**
   * FR-14.14 — set when the flow was started by a DESKTOP, which changes two things: the code
   * is delivered through `lgr://login?code=` instead of a cookie, and redeeming it additionally
   * requires the PKCE verifier below.
   */
  desktopId?: Types.ObjectId
  /**
   * The S256 challenge the desktop sent when it started the flow (base64url, unpadded).
   *
   * ⚠ This is what makes a hijacked `lgr://` link useless. Another app that registers the scheme
   * receives the CODE, but the verifier never leaves the shell until the fragment, so it cannot
   * produce a preimage of this hash. That is RFC 8252's principle, and it is the entire reason
   * the desktop flow is safe to deliver over a scheme any program can claim.
   */
  codeChallenge?: string
  createdAt: Date
  updatedAt: Date
}

const oauthHandoffSchema = new Schema<IOAuthHandoff>(
  {
    codeHash: { type: String, required: true, unique: true },
    // Required unless the handoff is identity-only: then the person is all there is to name.
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: function (this: IOAuthHandoff) { return !this.identityId } },
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: function (this: IOAuthHandoff) { return !this.identityId } },
    identityId: { type: Schema.Types.ObjectId, ref: 'Identity' },
    payload: { type: Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
    desktopId: { type: Schema.Types.ObjectId, ref: 'Desktop' },
    codeChallenge: { type: String },
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
