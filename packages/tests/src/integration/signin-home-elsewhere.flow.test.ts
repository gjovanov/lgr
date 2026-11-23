import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../api/src/api.js'
import { Identity, Org, OrgHome, User } from 'db/models'
import { forgetAllHomes, isHomeHere } from 'db/home/home'
import { getOrCreateUser } from 'services/biz/oauth.service'
import type { Types } from 'mongoose'

/**
 * FR-20.4: signing in to an org whose home is ANOTHER node, as lgrai.app sees an org that moved to its own
 * server, or one frozen for a move.
 *
 * Only the home writes an org's memberships, and the write guard refused the membership's `lastLoginAt` too.
 * Every NEW sign-in into a moved org answered 401 "Invalid credentials" on lgrai.app, which is where its admin
 * turns the org's relays on, moves it back or asks for its address. A session issued before the move went on
 * working, so no suite saw it; the field lane `shop-ubuntu-linked` did. The sign-in works now, the membership's
 * timestamp is left to its home, and a wrong password is refused as before.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
const PW = crypto.randomUUID()
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

afterEach(() => forgetAllHomes())

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  const res = await app.handle(
    new Request(`http://localhost/api${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  )
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}

/** Sign in. The body is built from parameters, so no literal credential pair sits in this file. */
function signInAs(username: string, password: string, extra: Record<string, unknown> = {}) {
  return call('POST', '/auth/login', { body: { username, password, ...extra } })
}
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

async function org() {
  const o = await createTestOrg({ slug: `away-${Date.now()}-${++seq}`, name: `Away ${seq}` } as any)
  return { id: String(o._id), slug: o.slug as string, _id: o._id as Types.ObjectId }
}

/** A person with a membership in each org, made while every org is still at home here. */
async function person(orgs: { _id: Types.ObjectId }[], link?: { provider: string; providerId: string }) {
  const email = `p${++seq}-${Date.now()}@away.test`
  const identity = await Identity.create({
    email,
    firstName: 'Per',
    lastName: 'Son',
    password: await Bun.password.hash(PW),
    passwordSetBy: 'self',
  })
  const members = []
  for (const o of orgs) {
    members.push(
      await createTestUser(o._id, {
        email,
        username: email.split('@')[0],
        identityId: identity._id,
        ...(link ? { oauthProviders: [link] } : {}),
      } as any),
    )
  }
  return { email, identity, members }
}

/** The org's home is now elsewhere: a master it moved to, or (`home: 'global'`) a move's freeze. */
async function homeElsewhere(orgId: Types.ObjectId, row: { home: string; state?: string } = { home: 'node-shop-1' }) {
  await OrgHome.create({ orgId, epoch: 1, state: 'active', ...row })
  await Org.updateOne({ _id: orgId }, { $set: { homeEpochHighWater: 1 } }).exec()
  // Writing the memberships cached the org as home here for five seconds.
  forgetAllHomes()
  expect(await isHomeHere(orgId)).toBe(false)
}

const lastLoginOf = async (id: unknown) => ((await User.findById(id, { lastLoginAt: 1 }).lean().exec()) as any)?.lastLoginAt

describe('signing in to an org whose home is another node', () => {
  it('by its slug: a session in it that reads, the membership left to its home, the person told where they were', async () => {
    const b = await org()
    const p = await person([b])
    await homeElsewhere(b._id)

    const res = await signInAs(p.email, PW, { orgSlug: b.slug })
    expect(res.status).toBe(200)
    expect(claimsOf(res.body.token).orgId).toBe(b.id)
    expect(await lastLoginOf(p.members[0]._id)).toBeUndefined()
    expect(String((await Identity.findById(p.identity._id, { lastOrgId: 1 }).lean().exec())?.lastOrgId)).toBe(b.id)

    const me = await call('GET', '/auth/me', { token: res.body.token })
    expect(me.status).toBe(200)
  })

  it('as the person, landing in their only org', async () => {
    const b = await org()
    const p = await person([b])
    await homeElsewhere(b._id)

    const res = await signInAs(p.email, PW)
    expect(res.status).toBe(200)
    expect(res.body.needsOrgChoice).toBe(false)
    expect(claimsOf(res.body.token).orgId).toBe(b.id)
  })

  it('switching into it from an org at home, which is stamped as before', async () => {
    const a = await org()
    const b = await org()
    const p = await person([a, b])
    await homeElsewhere(b._id)

    const inA = await signInAs(p.email, PW, { orgSlug: a.slug })
    expect(inA.status).toBe(200)
    expect(await lastLoginOf(p.members[0]._id)).toBeInstanceOf(Date)

    const res = await call('POST', '/auth/switch', { token: inA.body.token, body: { orgId: b.id } })
    expect(res.status).toBe(200)
    expect(claimsOf(res.body.token).orgId).toBe(b.id)
    expect(await lastLoginOf(p.members[1]._id)).toBeUndefined()
  })

  it('while a move freezes it', async () => {
    const b = await org()
    const p = await person([b])
    await homeElsewhere(b._id, { home: 'global', state: 'freezing' })

    const res = await signInAs(p.email, PW, { orgSlug: b.slug })
    expect(res.status).toBe(200)
    expect(claimsOf(res.body.token).orgId).toBe(b.id)
  })

  it('with a provider already linked to the membership (OAuth, by the org)', async () => {
    const b = await org()
    const link = { provider: 'google', providerId: `g-${Date.now()}-${++seq}` }
    const p = await person([b], link)
    await homeElsewhere(b._id)

    const out = await getOrCreateUser({ ...link, email: p.email, name: 'Per Son', emailVerified: true }, b.slug)
    expect(out.isNew).toBe(false)
    expect(String(out.user.orgId)).toBe(b.id)
    expect(await lastLoginOf(p.members[0]._id)).toBeUndefined()
  })

  it('a wrong password is refused as before', async () => {
    const b = await org()
    const p = await person([b])
    await homeElsewhere(b._id)

    const res = await signInAs(p.email, `${PW}-not-it`, { orgSlug: b.slug })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('invalid_credentials')
  })
})
