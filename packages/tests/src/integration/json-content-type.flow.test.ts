import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { createPendingRegistration } from 'services/biz/oauth.service'

/**
 * A JSON answer that also sets two or more cookies is still labelled JSON.
 *
 * On Bun 1.3.10, the runtime the Dockerfile shipped and CI ran until 2026-10-23, Elysia 1.4.30 loses
 * the type of such an answer: `handleSet` turns `set.headers` into a `Headers` instance, and the JSON
 * branch then sets `content-type` as a JS property on it. P0a-8 release N wrote both session
 * cookies, so from 2026-10-23 every sign-in and the sign-out answered text/plain in production. A
 * script that read the type before parsing broke, while browsers, whose HTTP client parses JSON
 * anyway, did not notice. Bun 1.4 does not show it.
 *
 * Since release N+1 a sign-in sets one cookie. An answer that sets two is still there: the OAuth
 * sign-up and the OAuth redeem each expire their flow cookie and set the session.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(createApiApp())
  const org = await createTestOrg({ slug: 'json-content-type' } as any)
  await createTestUser(org._id, { role: 'admin', username: 'jsonct', email: 'jsonct@json-content-type.test' } as any)
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
})

function signIn(password: string) {
  return app.handle(new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgSlug: 'json-content-type', username: 'jsonct', password }),
  }))
}

describe('cookies and a JSON body', () => {
  it('the OAuth sign-up: two cookies (the flow cookie expired, the session set), and the answer is JSON', async () => {
    const code = await createPendingRegistration({
      provider: 'google', providerId: 'jsonct-google', email: 'founder@json-content-type.test', name: 'Json Founder', emailVerified: true,
    })
    const res = await app.handle(new Request('http://localhost/api/oauth/pending/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `__Host-oauth_pending=${code}` },
      body: JSON.stringify({ orgName: 'Json Founder Ltd', orgSlug: 'json-founder', username: 'jsonfounder' }),
    }))
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie().length).toBeGreaterThanOrEqual(2)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(typeof ((await res.json()) as any).token).toBe('string')
  })

  it('sign-in: the session cookie, and the answer is JSON', async () => {
    const res = await signIn('test123')
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie().some(c => c.startsWith('__Host-auth='))).toBe(true)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json() as any
    expect(typeof body.token).toBe('string')
  })

  it('sign-out: the cookie cleared, and the answer is JSON', async () => {
    const { token } = await (await signIn('test123')).json() as any
    const res = await app.handle(new Request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    }))
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie().some(c => c.startsWith('__Host-auth='))).toBe(true)
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('a refused sign-in is JSON too', async () => {
    const res = await signIn('wrong-password')
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toContain('application/json')
  })
})
