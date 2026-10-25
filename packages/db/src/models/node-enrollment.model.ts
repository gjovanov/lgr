import { Schema, model, type Document, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * How a master is registered with global (FR-20.2, plan step P2-1): single-use codes an org admin
 * mints, reusable keys for the field lanes' throwaway masters, the ledger of what used a key, and
 * the replay book of the nodes' signed assertions. FR-14.19's desktop equivalents, on global only.
 *
 * ⚠ None of them stores a usable secret: codes and keys are SHA-256 hashes, so a dump of these
 * collections registers nothing.
 *
 * ⚠ No `tenantPlugin`, though three of them carry an `orgId`. They are global's NODE STATE (see
 * `home/node-state.ts`): they describe a node's relation to an org, never travel in the org's
 * bundle, and must stay writable on global when the org's home is a master. Registering a
 * replacement master for an org whose master is lost is exactly that case. The `orgId` is declared
 * by hand, and every query names it.
 */

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Single-use codes: an admin on lgrai.app mints one; the master's setup takes it.
// ──────────────────────────────────────────────────────────────────────────────────────────────

export interface INodeEnrollmentCode extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  /** SHA-256 of the code. The code itself is shown once and never stored. */
  codeHash: string
  /** The first 4 characters, in the clear: a quarter of ~41 bits, not a secret. */
  codePrefix: string
  createdBy: Types.ObjectId
  expiresAt: Date
  /** Set when redeemed, by a conditional update: two masters racing for one code cannot both win. */
  usedAt?: Date
  usedByNodeId?: string
  /** Failed redemptions, counted on the code's own row. */
  attempts: number
  createdAt: Date
  updatedAt: Date
}

const codeSchema = new Schema<INodeEnrollmentCode>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    codeHash: { type: String, required: true, unique: true },
    codePrefix: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
    usedByNodeId: String,
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'node_enrollment_codes' },
)
codeSchema.index({ orgId: 1, createdAt: -1 })
/** A floor, not the expiry check (the redemption compares the date): an hour past expiry. */
codeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 })

replicate(codeSchema, { class: 'N' })

export const NodeEnrollmentCode = model<INodeEnrollmentCode>('NodeEnrollmentCode', codeSchema)

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Reusable keys: for the field lanes' throwaway masters, which register unattended. Gated by the
// org's `settings.node.ephemeralKeysEnabled`, on use as well as on minting.
// ──────────────────────────────────────────────────────────────────────────────────────────────

export interface INodeEnrollmentKey extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
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
  createdAt: Date
  updatedAt: Date
}

const keySchema = new Schema<INodeEnrollmentKey>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    name: { type: String, required: true, maxlength: 120 },
    keyHash: { type: String, required: true, unique: true },
    keyPrefix: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    maxUses: { type: Number, default: 0 },
    uses: { type: Number, default: 0 },
    expiresAt: Date,
    revokedAt: Date,
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, collection: 'node_enrollment_keys' },
)
keySchema.index({ orgId: 1, createdAt: -1 })

replicate(keySchema, { class: 'N' })

export const NodeEnrollmentKey = model<INodeEnrollmentKey>('NodeEnrollmentKey', keySchema)

export interface INodeEnrollmentKeyUse extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  keyId: Types.ObjectId
  nodeId: string
  installationId: string
  ip?: string
  createdAt: Date
}

const keyUseSchema = new Schema<INodeEnrollmentKeyUse>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    keyId: { type: Schema.Types.ObjectId, ref: 'NodeEnrollmentKey', required: true },
    nodeId: { type: String, required: true },
    installationId: { type: String, required: true },
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'node_enrollment_key_uses' },
)
keyUseSchema.index({ orgId: 1, keyId: 1, createdAt: -1 })

replicate(keyUseSchema, { class: 'N' })

export const NodeEnrollmentKeyUse = model<INodeEnrollmentKeyUse>('NodeEnrollmentKeyUse', keyUseSchema)

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Replay protection for the nodes' signed assertions (enroll proofs and token requests).
// ──────────────────────────────────────────────────────────────────────────────────────────────

export interface INodeAssertion extends Document {
  _id: Types.ObjectId
  nodeId: string
  jti: string
  expiresAt: Date
  createdAt: Date
}

const assertionSchema = new Schema<INodeAssertion>(
  {
    nodeId: { type: String, required: true },
    jti: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'node_assertions' },
)
/**
 * ⚠ The unique index IS the replay check: the insert succeeds or raises E11000. A read-then-write
 * would let two simultaneous replays both pass.
 */
assertionSchema.index({ nodeId: 1, jti: 1 }, { unique: true })
assertionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

replicate(assertionSchema, { class: 'N' })

export const NodeAssertion = model<INodeAssertion>('NodeAssertion', assertionSchema)
