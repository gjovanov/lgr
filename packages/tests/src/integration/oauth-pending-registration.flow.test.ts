import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'
import { captureRejection } from '../helpers/capture-rejection'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { withFakeGoogle, googleCallbackRequest } from '../helpers/fake-oauth-provider'
import { createApiApp } from '../../../portal-api/src/api.js'
import {
  createPendingRegistration,
  readPendingRegistration,
  registerWithPendingRegistration,
  PendingRegistrationError,
  PENDING_REGISTRATION_REFUSED,
} from 'services/biz/oauth.service'
import { Identity, OAuthPendingRegistration, Org, User } from 'db/models'
import { isPublicRoute } from 'services/biz/public-routes'

/**
 * The OAuth SIGN-UP handoff (security review S-19): what replaced
 * `/auth/register?oauth_token=<JWT>`. The vector itself is `oauth-register-url-token.flow.test.ts`.
 *
 * S-05's fix, on the sign-up side: the callback stores the provider identity in a one-time record
 * and puts its code in the httpOnly `__Host-oauth_pending` cookie; the register form reads its
 * prefill and completes the sign-up through that cookie, and nothing else. An attacker cannot set a
 * cookie on our origin, and since P0a-8 (FR-20.72) not from a subdomain of it either, so a planted
 * register link carries nothing.
 *
 * ⚠ These use `captureRejection`, never `.rejects` — one `.rejects` reaps the shared mongod on
 * Windows and cascades every later file into ECONNREFUSED (CLAUDE.md).
 */

let app: any

beforeAll(async () => {
  await setupTestDB()
  app = createApiApp()
})
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

const signer = (new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt

/** A legitimate sign-up's identity. */
const person = { provider: 'google', providerId: 'person-google-id', email: 'ada@lovelace.test', name: 'Ada Lovelace', emailVerified: true }

/** Someone else's: an attacker's own Google account. */
const attacker = { provider: 'google', providerId: 'attacker-google-id', email: 'attacker@evil.test', name: 'Mallory Attacker', emailVerified: true }

function get(path: string, cookie?: string) {
  return app.handle(new Request(`http://localhost${path}`, { headers: cookie ? { cookie } : {} }))
}

function post(path: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie) headers.cookie = cookie
  return app.handle(new Request(`http://localhost${path}`, { method: 'POST', headers, body: JSON.stringify(body) }))
}

/** The `Set-Cookie` line for `name`, or undefined. */
function setCookieFor(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find(c => c.startsWith(`${name}=`))
}

