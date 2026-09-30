import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { withFakeGoogle, googleCallbackRequest } from '../helpers/fake-oauth-provider'
import { createApiApp } from '../../../portal-api/src/api.js'
import { Org, User } from 'db/models'
import { isPublicRoute } from 'services/biz/public-routes'

/**
 * S-19 — the OAuth sign-up put a credential in a URL.
 *
 * In register mode the callback finished with `…/auth/register?oauth_token=<JWT>`: an
 * `oauth_pending` token holding the provider identity, signed with the session secret and with no
 * expiry. The register form posted it back to `POST /api/oauth/register-oauth`, which honoured
 * whatever token it was sent. So:
 *
 *   - an attacker who started a sign-up of their own and sent a victim that link had the victim
 *     create an org and an admin account on the ATTACKER's provider identity, which the attacker
 *     then signs in to with their own Google account (S-05's fixation, on the sign-up side);
 *   - the token sat in the address bar, the history, the access log, `Referer` and analytics.
 *
 * These are written against the surface master already had, so they run, and fail, on the code
 * before the fix. What replaced it is covered in `oauth-pending-registration.flow.test.ts`.
 *
 * ⚠ No `.rejects` / `.resolves` anywhere (CLAUDE.md).
 */

let app: any

beforeAll(async () => {
  await setupTestDB()
  app = createApiApp()
})
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

const signer = (new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt

/** What the ATTACKER's own Google account yields. */
const attacker = { provider: 'google', providerId: 'attacker-google-id', email: 'attacker@evil.test', name: 'Mallory Attacker' }

describe('S-19 — no sign-up credential in a URL', () => {
  it('the register-mode callback redirects with no credential in the URL', async () => {
    const res = await withFakeGoogle(attacker, () => app.handle(googleCallbackRequest('register')))

    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    // It reached the register branch: not the stale-state refusal, not an error redirect.
    expect(location.startsWith(`${config.oauth.frontendUrl}/auth/register`)).toBe(true)
    expect(new URL(location).searchParams.has('oauth_token')).toBe(false)
    expect(location).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/)
  })

  it('does not honour a pending sign-up token taken from the URL', async () => {
    // What the callback used to put in `…/auth/register?oauth_token=`, signed as it signed it,
    // for the attacker's identity. The victim's browser submits it with an org of the victim's
    // choosing.
    const planted = await signer.sign({ type: 'oauth_pending', ...attacker, avatarUrl: '' })
    const res = await app.handle(
      new Request('http://localhost/api/oauth/register-oauth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oauthToken: planted, orgName: 'Victim Corp', orgSlug: 'victim-corp', username: 'victim' }),
      }),
    )

    expect(res.status).not.toBe(200)
    expect(await Org.findOne({ slug: 'victim-corp' }).lean()).toBeNull()
    expect(await User.findOne({ 'oauthProviders.providerId': attacker.providerId }).lean()).toBeNull()
  })

  it('lists no public endpoint that takes the sign-up token from the request', () => {
    expect(isPublicRoute('POST', '/api/oauth/register-oauth')).toBe(false)
  })
})
