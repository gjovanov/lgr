import { createHmac, timingSafeEqual } from 'crypto'
import {
  Desktop,
  DesktopAssertion,
  DesktopEnrollmentCode,
  DesktopEnrollmentKey,
  DesktopEnrollmentKeyUse,
  Org,
  type IDesktop,
} from 'db/models'
import { config } from 'config'
import { logger } from '../../logger/logger.js'
import {
  generateEnrollmentCode,
  generateEnrollmentKey,
  hashSecret,
  isValidDesktopPublicKey,
  normalizeEnrollmentCode,
  verifyAssertion,
} from './desktop-crypto.js'

/**
 * Desktop registration, access tokens and lifecycle (FR-14.18–14.22).
 *
 * ⚠ Every failure here returns the SAME shape with a machine-readable code and a flat message.
 * An enrollment endpoint that distinguishes "no such code" from "already used" from "expired" is
 * an oracle for probing an org's codes; the admin UI learns the difference from the code's own
 * row, which only an authenticated admin can read.
 */

export class DesktopError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** What every refusal on the enroll path says, whatever the real reason. */
const ENROLL_REFUSED = 'That registration code is not valid. Ask an administrator for a new one.'

const CODE_TTL_MS = 10 * 60 * 1000
/**
 * ⚠ ~41 bits of code is plenty against a rate-limited endpoint and far too little against an
 * unlimited one. Attempts are counted on the code's own row, so a flood at one code dies here
 * rather than after 2^41 tries.
 */
const MAX_CODE_ATTEMPTS = 10

// ── Minting (admin side) ─────────────────────────────────────────────────────────────────────

export async function mintEnrollmentCode(
  orgId: string,
  userId: string,
  serverOrigin: string,
): Promise<{ id: string; code: string; expiresAt: Date; deepLink: string }> {
  const { display, raw, prefix } = generateEnrollmentCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MS)
  const row = await DesktopEnrollmentCode.create({
    orgId,
    codeHash: hashSecret(raw),
    codePrefix: prefix,
    createdBy: userId,
    expiresAt,
  })
  return {
    id: String(row._id),
    // ⚠ The only time the code exists in plain text. It is not stored, and it cannot be shown
    // again — minting another is the recovery, which is also what makes single use meaningful.
    code: display,
    expiresAt,
    deepLink: `lgr://enroll?server=${encodeURIComponent(serverOrigin)}&code=${encodeURIComponent(display)}`,
  }
}

export async function mintEnrollmentKey(
  orgId: string,
  userId: string,
  input: { name: string; maxUses?: number; expiresAt?: Date; ephemeralTtlSec?: number },
): Promise<{ id: string; secret: string }> {
  await assertEphemeralKeysEnabled(orgId)
  const { secret, prefix } = generateEnrollmentKey()
  const row = await DesktopEnrollmentKey.create({
    orgId,
    name: input.name,
    keyHash: hashSecret(secret),
    keyPrefix: prefix,
    createdBy: userId,
    maxUses: input.maxUses ?? 0,
    expiresAt: input.expiresAt,
    ephemeralTtlSec: input.ephemeralTtlSec ?? 900,
  })
  return { id: String(row._id), secret }
}

/**
 * ⚠ The gate is checked on USE as well as on minting, so turning the org setting off revokes the
 * whole class at once (FR-14.19) instead of only stopping new keys being made.
 */
async function assertEphemeralKeysEnabled(orgId: string): Promise<void> {
  const org = await Org.findById(orgId).select('settings.desktop').lean()
  if (!(org as any)?.settings?.desktop?.ephemeralKeysEnabled) {
    throw new DesktopError(
      403,
      'ephemeral_keys_disabled',
      'Ephemeral enrollment keys are turned off for this organization.',
    )
  }
}

// ── Enrollment (desktop side) ────────────────────────────────────────────────────────────────

export interface EnrollInput {
  code?: string
  enrollmentKey?: string
  installationId: string
  machineId: string
  name: string
  os?: { platform?: string; version?: string; arch?: string }
  hostname?: string
  appVersion?: string
  publicKey: string
  ip?: string
}

export interface EnrollResult {
  desktopId: string
  orgId: string
  orgName: string
  assignment: { fiscalDeviceIds: string[]; startPath?: string }
  name: string
  serverTime: string
}

