import { config, nodeRole } from 'config'
import { Desktop, NodeState, ServerNode } from 'db/models'
import { homeOf } from 'db/home/home'
import { logger } from '../../logger/logger.js'
import { ephemeralSigningKey, signingKeyFrom, type SigningKey } from '../crypto/ed-jws.js'
import { BUILT_IN_REPOINT_KEYS, CA_PIN, CLOUD_URL, LAN_URL, allowRepointKeyInDevelopment, signRepoint } from './repoint-token.js'

/**
 * FR-20.82 (plan step P3-6b) — desktops follow their org's home. On global, a desktop whose org has
 * moved to its master is told where to go instead of being served: global holds that org's mirror
 * now, which only its home writes.
 *
 * - **A re-point** when global knows where the master answers on the shop's LAN (its health frame
 *   says so, `health.lan`) and holds its re-point key: signed, for that desktop alone.
 * - **"Moved"** otherwise: the desktop says the org has moved, and offers to pair it with the server.
 *
 * The desktop keeps its id and its key: its registry row moved with the org (FR-20.63), so on the
 * master it mints tokens as it did here, and no till is re-enrolled.
 *
 * The move back to lgrai.app (FR-20.80, P3-6c) is announced by the master, because the desktops are
 * connected to it: global signs one cloud instruction per desktop of the org at the flip
 * (`cloudRepointsFor`), the master keeps them (`keepCloudRepoints`), and its `movedFor` hands each
 * desktop its own.
 */

export type Moved =
  | { kind: 'repoint'; instruction: string; node: string; name: string }
  | { kind: 'moved'; node: string; name: string }

type IssuerKey = { ok: true; key: SigningKey } | { ok: false; reason: string }
let issuer: IssuerKey | undefined

/** The key global signs re-points with: `REPOINT_SIGNING_KEY`, a built-in one in production. */
export function repointIssuerKey(): IssuerKey {
  if (issuer) return issuer
  const production = process.env.NODE_ENV === 'production'
  const raw = config.repoint.signingKey
  if (!raw) {
    if (production) issuer = { ok: false, reason: 'REPOINT_SIGNING_KEY is not set' }
    else {
      const key = ephemeralSigningKey()
      allowRepointKeyInDevelopment(key)
      issuer = { ok: true, key }
    }
  } else {
    try {
      const key = signingKeyFrom(raw)
      if (production && !BUILT_IN_REPOINT_KEYS.has(key.kid)) {
        issuer = { ok: false, reason: `REPOINT_SIGNING_KEY (kid ${key.kid}) is not one of the keys built into this release, so no desktop would follow it` }
      } else {
        if (!production) allowRepointKeyInDevelopment(key)
        issuer = { ok: true, key }
      }
    } catch (e: any) {
      issuer = { ok: false, reason: `REPOINT_SIGNING_KEY is not a base64 PKCS#8 Ed25519 key (${e?.message ?? e})` }
    }
  }
  if (!issuer.ok) logger.error(`Desktops are told only that their org moved, never where: ${issuer.reason}`)
  return issuer
}

/** Tests: read the key again. */
export function resetRepointIssuerKey(): void {
  issuer = undefined
}

/**
 * What a desktop of `orgId` is told instead of being served, or null while the org's home is here.
 * Also null while the org is frozen for a move (it is still served, read-only) or homed nowhere
 * (`hold`): there is nowhere to send it yet.
 */
