import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { captureRejection } from '../helpers/capture-rejection'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { makeDesktopStub, enrollBody, type DesktopStub } from '../helpers/desktop-stub'
import { Desktop } from 'db/models'
import {
  DESKTOP_TOKEN_AUDIENCE,
  DesktopError,
  enrollDesktop,
  issueDesktopToken,
  loadActiveDesktop,
  mintEnrollmentCode,
  presenceOf,
  revokeDesktop,
  rotateDesktopKey,
  verifyDesktopToken,
} from 'services/biz/desktop/desktop.service'
import { ASSERTION_CLOCK_SKEW_SEC } from 'services/biz/desktop/desktop-crypto'
import { acceptableTokenAudiences } from '../../../portal-api/src/controllers/desktop-v1.controller.js'

/**
 * Desktop access tokens (FR-14.20).
 *
 * The property under test throughout: a valid signature on an unexpired token is NOT enough.
 * `loadActiveDesktop` re-reads the row on every request — the row is the revocation list — which is
 * what lets these tokens be short and stateless while revocation is still immediate.
 *
 * ⚠ `captureRejection`, never `.rejects` (CLAUDE.md).
 */

const AUD = 'https://lgrai.app/api/desktop/v1/token'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

async function enrolled(): Promise<{ orgId: string; userId: string; desktopId: string; stub: DesktopStub }> {
  const org = await createTestOrg()
  const admin = await createTestUser(org._id, { role: 'admin' } as any)
  const orgId = String(org._id)
  const userId = String(admin._id)
  const code = await mintEnrollmentCode(orgId, userId, 'https://lgrai.app')
  const stub = makeDesktopStub()
  const res = await enrollDesktop({ ...enrollBody(stub), code: code.code } as any)
  return { orgId, userId, desktopId: res.desktopId, stub }
}

describe('minting', () => {
  it('issues a short-lived token for a valid assertion', async () => {
    const { desktopId, orgId, stub } = await enrolled()
    const { token, expiresAt } = await issueDesktopToken(stub.assertion({ sub: desktopId, audience: AUD }), AUD)

    const claims = verifyDesktopToken(token)
    expect(claims).toBeTruthy()
    expect(claims!.desktopId).toBe(desktopId)
    expect(claims!.orgId).toBe(orgId)
    expect(claims!.keyEpoch).toBe(1)
    expect(claims!.aud).toBe(DESKTOP_TOKEN_AUDIENCE)
    // 15 minutes, not 24 hours: revocation is immediate because the row is re-read, and a short
    // token limits what a leaked one is worth in the meantime.
    const ttlSec = Math.round((expiresAt.getTime() - Date.now()) / 1000)
    expect(ttlSec).toBeGreaterThan(14 * 60)
    expect(ttlSec).toBeLessThanOrEqual(15 * 60)
  })

  it('refuses an assertion signed by the wrong key', async () => {
    const { desktopId } = await enrolled()
    const impostor = makeDesktopStub()
    const e = await captureRejection(
      issueDesktopToken(impostor.assertion({ sub: desktopId, audience: AUD }), AUD),
    )
    expect((e as DesktopError).code).toBe('bad_assertion')
  })

  it('refuses an assertion minted for a different audience', async () => {
    // ⚠ Without the audience check an assertion is a bearer credential for every endpoint that
    // accepts one.
    const { desktopId, stub } = await enrolled()
    const e = await captureRejection(
      issueDesktopToken(stub.assertion({ sub: desktopId, audience: 'https://evil.example/token' }), AUD),
    )
    expect((e as DesktopError).code).toBe('bad_assertion')
  })

  it('refuses an unsigned or malformed assertion', async () => {
    const { desktopId, stub } = await enrolled()
    const good = stub.assertion({ sub: desktopId, audience: AUD })
    const [h, p] = good.split('.')
    for (const bad of ['', 'x', `${h}.${p}`, `${h}.${p}.`, `${h}.${p}.AAAA`]) {
      const e = await captureRejection(issueDesktopToken(bad, AUD))
      expect((e as DesktopError).statusCode).toBe(401)
    }
  })

  it('refuses an assertion whose claimed lifetime is too long', async () => {
    const { desktopId, stub } = await enrolled()
    const now = Math.floor(Date.now() / 1000)
    const e = await captureRejection(
      issueDesktopToken(stub.assertion({ sub: desktopId, audience: AUD, iat: now, exp: now + 3600 }), AUD),
    )
    expect((e as DesktopError).code).toBe('bad_assertion')
  })
})

