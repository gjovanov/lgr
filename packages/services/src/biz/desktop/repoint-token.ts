import { randomBytes, type KeyObject } from 'node:crypto'
import keyFile from 'config/repoint-keys'
import { keysFromSpki, signJws, verifyJws, type SigningKey } from '../crypto/ed-jws.js'

/**
 * FR-20.82 (plan step P3-6b) — a re-point: global telling ONE desktop that its org's home is now a
 * master, where that master answers on the shop's LAN, and which CA to pin there.
 *
 * FR-20.80 (P3-6c) — or that its org lives on lgrai.app again: `node: 'global'`, the cloud's origin,
 * and NO pin (the machine's trust store vouches for a public name). Global signs it at the move back's
 * flip, one per desktop, and the master the desktops are connected to relays it. The desktop follows
 * one only to the cloud built into it.
 *
 * The desktop follows it only when one of the keys built into it (`config/src/repoint-keys.json`,
 * embedded by the shell) verifies it. ⚠ That is the point: a till reaches lgrai.app through the
 * machine's trust store, so a TLS-inspecting middlebox it trusts could otherwise send it to a server
 * of the middlebox's choosing, pinned and trusted from then on.
 *
 * Bound to the desktop (`sub`), its org, and the move's epoch: a desktop takes an epoch once and
 * never an older one, so a replayed instruction cannot send it back to a home it left.
 *
 * Import-pure: `node:crypto` only.
 */

export const REPOINT_TYPE = 'lgr-repoint+jws'
/** Sent again on every connection while it holds, so it need not live long; a till's clock can be days out. */
export const REPOINT_TTL_SEC = 30 * 24 * 3600
/** A desktop's clock may run behind global's by this much and still take a fresh instruction. */
const ISSUED_AHEAD_SEC = 24 * 3600

export interface Repoint {
  v: 1
  iss: 'lgrai.app'
  /** The desktop it is for (`Desktop._id`, the same on global and on the master). */
  sub: string
  org: string
  /** The org's new home (a master's id, or `global` for lgrai.app), and the epoch it took there. */
  node: string
  epoch: number
  /** Where the new home answers: `https://<host>[:port]`, nothing more. A master's LAN ingress, or the cloud. */
  server: string
  /** The pin of the master's LAN CA: `sha256:` and the base64url SHA-256 of its SPKI. Never for the cloud. */
  fp?: string
  iat: number
  exp: number
  jti: string
}

export const BUILT_IN_REPOINT_KEYS: ReadonlyMap<string, KeyObject> = keysFromSpki((keyFile as { keys: Array<{ spki: string }> }).keys.map(k => k.spki))

const developmentKeys = new Map<string, KeyObject>()

/** Accept `key`'s instructions in this process, outside production only. */
export function allowRepointKeyInDevelopment(key: SigningKey): void {
  developmentKeys.set(key.kid, key.publicKey)
}

/** The built-in keys; outside production also the ones this process signs with. */
export function acceptedRepointKeys(production = process.env.NODE_ENV === 'production'): ReadonlyMap<string, KeyObject> {
  if (production || !developmentKeys.size) return BUILT_IN_REPOINT_KEYS
  return new Map([...BUILT_IN_REPOINT_KEYS, ...developmentKeys])
}

export function signRepoint(claims: Omit<Repoint, 'v' | 'iss' | 'iat' | 'exp' | 'jti'>, key: SigningKey, now = Date.now()): string {
  const iat = Math.floor(now / 1000)
  const body: Repoint = { v: 1, iss: 'lgrai.app', ...claims, iat, exp: iat + REPOINT_TTL_SEC, jti: randomBytes(12).toString('base64url') }
  return signJws(REPOINT_TYPE, body, key)
}

const OBJECT_ID = /^[0-9a-f]{24}$/
const NODE_ID = /^master-[a-z2-7]{16}$/
/** `https://` and a host (a name, an IPv4 address, or a bracketed IPv6 one), an optional port, nothing else. */
export const LAN_URL = /^https:\/\/([A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63}){0,10}|\[[0-9A-Fa-f:.]{2,45}\])(:\d{1,5})?$/
export const CA_PIN = /^sha256:[A-Za-z0-9_-]{43}$/
/** The cloud's origin: `https://` and a dotted public name, an optional port. Never an address or a bare name. */
export const CLOUD_URL = /^https:\/\/[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63}){1,10}(:\d{1,5})?$/

export type RepointFailure = 'malformed' | 'unknown_key' | 'bad_signature' | 'bad_claims' | 'expired'
export type RepointVerified = { ok: true; claims: Repoint } | { ok: false; reason: RepointFailure }

/**
 * An instruction signed by one of `keys` and not expired, its claims as a desktop would take them.
 * The desktop's own check (`packages/desktop/src-tauri/src/repoint.rs`) is the one that matters; this
 * one is global's half of the same contract, for tests and diagnostics.
 */
export function verifyRepoint(jws: unknown, keys: ReadonlyMap<string, KeyObject>, now = Date.now()): RepointVerified {
  const v = verifyJws(jws, REPOINT_TYPE, keys)
  if (!v.ok) return v
  const c = v.payload
  const shaped = !!c && c.v === 1 && c.iss === 'lgrai.app' && typeof c.sub === 'string' && OBJECT_ID.test(c.sub)
    && typeof c.org === 'string' && OBJECT_ID.test(c.org) && typeof c.node === 'string'
    && Number.isSafeInteger(c.epoch) && c.epoch > 0 && typeof c.server === 'string'
    && Number.isInteger(c.iat) && Number.isInteger(c.exp) && typeof c.jti === 'string'
    // To a master: its LAN address and the pin of its CA. Back to the cloud: its origin, and no pin.
    && ((NODE_ID.test(c.node) && LAN_URL.test(c.server) && typeof c.fp === 'string' && CA_PIN.test(c.fp))
      || (c.node === 'global' && CLOUD_URL.test(c.server) && c.fp === undefined))
  if (!shaped) return { ok: false, reason: 'bad_claims' }
  const sec = Math.floor(now / 1000)
  if (c.exp <= sec || c.iat > sec + ISSUED_AHEAD_SEC) return { ok: false, reason: 'expired' }
  return { ok: true, claims: c as Repoint }
}
