import { Schema, model, type Document, type Types } from 'mongoose'

/**
 * S-08 — one failed-sign-in counter per key (`services/biz/login-throttle.service.ts`).
 *
 * A key is one of `pair:<ip>|<account>`, `acct:<account>` or `ip:<ip>`, where `<account>` is the
 * lowercased `orgSlug|username`. Only FAILED sign-ins count, so the many successful logins of a
 * busy till, an import script or the e2e suite never trip it.
 *
 * Global on purpose: there is no `orgId` path, so per-org backups skip it (`tenantCollections`) and
 * a restore can never resurrect a lockout. Rows expire a day after their last write.
 */
export interface ILoginThrottle extends Document {
  _id: Types.ObjectId
  key: string
  failures: number
  windowStart: Date
  lockedUntil?: Date
  updatedAt: Date
}

const loginThrottleSchema = new Schema<ILoginThrottle>(
  {
    key: { type: String, required: true, unique: true },
    failures: { type: Number, required: true, default: 0 },
    windowStart: { type: Date, required: true },
    lockedUntil: { type: Date },
    updatedAt: { type: Date, required: true },
  },
  { collection: 'login_throttles' },
)

loginThrottleSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 })

export const LoginThrottle = model<ILoginThrottle>('LoginThrottle', loginThrottleSchema)
