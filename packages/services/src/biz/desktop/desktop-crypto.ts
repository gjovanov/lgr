import { createHash, createPublicKey, randomBytes, randomInt, timingSafeEqual, verify } from 'crypto'

/**
 * The cryptographic primitives behind desktop registration (FR-14.19, FR-14.20).
 *
 * ⚠ Import-pure: no models, no config, no I/O. That is what lets the security-critical parts —
 * code alphabet, hashing, Ed25519 verification, assertion parsing — be unit-tested without a
 * database, and it is where the sharp edges are.
 *
 * ⚠ No new dependency. Ed25519 JWS verification is done with Node's own `crypto`, verified
 * against Bun before this was written (`crypto.verify(null, …)` with an SPKI-imported key).
 * Reaching for `jose` would have meant adding a direct dependency for one function.
 */

// ── Enrollment codes ────────────────────────────────────────────────────────────────────────

/**
 * Crockford base32: no `I`, `L`, `O` or `U`.
 *
 * ⚠ The point is a human reading a code off one screen and typing it into another. `I`/`1`,
 * `O`/`0` and `L`/`1` are the pairs people get wrong, and `U` is excluded so the alphabet cannot
 * spell an obscenity by accident. 8 characters of this is ~41 bits.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 8

/** `XXXX-XXXX`, plus the raw form the hash is taken over. */
export interface GeneratedCode {
  /** What the admin reads and the user types. */
  display: string
  /** What is hashed and compared — no dash, upper case. */
  raw: string
  prefix: string
}

export function generateEnrollmentCode(): GeneratedCode {
  let raw = ''
  // ⚠ `randomInt` and not `Math.random()`, and not `randomBytes(1) % 32` either: the modulo of a
  // byte over a 32-letter alphabet is uniform only because 256 happens to divide by 32, which is
  // the kind of accident that stops being true the moment someone edits the alphabet.
  for (let i = 0; i < CODE_LENGTH; i++) raw += CROCKFORD[randomInt(CROCKFORD.length)]
  return { display: `${raw.slice(0, 4)}-${raw.slice(4)}`, raw, prefix: raw.slice(0, 4) }
}

/**
 * Accept what a human actually types: lower case, spaces, any dashes, and the letters Crockford
 * treats as aliases (`O`→`0`, `I`/`L`→`1`).
 *
 * ⚠ Without the alias folding, a code containing `0` is rejected for a user who reads it as `O` —
 * and the error they see is "invalid code", which sends them back to the admin for a new one
 * rather than to the keyboard.
 */