describe('OAuth sign-up — end to end, through the real callback', () => {
  it('carries the identity from the callback to the new account through the cookie alone', async () => {
    const callback = await withFakeGoogle(person, () => app.handle(googleCallbackRequest('register')))
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe(`${config.oauth.frontendUrl}/auth/register?oauth=1`)

    // The code travels in an httpOnly `__Host-` cookie: Secure, `Path=/`, no Domain, so no
    // subdomain of ours can plant or overwrite it (P0a-8).
    const issued = setCookieFor(callback, '__Host-oauth_pending')
    expect(issued).toBeDefined()
    expect(issued).toMatch(/HttpOnly/i)
    expect(issued).toMatch(/SameSite=Lax/i)
    expect(issued).toMatch(/Secure/i)
    expect(issued).toMatch(/Path=\/(;|$)/)
    expect(issued).not.toMatch(/Domain=/i)
    // Release N wrote the plain name beside it, for one release. N+1 does not (P0a-8).
    expect(setCookieFor(callback, 'oauth_pending')).toBeUndefined()
    const cookie = issued!.split(';')[0]

    const prefill = await get('/api/oauth/pending', cookie)
    expect(prefill.status).toBe(200)
    expect(await prefill.json()).toEqual({ provider: 'google', email: person.email, name: person.name })

    const done = await post('/api/oauth/pending/register', { orgName: 'Lovelace Ltd', orgSlug: 'lovelace-ltd', username: 'ada' }, cookie)
    expect(done.status).toBe(200)
    const body = await done.json()
    expect(body.org.slug).toBe('lovelace-ltd')
    expect(typeof body.token).toBe('string')

    const user: any = await User.findOne({ username: 'ada' }).lean()
    expect(user.email).toBe(person.email)
    expect(user.role).toBe('admin')
    expect(user.oauthProviders.map((p: any) => p.providerId)).toEqual([person.providerId])

    // Signed in the way the sign-in handoff signs in: the session cookie matches the token's life.
    const session = setCookieFor(done, '__Host-auth')
    expect(session).toMatch(/HttpOnly/i)
    expect(session).toMatch(/SameSite=Lax/i)
    expect(session).toMatch(/Secure/i)
    expect(session).toMatch(/Max-Age=86400/)
    expect(setCookieFor(done, 'auth')).toBeUndefined()
    // And the sign-up cookie is gone: expired on the path and with the flags it was set with, or
    // the browser keeps it.
    const cleared = setCookieFor(done, '__Host-oauth_pending')
    expect(cleared).toMatch(/Max-Age=0/)
    expect(cleared).toMatch(/Path=\/(;|$)/)
    expect(cleared).toMatch(/Secure/i)
    expect(setCookieFor(done, 'oauth_pending')).toBeUndefined()

    // The same cookie cannot sign up twice.
    const again = await post('/api/oauth/pending/register', { orgName: 'Second', orgSlug: 'second-org', username: 'ada2' }, cookie)
    expect(again.status).toBe(400)
    expect((await again.json()).message).toBe(PENDING_REGISTRATION_REFUSED)
    expect(await Org.findOne({ slug: 'second-org' }).lean()).toBeNull()
  })
})

