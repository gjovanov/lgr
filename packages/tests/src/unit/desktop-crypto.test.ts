import { describe, it, expect } from 'bun:test'
import { generateKeyPairSync, sign } from 'crypto'
import {
  ASSERTION_MAX_LIFETIME_SEC,
  computeMachineId,
  generateEnrollmentCode,
  generateEnrollmentKey,
  hashSecret,
  hashesEqual,
  isValidDesktopPublicKey,
  isValidStartPath,
  START_PATH_PATTERN,
  normalizeEnrollmentCode,
  verifyAssertion,
} from 'services/biz/desktop/desktop-crypto'

/**
 * The security-critical primitives behind desktop registration (FR-14.19, FR-14.20).
 *
 * These are unit tests because `desktop-crypto.ts` is import-pure — no models, no config, no I/O.
 * That is the point of the split: the code alphabet, the Ed25519 verification and the assertion
 * rules are where the sharp edges are, and they should be assertable without a database.
 */

const AUD = 'https://lgrai.app/api/desktop/v1/token'

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey }
}

function makeAssertion(privateKey: any, claims: Record<string, unknown>, headerOverride?: Record<string, unknown>) {
  const b64u = (s: string) => Buffer.from(s).toString('base64url')
  const header = b64u(JSON.stringify(headerOverride ?? { alg: 'EdDSA', typ: 'JWT' }))
  const payload = b64u(JSON.stringify(claims))
  const sig = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')
  return `${header}.${payload}.${sig}`
}

function validClaims(sub = 'desk1') {
  const now = Math.floor(Date.now() / 1000)
  return { sub, aud: AUD, iat: now, exp: now + 30, jti: 'j1' }
}

describe('enrollment codes', () => {
  it('uses the Crockford alphabet, which omits the letters people misread', () => {
    // ⚠ I/L/O/U are excluded: I-1, O-0 and L-1 are the pairs a human gets wrong reading a code off
    // one screen and typing it into another, and U is out so the alphabet cannot spell an obscenity.
    for (let i = 0; i < 200; i++) {
      const { raw } = generateEnrollmentCode()
      expect(raw).toHaveLength(8)
      expect(raw).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
      expect(raw).not.toMatch(/[ILOU]/)
    }
  })

  it('formats as XXXX-XXXX and keeps the prefix consistent', () => {
    const { display, raw, prefix } = generateEnrollmentCode()
    expect(display).toBe(`${raw.slice(0, 4)}-${raw.slice(4)}`)
    expect(prefix).toBe(raw.slice(0, 4))
  })

  it('is drawn uniformly enough that no character dominates', () => {
    // A weak generator (`Math.random`, or a byte modulo a non-power-of-two alphabet) shows up here.
    const counts = new Map<string, number>()
    for (let i = 0; i < 4000; i++) for (const c of generateEnrollmentCode().raw) {
      counts.set(c, (counts.get(c) ?? 0) + 1)
    }
    expect(counts.size).toBe(32)
    const expected = (4000 * 8) / 32
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(expected * 0.6)
      expect(n).toBeLessThan(expected * 1.4)
    }
  })

  it('does not repeat itself', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) seen.add(generateEnrollmentCode().raw)
    expect(seen.size).toBe(2000)
  })
})

describe('normalizing what a human types', () => {
  it('accepts case, spacing and dashes', () => {
    expect(normalizeEnrollmentCode('ab12-cd34')).toBe('AB12CD34')
    expect(normalizeEnrollmentCode('  AB12 CD34  ')).toBe('AB12CD34')
    expect(normalizeEnrollmentCode('AB12_CD34')).toBe('AB12CD34')
  })

  it('folds the Crockford aliases, which is what stops a valid code being rejected', () => {
    // ⚠ Without this, a code containing `0` fails for a user who reads it as `O` — and the message
    // they get sends them back to the admin for a new code rather than to the keyboard.
    expect(normalizeEnrollmentCode('OBI2-CD34')).toBe('0B12CD34')
    expect(normalizeEnrollmentCode('LB12-CD34')).toBe('1B12CD34')
  })

  it('returns empty for anything that is not a string', () => {
    for (const bad of [undefined, null, 42, {}, []]) expect(normalizeEnrollmentCode(bad)).toBe('')
  })
})

