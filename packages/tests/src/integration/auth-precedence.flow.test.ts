import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { randomUUID } from 'crypto'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { withFakeGoogle } from '../helpers/fake-oauth-provider'
import { createApiApp } from '../../../portal-api/src/api.js'
import { isolationHeaders } from '../../../portal-api/src/isolation-headers.js'
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

    const hostCookie = res.headers.getSetCookie().find(c => c.startsWith('__Host-auth='))
    expect(hostCookie).toBeDefined()
    expect(hostCookie).toContain('Max-Age=86400')
    expect(hostCookie).toMatch(/Path=\/(;|$)/)
    expect(hostCookie).toMatch(/Secure/i)
    expect(hostCookie).not.toMatch(/Domain=/i)
    // P0a-8 release N: the plain name too, for one release, with the same life.
    const authCookie = res.headers.getSetCookie().find(c => c.startsWith('auth='))
    expect(authCookie).toBeDefined()
    expect(authCookie).toContain('Max-Age=86400')
  })
})

// ── FR-20.72, plan step P0a-8 release N: lgrai.app made safe to have subdomains ──────────────
//
// An org's address (`<org slug>.lgrai.app`) is answered by the org's own server, same-site with
// lgrai.app. Its pages must not be able to plant lgrai.app's cookies, nor make the person's
// browser spend them. `__Host-` stops the first; ignoring a cookie on a `Sec-Fetch-Site:
// same-site` request stops the second.

const setCookie = (res: Response, name: string) => res.headers.getSetCookie().find(c => c.startsWith(`${name}=`))

function loginState(nonce: string) {
  return Buffer.from(JSON.stringify({ mode: 'login', nonce, orgSlug: orgSlugA })).toString('base64url')
}

function callback(state: string, headers: Record<string, string>) {
  return withFakeGoogle(
    { providerId: 'google-alice', email: alice.email, name: 'Alice P' },
    () => app.handle(new Request(`http://localhost/api/oauth/callback/google?code=provider-code&state=${state}`, { headers })),
  )
}

function redeem(cookie: string, site: string) {
  return app.handle(new Request('http://localhost/api/auth/oauth-code/redeem', {
    method: 'POST',
    headers: { cookie, 'sec-fetch-site': site },
  }))
}

describe('P0a-8: the session cookie is __Host-auth, and a sibling subdomain cannot spend it', () => {
  it('__Host-auth alone signs a request in', async () => {
    const res = await me({ cookie: `__Host-auth=${aliceToken}` })
    expect(res.status).toBe(200)
    expect(res.body.user.id).toBe(alice.id)
  })

  it('the plain auth cookie still signs a request in, for this release only', async () => {
    const res = await me({ cookie: `auth=${aliceToken}` })
    expect(res.status).toBe(200)
    expect(res.body.user.id).toBe(alice.id)
  })

  it('__Host-auth wins over a plain auth cookie a subdomain could have planted', async () => {
    const res = await me({ cookie: `auth=${aliceToken}; __Host-auth=${bobToken}` })
    expect(res.status).toBe(200)
    expect(res.body.user.id).toBe(bob.id)
  })

  for (const cookie of ['__Host-auth', 'auth']) {
    it(`a same-site request carrying ${cookie} is not signed in`, async () => {
      const res = await me({ cookie: `${cookie}=${aliceToken}`, 'sec-fetch-site': 'same-site' })
      expect(res.status).toBe(401)
    })
  }

  for (const site of ['same-origin', 'none', 'cross-site']) {
    it(`a ${site} request carrying the cookie is signed in`, async () => {
      const res = await me({ cookie: `__Host-auth=${aliceToken}`, 'sec-fetch-site': site })
      expect(res.status).toBe(200)
      expect(res.body.user.id).toBe(alice.id)
    })
  }

  it("a bearer token is unaffected by the guard: it is the page's own credential", async () => {
    const res = await me({ authorization: `Bearer ${aliceToken}`, 'sec-fetch-site': 'same-site' })
    expect(res.status).toBe(200)
    expect(res.body.user.id).toBe(alice.id)
  })

  it('sign-out expires both names, each with the attributes it was set with', async () => {
    const res = await app.handle(new Request('http://localhost/api/auth/logout', { method: 'POST' }))
    const host = setCookie(res, '__Host-auth')!
    expect(host).toMatch(/Max-Age=0/)
    expect(host).toMatch(/Path=\/(;|$)/)
    expect(host).toMatch(/Secure/i)
    expect(host).not.toMatch(/Domain=/i)
    expect(setCookie(res, 'auth')).toMatch(/Max-Age=0/)
  })

  it('the OAuth callback, a cross-site navigation, completes with __Host-oauth_state', async () => {
    const nonce = randomUUID()
    const res = await callback(loginState(nonce), { cookie: `__Host-oauth_state=${nonce}`, 'sec-fetch-site': 'cross-site' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`${config.oauth.frontendUrl}/auth/oauth-callback`)

    const handoff = setCookie(res, '__Host-oauth_handoff')!
    expect(handoff).toMatch(/Path=\/(;|$)/)
    expect(handoff).toMatch(/Secure/i)
    expect(setCookie(res, 'oauth_handoff')).toMatch(/Path=\/api\/auth(;|$)/)
    // The nonce is spent: both names expired, each on its own path.
    expect(setCookie(res, '__Host-oauth_state')).toMatch(/Max-Age=0/)
    expect(setCookie(res, 'oauth_state')).toMatch(/Path=\/api\/oauth(;|$)/)

    // The SPA redeems the handoff with the __Host- cookie it now holds.
    const redeemed = await redeem(handoff.split(';')[0], 'same-origin')
    expect(redeemed.status).toBe(200)
    expect((await redeemed.json()).user.id).toBe(alice.id)
  })

  it('a handoff cookie presented by a same-site request is not redeemed', async () => {
    const nonce = randomUUID()
    const res = await callback(loginState(nonce), { cookie: `oauth_state=${nonce}` })
    expect(res.status).toBe(302) // the plain state name still works, for this release
    const handoff = setCookie(res, '__Host-oauth_handoff')!.split(';')[0]
    const sibling = await redeem(handoff, 'same-site')
    expect(sibling.status).toBe(400)
  })
})

describe('P0a-8: every response carries the isolation headers', () => {
  const expectIsolated = (res: Response) => {
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(res.headers.get('origin-agent-cluster')).toBe('?1')
  }

  it('on an API answer, a refusal, and an unknown route', async () => {
    const isolated = new Elysia().use(isolationHeaders()).use(createApiApp())
    expectIsolated(await isolated.handle(new Request('http://localhost/api/health')))
    expectIsolated(await isolated.handle(new Request('http://localhost/api/auth/me')))
    expectIsolated(await isolated.handle(new Request('http://localhost/api/__no_such_route__')))
  })

  it('on a Response a handler returns itself, and on what an error handler serves', async () => {
    // The shapes unified.ts relies on: a redirect or a download returned as a Response, and the SPA
    // shell the error handler serves for an unknown path.
    const shaped = new Elysia()
      .use(isolationHeaders())
      .onError(() => new Response('<html>shell</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
      .get('/redirect', () => Response.redirect('https://accounts.example.com/', 302))
      .get('/file', () => new Response('bytes', { headers: { 'content-type': 'application/pdf' } }))
    expectIsolated(await shaped.handle(new Request('http://localhost/redirect')))
    expectIsolated(await shaped.handle(new Request('http://localhost/file')))
    expectIsolated(await shaped.handle(new Request('http://localhost/some/spa/path')))
  })
})
