import { config, nodeRole } from 'config'
import { ServerNode } from 'db/models'
import { homeOf } from 'db/home/home'
import { logger } from '../../logger/logger.js'
import { ephemeralSigningKey, signingKeyFrom, type SigningKey } from '../crypto/ed-jws.js'
import { BUILT_IN_REPOINT_KEYS, CA_PIN, LAN_URL, allowRepointKeyInDevelopment, signRepoint } from './repoint-token.js'

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
 * master it mints tokens as it did here, and no till is re-enrolled. Global only; the move back to
 * lgrai.app (P3-6c) is the master's to announce.
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
    // FR-20.80 (P3-6c): the org went back to lgrai.app, and this server keeps a read-only copy. Its
    // desktops are told so; following on their own is P3-6c's second step (a signed instruction).
    const home = await homeOf(orgId)
    return home.home === 'global' && home.state === 'active' && home.epoch > 0 ? { kind: 'moved', node: 'global', name: 'lgrai.app' } : null
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
