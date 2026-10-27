import { createHmac, timingSafeEqual } from 'crypto'
import {
  NODE_ID_PATTERN,
  NodeAssertion,
  NodeEnrollmentCode,
  NodeEnrollmentKey,
  NodeEnrollmentKeyUse,
  MirrorState,
  NodePresence,
  Org,
  ServerNode,
  type IServerNode,
  type NodeLinkLevel,
} from 'db/models'
import { config } from 'config'
import { SUPTO_VERSION_RE } from 'config/supto'
import { logger } from '../../logger/logger.js'
import {
  generateEnrollmentCode,
  generateEnrollmentKey,
  hashSecret,
  isValidDesktopPublicKey,
  normalizeEnrollmentCode,
  verifyAssertion,
} from '../desktop/desktop-crypto.js'
import { isSealPublicKey } from '../crypto/node-seal.js'
import { CA_PIN, LAN_URL } from '../desktop/repoint-token.js'

/**
 * Global's registry of masters (FR-20.2, plan step P2-1): an org admin mints a code on lgrai.app,
 * the master's setup redeems it with the master's own id and Ed25519 key, and from then on the
 * master trades signed assertions for 15-minute tokens. The desktops' design (FR-14.19, FR-14.20),
 * with what differs because a node serves several orgs and is far more powerful than a till:
 *
 * - **The registration is signed** (`proof`) by the key it registers, so a node row always names a
 *   key somebody holds, and a second org can join a node only through that node.
 * - **A code is claimed by a conditional update** before it is used, so two masters racing for one
 *   code cannot both register. (The desktops mark theirs after the fact.)
 * - **Revocation is per org.** An org's admin takes their org off a node; the node is revoked only
 *   when no org is left on it. One org can never cut another org's server off.
 * - **Ephemeral nodes are reaped after 24 h of silence,** not 15 minutes (FR-20.113).
 *
 * ⚠ Every refusal on the registration path is one flat message: an endpoint that tells "no such
 * code" from "used" from "expired" is an oracle for an org's codes.
 */

export class NodeError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const ENROLL_REFUSED = 'That registration code is not valid. Ask an administrator of the organization for a new one.'
const CODE_TTL_MS = 10 * 60 * 1000
const MAX_CODE_ATTEMPTS = 10
/** Kept a little past an assertion's own 60 s, so a replay at the edge still collides. */
const ASSERTION_KEEP_MS = 5 * 60 * 1000

/** ⚠ Pinned into every node token, and checked on every node route. */
export const NODE_TOKEN_AUDIENCE = 'lgr-node'

export interface NodeTokenClaims {
  nodeId: string
  keyEpoch: number
  aud: typeof NODE_TOKEN_AUDIENCE
  iat: number
  exp: number
}

const refused = (status = 400) => new NodeError(status, 'enroll_refused', ENROLL_REFUSED)

// ── Minting (an org admin, on global) ──────────────────────────────────────────────────────────

export async function mintNodeEnrollmentCode(orgId: string, userId: string): Promise<{ id: string; code: string; expiresAt: Date }> {
  const { display, raw, prefix } = generateEnrollmentCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MS)
  const row = await NodeEnrollmentCode.create({ orgId, codeHash: hashSecret(raw), codePrefix: prefix, createdBy: userId, expiresAt })
  // ⚠ The only time the code exists in plain text: minting another is the recovery.
  return { id: String(row._id), code: display, expiresAt }
}

export async function mintNodeEnrollmentKey(
  orgId: string,
  userId: string,
  input: { name: string; maxUses?: number; expiresAt?: Date },
): Promise<{ id: string; secret: string }> {
  await assertEphemeralNodeKeysEnabled(orgId)
  const { secret, prefix } = generateEnrollmentKey()
  const row = await NodeEnrollmentKey.create({
    orgId,
    name: input.name,
    keyHash: hashSecret(secret),
    keyPrefix: prefix,
    createdBy: userId,
    maxUses: input.maxUses ?? 0,
    expiresAt: input.expiresAt,
  })
  return { id: String(row._id), secret }
}

