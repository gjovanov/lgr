import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

export interface IPersonalDataKeyEntry {
  keyId: string
  /** The data key, wrapped by the KEK (`services/biz/personal-data/crypto.ts`). */
  wrapped: string
  status: 'active' | 'retired'
  createdAt: Date
}

/**
 * FR-25 §3.12: one row per org, holding that org's keys in wrapped form, so it can travel with the
 * org's backups without opening anything by itself. The KEK that opens it is never in Mongo.
 *
 * ⚠ Losing this row loses the org's personal data, and payroll is kept for 50 years. It is covered
 * by the org bundle, and nothing prunes it (`retention.service.ts` is an allow-list).
 */
export interface IPersonalDataKey extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  /** Always 'org' today. It carries the one-row-per-org index, as `tenantPlugin` already indexes `orgId`. */
  scope: string
  /** Which KEK wrapped these keys (`kekIdOf`), so an operator can tell which one opens them. */
  kekId: string
  keys: IPersonalDataKeyEntry[]
  /** Keys the lookup HMAC. It does not rotate with the data key, so lookups survive a rotation. */
  indexKey: string
  /** A known value sealed with the active key: proves a KEK right without touching real data. */
  canary: string
  createdAt: Date
  updatedAt: Date
}

const personalDataKeySchema = new Schema<IPersonalDataKey>(
  {
    scope: { type: String, required: true, default: 'org' },
    kekId: { type: String, required: true },
    keys: [
      {
        _id: false,
        keyId: { type: String, required: true },
        wrapped: { type: String, required: true },
        status: { type: String, required: true, enum: ['active', 'retired'], default: 'active' },
        createdAt: { type: Date, required: true, default: Date.now },
      },
    ],
    indexKey: { type: String, required: true },
    canary: { type: String, required: true },
  },
  { timestamps: true },
)

personalDataKeySchema.plugin(tenantPlugin)
personalDataKeySchema.index({ orgId: 1, scope: 1 }, { unique: true })

replicate(personalDataKeySchema, { class: 'R' })

export const PersonalDataKey = model<IPersonalDataKey>('PersonalDataKey', personalDataKeySchema)