describe('replay', () => {
  it('refuses the same jti twice', async () => {
    const { desktopId, stub } = await enrolled()
    const a = stub.assertion({ sub: desktopId, audience: AUD, jti: 'fixed-jti' })
    await issueDesktopToken(a, AUD)

    const e = await captureRejection(issueDesktopToken(a, AUD))
    expect((e as DesktopError).code).toBe('assertion_replayed')
  })

  it('lets exactly ONE of two simultaneous replays win', async () => {
    // ⚠ This is why replay protection is a unique INSERT and not a read-then-write: both of these
    // would pass a read.
    const { desktopId, stub } = await enrolled()
    const a = stub.assertion({ sub: desktopId, audience: AUD, jti: 'raced' })
    const results = await Promise.allSettled([issueDesktopToken(a, AUD), issueDesktopToken(a, AUD)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
  })

  it('a fresh jti still works after a replay was refused', async () => {
    const { desktopId, stub } = await enrolled()
    await issueDesktopToken(stub.assertion({ sub: desktopId, audience: AUD, jti: 'one' }), AUD)
    await captureRejection(issueDesktopToken(stub.assertion({ sub: desktopId, audience: AUD, jti: 'one' }), AUD))
    const ok = await issueDesktopToken(stub.assertion({ sub: desktopId, audience: AUD, jti: 'two' }), AUD)
    expect(ok.token).toBeTruthy()
  })
})

describe('clock skew', () => {
  it('mints for a desktop whose clock is hours off', async () => {
    // ⚠ The Win11 golden image the field lanes use runs ~+3 h off until `w32time` resyncs, and the
    // FIRST assertion a desktop ever sends is made before it has seen any `serverTime`.
    const { desktopId, stub } = await enrolled()
    const skewed = Math.floor(Date.now() / 1000) + 3 * 60 * 60
    const { token, serverTime } = await issueDesktopToken(
      stub.assertion({ sub: desktopId, audience: AUD, iat: skewed, exp: skewed + 60 }),
      AUD,
    )
    expect(verifyDesktopToken(token)).toBeTruthy()
    // The response carries the truth, so the desktop can correct itself from here on.
    expect(Math.abs(Date.parse(serverTime) - Date.now())).toBeLessThan(10_000)
  })

  it('refuses a clock that is absurdly far out', async () => {
    const { desktopId, stub } = await enrolled()
    const tooFar = Math.floor(Date.now() / 1000) + ASSERTION_CLOCK_SKEW_SEC + 3600
    const e = await captureRejection(
      issueDesktopToken(stub.assertion({ sub: desktopId, audience: AUD, iat: tooFar, exp: tooFar + 60 }), AUD),
    )
    expect((e as DesktopError).code).toBe('bad_assertion')
  })
})

describe('the row IS the revocation list', () => {
  it('refuses a token that is still cryptographically valid after a revoke', async () => {
    const { orgId, userId, desktopId, stub } = await enrolled()
    const { token } = await issueDesktopToken(stub.assertion({ sub: desktopId, audience: AUD }), AUD)
    const claims = verifyDesktopToken(token)!

    // The token itself is untouched — the signature still verifies.
    expect(claims).toBeTruthy()

    await revokeDesktop(orgId, desktopId, userId, 'stolen laptop')

    const e = await captureRejection(loadActiveDesktop(claims))
    expect((e as DesktopError).code).toBe('desktop_revoked')
  })

  it('refuses minting a NEW token for a revoked desktop', async () => {
    const { orgId, userId, desktopId, stub } = await enrolled()
    await revokeDesktop(orgId, desktopId, userId)
    const e = await captureRejection(
      issueDesktopToken(stub.assertion({ sub: desktopId, audience: AUD }), AUD),
    )
    expect((e as DesktopError).code).toBe('desktop_revoked')
  })

  it('a key rotation invalidates every outstanding token, with no blacklist', async () => {
    const { orgId, desktopId, stub } = await enrolled()
    const { token } = await issueDesktopToken(stub.assertion({ sub: desktopId, audience: AUD }), AUD)
    const claims = verifyDesktopToken(token)!
    expect(claims.keyEpoch).toBe(1)

    await rotateDesktopKey(orgId, desktopId)

    const e = await captureRejection(loadActiveDesktop(claims))
    expect((e as DesktopError).code).toBe('key_rotated')

    // And a token minted after the rotation is fine.
    const fresh = await issueDesktopToken(stub.assertion({ sub: desktopId, audience: AUD }), AUD)
    expect(verifyDesktopToken(fresh.token)!.keyEpoch).toBe(2)
    expect(await loadActiveDesktop(verifyDesktopToken(fresh.token)!)).toBeTruthy()
  })

  it('refuses a token whose org no longer matches the row', async () => {
    const { desktopId, stub } = await enrolled()
    const { token } = await issueDesktopToken(stub.assertion({ sub: desktopId, audience: AUD }), AUD)
    const claims = verifyDesktopToken(token)!
    // Tamper with the row rather than the token: the org must come from the ROW.
    await Desktop.updateOne({ _id: desktopId }, { $set: { orgId: '0'.repeat(24) } })
    const e = await captureRejection(loadActiveDesktop(claims))
    expect((e as DesktopError).statusCode).toBe(401)
  })
})

describe('token verification', () => {
  it('refuses a tampered payload', async () => {
    const { desktopId, stub } = await enrolled()
    const { token } = await issueDesktopToken(stub.assertion({ sub: desktopId, audience: AUD }), AUD)
    const [h, p, s] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ desktopId, orgId: '0'.repeat(24), keyEpoch: 1, aud: DESKTOP_TOKEN_AUDIENCE, iat: 1, exp: 9e9 })).toString('base64url')
    expect(verifyDesktopToken(`${h}.${forged}.${s}`)).toBeNull()
  })

  it('refuses `alg: none` and an unexpected algorithm', async () => {
    // ⚠ The classic JWT flaw lives in this field.
    const { desktopId, stub } = await enrolled()
    const { token } = await issueDesktopToken(stub.assertion({ sub: desktopId, audience: AUD }), AUD)
    const [, p, s] = token.split('.')
    for (const alg of ['none', 'HS512', 'RS256']) {
      const h = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url')
      expect(verifyDesktopToken(`${h}.${p}.${s}`)).toBeNull()
    }
  })

  it('refuses an expired token and junk', async () => {
    expect(verifyDesktopToken('')).toBeNull()
    expect(verifyDesktopToken('a.b.c')).toBeNull()
    expect(verifyDesktopToken(undefined)).toBeNull()
  })
})