/** ⚠ Checked on USE as well as on minting: turning it off revokes every reusable key at once. */
async function assertEphemeralNodeKeysEnabled(orgId: string): Promise<void> {
  const org = await Org.findById(orgId).select('settings.node').lean()
  if (!(org as any)?.settings?.node?.ephemeralKeysEnabled) {
    throw new NodeError(403, 'ephemeral_keys_disabled', 'Reusable server registration keys are turned off for this organization.')
  }
}

// ── Registration (the master's setup) ──────────────────────────────────────────────────────────

export interface NodeEnrollInput {
  code?: string
  enrollmentKey?: string
  /** The master's own id, from its `state/node.json`. */
  nodeId: string
  installationId: string
  name: string
  /** base64 SPKI DER, Ed25519. */
  publicKey: string
  /** An EdDSA assertion by that key: `{sub: nodeId, aud: <this enroll URL>, iat, exp ≤ iat + 60, jti}`. */
  proof: string
  linkLevel?: NodeLinkLevel
  os?: { platform?: string; version?: string; arch?: string }
  versions?: { app?: string; protocol?: number; schema?: string; supto?: string }
  ip?: string
}

export interface NodeEnrollResult {
  nodeId: string
  orgId: string
  orgSlug: string
  orgName: string
  linkLevel: NodeLinkLevel
  /** So the master can correct its clock before it signs its first token assertion. */
  serverTime: string
}

type Credential =
  | { kind: 'code'; orgId: any; codeId: any; createdBy: any; claimedAt: Date }
  | { kind: 'key'; orgId: any; keyId: any }

/**
 * @param audiences the URLs this server answers the enroll route on (the proof's `aud`).
 */
export async function enrollNode(input: NodeEnrollInput, audiences: string[]): Promise<NodeEnrollResult> {
  if (!NODE_ID_PATTERN.test(input.nodeId ?? '')) {
    throw new NodeError(400, 'bad_request', 'nodeId must be the master\'s own id (`master-` and 16 letters).')
  }
  if (!isValidDesktopPublicKey(input.publicKey)) {
    throw new NodeError(400, 'bad_public_key', 'The public key must be a base64 Ed25519 SPKI key.')
  }
  // The proof first: it costs no database round-trip and consumes nothing. A registration that is
  // not signed by the key it names never reaches the code.
  const proof = verifyAssertion(input.proof, input.publicKey, { audience: audiences })
  if (!proof.ok || proof.claims.sub !== input.nodeId) {
    throw new NodeError(400, 'bad_proof', 'The registration must be signed by the key it registers.')
  }
  const credential = input.code ? await claimCode(input.code) : await redeemKey(input.enrollmentKey)
  let node: IServerNode
  try {
    // After the claim, so only a holder of a live code or key ever writes a replay row.
    await recordAssertion(input.nodeId, proof.claims.jti, 400, 'bad_proof')
    node = await upsertNode(credential, input)
  } catch (e) {
    // A refusal after the claim gives the code back: a misconfigured master must not burn the
    // admin's code. Counted, so a code cannot be retried for ever either.
    if (credential.kind === 'code') {
      await NodeEnrollmentCode.updateOne(
        { _id: credential.codeId, usedAt: credential.claimedAt },
        { $unset: { usedAt: 1 }, $inc: { attempts: 1 } },
      )
    } else {
      // The key's use, given back the same way.
      await NodeEnrollmentKey.updateOne({ _id: credential.keyId, uses: { $gt: 0 } }, { $inc: { uses: -1 } })
    }
    throw e
  }

  if (credential.kind === 'code') {
    await NodeEnrollmentCode.updateOne({ _id: credential.codeId }, { $set: { usedByNodeId: node._id } })
  } else {
    await NodeEnrollmentKeyUse.create({
      orgId: credential.orgId,
      keyId: credential.keyId,
      nodeId: node._id,
      installationId: input.installationId,
      ip: input.ip,
    })
  }

  const org = await Org.findById(credential.orgId).select('name slug').lean()
  return {
    nodeId: node._id,
    orgId: String(credential.orgId),
    orgSlug: (org as any)?.slug ?? '',
    orgName: (org as any)?.name ?? '',
    linkLevel: node.linkLevel,
    serverTime: new Date().toISOString(),
  }
}

