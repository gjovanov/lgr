import { Schema, model, type Document, type Types } from 'mongoose'

/**
 * A master registered with global (FR-20.2, plan step P2-1): global's registry of the on-prem
 * servers that may link to it. Lives on global only.
 *
 * ⚠ `_id` is the master's OWN node id (`master-<16 base32>`), made once by its supervisor in
 * `state/node.json` and never changed. Global records it; it does not hand out another. The id is
 * what the master's `org_homes` rows name as `home`, and it exists before (or without) any
 * registration: an Air-gapped master has one too.
 *
 * ⚠ No `tenantPlugin`, and no `orgId`: a node serves `orgIds[]`, several orgs at once, and the row
 * is global's own state about a machine, not any org's data. The plugin's write guard would also
 * refuse global the row of a node that is some org's home (a heartbeat, a revocation), which is
 * exactly when global must still be able to write it.
 */

/** What the supervisor makes (`packages/server/src/front.rs`): `master-` and 16 base32 letters. */
export const NODE_ID_PATTERN = /^master-[a-z2-7]{16}$/

/**
 * FR-20.54. How much the master shares with global, chosen in its setup. An Air-gapped master never
 * enrolls, so a registered node is one of these two.
 */
export const NODE_LINK_LEVELS = ['control', 'full'] as const
export type NodeLinkLevel = (typeof NODE_LINK_LEVELS)[number]

export interface IServerNode extends Omit<Document, '_id'> {
  _id: string
  name: string
  /** Random, made at install (FR-14's rule): cloned shop PCs share host names, never this. */
  installationId: string
  /** base64 SPKI DER, Ed25519. The private half never leaves the master's `keys/`. */
  publicKey: string
  /** Bumped when a revoked node is enrolled again with a new key: older tokens stop at once. */
  keyEpoch: number
  keyRotatedAt?: Date
  /** The orgs this node may act for. Each was added by that org's own admin, with a code. */
  orgIds: Types.ObjectId[]
  linkLevel: NodeLinkLevel
  status: 'active' | 'revoked'
  /** Enrolled with a reusable key (the field lanes): reaped after 24 h of silence. */
  ephemeral: boolean
  enrollKeyId?: Types.ObjectId
  versions: { app?: string; protocol?: number; schema?: string; supto?: string }
  os: { platform?: string; version?: string; arch?: string }
  enrolledAt: Date
  enrolledBy?: Types.ObjectId
  lastSeenAt?: Date
  presence?: { ip?: string; clockSkewMs?: number }
  revokedAt?: Date
  revokedBy?: Types.ObjectId
  revokeReason?: string
  /**
   * FR-20.8, FR-20.51: two LIVE uplinks from this node id with different boot nonces (a cloned disk,
   * a restored copy running beside the original). Global accepts neither's pages or tunnel traffic
   * while it is set; registering the node again clears it.
   */
  cloneAlarm?: { at: Date; channel: string; bootNonces: string[] }
  /** FR-20.57: the master's last `health` frame (every 60 s on its interactive socket), sanitised. */
  health?: Record<string, unknown>
  /**
   * FR-20.59, FR-20.54 (plan step P2-6): what global relays for this master, per org, as that org's
   * admin set it on lgrai.app: each org consents for its own data. Unset is the link level's
   * default, on at Full and off at Control.
   */
  relays?: Array<{ orgId: Types.ObjectId; mail?: boolean; documents?: boolean; setBy?: Types.ObjectId; setAt?: Date }>
  /**
   * FR-20.40 (plan step P2-4c): the X25519 key the master's API opens what global seals to it (its
   * people's local credentials), base64url raw. The NODE key vouches for it: it arrives only as the
   * `seal` claim of a token assertion the supervisor signed, so a proxy holding a node token cannot
   * put a key of its own here.
   */
  sealKey?: string
  sealKeyAt?: Date
  createdAt: Date
  updatedAt: Date
}

const serverNodeSchema = new Schema<IServerNode>(
  {
    _id: { type: String, required: true, match: NODE_ID_PATTERN },
    name: { type: String, required: true, maxlength: 120 },
    installationId: { type: String, required: true },
    publicKey: { type: String, required: true },
    keyEpoch: { type: Number, default: 1 },
    keyRotatedAt: Date,
    orgIds: [{ type: Schema.Types.ObjectId, ref: 'Org' }],
    linkLevel: { type: String, enum: NODE_LINK_LEVELS, default: 'control' },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    ephemeral: { type: Boolean, default: false },
    enrollKeyId: { type: Schema.Types.ObjectId, ref: 'NodeEnrollmentKey' },
    versions: {
      app: String,
      protocol: Number,
      schema: String,
      supto: String,
    },
    os: { platform: String, version: String, arch: String },
    enrolledAt: { type: Date, required: true },
    enrolledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    lastSeenAt: Date,
    presence: { ip: String, clockSkewMs: Number },
    revokedAt: Date,
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    revokeReason: String,
    // A single nested subdocument, absent until set: a nested path holding an array would default
    // to `{bootNonces: []}` on every node, and read as an alarm.
    cloneAlarm: { type: new Schema({ at: Date, channel: String, bootNonces: [String] }, { _id: false }), default: undefined },
    health: { type: Schema.Types.Mixed, default: undefined },
    relays: { type: [new Schema({ orgId: { type: Schema.Types.ObjectId, required: true }, mail: Boolean, documents: Boolean, setBy: Schema.Types.ObjectId, setAt: Date }, { _id: false })], default: undefined },
    sealKey: String,
    sealKeyAt: Date,
  },
  { timestamps: true, collection: 'nodes' },
)

/** An org's servers, the Servers page's one query. */
serverNodeSchema.index({ orgIds: 1, status: 1 })
/**
 * ⚠ One ACTIVE node per installation. A second machine presenting the same installationId is a
 * cloned disk, and is refused rather than registered beside the first. Partial, so a revoked row
 * does not block that installation from enrolling again (`$in`, because createIndexes rejects
 * `$ne` in a partial filter).
 */
serverNodeSchema.index({ installationId: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['active'] } } })
/** The reaper's query. */
serverNodeSchema.index({ ephemeral: 1, lastSeenAt: 1 })

export const ServerNode = model<IServerNode>('ServerNode', serverNodeSchema)
