import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { makeDesktopStub, enrollBody } from '../helpers/desktop-stub'
import { createApiApp } from '../../../portal-api/src/api.js'
import { isPublicRoute, PUBLIC_ROUTE_KEYS } from 'services/biz/public-routes'
import {
  enrollDesktop,
  issueDesktopToken,
  mintEnrollmentCode,
  signDesktopToken,
} from 'services/biz/desktop/desktop.service'

/**
 * The boundary between a USER principal and a DESKTOP principal (FR-14.20, FR-14.36).
 *
 * The property: the two token kinds are signed with different secrets, so neither is valid on the
 * other's routes **by construction** — not because every route remembers to check an audience.
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

const userSigner = (new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt

async function seedAll() {
  const org = await createTestOrg()
  const admin = await createTestUser(org._id, { role: 'admin' } as any)
  const member = await createTestUser(org._id, { role: 'member', permissions: ['invoicing.read'] } as any)
  const orgId = String(org._id)
  const code = await mintEnrollmentCode(orgId, String(admin._id), 'https://lgrai.app')
  const stub = makeDesktopStub()
  const enrolledRes = await enrollDesktop({ ...enrollBody(stub), code: code.code } as any)
  const aud = 'http://localhost/api/desktop/v1/token'
  const { token: desktopToken } = await issueDesktopToken(stub.assertion({ sub: enrolledRes.desktopId, audience: aud }), aud)

  const userToken = async (u: any) =>
    userSigner.sign({
      id: String(u._id), email: u.email, username: u.username,
      firstName: u.firstName, lastName: u.lastName, role: u.role,
      orgId, permissions: [...(u.permissions ?? [])],
    })

  return {
    orgId,
    desktopId: enrolledRes.desktopId,
    desktopToken,
    adminToken: await userToken(admin),
    memberToken: await userToken(member),
    stub,
  }
}

const call = (path: string, init: RequestInit = {}) =>
  app.handle(new Request(`http://localhost${path}`, init))

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

describe('a desktop token is not a user token', () => {
  it('is refused on a user route', async () => {
    const { orgId, desktopToken } = await seedAll()
    // ⚠ The desktop token is signed with DESKTOP_TOKEN_SECRET, so `AuthService`'s verifier cannot
    // even read it — no audience check has to remember to run.
    const res = await call(`/api/org/${orgId}/desktops`, { headers: auth(desktopToken) })
    expect(res.status).toBe(401)
  })

  it('is refused on an unrelated business route', async () => {
    const { orgId, desktopToken } = await seedAll()
    const res = await call(`/api/org/${orgId}/user`, { headers: auth(desktopToken) })
    expect(res.status).toBe(401)
  })
})

describe('a user token is not a desktop token', () => {
  it('is refused on a desktop route, even for an admin', async () => {
    const { adminToken } = await seedAll()
    const res = await call('/api/desktop/v1/self', {
      method: 'PUT',
      headers: { ...auth(adminToken), 'content-type': 'application/json' },
      body: JSON.stringify({ appVersion: '9.9.9' }),
    })
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('unauthenticated')
  })

  it('is refused on the ephemeral self-unregister', async () => {
    const { adminToken } = await seedAll()
    const res = await call('/api/desktop/v1/self', { method: 'DELETE', headers: auth(adminToken) })
    expect(res.status).toBe(401)
  })
})

describe('the desktop guard is deny-by-default', () => {
  it('refuses an anonymous caller on every non-public desktop route', async () => {
    await seedAll()
    for (const [method, path] of [['PUT', '/api/desktop/v1/self'], ['DELETE', '/api/desktop/v1/self']] as const) {
      const res = await call(path, {
        method,
        ...(method === 'PUT'
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }
          : {}),
      })
      expect(res.status).toBe(401)
    }
  })

  it('accepts a real desktop token', async () => {
    const { desktopToken } = await seedAll()
    const res = await call('/api/desktop/v1/self', {
      method: 'PUT',
      headers: { ...auth(desktopToken), 'content-type': 'application/json' },
      body: JSON.stringify({ appVersion: '0.2.0', clientTime: new Date().toISOString() }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('refuses a desktop token forged with the USER secret', async () => {
    // ⚠ The whole point of two secrets. A caller who somehow learned `JWT_SECRET` still cannot mint
    // a desktop credential.
    const { desktopId, orgId } = await seedAll()
    const forged = await userSigner.sign({ desktopId, orgId, keyEpoch: 1, aud: 'lgr-desktop' })
    const res = await call('/api/desktop/v1/self', {
      method: 'PUT',
      headers: { ...auth(forged), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(401)
  })

  it('refuses a token signed with the right secret but for a desktop that does not exist', async () => {
    await seedAll()
    const { token } = signDesktopToken({ desktopId: '0'.repeat(24), orgId: '0'.repeat(24), keyEpoch: 1 })
    const res = await call('/api/desktop/v1/self', {
      method: 'PUT',
      headers: { ...auth(token), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(401)
    // It reaches the row re-read and is refused there — the row is the revocation list.
    expect((await res.json()).code).toBe('desktop_revoked')
  })
})

describe('the admin side is gated and tenant-scoped', () => {
  it('refuses an anonymous caller', async () => {
    const { orgId } = await seedAll()
    expect((await call(`/api/org/${orgId}/desktops`)).status).toBe(401)
  })

  it('refuses a member without admin.settings', async () => {
    const { orgId, memberToken } = await seedAll()
    const res = await call(`/api/org/${orgId}/desktops`, { headers: auth(memberToken) })
    expect(res.status).toBe(403)
  })

  it('serves an admin', async () => {
    const { orgId, adminToken } = await seedAll()
    const res = await call(`/api/org/${orgId}/desktops`, { headers: auth(adminToken) })
    expect(res.status).toBe(200)
    const body = await res.json()
    // The store destructures a named key (CLAUDE.md's store contract).
    expect(Array.isArray(body.desktops)).toBe(true)
    expect(body.desktops).toHaveLength(1)
    expect(body.desktops[0].presence).toBe('stale') // just enrolled, no socket
    // ⚠ The public key is never wired out, even though it is not a secret.
    expect(JSON.stringify(body)).not.toContain('publicKey')
  })

  it('refuses a foreign org, via the isForeignOrg guard', async () => {
    const a = await seedAll()
    const b = await seedAll()
    const res = await call(`/api/org/${b.orgId}/desktops`, { headers: auth(a.adminToken) })
    expect(res.status).toBe(403)
  })

  it('hides revoked desktops unless asked', async () => {
    const { orgId, adminToken, desktopId } = await seedAll()
    await call(`/api/org/${orgId}/desktops/${desktopId}/revoke`, {
      method: 'POST',
      headers: { ...auth(adminToken), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'test' }),
    })
    const hidden = await (await call(`/api/org/${orgId}/desktops`, { headers: auth(adminToken) })).json()
    expect(hidden.desktops).toHaveLength(0)
    const shown = await (await call(`/api/org/${orgId}/desktops?includeRevoked=true`, { headers: auth(adminToken) })).json()
    expect(shown.desktops).toHaveLength(1)
    expect(shown.desktops[0].status).toBe('revoked')
  })
})

describe('the public-routes table', () => {
  it('exposes exactly the two desktop routes, and no more', async () => {
    expect(isPublicRoute('POST', '/api/desktop/v1/enroll')).toBe(true)
    expect(isPublicRoute('POST', '/api/desktop/v1/token')).toBe(true)
    // Everything else on the desktop surface is guarded.
    expect(isPublicRoute('PUT', '/api/desktop/v1/self')).toBe(false)
    expect(isPublicRoute('DELETE', '/api/desktop/v1/self')).toBe(false)
    expect(isPublicRoute('GET', '/api/org/:orgId/desktops')).toBe(false)
    // ⚠ FR-14.28's update manifest is NOT public. It is behind `DesktopAuth` so the hub can
    // answer per desktop and per channel, and because an anonymous caller has no business
    // enumerating what the fleet is being offered.
    expect(isPublicRoute('GET', '/api/desktop/v1/latest-release')).toBe(false)
    // ⚠ The deferred RFC 8628 device-authorization routes are NOT in the table. If someone adds
    // them later, they add the entry with them — this asserts the table has not drifted ahead of
    // the code.
    const desktopPublic = PUBLIC_ROUTE_KEYS.filter(k => k.includes('/desktop/'))
    expect(desktopPublic.sort()).toEqual([
      'POST /api/desktop/v1/enroll',
      'POST /api/desktop/v1/token',
    ])
  })

  it('exposes C12\'s redeem, which the /desktop/ filter above does not see', async () => {
    /**
     * ⚠ The assertion above filters on `/desktop/` and therefore does NOT cover
     * `/api/auth/desktop-code/redeem` — the path says `desktop-code`, not `/desktop/`. C12's
     * route was public and unasserted until this case existed, which is the shape of gap a
     * "list exactly these" test is supposed to close rather than create.
     *
     * It is public for the same reason `/auth/login` is: it is what PRODUCES the token. Its
     * credential is the code+verifier PAIR — the code arrives over `lgr://`, a scheme any
     * program can register, so the code alone is deliberately not enough.
     */
    expect(isPublicRoute('POST', '/api/auth/desktop-code/redeem')).toBe(true)

    // And it is the ONLY desktop-adjacent auth route that is public. Anything else that ever
    // spells "desktop" under /api/auth has to be added here deliberately.
    const authDesktopPublic = PUBLIC_ROUTE_KEYS.filter(
      k => k.includes('/auth/') && k.toLowerCase().includes('desktop'),
    )
    expect(authDesktopPublic.sort()).toEqual(['POST /api/auth/desktop-code/redeem'])
  })

  it('matches on the route pattern, so a parameter cannot spell its way in', () => {
    expect(isPublicRoute('POST', '/api/desktop/v1/enroll/../self')).toBe(false)
    expect(isPublicRoute('GET', '/api/desktop/v1/enroll')).toBe(false)
  })

  it('serves enroll and token anonymously', async () => {
    const { orgId } = await seedAll()
    const code = await mintEnrollmentCode(orgId, String((await createTestUser((await createTestOrg())._id))._id), 'https://x')
    // A wrong code still proves the guard let the request THROUGH: 400, not 401.
    const res = await call('/api/desktop/v1/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...enrollBody(makeDesktopStub()), code: 'ZZZZ-ZZZZ' }),
    })
    expect(res.status).toBe(400)
    expect(code).toBeTruthy()

    const tokenRes = await call('/api/desktop/v1/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assertion: 'x'.repeat(40) }),
    })
    expect(tokenRes.status).toBe(401) // reached the handler, refused on its own terms
  })
})