async function claimCode(code: string): Promise<Credential> {
  const raw = normalizeEnrollmentCode(code)
  if (!raw) throw refused()
  const row = await NodeEnrollmentCode.findOne({ codeHash: hashSecret(raw) })
  if (!row) throw refused()
  if (row.attempts >= MAX_CODE_ATTEMPTS) throw refused(429)
  const now = new Date()
  // ⚠ The claim is the conditional update itself: of two masters racing for one code, one matches.
  const claimed = await NodeEnrollmentCode.findOneAndUpdate(
    { _id: row._id, usedAt: null, expiresAt: { $gt: now }, attempts: { $lt: MAX_CODE_ATTEMPTS } },
    { $set: { usedAt: now } },
    { new: true },
  )
  if (!claimed) {
    await NodeEnrollmentCode.updateOne({ _id: row._id }, { $inc: { attempts: 1 } })
    throw refused()
  }
  return { kind: 'code', orgId: claimed.orgId, codeId: claimed._id, createdBy: claimed.createdBy, claimedAt: now }
}

async function redeemKey(secret: unknown): Promise<Credential> {
  if (typeof secret !== 'string' || !secret) throw refused()
  const row = await NodeEnrollmentKey.findOne({ keyHash: hashSecret(secret) })
  if (!row || row.revokedAt) throw refused()
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) throw refused()
  if (row.maxUses > 0 && row.uses >= row.maxUses) throw refused()
  await assertEphemeralNodeKeysEnabled(String(row.orgId))
  // ⚠ The use is claimed by a conditional increment, like a code: of two masters racing for a key's
  // last use, one gets it. (Counting after the fact let both through.)
  const claimed = await NodeEnrollmentKey.findOneAndUpdate(
    { _id: row._id, revokedAt: null, ...(row.maxUses > 0 ? { uses: { $lt: row.maxUses } } : {}) },
    { $inc: { uses: 1 } },
    { new: true },
  )
  if (!claimed) throw refused()
  return { kind: 'key', orgId: row.orgId, keyId: row._id }
}

/**
 * Create the node; add the org to a node that is already registered (a second org on the same
 * master); or REVIVE a revoked node that registers again with a new key.
 */
async function upsertNode(credential: Credential, input: NodeEnrollInput): Promise<IServerNode> {
  const now = new Date()
  const reported = {
    name: input.name,
    linkLevel: input.linkLevel ?? 'control',
    os: { platform: input.os?.platform ?? '', version: input.os?.version ?? '', arch: input.os?.arch ?? '' },
    versions: { ...input.versions },
    lastSeenAt: now,
  }
  const existing = await ServerNode.findById(input.nodeId)

  if (!existing) {
    try {
      const created = await ServerNode.create({
        _id: input.nodeId,
        installationId: input.installationId,
        publicKey: input.publicKey,
        keyEpoch: 1,
        orgIds: [credential.orgId],
        status: 'active',
        ephemeral: credential.kind === 'key',
        enrollKeyId: credential.kind === 'key' ? credential.keyId : undefined,
        enrolledAt: now,
        enrolledBy: credential.kind === 'code' ? credential.createdBy : undefined,
        ...reported,
      })
      logger.info({ nodeId: input.nodeId, orgId: String(credential.orgId), ephemeral: created.ephemeral }, 'Master registered')
      return created
    } catch (e) {
      throw duplicate(e)
    }
  }

  if (existing.status === 'active') {
    // ⚠ The same id with another key is another machine claiming this one's name, or this one after
    // it lost its key. Either way an admin decides: revoke it on the Servers page, then register.
    if (existing.publicKey !== input.publicKey) {
      throw new NodeError(409, 'node_exists', 'This server is registered with a different key. Remove it on the Servers page, then register it again.')
    }
    // The same key from another installation is a copied disk.
    if (existing.installationId !== input.installationId) {
      throw new NodeError(409, 'installation_mismatch', 'This server\'s key is registered for another installation.')
    }
    const updated = await ServerNode.findOneAndUpdate(
      { _id: existing._id, status: 'active', publicKey: input.publicKey },
      {
        $addToSet: { orgIds: credential.orgId },
        // ⚠ A permanent node stays permanent: a field lane's key must never make a shop's master reapable.
        $set: { ...reported, ephemeral: existing.ephemeral && credential.kind === 'key' },
      },
      { new: true },
    )
    if (!updated) throw new NodeError(409, 'node_changed', 'This server changed while it was being registered. Try again.')
    logger.info({ nodeId: existing._id, orgId: String(credential.orgId) }, 'Master registered for another org')
    return updated
  }

  // Revoked: the same machine registering again, with the key it has now.
  try {
    const revived = await ServerNode.findOneAndUpdate(
      { _id: existing._id, status: 'revoked' },
      {
        $set: {
          ...reported,
          installationId: input.installationId,
          publicKey: input.publicKey,
          keyEpoch: (existing.keyEpoch ?? 1) + 1,
          keyRotatedAt: now,
          orgIds: [credential.orgId],
          status: 'active',
          ephemeral: credential.kind === 'key',
          enrollKeyId: credential.kind === 'key' ? credential.keyId : undefined,
          enrolledAt: now,
          enrolledBy: credential.kind === 'code' ? credential.createdBy : undefined,
        },
        // A clone alarm clears here: an admin revoked the node and the real machine registered again.
        $unset: { revokedAt: 1, revokedBy: 1, revokeReason: 1, cloneAlarm: 1 },
      },
      { new: true },
    )
    if (!revived) throw new NodeError(409, 'node_changed', 'This server changed while it was being registered. Try again.')
    logger.info({ nodeId: existing._id, orgId: String(credential.orgId) }, 'Master registered again (revived, key rotated)')
    return revived
  } catch (e) {
    throw duplicate(e)
  }
}