describe('hashing', () => {
  it('produces a stable sha256 hex', () => {
    expect(hashSecret('ABCD1234')).toMatch(/^[0-9a-f]{64}$/)
    expect(hashSecret('ABCD1234')).toBe(hashSecret('ABCD1234'))
    expect(hashSecret('ABCD1234')).not.toBe(hashSecret('ABCD1235'))
  })

  it('compares without throwing on mismatched lengths', () => {
    const a = hashSecret('x')
    expect(hashesEqual(a, a)).toBe(true)
    expect(hashesEqual(a, hashSecret('y'))).toBe(false)
    expect(hashesEqual(a, 'short')).toBe(false)
    expect(hashesEqual(a, undefined as any)).toBe(false)
  })

  it('mints enrollment keys long enough not to be guessed', () => {
    const { secret, prefix } = generateEnrollmentKey()
    expect(secret.length).toBeGreaterThanOrEqual(43) // 32 random bytes, base64url
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(secret.startsWith(prefix)).toBe(true)
  })
})

describe('the desktop public key', () => {
  it('accepts a real Ed25519 SPKI key', () => {
    expect(isValidDesktopPublicKey(keypair().spki)).toBe(true)
  })

  it('refuses the right length of the wrong thing', () => {
    // ⚠ A length check alone would let 60 characters of anything through.
    expect(isValidDesktopPublicKey('A'.repeat(60))).toBe(false)
  })

  it('refuses another key type of the right shape', () => {
    // ⚠ An import alone would accept this; `asymmetricKeyType` is what pins it to Ed25519.
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const spki = ec.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    expect(isValidDesktopPublicKey(spki)).toBe(false)
  })

  it('refuses empty, non-string and wrong-length input', () => {
    for (const bad of ['', 'abc', undefined, null, 42, {}]) {
      expect(isValidDesktopPublicKey(bad)).toBe(false)
    }
  })
})