describe('OAuth sign-up — the two endpoints', () => {
  it('serves the prefill from the cookie, and keeps the provider id on the server', async () => {
    const code = await createPendingRegistration(person)

    const res = await get('/api/oauth/pending', `__Host-oauth_pending=${code}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ provider: 'google', email: person.email, name: person.name })
    expect(JSON.stringify(body)).not.toContain(person.providerId)
  })

  it('does not read a plain oauth_pending cookie, which a subdomain can plant (release N+1)', async () => {
    const code = await createPendingRegistration(person)
    const res = await get('/api/oauth/pending', `oauth_pending=${code}`)
    expect(res.status).toBe(400)
    expect((await res.json()).message).toBe(PENDING_REGISTRATION_REFUSED)

    const register = await post('/api/oauth/pending/register', { orgName: 'Planted', orgSlug: 'planted-org', username: 'ada' }, `oauth_pending=${code}`)
    expect(register.status).toBe(400)
    expect(await Org.findOne({ slug: 'planted-org' }).lean()).toBeNull()
  })

  it('ignores the cookie on a same-site request: a subdomain page cannot spend a sign-up', async () => {
    const code = await createPendingRegistration(person)
    const sibling = { cookie: `__Host-oauth_pending=${code}`, 'sec-fetch-site': 'same-site' }

    const prefill = await app.handle(new Request('http://localhost/api/oauth/pending', { headers: sibling }))
    expect(prefill.status).toBe(400)
    expect((await prefill.json()).message).toBe(PENDING_REGISTRATION_REFUSED)

    const register = await app.handle(new Request('http://localhost/api/oauth/pending/register', {
      method: 'POST',
      headers: { ...sibling, 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Sibling', orgSlug: 'sibling-org', username: 'ada' }),
    }))
    expect(register.status).toBe(400)
    expect(await Org.findOne({ slug: 'sibling-org' }).lean()).toBeNull()
    // Untouched: the person's own tab can still complete it.
    expect((await readPendingRegistration(code)).email).toBe(person.email)
  })

  it('does not read the prefill from the URL', async () => {
    const planted = await signer.sign({ type: 'oauth_pending', ...attacker })
    const res = await get(`/api/oauth/pending?oauth_token=${encodeURIComponent(planted)}`)
    expect(res.status).toBe(400)
    expect((await res.json()).message).toBe(PENDING_REGISTRATION_REFUSED)
  })

  it('completes with the STORED identity, whatever the body says', async () => {
    const code = await createPendingRegistration(person)
    const planted = await signer.sign({ type: 'oauth_pending', ...attacker })

    const res = await post(
      '/api/oauth/pending/register',
      { oauthToken: planted, orgName: 'Lovelace Ltd', orgSlug: 'lovelace-ltd', username: 'ada' },
      `__Host-oauth_pending=${code}`,
    )
    expect(res.status).toBe(200)

    const user: any = await User.findOne({ username: 'ada' }).lean()
    expect(user.email).toBe(person.email)
    expect(await User.findOne({ 'oauthProviders.providerId': attacker.providerId }).lean()).toBeNull()
  })

  it('refuses without the cookie, even with a valid pending token in the body', async () => {
    const planted = await signer.sign({ type: 'oauth_pending', ...person })
    const res = await post('/api/oauth/pending/register', {
      oauthToken: planted,
      orgName: 'Lovelace Ltd',
      orgSlug: 'lovelace-ltd',
      username: 'ada',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).message).toBe(PENDING_REGISTRATION_REFUSED)
    expect(await Org.findOne({ slug: 'lovelace-ltd' }).lean()).toBeNull()
  })

  it('keeps the cookie when the sign-up fails, so the corrected form can be resubmitted', async () => {
    await createTestOrg({ slug: 'taken-org' } as any)
    const code = await createPendingRegistration(person)

    const failed = await post('/api/oauth/pending/register', { orgName: 'Mine', orgSlug: 'taken-org', username: 'ada' }, `__Host-oauth_pending=${code}`)
    expect(failed.status).toBe(400)
    expect((await failed.json()).message).toContain('already taken')
    expect(setCookieFor(failed, '__Host-oauth_pending')).toBeUndefined()
    expect(setCookieFor(failed, 'oauth_pending')).toBeUndefined()

    const retried = await post('/api/oauth/pending/register', { orgName: 'Mine', orgSlug: 'my-own-org', username: 'ada' }, `__Host-oauth_pending=${code}`)
    expect(retried.status).toBe(200)
  })
})

describe('OAuth sign-up — the record', () => {
  it('stores the code HASHED and the identity as claims, never as a token', async () => {
    const code = await createPendingRegistration(person)
    const row: any = await OAuthPendingRegistration.findOne({}).lean()
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(code)
    expect(JSON.stringify(row)).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/)
    expect(row.claims.providerId).toBe(person.providerId)
    // 32 random bytes, base64url: 43 characters.
    expect(code.length).toBeGreaterThanOrEqual(43)
  })

  it('lets the form read the prefill more than once — only a completed sign-up uses the code', async () => {
    const code = await createPendingRegistration(person)
    expect((await readPendingRegistration(code)).email).toBe(person.email)
    expect((await readPendingRegistration(code)).email).toBe(person.email)
  })

  it('completes once; a second sign-up with the same code is refused', async () => {
    const code = await createPendingRegistration(person)
    await registerWithPendingRegistration(code, 'Lovelace Ltd', 'lovelace-ltd', 'ada')

    const err = await captureRejection(registerWithPendingRegistration(code, 'Second Org', 'second-org', 'ada2'))
    expect(err).toBeInstanceOf(PendingRegistrationError)
    expect(err.message).toBe(PENDING_REGISTRATION_REFUSED)
    expect(await Org.findOne({ slug: 'second-org' }).lean()).toBeNull()
    // The prefill is gone with it.
    expect((await captureRejection(readPendingRegistration(code))).message).toBe(PENDING_REGISTRATION_REFUSED)
  })

  it('lets exactly ONE of two simultaneous sign-ups proceed', async () => {
    const code = await createPendingRegistration(person)
    const results = await Promise.allSettled([
      registerWithPendingRegistration(code, 'Org One', 'org-one', 'ada1'),
      registerWithPendingRegistration(code, 'Org Two', 'org-two', 'ada2'),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(await Org.countDocuments({ slug: { $in: ['org-one', 'org-two'] } })).toBe(1)
  })

  it('releases the code when the sign-up fails', async () => {
    await createTestOrg({ slug: 'taken-org' } as any)
    const code = await createPendingRegistration(person)

    const failed = await captureRejection(registerWithPendingRegistration(code, 'Mine', 'taken-org', 'ada'))
    expect(failed).toBeTruthy()
    expect(failed.message).toContain('already taken')

    const { user } = await registerWithPendingRegistration(code, 'Mine', 'my-own-org', 'ada')
    expect(user.email).toBe(person.email)
  })

  it('refuses an expired, an unknown and a non-string code with ONE message', async () => {
    const expired = await createPendingRegistration(person)
    await OAuthPendingRegistration.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } })

    const messages: string[] = []
    for (const bad of [expired, 'never-existed', undefined, null, '', 123, {}] as unknown[]) {
      messages.push((await captureRejection(registerWithPendingRegistration(bad, 'X', 'x-org', 'xuser'))).message)
      messages.push((await captureRejection(readPendingRegistration(bad))).message)
    }
    expect(new Set(messages)).toEqual(new Set([PENDING_REGISTRATION_REFUSED]))
    expect(await Org.findOne({ slug: 'x-org' }).lean()).toBeNull()
  })
})

describe('OAuth sign-up — the address must be one the provider verified (multi-org)', () => {
  // Signing up founds a person on this address: their sign-in and password-reset channel in every
  // org. One the provider did not verify must not get that far, and one that already has an
  // account belongs to someone who signs in instead.

  it('refuses an unverified email at the callback, before any form, and stores nothing', async () => {
    const callback = await withFakeGoogle({ ...person, emailVerified: false }, () => app.handle(googleCallbackRequest('register')))
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toStartWith(`${config.oauth.frontendUrl}/auth/login?error=`)
    expect(setCookieFor(callback, '__Host-oauth_pending')).toBeUndefined()
    expect(setCookieFor(callback, 'oauth_pending')).toBeUndefined()
    expect(await OAuthPendingRegistration.countDocuments({})).toBe(0)
  })

  it('refuses, at the callback, an address that already has an account', async () => {
    await Identity.create({ email: person.email, firstName: 'Ada', lastName: 'Lovelace' })
    const callback = await withFakeGoogle(person, () => app.handle(googleCallbackRequest('register')))
    expect(callback.headers.get('location')).toStartWith(`${config.oauth.frontendUrl}/auth/login?error=`)
    expect(await OAuthPendingRegistration.countDocuments({})).toBe(0)
  })

  it('answers a sign-up recorded without a verified email with its code, and releases the record', async () => {
    // A record written before this rule has no `emailVerified`, which reads as unverified.
    const code = await createPendingRegistration({ ...person, emailVerified: false })
    const res = await post('/api/oauth/pending/register', { orgName: 'Mine', orgSlug: 'unverified-org', username: 'ada' }, `__Host-oauth_pending=${code}`)
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).code).toBe('unverified_email')
    expect(await Org.countDocuments({ slug: 'unverified-org' })).toBe(0)
    expect((await OAuthPendingRegistration.findOne({}).lean())!.usedAt).toBeNull()
  })
})

describe('OAuth sign-up — the route table', () => {
  it('exposes the two cookie-authenticated endpoints, because completing them is what produces a token', () => {
    expect(isPublicRoute('GET', '/api/oauth/pending')).toBe(true)
    expect(isPublicRoute('POST', '/api/oauth/pending/register')).toBe(true)
  })
})
