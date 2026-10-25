import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

/**
 * The two ways a desktop can be enrolled (FR-14.19), and the ledger of what used a reusable key.
 *
 * ⚠ Neither model stores a usable secret. Codes and keys are held as SHA-256 hashes, so a dump of
 * these collections enrolls nothing. That matters more here than for most tables: a valid
 * enrollment credential is a way into an org.
 */

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Single-use codes: an admin mints one, reads `XXXX-XXXX` off the screen, and types it into the
// desktop in front of them.
// ──────────────────────────────────────────────────────────────────────────────────────────────

export interface IDesktopEnrollmentCode extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  /** SHA-256 of the code. The code itself is shown once and never stored. */
  codeHash: string
  /**
   * The first 4 characters, in the clear. Not a secret (a quarter of ~40 bits) and it is what the
   * rate limiter counts against, so a flood of guesses at one code cannot be spread across many
   * fresh rows to dodge the limit.
   */
  codePrefix: string
  createdBy: Types.ObjectId
  expiresAt: Date
  /** Set when redeemed. Single use is enforced against this, not against deletion. */
  usedAt?: Date
  usedByDesktopId?: Types.ObjectId
  /** Failed redemption attempts, for the rate limiter. */
  attempts: number
  createdAt: Date
  updatedAt: Date
}

const codeSchema = new Schema<IDesktopEnrollmentCode>(
  {
    codeHash: { type: String, required: true, unique: true },
    codePrefix: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
    usedByDesktopId: { type: Schema.Types.ObjectId, ref: 'Desktop' },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true },
)

codeSchema.plugin(tenantPlugin)
codeSchema.index({ orgId: 1, createdAt: -1 })
/**
 * ⚠ A floor, not the expiry check. Mongo's TTL monitor runs about once a minute, so a document
 * outlives `expiresAt` by up to that long; the redemption path compares the date itself. Kept for
 * an hour past expiry so the Register dialog can still say "expired" rather than "no such code".
 */
codeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 })

replicate(codeSchema, { class: 'N' })

export const DesktopEnrollmentCode = model<IDesktopEnrollmentCode>(
  'DesktopEnrollmentCode',
  codeSchema,
)

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Reusable keys: for the throwaway VMs of the field-test lanes (FR-14.38), which enroll
// unattended and cannot read a code off a screen.
// ──────────────────────────────────────────────────────────────────────────────────────────────

export interface IDesktopEnrollmentKey extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  /** A label an admin recognises, e.g. "vmtest win11 lane". */
  name: string
  keyHash: string
  keyPrefix: string
  createdBy: Types.ObjectId
  /** 0 = unlimited. */
  maxUses: number
  uses: number
  expiresAt?: Date
  revokedAt?: Date
  revokedBy?: Types.ObjectId
  /** Every desktop enrolled by this key is ephemeral, and reaped when it stops reporting. */
  ephemeralTtlSec: number
  createdAt: Date
  updatedAt: Date
}

const keySchema = new Schema<IDesktopEnrollmentKey>(
  {
    name: { type: String, required: true },
    keyHash: { type: String, required: true, unique: true },
    keyPrefix: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    maxUses: { type: Number, default: 0 },
    uses: { type: Number, default: 0 },
    expiresAt: Date,
    revokedAt: Date,
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    ephemeralTtlSec: { type: Number, default: 900 },
  },
  { timestamps: true },
)

keySchema.plugin(tenantPlugin)
keySchema.index({ orgId: 1, createdAt: -1 })

replicate(keySchema, { class: 'N' })

export const DesktopEnrollmentKey = model<IDesktopEnrollmentKey>(
  'DesktopEnrollmentKey',
  keySchema,
)

// ──────────────────────────────────────────────────────────────────────────────────────────────
// The use ledger. ⚠ A reusable credential whose uses are not recorded is one nobody can audit
// after the fact: "which machines did this key let in?" has to be answerable.
// ──────────────────────────────────────────────────────────────────────────────────────────────

export interface IDesktopEnrollmentKeyUse extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  keyId: Types.ObjectId
  desktopId: Types.ObjectId
  installationId: string
  hostname?: string
  ip?: string
  createdAt: Date
  updatedAt: Date
}

const keyUseSchema = new Schema<IDesktopEnrollmentKeyUse>(
  {
    keyId: { type: Schema.Types.ObjectId, ref: 'DesktopEnrollmentKey', required: true },
    desktopId: { type: Schema.Types.ObjectId, ref: 'Desktop', required: true },
    installationId: { type: String, required: true },
    hostname: String,
    ip: String,
  },
  { timestamps: true },
)

keyUseSchema.plugin(tenantPlugin)
keyUseSchema.index({ orgId: 1, keyId: 1, createdAt: -1 })

replicate(keyUseSchema, { class: 'N' })

export const DesktopEnrollmentKeyUse = model<IDesktopEnrollmentKeyUse>(
  'DesktopEnrollmentKeyUse',
  keyUseSchema,
)

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Replay protection for the token endpoint's client assertions (FR-14.20).
// ──────────────────────────────────────────────────────────────────────────────────────────────

export interface IDesktopAssertion extends Document {
  _id: Types.ObjectId
  desktopId: Types.ObjectId
  jti: string
  expiresAt: Date
  createdAt: Date
}

const assertionSchema = new Schema<IDesktopAssertion>(
  {
    desktopId: { type: Schema.Types.ObjectId, ref: 'Desktop', required: true },
    jti: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

/**
 * ⚠ No `tenantPlugin`. This is replay bookkeeping keyed by the desktop that signed the assertion,
 * and the lookup happens before any org is established — adding a required `orgId` would mean
 * trusting a caller-supplied org to check a signature.
 *
 * ⚠ Unique on `(desktopId, jti)`, and that uniqueness IS the replay check: the insert either
 * succeeds or raises E11000. A read-then-write would let two simultaneous replays both pass.
 */
assertionSchema.index({ desktopId: 1, jti: 1 }, { unique: true })
assertionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

replicate(assertionSchema, { class: 'N' })

export const DesktopAssertion = model<IDesktopAssertion>('DesktopAssertion', assertionSchema)
