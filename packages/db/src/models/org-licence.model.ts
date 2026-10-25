import { Schema, model, type Document, type Types } from 'mongoose'

/**
 * FR-20.55 (plan step P2-3b) — a licence a sys-admin issued for an org to run on a master: a pilot,
 * until a date (regal's first site, the field tests). Global only. One row per org; issuing again
 * moves the date, and revoking stops renewals.
 *
 * ⚠ Revoking cannot take back a licence a master already holds: it is signed, and verified offline
 * against keys built into the package. It runs out on its own dates.
 *
 * ⚠ No `tenantPlugin`, though it carries an `orgId`: it is global's NODE STATE about the org (see
 * `home/node-state.ts`), never the org's data. A backup must not carry it (restoring an old bundle
 * would rewrite a pilot), and it stays writable on global while the org's home is a master, which
 * is exactly when it matters.
 */
export interface IOrgLicence extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  kind: 'pilot'
  /** The day the pilot is paid through, as an Enterprise subscription's period end would be. */
  until: Date
  note?: string
  issuedBy: string
  issuedAt: Date
  revokedAt?: Date
  revokedBy?: string
  createdAt: Date
  updatedAt: Date
}

const orgLicenceSchema = new Schema<IOrgLicence>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    kind: { type: String, enum: ['pilot'], default: 'pilot' },
    until: { type: Date, required: true },
    note: { type: String, maxlength: 500 },
    issuedBy: { type: String, required: true },
    issuedAt: { type: Date, required: true },
    revokedAt: Date,
    revokedBy: String,
  },
  { timestamps: true, collection: 'org_licences' },
)

orgLicenceSchema.index({ orgId: 1 }, { unique: true })

export const OrgLicence = model<IOrgLicence>('OrgLicence', orgLicenceSchema)
