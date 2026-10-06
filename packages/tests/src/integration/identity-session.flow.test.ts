import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { AuditLog, Identity, User } from 'db/models'
import { mongoose } from 'db/connection'
import { isPublicRoute } from 'services/biz/public-routes'
import { isIdentityRoute, IDENTITY_ROUTE_KEYS } from 'services/biz/identity-routes'
import { forgetIdentity } from 'services/biz/identity/session.service'
import type { Types } from 'mongoose'

/**
 * Multi-org sign-in, Phase 2: signing in as a PERSON, and entering their orgs.
 *
 * A session stays org-scoped (`tokenize()` of ONE membership), so the tenant guard and every
 * permission check are what they were. What is new is who a sign-in names and where it lands:
 *   - a username or an address names a person; several people behind one username is a 409,
 *     never a guess, and every outcome costs exactly one password check;
 *   - rule 5: a person lands only where they chose before (this browser's org, their last org,
 *     their only org); otherwise they get an IDENTITY-ONLY token, which reaches the identity
 *     routes and nothing else, and pick;
 *   - a linked membership signs in with its person's password, never with its legacy per-org copy;
 *   - a password change ends every session the person holds (`iid` + `tv`).
 */

let app: Elysia
const PW = crypto.randomUUID()
const OTHER_PW = crypto.randomUUID()
let seq = 0

