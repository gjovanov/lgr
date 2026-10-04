import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { randomUUID } from 'crypto'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { withFakeGoogle } from '../helpers/fake-oauth-provider'
import { createApiApp } from '../../../portal-api/src/api.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import type { Types } from 'mongoose'

/**
 * How a request proves who it is — and what it must not be able to do instead.
 *
 * 1. **A stale cookie overrode the bearer token.** Every auth plugin read `cookie.auth || Bearer`.
 *    Every SPA sends a bearer token from its storage, and no UI ever calls `POST /auth/logout`, so
 *    an old `auth` cookie (another sign-in, another org) silently replaced the token the caller
 *    chose, and the request ran as whoever the cookie named. Per-tab sessions — two orgs in two
 *    tabs, each with its own token but one shared cookie — cannot work on top of that.
 * 2. **A verified signature was taken as a session**, whatever the payload held. Until S-19 the
 *    `oauth_pending` JWT (no `id`, no `orgId`) passed every guard as a signed-in user.
 * 3. **S-07: CORS reflected any origin with credentials.** Harmless only while the auth cookie stays
 *    `sameSite: lax`; one flip and every site on the internet could make authenticated calls.
 * 4. **The OAuth callback set a 7-day cookie for a 24-hour token**, so the cookie outlived the
 *    session it carried.
 */

let app: Elysia
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const sign = (claims: Record<string, unknown>): Promise<string> => (signer as any).decorator.jwt.sign(claims)

interface Person { id: string; orgId: string; email: string }
let alice: Person
let bob: Person
let aliceToken = ''
let bobToken = ''
let orgSlugA = ''

function claims(p: Person) {
  return {
    id: p.id,
    orgId: p.orgId,
    email: p.email,
    username: p.email.split('@')[0],
    firstName: 'T',
    lastName: 'P',
    role: 'admin',
    permissions: DEFAULT_ROLE_PERMISSIONS.admin,
    ownRecordsModules: [],
  }
}

async function me(headers: Record<string, string>) {
  const res = await app.handle(new Request('http://localhost/api/auth/me', { headers }))
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(createApiApp())

  const a = await createTestOrg({ slug: 'precedence-a' } as any)
  const b = await createTestOrg({ slug: 'precedence-b' } as any)
  orgSlugA = 'precedence-a'
  const ua = await createTestUser(a._id as Types.ObjectId, {
    email: 'alice@precedence.test',
    username: 'alice',
    oauthProviders: [{ provider: 'google', providerId: 'google-alice' }],
  } as any)
  const ub = await createTestUser(b._id as Types.ObjectId, { email: 'bob@precedence.test', username: 'bob' } as any)
  alice = { id: String(ua._id), orgId: String(a._id), email: 'alice@precedence.test' }
  bob = { id: String(ub._id), orgId: String(b._id), email: 'bob@precedence.test' }
  aliceToken = await sign({ ...claims(alice), exp: Math.floor(Date.now() / 1000) + 3600 })
  bobToken = await sign({ ...claims(bob), exp: Math.floor(Date.now() / 1000) + 3600 })
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

describe('which credential a request presents', () => {
  it('a bearer token wins over the auth cookie', async () => {
    const res = await me({ authorization: `Bearer ${bobToken}`, cookie: `auth=${aliceToken}` })
    expect(res.status).toBe(200)
    expect(res.body.user.id).toBe(bob.id)
  })

  it('the cookie alone still signs a request in (downloads, the desktop redeem)', async () => {
    const res = await me({ cookie: `auth=${aliceToken}` })
    expect(res.status).toBe(200)
    expect(res.body.user.id).toBe(alice.id)
  })

  it('an invalid bearer token is a 401, never rescued by the cookie', async () => {
    const res = await me({ authorization: 'Bearer not-a-jwt', cookie: `auth=${aliceToken}` })
    expect(res.status).toBe(401)
  })

  it('an empty "Bearer " header counts as no header', async () => {
    const res = await me({ authorization: 'Bearer ', cookie: `auth=${aliceToken}` })
    expect(res.status).toBe(200)
    expect(res.body.user.id).toBe(alice.id)
  })
})

describe('a verified signature is not a session by itself', () => {
  it('refuses a token shaped like the old oauth_pending JWT (no id, no orgId)', async () => {
    const pending = await sign({ type: 'oauth_pending', email: 'stranger@example.com', providerId: 'x' })
    expect((await me({ authorization: `Bearer ${pending}` })).status).toBe(401)
  })

  it('refuses a token with an id but no orgId', async () => {
    const half = await sign({ id: alice.id, email: alice.email })
    expect((await me({ authorization: `Bearer ${half}` })).status).toBe(401)
  })

  it('refuses a session-shaped token that declares another type', async () => {
    const typed = await sign({ ...claims(alice), type: 'desktop' })
    expect((await me({ authorization: `Bearer ${typed}` })).status).toBe(401)
  })
})

describe('S-07: CORS answers only the origins this app is served from', () => {
  async function preflight(origin: string) {
    const { corsPlugin } = await import('../../../portal-api/src/cors.js')
    const withCors = new Elysia().use(corsPlugin()).use(createApiApp())
    return withCors.handle(
      new Request('http://localhost/api/auth/login', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
      }),
    )
  }

  it('does not reflect an arbitrary origin', async () => {
    const res = await preflight('https://evil.example')
    expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example')
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*')
  })

  it('answers the app\'s own origin, with credentials', async () => {
    const res = await preflight(config.oauth.frontendUrl)
    expect(res.headers.get('access-control-allow-origin')).toBe(config.oauth.frontendUrl)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('answers a per-app Vite dev port outside production', async () => {
    const res = await preflight('http://localhost:4021')
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:4021')
  })
})

describe('the session cookie lives as long as the session', () => {
  it('the OAuth callback\'s auth cookie expires with its 24-hour token, not after 7 days', async () => {
    const nonce = randomUUID()
    const state = Buffer.from(JSON.stringify({ mode: 'login', nonce, orgSlug: orgSlugA })).toString('base64url')
    const res = await withFakeGoogle(
      { providerId: 'google-alice', email: alice.email, name: 'Alice P' },
      () =>
        app.handle(
          new Request(`http://localhost/api/oauth/callback/google?code=provider-code&state=${state}`, {
            headers: { cookie: `oauth_state=${nonce}` },
          }),
        ),
    )

    const authCookie = res.headers.getSetCookie().find(c => c.startsWith('auth='))
    expect(authCookie).toBeDefined()
    expect(authCookie).toContain('Max-Age=86400')
  })
})