export function normalizeEnrollmentCode(input: unknown): string {
  if (typeof input !== 'string') return ''
  return input
    .toUpperCase()
    .replace(/[\s\-_]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Compare two hex hashes without leaking a prefix through timing.
 *
 * The lookup itself is by indexed hash, so this is belt-and-braces — but it costs nothing, and the
 * alternative (`===`) is the habit that eventually gets applied somewhere it matters.
 */
export function hashesEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/** A reusable enrollment key: long, random, not meant to be typed by a human. */
export function generateEnrollmentKey(): { secret: string; prefix: string } {
  const secret = randomBytes(32).toString('base64url')
  return { secret, prefix: secret.slice(0, 8) }
}

// ── The desktop's Ed25519 public key ────────────────────────────────────────────────────────

/** Ed25519 SPKI DER is always 44 bytes, so its base64 is always 60 characters. */
const ED25519_SPKI_B64_LENGTH = 60

/**
 * Validate a public key as the desktop is expected to send it: base64 SPKI DER.
 *
 * ⚠ Both checks are needed. A length check alone lets through 60 characters of anything; an import
 * alone accepts an RSA or EC key, and a caller could then enroll with a key type the token path
 * does not expect. `asymmetricKeyType` is what actually pins it to Ed25519.
 */
export function isValidDesktopPublicKey(publicKey: unknown): boolean {
  if (typeof publicKey !== 'string' || publicKey.length !== ED25519_SPKI_B64_LENGTH) return false
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
    return key.asymmetricKeyType === 'ed25519'
  } catch {
    return false
  }
}

// ── Client assertions ──────────────────────────────────────────────────────────────────────

export interface AssertionClaims {
  sub: string
  aud: string
  iat: number
  exp: number
  jti: string
}

export type AssertionResult =
  | { ok: true; claims: AssertionClaims }
  | { ok: false; reason: string }

/** How far ahead of `iat` an assertion may claim to expire (FR-14.20). */
export const ASSERTION_MAX_LIFETIME_SEC = 60
/**
 * Tolerance for an unsynchronised desktop clock.
 *
 * ⚠ This exists because of a specific machine: the Win11 golden image used by the field lanes runs
 * about **+3 h** off until `w32time` resyncs, and a 60-second assertion from such a clock looks
 * absurd in both directions. The desktop corrects `iat` from the `serverTime` we return, but the
 * FIRST assertion it ever sends is made before it has ever seen a `serverTime` — so the skew has
 * to be tolerated once, here.
 */
export const ASSERTION_CLOCK_SKEW_SEC = 4 * 60 * 60

/**
 * Parse and cryptographically verify a compact JWS client assertion.
 *
 * ⚠ Order matters: the SIGNATURE is checked before any claim is believed. Reading `sub` or `exp`
 * out of an unverified payload and acting on it — even to look up which key to verify with — is
 * how JWT implementations get broken. Here the caller supplies the key, so nothing from the
 * payload influences verification.
 *
 * ⚠ `alg` is pinned to `EdDSA`. Accepting whatever the header asks for is the classic JWT flaw:
 * `alg: none` and HMAC-with-the-public-key both live there.
 */
export function verifyAssertion(
  assertion: unknown,
  publicKeyB64: string,
  opts: { audience: string; now?: Date },
): AssertionResult {
  if (typeof assertion !== 'string' || !assertion) return { ok: false, reason: 'missing assertion' }

  const parts = assertion.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed assertion' }
  const [headerB64, payloadB64, sigB64] = parts

  let header: any
  let payload: any
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'))
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed assertion' }
  }
  if (!header || header.alg !== 'EdDSA') return { ok: false, reason: 'unsupported algorithm' }

  let key
  try {
    key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' })
  } catch {
    return { ok: false, reason: 'stored public key is unusable' }
  }
  if (key.asymmetricKeyType !== 'ed25519') return { ok: false, reason: 'stored public key is not ed25519' }

  let signatureOk = false
  try {
    signatureOk = verify(
      null,
      Buffer.from(`${headerB64}.${payloadB64}`),
      key,
      Buffer.from(sigB64, 'base64url'),
    )
  } catch {
    signatureOk = false
  }
  if (!signatureOk) return { ok: false, reason: 'bad signature' }

  // Only now is the payload worth reading.
  const { sub, aud, iat, exp, jti } = payload ?? {}
  if (typeof sub !== 'string' || !sub) return { ok: false, reason: 'missing sub' }
  if (typeof jti !== 'string' || !jti) return { ok: false, reason: 'missing jti' }
  if (typeof iat !== 'number' || typeof exp !== 'number') return { ok: false, reason: 'missing iat/exp' }

  // ⚠ The audience check is what stops an assertion minted for one endpoint being replayed at
  // another. Without it, an assertion is a bearer credential for every route that accepts one.
  if (aud !== opts.audience) return { ok: false, reason: 'wrong audience' }

  if (exp <= iat) return { ok: false, reason: 'exp is not after iat' }
  if (exp - iat > ASSERTION_MAX_LIFETIME_SEC) return { ok: false, reason: 'assertion lifetime too long' }

  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000)
  if (exp < nowSec - ASSERTION_CLOCK_SKEW_SEC) return { ok: false, reason: 'assertion expired' }
  if (iat > nowSec + ASSERTION_CLOCK_SKEW_SEC) return { ok: false, reason: 'assertion issued in the future' }

  return { ok: true, claims: { sub, aud, iat, exp, jti } }
}

/** SHA-256 of hostname + OS + arch — display only (see `IDesktop.machineId`). */
export function computeMachineId(hostname: string, platform: string, arch: string): string {
  return createHash('sha256').update(`${hostname}|${platform}|${arch}`).digest('hex')
}

// ── Where "Open LGR" is allowed to land ─────────────────────────────────────────────────────

/**
 * The one canonical rule for a desktop's `startPath` (FR-14.12, FR-14.16).
 *
 * ⚠ It is a path, and ONLY a path. The shell resolves it against the registered server origin and
 * navigates there, so a value that escapes the origin is a stored redirect waiting for a shell
 * that trusts it. Three things have to be ruled out, and the obvious pattern rules out only one:
 *
 *   · `//evil.example` — starts with `/` too, and resolves to ANOTHER ORIGIN. This is the trap
 *     FR-14.12 calls out by name, and the first version of this validation let it through. The
 *     test caught it;
 *   · `/pos/../admin` and `/../etc` — `.` and `/` are both legal path characters, so a plain
 *     character class permits traversal;
 *   · `?` and `#` — `/pos/?token=<JWT>` would sign the till into someone else's account
 *     (FR-14.24), and a fragment hides whatever follows it from a server-side check.
 *
 * The empty string is allowed and means "no assigned start path" — the app hub.
 *
 * ⚠ C08's Rust deep-link validator must mirror this EXACTLY. Two validators that disagree about
 * `//` is the same bug in a second place, so this constant is the source and the Rust side is a
 * deliberate copy of it, not an independent invention.
 */
export const START_PATH_PATTERN = '^(?:|\\/(?!\\/)(?!.*\\.\\.)[A-Za-z0-9._~/-]*)$'

const START_PATH_RE = new RegExp(START_PATH_PATTERN)

export function isValidStartPath(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 200 && START_PATH_RE.test(value)
}