beforeAll(async () => {
  await setupTestDB()
  await Identity.init()
  await User.init()
  app = new Elysia().use(createApiApp())
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

async function call(method: string, path: string, opts: { token?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.cookie) headers.cookie = opts.cookie
  const res = await app.handle(
    new Request(`http://localhost/api${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  )
  return { status: res.status, body: (await res.json().catch(() => null)) as any, headers: res.headers }
}

/** Sign in. The body is built from parameters, so no literal credential pair sits in this file. */
function signInAs(username: string, password: string, extra: Record<string, unknown> = {}) {
  return call('POST', '/auth/login', { body: { username, password, ...extra } })
}
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

async function org(prefix = 'o') {
  const o = await createTestOrg({ slug: `${prefix}-${Date.now()}-${++seq}`, name: `${prefix.toUpperCase()} ${seq}` } as any)
  return { id: String(o._id), slug: o.slug as string, _id: o._id as Types.ObjectId }
}

/** A person with a membership in each org, all under one username. */
async function person(email: string, orgs: { _id: Types.ObjectId }[], opts: { username?: string; password?: string | null; lastOrgId?: unknown } = {}) {
  const identity = await Identity.create({
    email,
    firstName: 'Per',
    lastName: 'Son',
    password: opts.password === null ? undefined : await Bun.password.hash(opts.password ?? PW),
    passwordSetBy: 'self',
    lastOrgId: opts.lastOrgId,
  })
  const members = []
  for (const o of orgs) {
    members.push(
      await createTestUser(o._id, {
        email,
        username: opts.username ?? email.split('@')[0],
        identityId: identity._id,
        // The legacy per-org copy is deliberately a DIFFERENT password: sign-in must not use it.
        password: await Bun.password.hash(OTHER_PW),
      } as any),
    )
  }
  return { identity, members }
}

// ── Signing in as a person ─────────────────────────────────────────────────────────────────

describe('signing in without an org', () => {
  it('lands a person with one org in it: an org session that names the person', async () => {
    const a = await org('solo')
    const { identity, members } = await person(`solo-${seq}@x.test`, [a])

    const res = await signInAs(members[0].username, PW)
    expect(res.status).toBe(200)
    expect(res.body.needsOrgChoice).toBe(false)
    expect(res.body.org.slug).toBe(a.slug)
    expect(res.body.orgs.map((o: any) => [o.slug, o.current])).toEqual([[a.slug, true]])
    const claims = claimsOf(res.body.token)
    expect([claims.orgId, claims.iid, claims.tv]).toEqual([a.id, String(identity._id), 0])
    expect(String((await Identity.findById(identity._id).lean().exec())!.lastOrgId)).toBe(a.id)
  })

  it('takes an email address, in any case', async () => {
    const a = await org('mail')
    await person(`Mail.Person-${seq}@X.test`.toLowerCase(), [a])

    const res = await signInAs(`  MAIL.PERSON-${seq}@x.TEST `, PW)
    expect(res.status).toBe(200)
    expect(res.body.org.slug).toBe(a.slug)
  })

  it('gives a person with several orgs and no choice yet an identity-only token, and no cookie', async () => {
    const [a, b] = [await org('two-a'), await org('two-b')]
    await person(`two-${seq}@x.test`, [a, b])

    const res = await signInAs(`two-${seq}@x.test`, PW)
    expect(res.status).toBe(200)
    expect(res.body.needsOrgChoice).toBe(true)
    expect(res.body.user).toBeUndefined()
    expect(res.body.orgs.map((o: any) => o.slug).sort()).toEqual([a.slug, b.slug].sort())
    expect(claimsOf(res.body.token).type).toBe('identity')
    // Not a session: it must never replace the cookie another tab's session uses.
    expect(res.headers.getSetCookie().some(c => c.startsWith('auth='))).toBe(false)
  })

  it('lands where this browser was last (if it is theirs), else their last org', async () => {
    const [a, b, foreign] = [await org('pref-a'), await org('pref-b'), await org('pref-x')]
    await person(`pref-${seq}@x.test`, [a, b], { lastOrgId: a._id })
    const username = `pref-${seq}@x.test`

    expect((await signInAs(username, PW, { preferredOrgId: b.id })).body.org.slug).toBe(b.slug)
    // A preferred org the person is not in is ignored: the person's own last org wins.
    expect((await signInAs(username, PW, { preferredOrgId: foreign.id })).body.org.slug).toBe(b.slug)
  })

  it('answers a username several people share with 409, and the email still works', async () => {
    const [a, b] = [await org('amb-a'), await org('amb-b')]
    const name = `shared${seq}`
    await person(`first-${seq}@x.test`, [a], { username: name })
    await person(`second-${seq}@x.test`, [b], { username: name })

    const ambiguous = await signInAs(name, PW)
    expect(ambiguous.status).toBe(409)
    expect(ambiguous.body.code).toBe('ambiguous_login')

    const byOrg = await signInAs(name, PW, { orgSlug: b.slug })
    expect(byOrg.status).toBe(200)
    expect((await signInAs(`first-${seq}@x.test`, PW)).body.org.slug).toBe(a.slug)
  })

  it('says nothing about an account to someone without its password', async () => {
    const a = await org('quiet')
    await person(`quiet-${seq}@x.test`, [a])

    for (const [who, secret] of [
      [`quiet-${seq}@x.test`, OTHER_PW], // wrong: the legacy copy's password
      [`nobody-${seq}@x.test`, PW],
      [`nobody${seq}`, PW],
    ]) {
      const res = await signInAs(who, secret)
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 401, code: 'invalid_credentials' })
    }
  })

  it('tells only the password holder that the person has not activated yet', async () => {
    const a = await org('pend')
    const { identity } = await person(`pend-${seq}@x.test`, [a])
    await Identity.updateOne({ _id: identity._id }, { $set: { isActive: false } })

    expect((await signInAs(`pend-${seq}@x.test`, OTHER_PW)).body.code).toBe('invalid_credentials')
    expect((await signInAs(`pend-${seq}@x.test`, PW)).body.code).toBe('not_activated')
  })

  it('still signs in a user the migration has not linked, to its own org, without a person claim', async () => {
    const a = await org('legacy')
    const u = await createTestUser(a._id, { username: `unlinked${seq}`, password: await Bun.password.hash(PW) } as any)

    const res = await signInAs(u.username, PW)
    expect(res.status).toBe(200)
    expect(res.body.org.slug).toBe(a.slug)
    expect(claimsOf(res.body.token).iid).toBeUndefined()
  })
})

describe('the org path (orgSlug), as scripts and the old UI use it', () => {
  it("verifies a linked membership against its PERSON's password, never its legacy copy", async () => {
    const a = await org('slug')
    const { members } = await person(`slug-${seq}@x.test`, [a])

    expect((await signInAs(members[0].username, PW, { orgSlug: a.slug })).status).toBe(200)
    expect((await signInAs(members[0].username, OTHER_PW, { orgSlug: a.slug })).status).toBe(401)
  })

  it('refuses a merged person with no password, whatever the old per-org password was', async () => {
    const a = await org('nopw')
    const { members } = await person(`nopw-${seq}@x.test`, [a], { password: null })

    const res = await signInAs(members[0].username, OTHER_PW, { orgSlug: a.slug })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('invalid_credentials')
  })

  it('falls back to the membership\'s own password when its person is missing (a restore without identities)', async () => {
    const a = await org('dangling')
    const u = await createTestUser(a._id, {
      username: `dangling${seq}`,
      password: await Bun.password.hash(PW),
      identityId: new mongoose.Types.ObjectId(), // a person that is not there
    } as any)

    expect((await signInAs(u.username, PW, { orgSlug: a.slug })).status).toBe(200)
  })
})

// ── The identity-only token ────────────────────────────────────────────────────────────────

describe('the identity-only token', () => {
  async function identityToken() {
    const [a, b] = [await org('it-a'), await org('it-b')]
    await person(`it-${seq}@x.test`, [a, b])
    const res = await signInAs(`it-${seq}@x.test`, PW)
    expect(res.body.needsOrgChoice).toBe(true)
    return { token: res.body.token as string, a, b }
  }

  it('lists the person\'s orgs and the invitations pinned to their address', async () => {
    const { token, a, b } = await identityToken()
    const res = await call('GET', '/auth/orgs', { token })
    expect(res.status).toBe(200)
    expect(res.body.orgs.map((o: any) => o.slug).sort()).toEqual([a.slug, b.slug].sort())
    expect(res.body.invitations).toEqual([])
  })

  it('reaches no other route: every one answers 401 (or 422 where the body is checked first)', async () => {
    const { token } = await identityToken()
    expect(IDENTITY_ROUTE_KEYS.length).toBeGreaterThan(0)

    const leaked: string[] = []
    for (const r of (app as any).routes as Array<{ method: string; path: string }>) {
      if (r.method === 'WS' || r.method === 'ALL') continue
      if (isPublicRoute(r.method, r.path) || isIdentityRoute(r.method, r.path)) continue
      const url = r.path.replace(/:orgId/g, '000000000000000000000001').replace(/:[A-Za-z]+/g, '1')
      const res = await app.handle(
        new Request(`http://localhost${url}`, {
          method: r.method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: r.method === 'GET' || r.method === 'HEAD' ? undefined : '{}',
        }),
      )
      if (res.status !== 401 && res.status !== 422) leaked.push(`${r.method} ${r.path} -> ${res.status}`)
    }
    expect(leaked).toEqual([])
  })

  it('switches into one of the person\'s orgs, keeping the original expiry', async () => {
    const { token, b } = await identityToken()
    const res = await call('POST', '/auth/switch', { token, body: { orgId: b.id } })
    expect(res.status).toBe(200)
    expect(res.body.org.slug).toBe(b.slug)
    const claims = claimsOf(res.body.token)
    expect(claims.orgId).toBe(b.id)
    expect(claims.exp).toBe(claimsOf(token).exp) // a switch never extends a sign-in
    expect((await call('GET', '/auth/me', { token: res.body.token })).status).toBe(200)
  })
})

