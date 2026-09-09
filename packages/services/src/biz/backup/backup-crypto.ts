/**
 * FR-13.23/13.56 (#24) — sealing a bundle before it leaves the cluster.
 *
 * **Why this exists at all.** A bundle carries every tenant-scoped collection. That includes
 * `User` rows, and `user.model.ts` does not mark `password` as `select: false`, so bcrypt
 * hashes ride along; it includes every contact's tax ID and address; and it includes `orgs`,
 * which is where a Google Drive credential would live. FR-13.23 forbids any of that leaving
 * the cluster in the clear, and FR-13.56 makes the point sharper for Drive specifically: the
 * credential that can DELETE the off-site copy is inside the thing being uploaded.
 *
 * **Why asymmetric, and why that is the requirement rather than a preference.** A symmetric
 * key in `lgr-secret` would mean anything able to read the secret can read every backup ever
 * taken — and the pod that writes the bundles is exactly the thing an attacker who reached
 * the cluster already controls. So the cluster holds a WRITE-ONLY key: it can seal and cannot
 * open. The private half lives off-cluster, in the password manager, precisely as Layer 1's
 * `age` key does (`lgr-deploy/docs/BACKUP-RUNBOOK.md` §8).
 *
 * **Why not `age` itself.** `age` is a binary, not a library, and the container does not carry
 * it; re-implementing its wire format (bech32 recipients, header MAC, STREAM chunking) to
 * gain `age -d` compatibility is a great deal of surface for one consumer. This is the same
 * construction age uses — X25519 → HKDF-SHA256 → AEAD — in a container this repo owns, with
 * `scripts/backup-crypto.ts` as the decrypt tool. Every primitive is verified present in the
 * deployed Bun.
 *
 * **Format** (`lgr-sealed-1`): a single-line JSON header, `\n`, then the ciphertext.
 *
 *     {"format":"lgr-sealed-1","alg":"x25519-hkdf-sha256/aes-256-gcm","epk":"…",…}\n
 *     <ciphertext bytes>
 *
 * The header is plaintext ON PURPOSE — an operator holding a sealed artifact must be able to
 * tell what it is, which key opens it and whether it is intact, without the private key.
 * ⚠ It is also AUTHENTICATED: it is fed to GCM as additional data, so an attacker cannot
 * rewrite `plainSha256` to make a tampered artifact look like a different valid one.
 */

import crypto from 'node:crypto'

export const SEALED_FORMAT = 'lgr-sealed-1'
export const SEALED_ALG = 'x25519-hkdf-sha256/aes-256-gcm'

/** Keys are prefixed so a public half pasted where a private one belongs fails loudly. */
export const PUBLIC_KEY_PREFIX = 'lgrseal1:'
export const PRIVATE_KEY_PREFIX = 'lgrseal1-sk:'

const HKDF_INFO = Buffer.from('lgr-backup-seal-v1')

export interface SealedHeader {
  format: string
  alg: string
  /** Ephemeral X25519 public key, base64 SPKI DER. One per artifact, never reused. */
  epk: string
  salt: string
  iv: string
  tag: string
  /** SHA-256 over the PLAINTEXT. Lets a restore prove the unsealed bytes are the bundle. */
  plainSha256: string
  plainBytes: number
  /** Which recipient this was sealed to, so an operator can tell which key opens it. */
  recipient: string
  sealedAt: string
}

export interface BackupKeyPair {
  publicKey: string
  privateKey: string
}

