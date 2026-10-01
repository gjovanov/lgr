import { test, expect } from '@playwright/test'

/**
 * C15 §2 — who may reach the Desktops endpoints (FR-14.23, AC 12).
 *
 * ⚠ **API-only, and that is the point.** Portal routes have NO client-side guard (FR-13 trap 20):
 * the menu item being hidden proves nothing, because the route is reachable by typing the URL and
 * the data is reachable with `fetch`. The real assertion is the server's refusal, so this spec
 * never opens a page.
 *
 * ⚠ It also never WRITES. Every case asserts a refusal, so a run leaves the database exactly as
 * it found it — which is what lets it be the first thing anybody runs against a dev hub.
 */

const API = process.env.BASE_URL || 'http://localhost:4001'

interface Session { token: string; orgId: string }

async function login(orgSlug: string, username: string): Promise<Session> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug, username, password: 'test123' }),
  })
  if (!res.ok) throw new Error(`login ${orgSlug}/${username} failed (${res.status}) — is the DB seeded?`)
  const data = await res.json()
  return { token: data.token, orgId: data.org._id || data.org.id }
}

/** Every desktops endpoint an admin uses, as `METHOD path` against a given org. */
function endpoints(orgId: string) {
  const base = `${API}/api/org/${orgId}/desktops`
  return [
    { method: 'GET', url: base, body: undefined },
    { method: 'POST', url: `${base}/codes`, body: {} },
    { method: 'GET', url: `${base}/codes`, body: undefined },
    // A non-existent id on purpose: a refusal must come from the GATE, before anything is looked
    // up, so these say nothing about whether the desktop exists.
    { method: 'PUT', url: `${base}/000000000000000000000000`, body: { name: 'x' } },
    { method: 'POST', url: `${base}/000000000000000000000000/revoke`, body: { reason: 'x' } },
  ]
}

async function call(e: { method: string; url: string; body: unknown }, token?: string) {
  return fetch(e.url, {
    method: e.method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(e.body === undefined ? {} : { body: JSON.stringify(e.body) }),
  })
}

test.describe('the Desktops endpoints refuse everyone but an admin', () => {
  test('anonymous gets 401 on every one', async () => {
    const admin = await login('acme-corp', 'admin')
    for (const e of endpoints(admin.orgId)) {
      const res = await call(e)
      expect(`${e.method} ${new URL(e.url).pathname} -> ${res.status}`)
        .toBe(`${e.method} ${new URL(e.url).pathname} -> 401`)
    }
  })

  test('a signed-in non-admin gets 403 on every one', async () => {
    /**
     * ⚠ `accountant` and `sales` are the seeded roles that hold NO `admin.settings`, which is the
     * gate these routes use. They stand in for C15's "member and manager" — the property under
     * test is the permission, not the role name, and creating two users to spell the role names
     * exactly would leave rows behind in whatever database this runs against.
     *
     * `manager` is worth a word: it holds every MODULE permission and still fails here, because
     * `DEFAULT_ROLE_PERMISSIONS.manager` deliberately excludes everything under `admin.`.
     */
    for (const username of ['accountant', 'sales']) {
      const user = await login('acme-corp', username)
      for (const e of endpoints(user.orgId)) {
        const res = await call(e, user.token)
        expect(`${username} ${e.method} ${new URL(e.url).pathname} -> ${res.status}`)
          .toBe(`${username} ${e.method} ${new URL(e.url).pathname} -> 403`)
      }
    }
  })

  test('an admin of ANOTHER org is refused, by org and not by role', async () => {
    // ⚠ The sharp case: beta's admin holds `admin.settings`, so only the tenant guard stands
    // between them and acme's fleet. A 200 here would mean one shop could revoke another's tills.
    const acme = await login('acme-corp', 'admin')
    const beta = await login('beta-inc', 'admin')
    expect(acme.orgId).not.toBe(beta.orgId)

    for (const e of endpoints(acme.orgId)) {
      const res = await call(e, beta.token)
      expect(`beta -> acme ${e.method} ${new URL(e.url).pathname} -> ${res.status}`)
        .toBe(`beta -> acme ${e.method} ${new URL(e.url).pathname} -> 403`)
    }
  })

  test('the same admin IS served their own org', async () => {
    // The control. Without it, every assertion above would also pass against a route that is
    // simply broken for everybody.
    const beta = await login('beta-inc', 'admin')
    const res = await fetch(`${API}/api/org/${beta.orgId}/desktops`, {
      headers: { Authorization: `Bearer ${beta.token}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveProperty('desktops')
  })
})

test.describe('the desktop-principal routes are not reachable with a user token', () => {
  test('a user token is refused on /api/desktop/v1/self', async () => {
    // ⚠ The two secrets are separate by construction (`DESKTOP_TOKEN_SECRET`), so a signed-in
    // browser is not a desktop however legitimate its session.
    const admin = await login('acme-corp', 'admin')
    const res = await fetch(`${API}/api/desktop/v1/self`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ appVersion: '9.9.9' }),
    })
    expect([401, 403]).toContain(res.status)
  })

  test('enroll and token are public, and refuse rubbish on their own terms', async () => {
    // They are in `public-routes.ts` because they PRODUCE the credential — so the refusal has to
    // come from the code/signature check, not from the auth guard. A 401 here would mean the
    // table had drifted and no desktop could ever enroll.
    const enroll = await fetch(`${API}/api/desktop/v1/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'ZZZZ-ZZZZ',
        installationId: 'e2e-not-a-real-install',
        machineId: 'e2e-machine',
        name: 'e2e probe',
        publicKey: 'x'.repeat(60),
      }),
    })
    expect(enroll.status).not.toBe(401)
    expect(enroll.ok).toBe(false)

    const token = await fetch(`${API}/api/desktop/v1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assertion: 'not.a.real-assertion' }),
    })
    expect(token.status).toBe(401)
  })
})

test.describe('a ?token= in the URL does not sign anyone in (C01)', () => {
  test('a production-origin token authenticates nothing', async ({ page }) => {
    /**
     * FR-14.24. The cross-SPA handoff used to accept any `?token=`, so a planted link signed a
     * visitor into the attacker's account. The gate now refuses the parameter outright.
     *
     * ⚠ Asserted by what the APP does, not by what the URL looks like: the token is taken from a
     * real login, so this is the strongest form of the attack — a structurally valid, correctly
     * signed JWT for a real account — and it must still not establish a session.
     */
    const admin = await login('acme-corp', 'admin')

    await page.goto(`/auth/login?token=${admin.token}`, { waitUntil: 'networkidle' })

    const stored = await page.evaluate(() => localStorage.getItem('lgr_token'))
    expect(stored).toBeNull()

    // And the URL no longer carries it, so it cannot survive into a bookmark or the history.
    expect(page.url()).not.toContain('token=')
  })
})