/** E11000 on the partial index: another active node already has this installation. */
function duplicate(e: unknown): unknown {
  if ((e as any)?.code !== 11000) return e
  return new NodeError(409, 'installation_in_use', 'Another registered server has this installation. A cloned disk is registered again from its own install.')
}

/** ⚠ The unique insert IS the replay check; a read-then-write would let two replays both pass. */
async function recordAssertion(nodeId: string, jti: string, status: number, code: string): Promise<void> {
  try {
    await NodeAssertion.create({ nodeId, jti, expiresAt: new Date(Date.now() + ASSERTION_KEEP_MS) })
  } catch (e: any) {
    if (e?.code === 11000) throw new NodeError(status, code, 'That signed request has already been used.')
    throw e
  }
}

// ── Access tokens ──────────────────────────────────────────────────────────────────────────────

function b64u(input: string): string {
  return Buffer.from(input).toString('base64url')
}

/** A hand-rolled HS256 JWS signed with `NODE_TOKEN_SECRET`, never `JWT_SECRET` (see the config). */
export function signNodeToken(claims: Omit<NodeTokenClaims, 'aud' | 'iat' | 'exp'>): { token: string; expiresAt: Date } {
  if (!config.node.tokenSecret) throw new Error('This server issues no node tokens.')
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + config.node.tokenTtlSec
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64u(JSON.stringify({ ...claims, aud: NODE_TOKEN_AUDIENCE, iat, exp } satisfies NodeTokenClaims))
  const sig = createHmac('sha256', config.node.tokenSecret).update(`${header}.${payload}`).digest('base64url')
  return { token: `${header}.${payload}.${sig}`, expiresAt: new Date(exp * 1000) }
}

/**
 * The token's signature, audience and expiry. ⚠ It does NOT say the node is still allowed in: only
 * re-reading its row does (`loadActiveNode`), on every request.
 */
