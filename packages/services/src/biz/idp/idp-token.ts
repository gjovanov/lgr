import { randomBytes, type KeyObject } from 'node:crypto'
import keyFile from 'config/idp-keys'
import { keysFromSpki, signJws, verifyJws, type SigningKey } from '../crypto/ed-jws.js'

/**
 * FR-20.39 (plan step P2-4) — the assertion global hands a master when a person signs in to it with
 * "Sign in with LGR": who the person is, in which org, for which master, for five minutes.
 *
 * The master verifies it with the identity keys built into its package (`config/src/idp-keys.json`),
 * never with a key it learned over a network. It is never a session: the master maps it to the
 * person's membership and issues its own.
 *
 * Import-pure: `node:crypto` only.
 */

export const IDP_TYPE = 'lgr-idp+jws'
export const ASSERTION_TTL_SEC = 5 * 60
/** A master's clock may run ahead of global's by this much and still accept a fresh assertion. */
const ISSUED_AHEAD_SEC = 120

export interface IdpAssertion {
  v: 1
  iss: 'lgrai.app'
  /** The master it was issued to (`master-<16 base32>`). */
  aud: string
  /** The person (`Identity._id`). */
  sub: string
  /** The org, and the person's membership in it (`User._id`, the same on global and on the master). */
  org: string
  uid: string
  email: string
  /** The person's `tokenVersion` when they signed in: the master's sessions honour revocation from it. */
  tv: number
  /** How the person signed in to lgrai.app. */
  amr: string[]
  iat: number
  exp: number
  jti: string
}

export const BUILT_IN_IDP_KEYS: ReadonlyMap<string, KeyObject> = keysFromSpki((keyFile as { keys: Array<{ spki: string }> }).keys.map(k => k.spki))

const developmentKeys = new Map<string, KeyObject>()

/** Accept `key`'s assertions in this process, outside production only. */
export function allowIdpKeyInDevelopment(key: SigningKey): void {
  developmentKeys.set(key.kid, key.publicKey)
}

/** The built-in keys; outside production also the ones this process signs with. */
export function acceptedIdpKeys(production = process.env.NODE_ENV === 'production'): ReadonlyMap<string, KeyObject> {
  if (production || !developmentKeys.size) return BUILT_IN_IDP_KEYS
  return new Map([...BUILT_IN_IDP_KEYS, ...developmentKeys])
}

export function signAssertion(claims: Omit<IdpAssertion, 'v' | 'iss' | 'iat' | 'exp' | 'jti'>, key: SigningKey, now = Date.now()): { jws: string; expiresAt: Date } {
  const iat = Math.floor(now / 1000)
  const body: IdpAssertion = { v: 1, iss: 'lgrai.app', ...claims, iat, exp: iat + ASSERTION_TTL_SEC, jti: randomBytes(12).toString('base64url') }
  return { jws: signJws(IDP_TYPE, body, key), expiresAt: new Date(body.exp * 1000) }
}

const OBJECT_ID = /^[0-9a-f]{24}$/
const NODE_ID = /^master-[a-z2-7]{16}$/

export type AssertionFailure = 'malformed' | 'unknown_key' | 'bad_signature' | 'bad_claims' | 'wrong_audience' | 'expired'
export type AssertionVerified = { ok: true; claims: IdpAssertion } | { ok: false; reason: AssertionFailure }

/** An assertion for THIS master (`audience`), signed by one of `keys`, and not expired. */
export function verifyAssertion(jws: unknown, audience: string, keys: ReadonlyMap<string, KeyObject>, now = Date.now()): AssertionVerified {
  const v = verifyJws(jws, IDP_TYPE, keys)
  if (!v.ok) return v
  const c = v.payload
  const shaped = !!c && c.v === 1 && c.iss === 'lgrai.app' && typeof c.aud === 'string' && NODE_ID.test(c.aud)
    && typeof c.sub === 'string' && OBJECT_ID.test(c.sub) && typeof c.org === 'string' && OBJECT_ID.test(c.org)
    && typeof c.uid === 'string' && OBJECT_ID.test(c.uid) && typeof c.email === 'string'
    && Number.isInteger(c.tv) && c.tv >= 0 && Array.isArray(c.amr) && c.amr.every((a: unknown) => typeof a === 'string')
    && Number.isInteger(c.iat) && Number.isInteger(c.exp) && typeof c.jti === 'string'
  if (!shaped) return { ok: false, reason: 'bad_claims' }
  if (c.aud !== audience) return { ok: false, reason: 'wrong_audience' }
  const sec = Math.floor(now / 1000)
  if (c.exp <= sec || c.iat > sec + ISSUED_AHEAD_SEC || c.exp - c.iat > ASSERTION_TTL_SEC) return { ok: false, reason: 'expired' }
  return { ok: true, claims: c as IdpAssertion }
}