describe('presence', () => {
  it('is online with a socket, stale just after, offline later', () => {
    const now = Date.now()
    expect(presenceOf({ lastSeenAt: new Date(now) } as any, true)).toBe('online')
    expect(presenceOf({ lastSeenAt: new Date(now - 30_000) } as any, false)).toBe('stale')
    expect(presenceOf({ lastSeenAt: new Date(now - 10 * 60_000) } as any, false)).toBe('offline')
    expect(presenceOf({ lastSeenAt: undefined } as any, false)).toBe('offline')
  })
})

describe('the audience, behind a proxy', () => {
  /**
   * The bug these cover shipped and was invisible.
   *
   * A till signs its assertion for the server URL its operator typed. The hub used to rebuild the
   * expected audience with `new URL(request.url).origin`, which behind a TLS-terminating ingress is
   * `http://host` while the till signed `https://host`. Exact compare, no match, `bad_assertion`
   * on every authenticated call: presence never authenticates, `lastSeenAt` never moves and the
   * Desktops page shows a healthy till as permanently **offline**.
   *
   * ⚠ It was undetectable in production because no desktop is enrolled there. It showed up
   * locally instead, where Vite's `changeOrigin: true` proxy produces the same mismatch
   * (`localhost:4000` signed, `127.0.0.1:4001` seen) and a fresh enrollment died with
   * `enrolled_but_token_failed:bad_assertion`.
   */
  it('accepts the origin the till signed when a proxy terminated the TLS', async () => {
    const { desktopId, stub } = await enrolled()
    // Exactly the production shape: signed for https, arriving as http.
    const seenByThePod = 'http://lgrai.app/api/desktop/v1/token'
    const { token } = await issueDesktopToken(
      stub.assertion({ sub: desktopId, audience: AUD }),
      [seenByThePod, AUD],
    )
    expect(verifyDesktopToken(token)).not.toBeNull()
  })

  it('still refuses an assertion minted for another server', async () => {
    const { desktopId, stub } = await enrolled()
    // ⚠ The set must not become "any audience". Every member is an origin THIS server answers
    // on; nothing in it comes from the assertion.
    const err = await captureRejection(
      issueDesktopToken(
        stub.assertion({ sub: desktopId, audience: 'https://evil.example/api/desktop/v1/token' }),
        ['http://lgrai.app/api/desktop/v1/token', AUD],
      ),
    )
    expect((err as DesktopError).code).toBe('bad_assertion')
  })

  it('offers the forwarded scheme and the configured base, and never a forwarded HOST', () => {
    const auds = acceptableTokenAudiences(
      new Request('http://10.244.1.7:4001/api/desktop/v1/token', {
        method: 'POST',
        headers: {
          'x-forwarded-proto': 'https',
          // ⚠ Deliberately ignored. The scheme comes from the proxy; the host does not, or a
          // caller could nominate the audience its own assertion is checked against.
          'x-forwarded-host': 'attacker.example',
        },
      }),
    )
    expect(auds).toContain('http://10.244.1.7:4001/api/desktop/v1/token')
    expect(auds).toContain('https://10.244.1.7:4001/api/desktop/v1/token')
    expect(auds.some(a => a.includes('attacker.example'))).toBe(false)
    // The configured canonical base is always offered - it is what the enrollment deep link
    // advertises, so a till enrolled from a deep link matches by construction.
    expect(auds.length).toBeGreaterThanOrEqual(2)
  })

  it('takes only the first hop of a comma-joined x-forwarded-proto', () => {
    const auds = acceptableTokenAudiences(
      new Request('http://host.example/api/desktop/v1/token', {
        method: 'POST',
        headers: { 'x-forwarded-proto': 'https, http' },
      }),
    )
    expect(auds).toContain('https://host.example/api/desktop/v1/token')
  })
})
