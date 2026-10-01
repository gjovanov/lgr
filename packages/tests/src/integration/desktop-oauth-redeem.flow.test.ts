import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { createHash, randomBytes } from 'crypto'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import {
  createDesktopHandoff,
  redeemDesktopHandoff,
  redeemLoginHandoff,
  createLoginHandoff,
  buildAuthUrl,
  parseState,
  HANDOFF_REFUSED,
} from 'services/biz/oauth.service'
import { Desktop, OAuthHandoff } from 'db/models'
import { PUBLIC_ROUTE_KEYS } from 'services/biz/public-routes'

/**
 * FR-14.14 — the desktop's OAuth sign-in.
 *
 * ⚠ The property under test is that the ONE-TIME CODE IS NOT A CREDENTIAL. It arrives over
 * `lgr://login`, a scheme any program on the machine can register, so every case below is a way
 * somebody might try to use a stolen code without the verifier that never left the shell.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const verifier = () => randomBytes(32).toString('base64url')
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url')

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

async function seed() {
  const org = await createTestOrg({ name: 'Till Org', slug: 'till-org' })
  const user = await createTestUser(org._id, { email: 'till@test.com', username: 'tilluser' })
  const desktop = await Desktop.create({
    orgId: org._id,
    name: 'TILL-1',
    installationId: 'inst-1',
    machineId: 'machine-1',
    publicKey: 'x'.repeat(60),
    status: 'active',
  })
  const payload = {
    id: String(user._id), email: user.email, username: user.username,
    firstName: user.firstName, lastName: user.lastName, role: user.role,
    orgId: String(org._id), permissions: [], ownRecordsModules: [],
  } as any
  return { org, user, desktop, payload }
}

describe('desktop OAuth redeem (FR-14.14)', () => {
  it('redeems once with the right verifier, and answers like /auth/login', async () => {
    const { org, payload, desktop } = await seed()
    const v = verifier()
    const code = await createDesktopHandoff(payload, String(desktop._id), s256(v))

    const { user, org: gotOrg } = await redeemDesktopHandoff(code, v)
    expect(user.id).toBe(payload.id)
    expect(String(gotOrg._id)).toBe(String(org._id))
  })

  it('refuses a second redemption', async () => {
    const { payload, desktop } = await seed()
    const v = verifier()
    const code = await createDesktopHandoff(payload, String(desktop._id), s256(v))
    await redeemDesktopHandoff(code, v)

    const err = await captureRejection(redeemDesktopHandoff(code, v))
    expect(err?.message).toBe(HANDOFF_REFUSED)
  })

  it('refuses the WRONG verifier — the hijacked-deep-link case', async () => {
    // ⚠ The whole point. Another app that registers `lgr://` receives the code; without the
    // verifier it cannot redeem it (RFC 8252).
    const { payload, desktop } = await seed()
    const code = await createDesktopHandoff(payload, String(desktop._id), s256(verifier()))

    const err = await captureRejection(redeemDesktopHandoff(code, verifier()))
    expect(err?.message).toBe(HANDOFF_REFUSED)
  })

  it('burns the code even when the verifier is wrong', async () => {
    // ⚠ Claim-then-check, so a thief cannot grind verifiers against a code that stays alive.
    const { payload, desktop } = await seed()
    const v = verifier()
    const code = await createDesktopHandoff(payload, String(desktop._id), s256(v))

    await captureRejection(redeemDesktopHandoff(code, verifier()))
    // Even the RIGHT verifier is now too late.
    const err = await captureRejection(redeemDesktopHandoff(code, v))
    expect(err?.message).toBe(HANDOFF_REFUSED)
  })

  it('refuses after it has expired', async () => {
    const { payload, desktop } = await seed()
    const v = verifier()
    const code = await createDesktopHandoff(payload, String(desktop._id), s256(v))
    // The TTL is 60 s; move the record's own expiry rather than the clock.
    await OAuthHandoff.updateOne({ desktopId: desktop._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } })

    const err = await captureRejection(redeemDesktopHandoff(code, v))
    expect(err?.message).toBe(HANDOFF_REFUSED)
  })

  it('refuses for a REVOKED desktop', async () => {
    // The row is the revocation list, and a sign-in completed a minute ago must not outlive it.
    const { payload, desktop } = await seed()
    const v = verifier()
    const code = await createDesktopHandoff(payload, String(desktop._id), s256(v))
    await Desktop.updateOne({ _id: desktop._id }, { $set: { status: 'revoked' } })

    const err = await captureRejection(redeemDesktopHandoff(code, v))
    expect(err?.message).toBe(HANDOFF_REFUSED)
  })

  it('refuses a verifier shorter than RFC 7636 allows', async () => {
    const { payload, desktop } = await seed()
    const code = await createDesktopHandoff(payload, String(desktop._id), s256(verifier()))

    const err = await captureRejection(redeemDesktopHandoff(code, 'tooshort'))
    expect(err?.message).toBe(HANDOFF_REFUSED)
  })

  it('stores no verifier and no token at rest', async () => {
    // ⚠ A dump of this collection must yield nothing redeemable: the code is hashed and only
    // the CHALLENGE is kept, never its preimage.
    const { payload, desktop } = await seed()
    const v = verifier()
    const code = await createDesktopHandoff(payload, String(desktop._id), s256(v))

    const row: any = await OAuthHandoff.findOne({ desktopId: desktop._id }).lean()
    expect(row.codeHash).not.toBe(code)
    expect(JSON.stringify(row)).not.toContain(v)
    expect(JSON.stringify(row)).not.toContain(code)
    expect(row.codeChallenge).toBe(s256(v))
  })
})

describe('the two handoff kinds cannot be crossed', () => {
  it('a DESKTOP code cannot be redeemed through the browser (cookie) route', async () => {
    // ⚠ The browser route asks for no verifier. If a desktop code were redeemable there, PKCE
    // would be optional for anyone who could plant the cookie.
    const { payload, desktop } = await seed()
    const code = await createDesktopHandoff(payload, String(desktop._id), s256(verifier()))

    const err = await captureRejection(redeemLoginHandoff(code))
    expect(err?.message).toBe(HANDOFF_REFUSED)
  })

  it('a BROWSER code cannot be redeemed through the desktop route', async () => {
    const { payload } = await seed()
    const code = await createLoginHandoff(payload)

    const err = await captureRejection(redeemDesktopHandoff(code, verifier()))
    expect(err?.message).toBe(HANDOFF_REFUSED)
  })
})

describe('the desktop parameters survive the provider round trip', () => {
  // ⚠ `getProviderConfig` reads `process.env` on every call (not at import), so setting this
  // here is enough and nothing has to be re-imported. Without it every case below fails with
  // "provider is not configured", which says nothing about the state encoding under test.
  const ORIGINAL = process.env.GOOGLE_OAUTH_CLIENT_ID
  beforeAll(() => { process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id' })
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID
    else process.env.GOOGLE_OAUTH_CLIENT_ID = ORIGINAL
  })

  it('buildAuthUrl carries desktopId and the challenge in state, and parseState returns them', () => {
    const challenge = s256(verifier())
    const url = buildAuthUrl('google', 'till-org', 'login', 'nonce-1', undefined, {
      desktopId: 'desk-1',
      codeChallenge: challenge,
    })
    const state = new URL(url).searchParams.get('state')!
    const parsed = parseState(state)
    expect(parsed.desktopId).toBe('desk-1')
    expect(parsed.codeChallenge).toBe(challenge)
    // ⚠ And the ordinary fields still survive: dropping `orgSlug` makes the server answer 400
    // for every login, which reads as "Google is broken".
    expect(parsed.orgSlug).toBe('till-org')
    expect(parsed.nonce).toBe('nonce-1')
  })

  it('a browser flow carries neither', () => {
    const url = buildAuthUrl('google', 'till-org', 'login', 'nonce-1')
    const parsed = parseState(new URL(url).searchParams.get('state')!)
    expect(parsed.desktopId).toBeUndefined()
    expect(parsed.codeChallenge).toBeUndefined()
  })

  it('no JWT and no verifier appears in the authorisation URL', () => {
    // AC 3: no JWT in any URL, history entry or log line.
    //
    // ⚠ NOT a check for `eyJ`. `state` is base64url-encoded JSON, so it legitimately begins
    // `eyJ` — every such payload does. The properties that matter are that there is no JWT
    // (three dot-separated base64url segments), no `token` parameter, and above all that the
    // VERIFIER never leaves the shell.
    const v = verifier()
    const url = buildAuthUrl('google', 'till-org', 'login', 'nonce-1', undefined, {
      desktopId: 'desk-1',
      codeChallenge: s256(v),
    })

    expect(url).not.toContain('token=')
    expect(url).not.toMatch(/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/)
    // The challenge travels; its preimage must not.
    expect(url).not.toContain(v)
    expect(url).not.toContain(encodeURIComponent(v))

    // And the state decodes to exactly the fields the callback reads — nothing credential-shaped.
    const decoded = JSON.parse(
      Buffer.from(new URL(url).searchParams.get('state')!, 'base64url').toString('utf8'),
    )
    expect(Object.keys(decoded).sort()).toEqual(
      ['codeChallenge', 'desktopId', 'mode', 'nonce', 'orgSlug'].sort(),
    )
  })
})

describe('the redeem route is public, and deliberately', () => {
  it('is listed in the public route table', () => {
    // It is what PRODUCES the token, like /auth/login — and its credential is the code+verifier
    // pair, not a JWT.
    expect([...PUBLIC_ROUTE_KEYS]).toContain('POST /api/auth/desktop-code/redeem')
  })
})
