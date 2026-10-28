import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

/**
 * The tenant's own letterhead, stored as bytes.
 *
 * Deliberately its own collection rather than a field on `Org`: the org document is read on
 * nearly every request (and returned by `/auth/me`), so a few hundred KB of image on it would
 * be paid for by every one of those reads. `Org.logo` keeps only the URL of the GET endpoint.
 *
 * Also deliberately not a `File`: that model describes disk-backed uploads (it requires
 * `storagePath` and `module`), while this is a singleton branding asset per org — one row,
 * upserted, keyed uniquely by `orgId`.
 */
export interface IOrgLogo extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  /** Raw image bytes. Capped by the service (MAX_LOGO_BYTES), not by the schema. */
  data: Buffer
  mimeType: string
  size: number
  width: number
  height: number
  /** sha256 of `data`, truncated — doubles as the ETag and the `?v=` cache buster. */
  hash: string
  uploadedBy?: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const orgLogoSchema = new Schema<IOrgLogo>(
  {
    data: { type: Buffer, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    hash: { type: String, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
)

orgLogoSchema.plugin(tenantPlugin)
// One logo per org — every upload upserts this row. Set on the path the plugin already
// declared rather than adding a second `schema.index()`, which Mongoose flags as a duplicate.
orgLogoSchema.path('orgId').index({ unique: true })

replicate(orgLogoSchema, { class: 'R' })

export const OrgLogo = model<IOrgLogo>('OrgLogo', orgLogoSchema)