export async function enrollDesktop(input: EnrollInput): Promise<EnrollResult> {
  if (!isValidDesktopPublicKey(input.publicKey)) {
    throw new DesktopError(400, 'bad_public_key', 'The public key must be a base64 Ed25519 SPKI key.')
  }
  if (!input.installationId || !input.machineId || !input.name) {
    throw new DesktopError(400, 'bad_request', 'installationId, machineId and name are required.')
  }

  const credential = input.code
    ? await redeemCode(input.code)
    : await redeemKey(input.enrollmentKey)

  const desktop = await upsertDesktop(credential, input)

  if (credential.kind === 'code') {
    await DesktopEnrollmentCode.updateOne(
      { _id: credential.codeId },
      { $set: { usedAt: new Date(), usedByDesktopId: desktop._id } },
    )
  } else {
    await DesktopEnrollmentKey.updateOne({ _id: credential.keyId }, { $inc: { uses: 1 } })
    await DesktopEnrollmentKeyUse.create({
      orgId: credential.orgId,
      keyId: credential.keyId,
      desktopId: desktop._id,
      installationId: input.installationId,
      hostname: input.hostname,
      ip: input.ip,
    })
  }

  const org = await Org.findById(credential.orgId).select('name').lean()
  return {
    desktopId: String(desktop._id),
    orgId: String(credential.orgId),
    orgName: (org as any)?.name ?? '',
    assignment: {
      fiscalDeviceIds: (desktop.fiscalDeviceIds ?? []).map(String),
      startPath: desktop.startPath,
    },
    name: desktop.name,
    // ⚠ So the desktop can correct its own clock before signing its first assertion. The Win11
    // golden image the field lanes use runs ~+3 h off until `w32time` resyncs.
    serverTime: new Date().toISOString(),
  }
}

type Credential =
  | { kind: 'code'; orgId: any; codeId: any; createdBy: any }
  | { kind: 'key'; orgId: any; keyId: any; ephemeralTtlSec: number }

async function redeemCode(code: string): Promise<Credential> {
  const raw = normalizeEnrollmentCode(code)
  if (!raw) throw new DesktopError(400, 'enroll_refused', ENROLL_REFUSED)

  const row = await DesktopEnrollmentCode.findOne({ codeHash: hashSecret(raw) })
  if (!row) throw new DesktopError(400, 'enroll_refused', ENROLL_REFUSED)

  // ⚠ Count the attempt BEFORE deciding, and on the row we found, so a wrong guess at a real code
  // is what gets rate-limited. Counting only on success would limit nothing.
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    throw new DesktopError(429, 'enroll_refused', ENROLL_REFUSED)
  }
  if (row.usedAt || row.expiresAt.getTime() < Date.now()) {
    await DesktopEnrollmentCode.updateOne({ _id: row._id }, { $inc: { attempts: 1 } })
    throw new DesktopError(400, 'enroll_refused', ENROLL_REFUSED)
  }
  return { kind: 'code', orgId: row.orgId, codeId: row._id, createdBy: row.createdBy }
}

async function redeemKey(secret: unknown): Promise<Credential> {
  if (typeof secret !== 'string' || !secret) throw new DesktopError(400, 'enroll_refused', ENROLL_REFUSED)
  const row = await DesktopEnrollmentKey.findOne({ keyHash: hashSecret(secret) })
  if (!row) throw new DesktopError(400, 'enroll_refused', ENROLL_REFUSED)
  if (row.revokedAt) throw new DesktopError(400, 'enroll_refused', ENROLL_REFUSED)
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    throw new DesktopError(400, 'enroll_refused', ENROLL_REFUSED)
  }
  if (row.maxUses > 0 && row.uses >= row.maxUses) {
    throw new DesktopError(400, 'enroll_refused', ENROLL_REFUSED)
  }
  // The org-level switch, re-checked on use.
  await assertEphemeralKeysEnabled(String(row.orgId))
  return { kind: 'key', orgId: row.orgId, keyId: row._id, ephemeralTtlSec: row.ephemeralTtlSec }
}

/**
 * Create the desktop, or REVIVE the machine's revoked row (FR-14.19).
 *
 * ⚠ Reviving rather than inserting is why the unique index is partial. It keeps the row's audit
 * history and its assignment, and it keeps `nameAdminSet` winning over the desktop's own reported
 * name — an admin who renamed a till does not expect a reinstall to undo that.
 */