// ── Switching ──────────────────────────────────────────────────────────────────────────────

describe('switching org', () => {
  async function sessionIn(slugPrefix: string) {
    const [a, b] = [await org(`${slugPrefix}-a`), await org(`${slugPrefix}-b`)]
    const { identity, members } = await person(`${slugPrefix}-${seq}@x.test`, [a, b], { lastOrgId: a._id })
    const res = await signInAs(`${slugPrefix}-${seq}@x.test`, PW)
    expect(res.body.org.slug).toBe(a.slug)
    return { token: res.body.token as string, a, b, identity, members }
  }

  it('enters only the person\'s own, active memberships', async () => {
    const { token, b, members } = await sessionIn('own')
    const stranger = await org('stranger')
    expect((await call('POST', '/auth/switch', { token, body: { orgId: stranger.id } })).body.code).toBe('not_a_member')

    await User.updateOne({ _id: members[1]._id }, { $set: { isActive: false, deactivatedAt: new Date() } })
    expect((await call('POST', '/auth/switch', { token, body: { orgId: b.id } })).body.code).toBe('not_a_member')
  })

  it('refuses a caller with only a cookie (rule 7: the tab\'s own token decides)', async () => {
    const { token, b } = await sessionIn('cookie')
    const res = await call('POST', '/auth/switch', { cookie: `auth=${token}`, body: { orgId: b.id } })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('bearer_required')
  })

  it('gives a session the tenant guard treats like any other, records the sign-in, and remembers the choice', async () => {
    const { token, a, b, identity } = await sessionIn('guard')
    const switched = await call('POST', '/auth/switch', { token, body: { orgId: b.id } })
    expect(switched.status).toBe(200)

    // The org it left is now another org's data to this token.
    expect((await call('GET', `/org/${a.id}/user`, { token: switched.body.token })).status).toBe(403)
    expect((await call('GET', `/org/${b.id}/user`, { token: switched.body.token })).status).toBe(200)

    const audit = await AuditLog.findOne({ orgId: b._id, action: 'login' }).sort({ timestamp: -1 }).lean().exec()
    expect(audit!.changes!.find(c => c.field === 'method')!.newValue).toBe('switch')
    expect(String((await Identity.findById(identity._id).lean().exec())!.lastOrgId)).toBe(b.id)
  })

  it('tells a session that names no person (not migrated yet) to sign in to each org instead', async () => {
    const a = await org('np')
    const u = await createTestUser(a._id, { username: `np${seq}`, password: await Bun.password.hash(PW) } as any)
    const token = (await signInAs(u.username, PW, { orgSlug: a.slug })).body.token
    expect((await call('POST', '/auth/switch', { token, body: { orgId: a.id } })).body.code).toBe('not_a_person')
  })
})