export function generateBackupKeyPair(): BackupKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  return {
    publicKey: PUBLIC_KEY_PREFIX + (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
    privateKey: PRIVATE_KEY_PREFIX + (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64'),
  }
}

function parsePublicKey(key: string): crypto.KeyObject {
  if (!key.startsWith(PUBLIC_KEY_PREFIX)) {
    throw new Error(`a backup recipient must start with ${PUBLIC_KEY_PREFIX}`)
  }
  return crypto.createPublicKey({
    key: Buffer.from(key.slice(PUBLIC_KEY_PREFIX.length), 'base64'),
    format: 'der',
    type: 'spki',
  })
}

function parsePrivateKey(key: string): crypto.KeyObject {
  if (!key.startsWith(PRIVATE_KEY_PREFIX)) {
    // ⚠ Named explicitly, because the mistake this catches — pasting the public half into
    // the decrypt tool — otherwise surfaces as an unintelligible DER parse error.
    throw new Error(`a backup identity must start with ${PRIVATE_KEY_PREFIX} (you may have pasted the PUBLIC key)`)
  }
  return crypto.createPrivateKey({
    key: Buffer.from(key.slice(PRIVATE_KEY_PREFIX.length), 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
}

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')

/**
 * Seal `plain` to `recipient`.
 *
 * A fresh ephemeral key pair per artifact means the same bundle sealed twice produces
 * different bytes, and no two artifacts ever share a content-encryption key — so the fixed
 * all-zero IV that follows from a per-artifact key is safe, and is chosen over a random one
 * precisely so that reuse is impossible by construction rather than by luck.
 */
export function sealBundle(plain: Buffer, recipient: string): Buffer {
  const recipientKey = parsePublicKey(recipient)
  const ephemeral = crypto.generateKeyPairSync('x25519')
  const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientKey })

  const salt = crypto.randomBytes(16)
  const epk = (ephemeral.publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
  // The ephemeral public key goes into the KDF salt chain as well as the header, so a header
  // rewritten to point at a different `epk` derives a different key and fails the tag.
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([salt, epk]), HKDF_INFO, 32))
  const iv = Buffer.alloc(12)

  const header: Omit<SealedHeader, 'tag'> = {
    format: SEALED_FORMAT,
    alg: SEALED_ALG,
    epk: epk.toString('base64'),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    plainSha256: sha256(plain),
    plainBytes: plain.length,
    recipient,
    sealedAt: new Date().toISOString(),
  }

  // ⚠ The tag is computed over a header that does not yet contain the tag, and the decrypt
  // side reconstructs exactly that. Getting this asymmetry wrong is the classic way an AAD
  // scheme silently authenticates nothing.
  const aad = Buffer.from(JSON.stringify(header), 'utf8')
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])

  const full: SealedHeader = { ...header, tag: cipher.getAuthTag().toString('base64') }
  return Buffer.concat([Buffer.from(JSON.stringify(full) + '\n', 'utf8'), body])
}

/** Read a sealed artifact's header without the private key. */
export function readSealedHeader(sealed: Buffer): SealedHeader {
  const nl = sealed.indexOf(0x0a)
  if (nl === -1) throw new Error('not a sealed artifact: no header line')
  const header = JSON.parse(sealed.subarray(0, nl).toString('utf8'))
  if (header?.format !== SEALED_FORMAT) throw new Error(`not a ${SEALED_FORMAT} artifact: ${header?.format}`)
  return header
}

export function unsealBundle(sealed: Buffer, identity: string): Buffer {
  const nl = sealed.indexOf(0x0a)
  if (nl === -1) throw new Error('not a sealed artifact: no header line')
  const header = readSealedHeader(sealed)
  if (header.alg !== SEALED_ALG) throw new Error(`unsupported algorithm: ${header.alg}`)

  const privateKey = parsePrivateKey(identity)
  const epk = Buffer.from(header.epk, 'base64')
  const shared = crypto.diffieHellman({
    privateKey,
    publicKey: crypto.createPublicKey({ key: epk, format: 'der', type: 'spki' }),
  })
  const salt = Buffer.from(header.salt, 'base64')
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([salt, epk]), HKDF_INFO, 32))

  const { tag, ...withoutTag } = header
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'))
  decipher.setAAD(Buffer.from(JSON.stringify(withoutTag), 'utf8'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))

  let plain: Buffer
  try {
    plain = Buffer.concat([decipher.update(sealed.subarray(nl + 1)), decipher.final()])
  } catch {
    // GCM gives one undifferentiated failure for "wrong key" and "tampered bytes". Say both
    // rather than guessing, and say it in the language of what the operator should check.
    throw new Error('the artifact could not be opened: either this is the wrong identity, or the bytes have been altered')
  }

  // Belt and braces on top of the tag: the tag proves the CIPHERTEXT is intact, this proves
  // the plaintext is the bundle whose checksum was recorded when it was sealed.
  if (sha256(plain) !== header.plainSha256) {
    throw new Error('the unsealed bytes do not match the checksum recorded when the artifact was sealed')
  }
  return plain
}