export function verifyNodeToken(token: unknown): NodeTokenClaims | null {
  // A master issues none, and must not accept one signed with an empty key.
  if (!config.node.tokenSecret || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, payload, sig] = parts
  let head: any
  try {
    head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  // ⚠ Pinned: `alg: none` and HMAC-with-the-public-key both live in this field.
  if (head?.alg !== 'HS256') return null
  const expected = createHmac('sha256', config.node.tokenSecret).update(`${header}.${payload}`).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let claims: any
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (claims?.aud !== NODE_TOKEN_AUDIENCE) return null
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null
  if (typeof claims.nodeId !== 'string' || !NODE_ID_PATTERN.test(claims.nodeId) || typeof claims.keyEpoch !== 'number') return null
  return claims as NodeTokenClaims
}

/** The token endpoint: the assertion is verified with the key on the node's row, then a token is minted. */
export async function issueNodeToken(
  assertion: unknown,
  audiences: string[],
  ip?: string,
): Promise<{ token: string; expiresAt: Date; serverTime: string; node: IServerNode }> {
  // ⚠ The unverified `sub` only selects which key to verify with; a wrong guess fails the signature.
  const sub = peekAssertionSub(assertion)
  if (!sub || !NODE_ID_PATTERN.test(sub)) throw new NodeError(401, 'bad_assertion', 'Invalid client assertion.')
  const node = await ServerNode.findById(sub)
  if (!node) throw new NodeError(401, 'bad_assertion', 'Invalid client assertion.')
  if (node.status !== 'active' || !node.orgIds?.length) {
    throw new NodeError(401, 'node_revoked', 'This server has been removed. Register it again.')
  }
  const result = verifyAssertion(assertion, node.publicKey, { audience: audiences })
  if (!result.ok) throw new NodeError(401, 'bad_assertion', 'Invalid client assertion.')
  await recordAssertion(node._id, result.claims.jti, 401, 'assertion_replayed')

  const { token, expiresAt } = signNodeToken({ nodeId: node._id, keyEpoch: node.keyEpoch ?? 1 })
  const now = Date.now()
  // FR-20.40 (P2-4c): the master's seal key, vouched for by the node key's signature over it. Only
  // ever taken from here: a proxy that sees a node token cannot put a key of its own on the row.
  const seal = result.claims.seal
  const newSeal = isSealPublicKey(seal) && seal !== node.sealKey ? { sealKey: seal, sealKeyAt: new Date(now) } : {}
  await ServerNode.updateOne(
    { _id: node._id, status: 'active' },
    { $set: { lastSeenAt: new Date(now), presence: { ip, clockSkewMs: result.claims.iat * 1000 - now }, ...newSeal } },
  )
  if (newSeal.sealKey) {
    node.sealKey = newSeal.sealKey
    logger.info({ nodeId: node._id }, 'A master registered its seal key (FR-20.40)')
  }
  return { token, expiresAt, serverTime: new Date(now).toISOString(), node }
}

function peekAssertionSub(assertion: unknown): string | null {
  if (typeof assertion !== 'string') return null
  const parts = assertion.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof payload?.sub === 'string' && payload.sub ? payload.sub : null
  } catch {
    return null
  }
}

/**
 * Re-read the row behind a token: what makes revocation immediate. ⚠ `keyEpoch` is compared, so a
 * node registered again with a new key leaves every older token dead without a blacklist.
 */
export async function loadActiveNode(claims: NodeTokenClaims): Promise<IServerNode> {
  const node = await ServerNode.findById(claims.nodeId)
  if (!node || node.status !== 'active' || !node.orgIds?.length) {
    throw new NodeError(401, 'node_revoked', 'This server has been removed. Register it again.')
  }
  if ((node.keyEpoch ?? 1) !== claims.keyEpoch) {
    throw new NodeError(401, 'key_rotated', 'This server\'s key has changed. Authenticate again.')
  }
  return node
}

/** The mirror's refusals that mean the master's history went back (`series-lock.service#WENT_BACK_REFUSALS`). */
const WENT_BACK: ReadonlySet<string> = new Set(['instance_changed', 'stale_journal', 'diverged'])

