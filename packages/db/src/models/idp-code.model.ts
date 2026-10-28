import { Schema, model, type Document, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * FR-20.39 (plan step P2-4) — the one-time codes of "Sign in with LGR": a person signed in to
 * lgrai.app agrees to sign in to one of their org's servers, and the server redeems the code over its
 * node credential for a short assertion. Global only.
 *
 * - **60 seconds, single use, bound** to the server, the redirect it was issued for and the PKCE
 *   challenge of the browser that asked: a code stolen from a redirect is worth nothing to anyone but
 *   that server, and to that server only with that browser's verifier.
 * - Only the code's SHA-256 is kept.
 * - ⚠ NODE STATE (`home/node-state.ts`), never the org's data.
 */
export interface IIdpCode extends Document {
  _id: Types.ObjectId
  codeHash: string
  nodeId: string
  orgId: Types.ObjectId
  identityId: Types.ObjectId
  /** The person's membership in the org: the same `_id` on the master. */
  userId: Types.ObjectId
  redirectUri: string
  /** S256 of the browser's verifier, base64url. */
  codeChallenge: string
  /** How the person signed in to lgrai.app. */
  amr: string[]
  expiresAt: Date
  /** Set by the redemption's conditional update: two redemptions of one code cannot both win. */
  usedAt?: Date
  createdAt: Date
}

const idpCodeSchema = new Schema<IIdpCode>(
  {
    codeHash: { type: String, required: true },
    nodeId: { type: String, required: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    identityId: { type: Schema.Types.ObjectId, ref: 'Identity', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    redirectUri: { type: String, required: true, maxlength: 400 },
    codeChallenge: { type: String, required: true },
    amr: [String],
    expiresAt: { type: Date, required: true },
    usedAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'idp_codes' },
)

idpCodeSchema.index({ codeHash: 1 }, { unique: true })
idpCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

replicate(idpCodeSchema, { class: 'N' })

export const IdpCode = model<IIdpCode>('IdpCode', idpCodeSchema)