// ── Revocation ─────────────────────────────────────────────────────────────────────────────

describe('ending a person\'s sessions', () => {
  it('ends every session of a person whose password an admin changed', async () => {
    const a = await org('rev')
    const { identity, members } = await person(`rev-${seq}@x.test`, [a])
    const old = (await signInAs(`rev-${seq}@x.test`, PW)).body.token
    expect((await call('GET', '/auth/me', { token: old })).status).toBe(200)

    const admin = (await signInAs(`rev-${seq}@x.test`, PW)).body.token
    expect((await call('PUT', `/org/${a.id}/user/${members[0]._id}`, { token: admin, body: { password: OTHER_PW } })).status).toBe(200)

    expect((await call('GET', '/auth/me', { token: old })).status).toBe(401)
    const fresh = await signInAs(`rev-${seq}@x.test`, OTHER_PW)
    expect(claimsOf(fresh.body.token).tv).toBe(1)
    expect((await Identity.findById(identity._id).lean().exec())!.tokenVersion).toBe(1)
  })

  it('ends the sessions of a person who is switched off (within the cache minute on other pods)', async () => {
    const a = await org('off')
    const { identity } = await person(`off-${seq}@x.test`, [a])
    const token = (await signInAs(`off-${seq}@x.test`, PW)).body.token

    await Identity.updateOne({ _id: identity._id }, { $set: { isActive: false } })
    forgetIdentity(identity._id) // what another pod's cache does by itself within a minute
    expect((await call('GET', '/auth/me', { token })).status).toBe(401)
  })

  it('shows the person on /auth/me: never the hash, only whether there is one', async () => {
    const a = await org('me')
    await person(`me-${seq}@x.test`, [a])
    const token = (await signInAs(`me-${seq}@x.test`, PW)).body.token
    const me = await call('GET', '/auth/me', { token })
    expect(me.body.identity).toMatchObject({ email: `me-${seq}@x.test`, hasPassword: true, passwordSetBy: 'self' })
    expect(JSON.stringify(me.body)).not.toContain('$argon2')
  })
})