describe('client assertions', () => {
  it('accepts a well-formed one', () => {
    const { spki, privateKey } = keypair()
    const r = verifyAssertion(makeAssertion(privateKey, validClaims()), spki, { audience: AUD })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.claims.jti).toBe('j1')
  })

  it('refuses a signature made by another key', () => {
    const a = keypair()
    const b = keypair()
    const r = verifyAssertion(makeAssertion(b.privateKey, validClaims()), a.spki, { audience: AUD })
    expect(r.ok).toBe(false)
  })

  it('refuses a tampered payload', () => {
    const { spki, privateKey } = keypair()
    const good = makeAssertion(privateKey, validClaims())
    const [h, , s] = good.split('.')
    const forged = Buffer.from(JSON.stringify(validClaims('someone-else'))).toString('base64url')
    const r = verifyAssertion(`${h}.${forged}.${s}`, spki, { audience: AUD })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('bad signature')
  })

  it('pins alg to EdDSA', () => {
    // ⚠ `alg: none` and "verify the HMAC with the public key" both live in this field. Accepting
    // whatever the header asks for is the classic JWT break.
    const { spki, privateKey } = keypair()
    for (const alg of ['none', 'HS256', 'RS256', 'ES256']) {
      const a = makeAssertion(privateKey, validClaims(), { alg, typ: 'JWT' })
      const r = verifyAssertion(a, spki, { audience: AUD })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('unsupported algorithm')
    }
  })

  it('checks the audience', () => {
    const { spki, privateKey } = keypair()
    const r = verifyAssertion(makeAssertion(privateKey, validClaims()), spki, {
      audience: 'https://other.example/token',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('wrong audience')
  })

  it('refuses a lifetime longer than a minute', () => {
    const { spki, privateKey } = keypair()
    const now = Math.floor(Date.now() / 1000)
    const claims = { ...validClaims(), iat: now, exp: now + ASSERTION_MAX_LIFETIME_SEC + 1 }
    const r = verifyAssertion(makeAssertion(privateKey, claims), spki, { audience: AUD })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('assertion lifetime too long')
  })

  it('refuses missing or malformed claims', () => {
    const { spki, privateKey } = keypair()
    const now = Math.floor(Date.now() / 1000)
    const cases: [Record<string, unknown>, string][] = [
      [{ aud: AUD, iat: now, exp: now + 30, jti: 'j' }, 'missing sub'],
      [{ sub: 'd', aud: AUD, iat: now, exp: now + 30 }, 'missing jti'],
      [{ sub: 'd', aud: AUD, jti: 'j' }, 'missing iat/exp'],
      [{ sub: 'd', aud: AUD, iat: now, exp: now, jti: 'j' }, 'exp is not after iat'],
    ]
    for (const [claims, reason] of cases) {
      const r = verifyAssertion(makeAssertion(privateKey, claims), spki, { audience: AUD })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe(reason)
    }
  })

  it('refuses structurally broken input without throwing', () => {
    const { spki } = keypair()
    for (const bad of ['', 'x', 'a.b', 'a.b.c.d', undefined, null, 42, {}]) {
      const r = verifyAssertion(bad, spki, { audience: AUD })
      expect(r.ok).toBe(false)
    }
  })

  it('tolerates a badly wrong clock, but not an absurd one', () => {
    // ⚠ The Win11 golden image the field lanes use runs ~+3 h off until `w32time` resyncs, and the
    // first assertion a desktop sends is made before it has ever seen a `serverTime`.
    const { spki, privateKey } = keypair()
    const now = Math.floor(Date.now() / 1000)

    const skewed = now + 3 * 60 * 60
    const ok = verifyAssertion(
      makeAssertion(privateKey, { ...validClaims(), iat: skewed, exp: skewed + 30 }),
      spki,
      { audience: AUD },
    )
    expect(ok.ok).toBe(true)

    const absurd = now + 48 * 60 * 60
    const bad = verifyAssertion(
      makeAssertion(privateKey, { ...validClaims(), iat: absurd, exp: absurd + 30 }),
      spki,
      { audience: AUD },
    )
    expect(bad.ok).toBe(false)
  })

  it('refuses a stored key that is unusable, rather than crashing', () => {
    const { privateKey } = keypair()
    const r = verifyAssertion(makeAssertion(privateKey, validClaims()), 'not-a-key', { audience: AUD })
    expect(r.ok).toBe(false)
  })
})

describe('startPath', () => {
  it('accepts a path, including the empty "no start path" case', () => {
    for (const s of ['', '/', '/pos/', '/invoicing/invoices', '/a-b_c.d~e/']) {
      expect(isValidStartPath(s)).toBe(true)
    }
  })

  it('refuses a protocol-relative path — the FR-14.12 trap', () => {
    // ⚠ `//evil.example` starts with `/` too and resolves to ANOTHER ORIGIN. The obvious pattern
    // `^$|^/[A-Za-z0-9._~/-]*$` accepts it; the first version of this validation did, and the
    // integration test is what caught it.
    for (const s of ['//evil.example', '///x', '//']) {
      expect(isValidStartPath(s)).toBe(false)
    }
  })

  it('refuses traversal', () => {
    // `.` and `/` are both legal path characters, so a plain character class permits this.
    for (const s of ['/pos/../admin', '/../etc', '/..', '/a/../../b']) {
      expect(isValidStartPath(s)).toBe(false)
    }
  })

  it('refuses a query or a fragment', () => {
    // ⚠ `/pos/?token=<JWT>` would sign the till into someone else's account (FR-14.24), and a
    // fragment hides whatever follows it from a server-side check.
    for (const s of ['/pos/?token=x', '/pos/#f', '/pos?a=b']) {
      expect(isValidStartPath(s)).toBe(false)
    }
  })

  it('refuses an absolute URL, a bare word and a backslash', () => {
    for (const s of ['https://evil.example', 'http://x', 'pos', '/a\\b', '\\\\server\\share']) {
      expect(isValidStartPath(s)).toBe(false)
    }
  })

  it('refuses over-long input and non-strings', () => {
    expect(isValidStartPath('/' + 'a'.repeat(300))).toBe(false)
    for (const bad of [undefined, null, 42, {}, []]) expect(isValidStartPath(bad)).toBe(false)
  })

  it('exports the pattern so the shell\'s Rust validator mirrors ONE rule', () => {
    // ⚠ Two validators that disagree about `//` is the same bug in a second place. C08 copies
    // this deliberately rather than inventing its own.
    expect(typeof START_PATH_PATTERN).toBe('string')
    expect(new RegExp(START_PATH_PATTERN).test('/pos/')).toBe(true)
    expect(new RegExp(START_PATH_PATTERN).test('//evil.example')).toBe(false)
  })
})

describe('machineId', () => {
  it('is stable and derived only from what it claims', () => {
    const a = computeMachineId('TILL-1', 'windows', 'x86_64')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(computeMachineId('TILL-1', 'windows', 'x86_64')).toBe(a)
    expect(computeMachineId('TILL-2', 'windows', 'x86_64')).not.toBe(a)
  })

  it('is NOT unique per machine — which is why it is display-only', () => {
    // ⚠ Two identical PCs with the same hostname produce the same value. `IDesktop.machineId` says
    // "display only, never a credential"; this is that statement made checkable.
    expect(computeMachineId('TILL-1', 'windows', 'x86_64'))
      .toBe(computeMachineId('TILL-1', 'windows', 'x86_64'))
  })
})