/** What a node may know about itself: its registration and the orgs on it, by name. */
export async function nodeSelf(node: IServerNode) {
  const orgs = await Org.find({ _id: { $in: node.orgIds } }).select('name slug').lean()
  // FR-20.51 (P3-7): what makes the master lock its legal series: a clone alarm, its pages refused as
  // a history that went back when that refusal is the newest thing the mirror heard, and how far the
  // mirror holds each org's journal (a master whose journal is below that went back).
  const states: any[] = await MirrorState.find({ orgId: { $in: node.orgIds }, nodeId: node._id, chainHash: { $nin: ['', null] } }, { orgId: 1, watermark: 1, lastRefusal: 1, lastPageAt: 1 }).lean()
  return {
    nodeId: node._id,
    name: node.name,
    linkLevel: node.linkLevel,
    status: node.status,
    keyEpoch: node.keyEpoch ?? 1,
    ephemeral: !!node.ephemeral,
    orgs: orgs.map((o: any) => ({ id: String(o._id), slug: o.slug, name: o.name })),
    cloneAlarm: (node as any).cloneAlarm?.at ? { at: (node as any).cloneAlarm.at } : null,
    wentBack: states
      .filter(s => WENT_BACK.has(s.lastRefusal?.reason) && s.lastRefusal.at && (!s.lastPageAt || new Date(s.lastRefusal.at) > new Date(s.lastPageAt)))
      .map(s => ({ orgId: String(s.orgId), reason: s.lastRefusal.reason, at: s.lastRefusal.at })),
    mirrors: states.map(s => ({ orgId: String(s.orgId), watermark: s.watermark ?? 0, lastPageAt: s.lastPageAt ?? null })),
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────────────────────

export type RevokeOutcome = 'removed' | 'revoked' | 'deleted'

/**
 * Take `orgId` off a node. ⚠ Per org: the node keeps serving its other orgs, and is revoked only
 * when this was its last one (an ephemeral one is deleted, so the field lanes leave no graveyard).
 * Each step is conditional on the row as read, so two orgs leaving at once cannot leave an active
 * node with no org, or revoke one that still has one.
 */
export async function revokeNodeForOrg(orgId: string, nodeId: string, userId: string, reason?: string): Promise<{ node: IServerNode; outcome: RevokeOutcome }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const node = await ServerNode.findOne({ _id: nodeId, orgIds: orgId, status: 'active' })
    if (!node) throw new NodeError(404, 'not_found', 'Server not found.')
    const others = node.orgIds.filter(id => String(id) !== orgId)
    const asRead = { _id: node._id, status: 'active', orgIds: { $size: node.orgIds.length, $all: node.orgIds } }
    if (others.length) {
      const r = await ServerNode.updateOne(asRead, { $pull: { orgIds: node.orgIds.find(id => String(id) === orgId) } })
      if (r.modifiedCount) return { node, outcome: 'removed' }
      continue
    }
    if (node.ephemeral) {
      const r = await ServerNode.deleteOne({ ...asRead, ephemeral: true })
      if (r.deletedCount) return { node, outcome: 'deleted' }
      continue
    }
    // The last org: the row stays, revoked and still naming it, as that org's record.
    const r = await ServerNode.updateOne(asRead, { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: userId, revokeReason: reason } })
    if (r.modifiedCount) return { node, outcome: 'revoked' }
  }
  throw new NodeError(409, 'node_changed', 'This server changed while it was being removed. Try again.')
}

/**
 * Remove ephemeral nodes silent for 24 h (FR-20.113). ⚠ ONLY `ephemeral: true` rows: a reaper that
 * gets this wrong deletes a shop's master because its internet was down.
 */
export async function reapEphemeralNodes(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - config.node.ephemeralSilenceMs)
  const r = await ServerNode.deleteMany({
    ephemeral: true,
    $or: [{ lastSeenAt: { $lt: cutoff } }, { lastSeenAt: { $exists: false } }],
  })
  if (r.deletedCount) logger.info({ count: r.deletedCount }, 'Reaped ephemeral masters')
  return r.deletedCount ?? 0
}

// ── Health (FR-20.57) ──────────────────────────────────────────────────────────────────────────

const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(v, max)) : undefined)
const str = (v: unknown, max = 40) => (typeof v === 'string' ? v.slice(0, max) : undefined)
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined)
/** The master's clock less global's as its frame arrived, in whole seconds; nothing when it sent none. */
const skewOf = (v: unknown, at: Date) => {
  const d = typeof v === 'string' ? new Date(v) : null
  if (!d || !Number.isFinite(d.getTime())) return undefined
  return Math.max(-1e7, Math.min(1e7, Math.round((d.getTime() - at.getTime()) / 1000)))
}
/** A version as a release names it, or nothing: never free text a master chose. */
const ver = (v: unknown) => (typeof v === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.-]{1,40})?$/.test(v) ? v : undefined)
/** FR-20.50: a SUPTO version (`SUPTO_VERSION_RE`), or the word a master uses for a release that names none. */
const supto = (v: unknown) => (typeof v === 'string' && (v === 'unknown' || SUPTO_VERSION_RE.test(v)) ? v : undefined)
const UPDATE_STATES = ['up-to-date', 'installing', 'deferred', 'not-versioned'] as const

