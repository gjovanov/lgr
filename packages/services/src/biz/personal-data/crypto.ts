/**
 * FR-25 §3.12: what personal data is sealed with. Import-pure: no database, no config, so a unit
 * test boots nothing, and a migration or a script can use it as it is.
 *
 * ⚠ The additional data is what stops a ciphertext being moved. Someone able to write to the
 * database but not holding a key could otherwise copy their own sealed IBAN onto a colleague's row
 * and have that colleague's salary paid to them, without ever decrypting anything. So a value opens
 * only on the document and the field it was sealed for. The org is not in it on purpose: a key
 * belongs to one org's row (`PersonalDataKey`), so another org simply has no key to try.
 *
 * Format, a plain string so that any schema can hold it: `pd1.<keyId>.<nonce>.<ciphertext+tag>`.
 */
import crypto from 'node:crypto'

export const SEALED_PREFIX = 'pd1'

const ALG = 'aes-256-gcm'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

/** What every org's key row seals, so that a key can be proven right without touching real data. */
export const CANARY = 'lgr-personal-data-canary-v1'

export function generateKey(): Buffer {
  return crypto.randomBytes(KEY_BYTES)
}

export function generateKeyId(): string {
  return crypto.randomBytes(8).toString('hex')
}

/** A KEK as configured: base64 of 32 bytes. Anything else is refused rather than stretched. */
export function parseKek(raw: string): Buffer {
  const key = Buffer.from(raw.trim(), 'base64')
  if (key.length !== KEY_BYTES) throw new Error(`a personal-data key must be ${KEY_BYTES} bytes of base64`)
  return key
}

/** Names a KEK without revealing it, so a row can say which one wrapped it. */
export function kekIdOf(kek: Buffer): string {
  return crypto.createHash('sha256').update(kek).digest('hex').slice(0, 12)
}

export function aadFor(keyId: string, model: string, docId: string, path: string): string {
  return `${keyId}|${model}|${docId}|${path}`
}

/**
 * Where one person's line lives on a run. The person is in the path, so that swapping two people's
 * ciphertexts inside one run does not open, as moving a value between documents does not.
 */
export function runItemPath(entry: { employeeId: unknown; contractId?: unknown }): string {
  return `item:${String(entry.employeeId)}:${entry.contractId ? String(entry.contractId) : '-'}`
}

export function isSealed(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${SEALED_PREFIX}.`)
}

export function keyIdOf(sealed: string): string {
  const parts = sealed.split('.')
  if (parts.length !== 4 || parts[0] !== SEALED_PREFIX) throw new Error('not a sealed value')
  return parts[1]
}

export function seal(key: Buffer, keyId: string, plain: string | Buffer, aad: string): string {
  const nonce = crypto.randomBytes(NONCE_BYTES)
  const cipher = crypto.createCipheriv(ALG, key, nonce)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const body = Buffer.concat([cipher.update(typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain), cipher.final()])
  const sealed = Buffer.concat([body, cipher.getAuthTag()])
  return `${SEALED_PREFIX}.${keyId}.${nonce.toString('base64url')}.${sealed.toString('base64url')}`
}

export function openBytes(key: Buffer, sealed: string, aad: string): Buffer {
  const parts = sealed.split('.')
  if (parts.length !== 4 || parts[0] !== SEALED_PREFIX) throw new Error('not a sealed value')
  const nonce = Buffer.from(parts[2], 'base64url')
  const body = Buffer.from(parts[3], 'base64url')
  if (nonce.length !== NONCE_BYTES || body.length < TAG_BYTES) throw new Error('not a sealed value')
  const decipher = crypto.createDecipheriv(ALG, key, nonce)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES))
  return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()])
}

export function open(key: Buffer, sealed: string, aad: string): string {
  return openBytes(key, sealed, aad).toString('utf8')
}

/** A data key or an index key, wrapped by the KEK. Bound to its key id, so two cannot be swapped. */
export function wrapKey(kek: Buffer, keyId: string, role: 'dek' | 'index', key: Buffer): string {
  return seal(kek, keyId, key, `PersonalDataKey|${keyId}|${role}`)
}

export function unwrapKey(kek: Buffer, wrapped: string, role: 'dek' | 'index'): Buffer {
  const keyId = keyIdOf(wrapped)
  return openBytes(kek, wrapped, `PersonalDataKey|${keyId}|${role}`)
}

/**
 * Equality search over a sealed value. A person's ЕГН is ten digits, so without a secret this would
 * be a lookup table away from the ЕГН itself: the index key is the whole of its protection.
 */
export function blindIndex(indexKey: Buffer, field: string, value: string): string {
  return crypto.createHmac('sha256', indexKey).update(`${field}|${normalizeForIndex(value)}`).digest('base64url')
}

export function normalizeForIndex(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase()
}

/** What a list may show of an identifier: its last characters and nothing else. */
export function maskIdentifier(value: string, keep = 4): string {
  const clean = value.replace(/\s+/g, '')
  if (clean.length <= keep) return '•'.repeat(clean.length)
  return `${'•'.repeat(clean.length - keep)}${clean.slice(-keep)}`
}
