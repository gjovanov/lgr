import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto'
import keyFile from 'config/licence-keys'

/**
 * FR-20.55 (plan step P2-3b) — an org's licence on a master: a compact JWS (EdDSA) that global
 * signs and the master verifies with the public keys built into its package
 * (`config/src/licence-keys.json`, which the supervisor reads too).
 *
 * A licence names one org and one master, and the date it is paid through. Nothing in it is secret,
 * and nothing in it can be changed without the signature failing. It rotates only through a release,
 * because the keys that verify it come with the package.
 *
 * Import-pure: `node:crypto` only.
 */

export const LICENCE_VERSION = 1
export const LICENCE_TYPE = 'lgr-licence+jws'
/** Paid-through plus this, and nothing is blocked (FR-20.55). */
export const GRACE_DAYS = 30
/** A licence is a few hundred bytes. Anything far larger is not one. */
const MAX_JWS = 8192

export type LicencePlan = 'enterprise' | 'pilot'

export interface LicenceClaims {
  v: 1
  /** The org's id. */
  sub: string
  /** Its slug and name, for whoever reads the file. */
  org: string
  orgName: string
  /** The master it was issued for (`master-<16 base32>`). */
  node: string
  plan: LicencePlan
  /** The day it is paid through, ISO 8601. */
  paidThrough: string
  graceDays: number
  /** Seconds since the epoch. A newer licence replaces an older one, never the reverse. */
  iat: number
  jti: string
}

export type VerifyFailure = 'malformed' | 'unknown_key' | 'bad_signature' | 'bad_claims'
export type Verified = { ok: true; claims: LicenceClaims; kid: string } | { ok: false; reason: VerifyFailure }

const b64url = (b: Buffer) => b.toString('base64url')

/** A key's id: the first 16 characters of the base64url SHA-256 of its SPKI DER. */
export function kidOf(spkiDer: Buffer): string {
  return b64url(createHash('sha256').update(spkiDer).digest()).slice(0, 16)
}

function publicKeyFromSpki(b64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' })
}

/** The built-in keys, by kid. */
export const BUILT_IN_KEYS: ReadonlyMap<string, KeyObject> = new Map(
  (keyFile as { keys: Array<{ spki: string }> }).keys.map(k => [kidOf(Buffer.from(k.spki, 'base64')), publicKeyFromSpki(k.spki)] as const),
)

/** A key that signs: its id and its private half. */
export interface SigningKey {
  kid: string
  privateKey: KeyObject
  publicKey: KeyObject
}

/** A signing key from its base64 PKCS#8 DER (`LICENCE_SIGNING_KEY`). Throws on anything else. */
export function signingKeyFrom(pkcs8B64: string): SigningKey {
  const privateKey = createPrivateKey({ key: Buffer.from(pkcs8B64, 'base64'), format: 'der', type: 'pkcs8' })
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`the licence key must be Ed25519, not ${privateKey.asymmetricKeyType}`)
  const publicKey = createPublicKey(privateKey)
  return { kid: kidOf(publicKey.export({ format: 'der', type: 'spki' }) as Buffer), privateKey, publicKey }
}

/** A key made in this process, for the tests and a developer's machine. Never written anywhere. */
export function ephemeralSigningKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { kid: kidOf(publicKey.export({ format: 'der', type: 'spki' }) as Buffer), privateKey, publicKey }
}

/** Outside production: keys this process signs with that are not built in, so it verifies its own. */
const developmentKeys = new Map<string, KeyObject>()

/** Accept `key`'s licences in this process, outside production only. */
export function allowInDevelopment(key: SigningKey): void {
  developmentKeys.set(key.kid, key.publicKey)
}

/**
 * The keys a licence may be signed with here: the built-in ones, and outside production also the
 * ones this process signs with. ⚠ A production master accepts the built-in keys and nothing else.
 */
export function acceptedKeys(production = process.env.NODE_ENV === 'production'): ReadonlyMap<string, KeyObject> {
  if (production || !developmentKeys.size) return BUILT_IN_KEYS
  return new Map([...BUILT_IN_KEYS, ...developmentKeys])
}

export function signLicence(claims: Omit<LicenceClaims, 'v' | 'jti' | 'iat'> & { iat?: number }, key: SigningKey): string {
  const header = { alg: 'EdDSA', typ: LICENCE_TYPE, kid: key.kid }
  const body: LicenceClaims = {
    v: LICENCE_VERSION,
    ...claims,
    iat: claims.iat ?? Math.floor(Date.now() / 1000),
    jti: b64url(randomBytes(12)),
  }
  const input = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(body)))}`
  return `${input}.${b64url(sign(null, Buffer.from(input), key.privateKey))}`
}

const OBJECT_ID = /^[0-9a-f]{24}$/
const NODE_ID = /^master-[a-z2-7]{16}$/

function claimsOk(c: any): c is LicenceClaims {
  return (
    !!c && c.v === LICENCE_VERSION &&
    typeof c.sub === 'string' && OBJECT_ID.test(c.sub) &&
    typeof c.node === 'string' && NODE_ID.test(c.node) &&
    (c.plan === 'enterprise' || c.plan === 'pilot') &&
    typeof c.paidThrough === 'string' && Number.isFinite(Date.parse(c.paidThrough)) &&
    Number.isInteger(c.graceDays) && c.graceDays >= 0 && c.graceDays <= 366 &&
    Number.isInteger(c.iat) && c.iat > 0 &&
    typeof c.org === 'string' && typeof c.orgName === 'string' && typeof c.jti === 'string'
  )
}

/**
 * Verify a licence against `keys`. The signature is checked first; nothing is read from a payload
 * whose signature fails, and the header's `kid` only picks the key.
 */
export function verifyLicence(jws: unknown, keys: ReadonlyMap<string, KeyObject>): Verified {
  if (typeof jws !== 'string' || jws.length > MAX_JWS) return { ok: false, reason: 'malformed' }
  const parts = jws.trim().split('.')
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'malformed' }
  let header: any
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (header?.alg !== 'EdDSA' || header?.typ !== LICENCE_TYPE || typeof header?.kid !== 'string') return { ok: false, reason: 'malformed' }
  const key = keys.get(header.kid)
  if (!key) return { ok: false, reason: 'unknown_key' }
  let good = false
  try {
    good = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))
  } catch {
    good = false
  }
  if (!good) return { ok: false, reason: 'bad_signature' }
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'bad_claims' }
  }
  if (!claimsOk(claims)) return { ok: false, reason: 'bad_claims' }
  return { ok: true, claims, kid: header.kid }
}

/** When the grace ends: the paid-through date plus its grace days. */
export function graceEndsAt(claims: Pick<LicenceClaims, 'paidThrough' | 'graceDays'>): Date {
  return new Date(Date.parse(claims.paidThrough) + claims.graceDays * 86_400_000)
}