/**
 * FR-20.20 (plan step P1-8e): what a master says about its own updates, kept for the Servers page:
 * what runs, what waits, why, and the alarm after seven windows kept out by open tills.
 */
function sanitizeUpdate(u: any) {
  if (!u || typeof u !== 'object') return undefined
  const state = (UPDATE_STATES as readonly string[]).includes(u.state) ? u.state : undefined
  if (!state) return undefined
  return {
    state, running: ver(u.running), available: ver(u.available), reason: str(u.reason, 160), blockedWindows: num(u.blockedWindows, 1000), alarm: bool(u.alarm),
    // FR-20.50 (P3-8c): the SUPTO version that runs, and the one an update waits for (an alarm).
    supto: supto(u.supto), suptoWaiting: supto(u.suptoWaiting),
  }
}

/**
 * A master's `health` frame, as global keeps it: only the fields it knows, every string cut short and
 * every number bounded. ⚠ The frame comes from a machine global does not run, so nothing in it is
 * kept as given: an unbounded field there would be an unbounded write here.
 */
/** Without its undefined fields, at every depth: Mongo would keep each one as a null. */
function compact<T>(v: T): T {
  if (Array.isArray(v)) return v.map(compact) as any
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, compact(x)])) as any
  }
  return v
}

export function sanitizeHealth(frame: any, at = new Date()): Record<string, unknown> {
  const children = Array.isArray(frame?.children)
    ? frame.children.slice(0, 8).map((c: any) => ({ name: str(c?.name, 20), state: str(c?.state, 20), failures: num(c?.failures, 1e6) }))
    : []
  return compact({
    at,
    versions: { app: str(frame?.versions?.app), protocol: num(frame?.versions?.protocol, 1e6) },
    uptimeSecs: num(frame?.uptimeSecs, 1e10),
    children,
    disk: { freeBytes: num(frame?.disk?.freeBytes, 1e16), totalBytes: num(frame?.disk?.totalBytes, 1e16) },
    // FR-20.101 (P3-8): what the alarms read (`node-alarms.ts`). The oplog's reach only once it wraps;
    // the clock as the skew between the master's and global's when the frame arrived.
    oplogWindowSecs: num(frame?.oplogWindowSecs, 1e10),
    clockSkewSecs: skewOf(frame?.clock, at),
    api: {
      ok: bool(frame?.api?.ok),
      posOpen: num(frame?.api?.posOpen, 1e6),
      fiscalInFlight: num(frame?.api?.fiscalInFlight, 1e6),
      clockTrusted: bool(frame?.api?.clockTrusted),
      lastBackupAt: when(frame?.api?.lastBackupAt, at),
      fenced: num(frame?.api?.fenced, 1e4),
      outboxQueued: num(frame?.api?.outboxQueued, 1e9),
    },
    update: sanitizeUpdate(frame?.update),
    // FR-20.82 (P3-6b): where its LAN ingress answers, and the pin of its CA: what a re-point names
    // for an org's desktops when the org moves here. Kept only in the shape a desktop would take.
    lan: typeof frame?.lan?.url === 'string' && LAN_URL.test(frame.lan.url) && typeof frame?.lan?.caFingerprint === 'string' && CA_PIN.test(frame.lan.caFingerprint)
      ? { url: frame.lan.url, caFingerprint: frame.lan.caFingerprint }
      : undefined,
  })
}

// ── What a master says of the orgs it writes (FR-20.51, P3-7) ───────────────────────────────────

const WENT_BACK_REASONS: ReadonlySet<string> = new Set(['mirror_ahead', 'instance_changed', 'stale_journal', 'diverged'])
const LOCK_REASONS: ReadonlySet<string> = new Set(['promoted', 'restored', 'went_back', 'clone'])
/** A time a master reported, kept only when it is one, and not after now (its clock may be wrong). */
const when = (v: unknown, now: Date) => {
  const d = typeof v === 'string' || v instanceof Date ? new Date(v) : null
  return d && Number.isFinite(d.getTime()) ? new Date(Math.min(d.getTime(), now.getTime())) : undefined
}

/**
 * A master's account of the orgs it writes (`POST /api/node/v1/org-state`, every minute): where each
 * org's journal stands, whether its database went back underneath the mirror, and whether its legal
 * numbering is locked and why. Kept per node, for the orgs it is registered for only, every string
 * cut short, every reason one of the known ones: shown to the org's admin on the Servers page, and
 * never trusted to decide what the mirror holds. Returns how many orgs it kept.
 */
