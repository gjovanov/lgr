import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'

/**
 * Compact JWS with Ed25519 (EdDSA), the shape global's signed statements to a master take: the
 * licence (FR-20.55) and the "Sign in with LGR" assertion (FR-20.39). Each kind has its own `typ`
 * and its own keys, so one can never pass for the other.
 *
 * A key's id is the first 16 characters of the base64url SHA-256 of its SPKI DER, so a set of
 * public keys names itself and nothing has to keep kids and keys in step.
 *
 * Import-pure: `node:crypto` only.
 */

const MAX_JWS = 8192
const b64url = (b: Buffer) => b.toString('base64url')

export function kidOf(spkiDer: Buffer): string {
  return b64url(createHash('sha256').update(spkiDer).digest()).slice(0, 16)
}

/** Public keys by kid, from base64 SPKI DER. */
export function keysFromSpki(spkis: readonly string[]): ReadonlyMap<string, KeyObject> {
  return new Map(spkis.map(b64 => {
    const der = Buffer.from(b64, 'base64')
    return [kidOf(der), createPublicKey({ key: der, format: 'der', type: 'spki' })] as const
  }))
}

export interface SigningKey {
  kid: string
  privateKey: KeyObject
  publicKey: KeyObject
}

/** A signing key from its base64 PKCS#8 DER. Throws on anything but Ed25519. */
export function signingKeyFrom(pkcs8B64: string): SigningKey {
  const privateKey = createPrivateKey({ key: Buffer.from(pkcs8B64, 'base64'), format: 'der', type: 'pkcs8' })
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`the key must be Ed25519, not ${privateKey.asymmetricKeyType}`)
  const publicKey = createPublicKey(privateKey)
  return { kid: kidOf(publicKey.export({ format: 'der', type: 'spki' }) as Buffer), privateKey, publicKey }
}

/** A key made in this process (tests, a developer's machine). Never written anywhere. */
export function ephemeralSigningKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { kid: kidOf(publicKey.export({ format: 'der', type: 'spki' }) as Buffer), privateKey, publicKey }
}

export function signJws(typ: string, payload: object, key: SigningKey): string {
  const input = `${b64url(Buffer.from(JSON.stringify({ alg: 'EdDSA', typ, kid: key.kid })))}.${b64url(Buffer.from(JSON.stringify(payload)))}`
  return `${input}.${b64url(sign(null, Buffer.from(input), key.privateKey))}`
}

export type JwsFailure = 'malformed' | 'unknown_key' | 'bad_signature'
export type JwsVerified = { ok: true; payload: any; kid: string } | { ok: false; reason: JwsFailure }

/**
 * The payload of `jws` when it is of type `typ` and signed by one of `keys`. The signature is
 * checked before a byte of the payload is read; the header's `kid` only picks the key.
 */
export function verifyJws(jws: unknown, typ: string, keys: ReadonlyMap<string, KeyObject>): JwsVerified {
  if (typeof jws !== 'string' || jws.length > MAX_JWS) return { ok: false, reason: 'malformed' }
  const parts = jws.trim().split('.')
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'malformed' }
  let header: any
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (header?.alg !== 'EdDSA' || header?.typ !== typ || typeof header?.kid !== 'string') return { ok: false, reason: 'malformed' }
  const key = keys.get(header.kid)
  if (!key) return { ok: false, reason: 'unknown_key' }
  let good = false
  try {
    good = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))
  } catch {
    good = false
  }
  if (!good) return { ok: false, reason: 'bad_signature' }
  try {
    return { ok: true, payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')), kid: header.kid }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}
