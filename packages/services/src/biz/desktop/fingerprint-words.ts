/**
 * FR-20.29 (plan step P1-6) — the six words that confirm a master's certificate by eye.
 *
 * A pairing code carries the master CA's fingerprint, and the desktop pins its first TLS connection
 * to it. A code scanned or opened as a link brings the fingerprint along. A code typed by hand does
 * not: the person then compares six words, shown on the master's Desktops page and on the desktop.
 *
 * ⚠ Six words, not four hex characters. The fingerprint is broadcast in DNS-SD, so a short
 * comparison would let someone grind a look-alike certificate in hours. Six words are 66 bits:
 * out of reach.
 *
 * The words are the first 66 bits of the SHA-256, eleven bits a word, from the BIP-39 English list
 * (`fingerprint-words.txt`, MIT, 2048 words, SHA-256 `2f5eed53…dbda`). The desktop shell reads the
 * same file (`include_str!`), so both sides cannot disagree about a word.
 *
 * A fingerprint is written `sha256:<base64url of the 32-byte digest, no padding>`: the SHA-256 of
 * the CA's SubjectPublicKeyInfo, what the supervisor computes (`packages/server/src/certs.rs`).
 */
import list from './fingerprint-words.txt' with { type: 'text' }

export const FINGERPRINT_WORDS: readonly string[] = list
  .split('\n')
  .map(w => w.trim())
  .filter(Boolean)

const FINGERPRINT = /^sha256:([A-Za-z0-9_-]{43})$/

/** The 32-byte digest a fingerprint names, or `null` for anything that is not one. */
export function fingerprintDigest(fp: string): Buffer | null {
  const m = FINGERPRINT.exec(fp.trim())
  if (!m) return null
  const digest = Buffer.from(m[1], 'base64url')
  return digest.length === 32 ? digest : null
}

/** The six words for a fingerprint, or `null` when it is not one. */
export function fingerprintWords(fp: string): string[] | null {
  const digest = fingerprintDigest(fp)
  if (!digest || FINGERPRINT_WORDS.length !== 2048) return null
  // The first 72 bits, of which the first 66 are the six words.
  let bits = 0n
  for (let i = 0; i < 9; i++) bits = (bits << 8n) | BigInt(digest[i])
  bits >>= 6n
  const words: string[] = []
  for (let k = 5; k >= 0; k--) words.push(FINGERPRINT_WORDS[Number((bits >> BigInt(11 * k)) & 0x7ffn)])
  return words
}