export async function recordOrgState(node: IServerNode, body: any, at = new Date()): Promise<number> {
  const mine = new Set((node.orgIds ?? []).map(String))
  const seen = new Set<string>()
  const orgs: any[] = []
  for (const o of Array.isArray(body?.orgs) ? body.orgs.slice(0, 100) : []) {
    const orgId = typeof o?.orgId === 'string' ? o.orgId : ''
    if (!mine.has(orgId) || seen.has(orgId)) continue
    seen.add(orgId)
    const wentBack = o.wentBack && WENT_BACK_REASONS.has(o.wentBack.reason) ? compact({ at: when(o.wentBack.at, at), reason: o.wentBack.reason, detail: str(o.wentBack.detail, 300) }) : undefined
    const numbering = o.numbering && LOCK_REASONS.has(o.numbering.reason) ? compact({ since: when(o.numbering.since, at), reason: o.numbering.reason, detail: str(o.numbering.detail, 300) }) : undefined
    const head = num(o.head, 1e15)
    // ⚠ Not through `compact`: it would take the ObjectId apart.
    orgs.push({ orgId: (node.orgIds ?? []).find(id => String(id) === orgId), at, ...(head !== undefined ? { head } : {}), ...(wentBack ? { wentBack } : {}), ...(numbering ? { numbering } : {}) })
  }
  await ServerNode.updateOne({ _id: node._id }, { $set: { orgState: orgs } })
  return orgs.length
}

/** What the Servers page shows of a master's account of ONE org: never what it says of its others. */
export function orgStateFor(n: any, orgId: string) {
  const s = (n.orgState ?? []).find((x: any) => String(x.orgId) === orgId)
  return s ? { at: s.at, ...(s.wentBack ? { wentBack: s.wentBack } : {}), ...(s.numbering ? { numbering: s.numbering } : {}) } : null
}

/** Which channels of each node a live socket holds now: a row heartbeated within 75 s. */
export async function presenceOfNodes(ids: string[]): Promise<Map<string, { interactive: boolean; bulk: boolean }>> {
  const fresh = new Date(Date.now() - 75_000)
  const rows = await NodePresence.find({ nodeId: { $in: ids }, heartbeatAt: { $gte: fresh } }).select('nodeId channel').lean()
  const out = new Map<string, { interactive: boolean; bulk: boolean }>()
  for (const id of ids) out.set(id, { interactive: false, bulk: false })
  for (const r of rows as any[]) (out.get(r.nodeId) as any)[r.channel] = true
  return out
}

/** What the Servers page shows. ⚠ Never the key, the installation, or the node's other orgs. */
export function nodeToWire(n: any) {
  return {
    id: String(n._id),
    name: n.name,
    linkLevel: n.linkLevel,
    status: n.status,
    ephemeral: !!n.ephemeral,
    os: n.os,
    versions: n.versions,
    lastSeenAt: n.lastSeenAt,
    clockSkewMs: n.presence?.clockSkewMs,
    enrolledAt: n.enrolledAt,
    revokedAt: n.revokedAt,
    revokeReason: n.revokeReason,
    cloneAlarm: !!n.cloneAlarm?.at,
    health: n.health
      ? {
          at: n.health.at,
          appVersion: n.health.versions?.app,
          uptimeSecs: n.health.uptimeSecs,
          diskFreeBytes: n.health.disk?.freeBytes,
          diskTotalBytes: n.health.disk?.totalBytes,
          oplogWindowSecs: n.health.oplogWindowSecs,
          lastBackupAt: n.health.api?.lastBackupAt,
          outboxQueued: n.health.api?.outboxQueued,
          apiOk: n.health.api?.ok,
          posOpen: n.health.api?.posOpen,
          clockTrusted: n.health.api?.clockTrusted,
          update: n.health.update
            ? { state: n.health.update.state, available: n.health.update.available, reason: n.health.update.reason, blockedWindows: n.health.update.blockedWindows, alarm: !!n.health.update.alarm, supto: n.health.update.supto, suptoWaiting: n.health.update.suptoWaiting }
            : undefined,
        }
      : null,
  }
}
