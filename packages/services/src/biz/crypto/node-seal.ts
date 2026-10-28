import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto'

/**
 * What lgrai.app seals to ONE master (FR-20.40, plan step P2-4c): a person's local credential, which
 * only that master can open, whatever sits between the two (FR-20.53 lets a TLS-inspecting proxy in).
 *
 * X25519 with a fresh ephemeral key per message, HKDF-SHA256, AES-256-GCM. The recipient is the
 * master's seal key: its API made it (`node/node-seal-key.ts`), and its supervisor vouches for it
 * with the node key, as the `seal` claim of the token assertions it signs (`node_token.rs`).
 *
 * - ⚠ **Nothing about the plaintext is in the clear.** The backup seal (`backup-crypto.ts`) puts an
 *   unsalted SHA-256 of its plaintext in the header, which for a six-digit PIN's verifier would be
 *   no seal at all. It is not reused here for that reason.
 * - ⚠ **The context (`aad`) binds a sealed value to what it is for:** one master, one person, one
 *   org, one kind, one version. Moved into another item, or with a clear field changed, it does not
 *   open.
 * - It does not say who sealed it: anyone holding the public key can. That a value came from global
 *   is the node token's TLS channel's to say; the seal only keeps it unread on the way.
 *
 * Keys are base64url of the raw 32 bytes. Import-pure: no models, no config.
 */

const VERSION = 'lgrseal1'
const INFO = Buffer.from('lgr-node-seal-v1')
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex')
const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const RAW_KEY = /^[A-Za-z0-9_-]{43}$/

const publicKeyOf = (raw: Buffer): KeyObject => createPublicKey({ key: Buffer.concat([X25519_SPKI, raw]), format: 'der', type: 'spki' })
const privateKeyOf = (raw: Buffer): KeyObject => createPrivateKey({ key: Buffer.concat([X25519_PKCS8, raw]), format: 'der', type: 'pkcs8' })
const rawPublic = (key: KeyObject): Buffer => key.export({ format: 'der', type: 'spki' }).subarray(X25519_SPKI.length)

/** Whether this is an X25519 public key a value can be sealed to: 32 bytes, not the zero point. */
export function isSealPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || !RAW_KEY.test(value)) return false
  const raw = Buffer.from(value, 'base64url')
  if (raw.length !== 32 || raw.every(b => b === 0)) return false
  try {
    publicKeyOf(raw)
    return true
  } catch {
    return false
  }
}

/** A new seal key pair. */
export function generateSealKey(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    publicKey: rawPublic(publicKey).toString('base64url'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(X25519_PKCS8.length).toString('base64url'),
  }
}

/** The public half of a private seal key, or null when it is not one. */
export function sealPublicKeyOf(privateKey: string): string | null {
  try {
    const raw = Buffer.from(privateKey, 'base64url')
    if (raw.length !== 32) return null
    return rawPublic(createPublicKey(privateKeyOf(raw))).toString('base64url')
  } catch {
    return null
  }
}

const keyFor = (shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer =>
  Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeral, recipient]), INFO, 32))

/** Seal `plaintext` to `recipient` for `aad`: `lgrseal1.<ephemeral>.<iv>.<ciphertext+tag>`. */
export function sealTo(recipient: string, plaintext: string, aad: string): string {
  if (!isSealPublicKey(recipient)) throw new Error('not an X25519 seal key')
  const to = Buffer.from(recipient, 'base64url')
  const ephemeral = generateKeyPairSync('x25519')
  const ephemeralRaw = rawPublic(ephemeral.publicKey)
  const key = keyFor(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicKeyOf(to) }), ephemeralRaw, to)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`${VERSION}|${aad}`))
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return [VERSION, ephemeralRaw.toString('base64url'), iv.toString('base64url'), body.toString('base64url')].join('.')
}

/** Open what was sealed to this private key for `aad`. Null for anything that does not open. */
export function openSealed(privateKey: string, sealed: unknown, aad: string): string | null {
  if (typeof sealed !== 'string') return null
  try {
    const [version, e, i, b, ...rest] = sealed.split('.')
    if (version !== VERSION || rest.length || !e || !i || !b) return null
    const ephemeralRaw = Buffer.from(e, 'base64url')
    const iv = Buffer.from(i, 'base64url')
    const body = Buffer.from(b, 'base64url')
    if (ephemeralRaw.length !== 32 || iv.length !== 12 || body.length < 17) return null
    const own = privateKeyOf(Buffer.from(privateKey, 'base64url'))
    const ownRaw = rawPublic(createPublicKey(own))
    const key = keyFor(diffieHellman({ privateKey: own, publicKey: publicKeyOf(ephemeralRaw) }), ephemeralRaw, ownRaw)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(`${VERSION}|${aad}`))
    decipher.setAuthTag(body.subarray(body.length - 16))
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