export async function movedFor(desktopId: string, orgId: string): Promise<Moved | null> {
  if (nodeRole() === 'master') {
    // FR-20.80 (P3-6c): the org went back to lgrai.app, and this server keeps a read-only copy. Each
    // of its desktops gets the instruction global signed for it at the flip, or else only "moved".
    const home = await homeOf(orgId)
    if (home.home !== 'global' || home.state !== 'active' || home.epoch <= 0) return null
    const kept: any = await NodeState.findById(cloudKey(orgId)).lean()
    const instruction = kept?.value?.epoch === home.epoch ? kept.value.instructions?.[desktopId] : undefined
    return typeof instruction === 'string'
      ? { kind: 'repoint', instruction, node: 'global', name: 'lgrai.app' }
      : { kind: 'moved', node: 'global', name: 'lgrai.app' }
  }
  if (nodeRole() !== 'global') return null
  const home = await homeOf(orgId)
  if (home.home === 'global' || home.state !== 'active') return null
  const node: any = await ServerNode.findById(home.home, { name: 1, status: 1, orgIds: 1, health: 1 }).lean()
  const name: string = node?.name ?? home.home
  const lan = node?.health?.lan
  const registered = node?.status === 'active' && (node.orgIds ?? []).some((id: unknown) => String(id) === orgId)
  // Only an address this server itself reported, in the shape a desktop takes.
  const known = registered && typeof lan?.url === 'string' && LAN_URL.test(lan.url) && typeof lan?.caFingerprint === 'string' && CA_PIN.test(lan.caFingerprint)
  if (!known) return { kind: 'moved', node: home.home, name }
  const key = repointIssuerKey()
  if (!key.ok) return { kind: 'moved', node: home.home, name }
  const instruction = signRepoint({ sub: desktopId, org: orgId, node: home.home, epoch: home.epoch, server: lan.url, fp: lan.caFingerprint }, key.key)
  return { kind: 'repoint', instruction, node: home.home, name }
}

/** lgrai.app's own origin, as a desktop reaches it: `OAUTH_BASE_URL`'s, when it is a public https one. */
export function cloudOrigin(): string | null {
  try {
    const u = new URL(config.oauth.baseUrl)
    return u.protocol === 'https:' && CLOUD_URL.test(u.origin) ? u.origin : null
  } catch {
    return null
  }
}

/**
 * FR-20.80 (P3-6c): one cloud re-point for each desktop of the org, at the move back's epoch, for the
 * master to hand on. None when global has no key to sign with, or no public https origin of its own.
 */
export async function cloudRepointsFor(orgId: string, epoch: number): Promise<Array<{ desktopId: string; instruction: string }>> {
  if (nodeRole() !== 'global') return []
  const key = repointIssuerKey()
  const server = cloudOrigin()
  if (!key.ok || !server) {
    if (!key.ok) logger.warn({ orgId, reason: key.reason }, 'Move back: no re-point key; the org\'s desktops are told only that it moved')
    return []
  }
  const desktops = await Desktop.find({ orgId, status: 'active' }, { _id: 1 }).lean()
  return desktops.map((d: any) => ({ desktopId: String(d._id), instruction: signRepoint({ sub: String(d._id), org: orgId, node: 'global', epoch, server }, key.key) }))
}

const cloudKey = (orgId: unknown) => `cloud-repoint:${String(orgId)}`

/** On a master: the cloud re-points global signed for an org that went back, kept for its desktops. */
export async function keepCloudRepoints(orgId: string, epoch: number, repoints: unknown): Promise<number> {
  const instructions: Record<string, string> = {}
  for (const r of Array.isArray(repoints) ? repoints : []) {
    if (typeof r?.desktopId === 'string' && /^[0-9a-f]{24}$/.test(r.desktopId) && typeof r?.instruction === 'string' && r.instruction.length <= 8192) {
      instructions[r.desktopId] = r.instruction
    }
  }
  await NodeState.updateOne({ _id: cloudKey(orgId) }, { $set: { value: { epoch, instructions, at: new Date() } } }, { upsert: true })
  return Object.keys(instructions).length
}

/** On a master: whether the org's cloud re-points are kept for that epoch. */
export async function cloudRepointsKept(orgId: string, epoch: number): Promise<boolean> {
  const kept: any = await NodeState.findById(cloudKey(orgId)).lean()
  return kept?.value?.epoch === epoch
}