async function upsertDesktop(credential: Credential, input: EnrollInput): Promise<IDesktop> {
  const existing = await Desktop.findOne({
    orgId: credential.orgId,
    installationId: input.installationId,
  }).sort({ createdAt: -1 })

  const ephemeral = credential.kind === 'key'
  const common = {
    machineId: input.machineId,
    os: {
      platform: input.os?.platform ?? '',
      version: input.os?.version ?? '',
      arch: input.os?.arch ?? '',
    },
    hostname: input.hostname ?? '',
    appVersion: input.appVersion,
    publicKey: input.publicKey,
    status: 'active' as const,
    ephemeral,
    ephemeralTtlSec: ephemeral ? (credential as any).ephemeralTtlSec : undefined,
    enrollKeyId: ephemeral ? (credential as any).keyId : undefined,
    enrolledBy: credential.kind === 'code' ? credential.createdBy : undefined,
    enrolledAt: new Date(),
    revokedAt: undefined,
    revokedBy: undefined,
    revokeReason: undefined,
    lastSeenAt: new Date(),
  }

  if (existing) {
    Object.assign(existing, common)
    // A rotation, because the machine generated a fresh keypair to re-enroll.
    existing.keyEpoch = (existing.keyEpoch ?? 1) + 1
    existing.keyRotatedAt = new Date()
    if (!existing.nameAdminSet) existing.name = input.name
    await existing.save()
    logger.info(
      { orgId: String(credential.orgId), desktopId: String(existing._id) },
      'Desktop re-enrolled (row revived, key rotated)',
    )
    return existing
  }

  const created = await Desktop.create({
    orgId: credential.orgId,
    name: input.name,
    installationId: input.installationId,
    ...common,
  })
  logger.info(
    { orgId: String(credential.orgId), desktopId: String(created._id), ephemeral },
    'Desktop enrolled',
  )
  return created
}

// ── Access tokens ───────────────────────────────────────────────────────────────────────────

/** ⚠ Pinned into every desktop token, and checked on every desktop route. */
export const DESKTOP_TOKEN_AUDIENCE = 'lgr-desktop'

export interface DesktopTokenClaims {
  desktopId: string
  orgId: string
  keyEpoch: number
  aud: typeof DESKTOP_TOKEN_AUDIENCE
  iat: number
  exp: number
}

function b64u(input: Buffer | string): string {
  return Buffer.from(input as any).toString('base64url')
}

/**
 * Sign a desktop access token.
 *
 * A hand-rolled HS256 JWS rather than the Elysia jwt plugin, because it must be signed with
 * `DESKTOP_TOKEN_SECRET` and NOT `JWT_SECRET` — see the config comment. Keeping it here makes the
 * separation visible in one file instead of relying on which plugin instance a route happened to use.
 */
export function signDesktopToken(claims: Omit<DesktopTokenClaims, 'aud' | 'iat' | 'exp'>): {
  token: string
  expiresAt: Date
} {
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + config.desktop.tokenTtlSec
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64u(
    JSON.stringify({ ...claims, aud: DESKTOP_TOKEN_AUDIENCE, iat, exp } satisfies DesktopTokenClaims),
  )
  const sig = createHmac('sha256', config.desktop.tokenSecret).update(`${header}.${payload}`).digest('base64url')
  return { token: `${header}.${payload}.${sig}`, expiresAt: new Date(exp * 1000) }
}

/**
 * Verify a desktop access token's signature, audience and expiry.
 *
 * ⚠ This does NOT establish that the desktop is still allowed in. Only re-reading the row does
 * that (`loadActiveDesktop`), and every authenticated route must — the row is the revocation list.
 */
export function verifyDesktopToken(token: unknown): DesktopTokenClaims | null {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, payload, sig] = parts

  let head: any
  try {
    head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  // ⚠ Pinned. `alg: none` and "verify an HMAC with the public key" both live in this field.
  if (head?.alg !== 'HS256') return null

  const expected = createHmac('sha256', config.desktop.tokenSecret)
    .update(`${header}.${payload}`)
    .digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  let claims: any
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (claims?.aud !== DESKTOP_TOKEN_AUDIENCE) return null
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null
  if (!claims.desktopId || !claims.orgId) return null
  return claims as DesktopTokenClaims
}

