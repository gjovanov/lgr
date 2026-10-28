import { Schema, model, type Document, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * An org's address on the internet, `<label>.lgrai.app` (FR-20.72, plan step P3-4a): where the people
 * of an org written on its own server reach it from anywhere, through lgrai.app (the tunnel, P3-4b/c).
 *
 * ⚠ No `tenantPlugin`, though it carries an `orgId`: it is global's record ABOUT the org, never the
 * org's data. Not replicated, never in a backup bundle (`NODE_STATE_MODELS`): restoring an old bundle
 * must not give an address back, or take one away.
 *
 * - **The label is the org's slug when it is issued.** A rename does not move it.
 * - `requested` → `active` (a sys-admin approves) or `refused`; `active` → `retired`.
 * - **A label is issued once.** A retired one answers with a notice until `noticeUntil` (12 months)
 *   and is never issued to anyone again: the unique index on `label` keeps every one but the refused.
 */
export type OrgAddressState = 'requested' | 'active' | 'refused' | 'retired'

export interface IOrgAddress extends Document {
  /** The DNS label: `<label>.<ORG_ADDRESS_APEX>`. */
  label: string
  orgId: Types.ObjectId
  state: OrgAddressState
  requestedBy: string
  requestedAt: Date
  /** Who approved or refused it, and why (a refusal says). */
  decidedBy?: string
  decidedAt?: Date
  reason?: string
  retiredBy?: string
  retiredAt?: Date
  /** Until when a retired address answers with a notice; after it, like an unknown one. */
  noticeUntil?: Date
}

const orgAddressSchema = new Schema<IOrgAddress>(
  {
    label: { type: String, required: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    state: { type: String, required: true, enum: ['requested', 'active', 'refused', 'retired'] },
    requestedBy: { type: String, required: true },
    requestedAt: { type: Date, required: true },
    decidedBy: String,
    decidedAt: Date,
    reason: String,
    retiredBy: String,
    retiredAt: Date,
    noticeUntil: Date,
  },
  { timestamps: true, collection: 'org_addresses' },
)
// A label once requested, issued or retired is never anyone else's; a refused request frees it.
orgAddressSchema.index({ label: 1 }, { unique: true, partialFilterExpression: { state: { $in: ['requested', 'active', 'retired'] } } })
// One live address (or request) per org.
orgAddressSchema.index({ orgId: 1 }, { unique: true, partialFilterExpression: { state: { $in: ['requested', 'active'] } } })

replicate(orgAddressSchema, { class: 'N' })

export const OrgAddress = model<IOrgAddress>('OrgAddress', orgAddressSchema)