/** The token endpoint. Verifies the assertion against the stored key, then mints. */
export async function issueDesktopToken(
  assertion: unknown,
  audience: string,
): Promise<{ token: string; expiresAt: Date; serverTime: string; desktop: IDesktop }> {
  // ⚠ `sub` is read from the assertion to find the row, and then the assertion is verified with
  // THAT row's key. An unverified `sub` selects which key to try; it grants nothing by itself, and
  // a wrong guess simply fails the signature check.
  const unverifiedSub = peekAssertionSub(assertion)
  if (!unverifiedSub) throw new DesktopError(401, 'bad_assertion', 'Invalid client assertion.')

  const desktop = await Desktop.findById(unverifiedSub)
  if (!desktop) throw new DesktopError(401, 'bad_assertion', 'Invalid client assertion.')
  // A revoked desktop must not be able to mint, whatever it can prove about its key.
  if (desktop.status !== 'active') {
    throw new DesktopError(401, 'desktop_revoked', 'This desktop has been removed from the organization.')
  }

  const result = verifyAssertion(assertion, desktop.publicKey, { audience })
  if (!result.ok) throw new DesktopError(401, 'bad_assertion', 'Invalid client assertion.')

  // ⚠ Replay protection is the UNIQUE INSERT, not a read-then-write: two simultaneous replays of
  // one assertion would both pass a read.
  try {
    await DesktopAssertion.create({
      desktopId: desktop._id,
      jti: result.claims.jti,
      // Kept a little past the assertion's own life, so a replay at the edge still collides.
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    })
  } catch (e: any) {
    if (e?.code === 11000) {
      throw new DesktopError(401, 'assertion_replayed', 'That client assertion has already been used.')
    }
    throw e
  }

  const { token, expiresAt } = signDesktopToken({
    desktopId: String(desktop._id),
    orgId: String(desktop.orgId),
    keyEpoch: desktop.keyEpoch ?? 1,
  })
  return { token, expiresAt, serverTime: new Date().toISOString(), desktop }
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
 * Re-read the row behind a token — the check that makes revocation immediate (FR-14.20).
 *
 * ⚠ `keyEpoch` is compared, so rotating a key invalidates every outstanding token without any
 * token blacklist. A token minted before the rotation still verifies cryptographically; it is
 * refused here.
 */
export async function loadActiveDesktop(claims: DesktopTokenClaims): Promise<IDesktop> {
  const desktop = await Desktop.findById(claims.desktopId)
  if (!desktop || desktop.status !== 'active') {
    throw new DesktopError(401, 'desktop_revoked', 'This desktop has been removed from the organization.')
  }
  if ((desktop.keyEpoch ?? 1) !== claims.keyEpoch) {
    throw new DesktopError(401, 'key_rotated', 'This desktop\'s key has been rotated. Re-authenticate.')
  }
  // ⚠ The org comes from the ROW, never from the token's claim being trusted on its own. They are
  // written together, so a mismatch means something is wrong enough to refuse.
  if (String(desktop.orgId) !== claims.orgId) {
    throw new DesktopError(401, 'desktop_revoked', 'This desktop has been removed from the organization.')
  }
  return desktop
}

// ── Reporting and presence ──────────────────────────────────────────────────────────────────

export type Presence = 'online' | 'stale' | 'offline'

/** Seen within this window but with no live socket = `stale` (FR-14.21). */
export const PRESENCE_STALE_MS = 90 * 1000

export function presenceOf(desktop: Pick<IDesktop, 'lastSeenAt'>, hasSocket: boolean): Presence {
  if (hasSocket) return 'online'
  const seen = desktop.lastSeenAt?.getTime() ?? 0
  return Date.now() - seen <= PRESENCE_STALE_MS ? 'stale' : 'offline'
}

export async function reportSelf(
  desktop: IDesktop,
  input: {
    appVersion?: string
    os?: { platform?: string; version?: string; arch?: string }
    capabilities?: { fiscalBridge?: boolean; serialPorts?: string[] }
    hostname?: string
    clientTime?: string
    ip?: string
  },
): Promise<void> {
  const set: Record<string, unknown> = { lastSeenAt: new Date() }
  if (input.appVersion) set.appVersion = input.appVersion
  if (input.hostname) set.hostname = input.hostname
  if (input.os) set.os = { platform: input.os.platform ?? '', version: input.os.version ?? '', arch: input.os.arch ?? '' }
  if (input.capabilities) set.capabilities = input.capabilities
  set.lastPresence = {
    ip: input.ip,
    clockSkewMs: clockSkewMs(input.clientTime),
  }
  await Desktop.updateOne({ _id: desktop._id }, { $set: set })
}

/**
 * How far the desktop's wall clock is from ours, per heartbeat (FR-14.21).
 *
 * Recorded rather than corrected: the desktop adjusts its own view from `serverTime`, and the
 * skew is worth SHOWING an admin because a wrong clock on a till breaks fiscal device time sync,
 * which is Bulgarian-time-sensitive.
 */
export function clockSkewMs(clientTime: unknown): number | undefined {
  if (typeof clientTime !== 'string') return undefined
  const t = Date.parse(clientTime)
  if (Number.isNaN(t)) return undefined
  return t - Date.now()
}

// ── Lifecycle (admin side) ──────────────────────────────────────────────────────────────────

export async function revokeDesktop(
  orgId: string,
  desktopId: string,
  userId: string,
  reason?: string,
): Promise<IDesktop> {
  const desktop = await Desktop.findOne({ _id: desktopId, orgId })
  if (!desktop) throw new DesktopError(404, 'not_found', 'Desktop not found.')

  // ⚠ An ephemeral row is DELETED, not kept as revoked. They are created by the dozen by the field
  // lanes, and a revoked-row graveyard would bury the real desktops in the admin list.
  if (desktop.ephemeral) {
    await Desktop.deleteOne({ _id: desktop._id })
    return desktop
  }

  desktop.status = 'revoked'
  desktop.revokedAt = new Date()
  desktop.revokedBy = userId as any
  desktop.revokeReason = reason
  await desktop.save()
  return desktop
}

export async function rotateDesktopKey(orgId: string, desktopId: string): Promise<IDesktop> {
  const desktop = await Desktop.findOne({ _id: desktopId, orgId })
  if (!desktop) throw new DesktopError(404, 'not_found', 'Desktop not found.')
  desktop.keyEpoch = (desktop.keyEpoch ?? 1) + 1
  desktop.keyRotatedAt = new Date()
  await desktop.save()
  return desktop
}

export async function updateDesktop(
  orgId: string,
  desktopId: string,
  input: { name?: string; fiscalDeviceIds?: string[]; startPath?: string },
): Promise<IDesktop> {
  const desktop = await Desktop.findOne({ _id: desktopId, orgId })
  if (!desktop) throw new DesktopError(404, 'not_found', 'Desktop not found.')

  if (input.name !== undefined && input.name !== desktop.name) {
    desktop.name = input.name
    // ⚠ From now on the desktop's own reported name loses, including across re-enrollment.
    desktop.nameAdminSet = true
  }
  if (input.fiscalDeviceIds !== undefined) desktop.fiscalDeviceIds = input.fiscalDeviceIds as any
  if (input.startPath !== undefined) desktop.startPath = input.startPath || undefined
  await desktop.save()
  return desktop
}

/**
 * Remove ephemeral desktops that stopped reporting (FR-14.19).
 *
 * ⚠ It touches ONLY `ephemeral: true` rows. A reaper that gets this wrong deletes a customer's
 * till because the shop's internet was down, so the negative case is the one the tests assert.
 */
export async function reapEphemeralDesktops(now = new Date()): Promise<number> {
  const candidates = await Desktop.find({ ephemeral: true }).select('_id lastSeenAt ephemeralTtlSec orgId').lean()
  const doomed = candidates
    .filter(d => {
      const ttlMs = ((d as any).ephemeralTtlSec ?? 900) * 1000
      const seen = (d as any).lastSeenAt ? new Date((d as any).lastSeenAt).getTime() : 0
      return now.getTime() - seen > ttlMs
    })
    .map(d => (d as any)._id)
  if (!doomed.length) return 0
  await Desktop.deleteMany({ _id: { $in: doomed }, ephemeral: true })
  logger.info({ count: doomed.length }, 'Reaped ephemeral desktops')
  return doomed.length
}
