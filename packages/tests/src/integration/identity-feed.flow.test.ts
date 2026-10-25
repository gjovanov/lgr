import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from 'config'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { makeNodeStub, nodeEnrollBody } from '../helpers/node-stub'
import { createApiApp } from '../../../portal-api/src/api.js'
import { Identity, NodeState } from 'db/models'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { sessionFor } from 'services/biz/auth.service'
import { applyIdentityChanges, identityFeedTick } from 'services/biz/identity/identity-feed.service'

/**
 * The identity feed (FR-20.43, FR-20.44, plan step P2-5): what changes about a master's people on
 * lgrai.app reaches the master, and a password change or a deactivation there ends their sessions
 * here. Nothing secret about a person ever leaves global.
 */

const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'
const realFetch = globalThis.fetch
const saved = { role: config.node.role, id: config.node.id, tokenFile: config.outbox.tokenFile }
let tmp = ''

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => {
  globalThis.fetch = realFetch
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.outbox as any).tokenFile = saved.tokenFile
  forgetAllHomes()
  await clearCollections()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = ''
})

const jwt = async () => ((new Elysia().use((await import('@elysiajs/jwt')).default({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt)
const call = (app: any, method: string, path: string, token?: string) =>
  app.handle(new Request(`http://localhost${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} }))

async function aServerWithPeople() {
  const org = await createTestOrg()
  const person = (name: string, extra: Record<string, unknown> = {}) => Identity.create({
    email: `${name}-${randomBytes(3).toString('hex')}@shop.test`, firstName: name, lastName: 'Shop',
    password: '$argon2id$v=19$m=65536,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA', ...extra,
  })
  const ana: any = await person('Ana', { oauthProviders: [{ provider: 'google', providerId: 'g-123', accessToken: 'ya29.secret-token' }] })
  const boris: any = await person('Boris', { password: '$2b$10$abcdefghijklmnopqrstuuJ3o2iv2HYp1q4l1jVxk3JcJ9rRyLm2' })
  const stranger: any = await person('Stranger')
  const anaMember: any = await createTestUser(org._id, { role: 'admin', identityId: ana._id, email: ana.email } as any)
  await createTestUser(org._id, { role: 'member', identityId: boris._id, email: boris.email } as any)
  await createTestUser((await createTestOrg())._id, { identityId: stranger._id, email: stranger.email } as any)
  const stub = makeNodeStub()
  const { code } = await mintNodeEnrollmentCode(String(org._id), String(anaMember._id))
  await enrollNode({ ...nodeEnrollBody(stub, ENROLL), code } as any, [ENROLL])
  const nodeToken = (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN }), [TOKEN])).token
  return { orgId: String(org._id), ana, anaMember, boris, stranger, nodeId: stub.nodeId, nodeToken, app: new Elysia().use(createApiApp()) }
}

describe('global: a server\'s people, and nothing secret about them', () => {
  it('lists the members of its orgs, by cursor, with no password, OAuth token or hash shape', async () => {
    const s = await aServerWithPeople()
    const feed = async (q = '') => (await call(s.app, 'GET', `/api/node/v1/identity-changes${q}`, s.nodeToken)).json()
    expect((await call(s.app, 'GET', '/api/node/v1/identity-changes')).status).toBe(401)

    const all = await feed()
    expect(all.items.map((i: any) => i.iid).sort()).toEqual([String(s.ana._id), String(s.boris._id)].sort())
    expect(all.more).toBe(false)
    const text = JSON.stringify(all)
    for (const shape of ['$argon2', '$2a$', '$2b$', '$2y$', 'ya29.', 'oauthProviders', 'password', 'accessToken']) expect(text).not.toContain(shape)
    expect(Object.keys(all.items[0]).sort()).toEqual(['active', 'email', 'firstName', 'iid', 'lastName', 'tv'])

    // Paged by the cursor: one at a time, then nothing new.
    const first = await feed('?limit=1')
    expect(first.items).toHaveLength(1)
    expect(first.more).toBe(true)
    const second = await feed(`?limit=1&after=${encodeURIComponent(first.cursor)}`)
    expect(second.items.map((i: any) => i.iid)).not.toContain(first.items[0].iid)
    expect((await feed(`?after=${encodeURIComponent(all.cursor)}`)).items).toEqual([])

    // A password change on lgrai.app moves the person past the cursor, with the new tokenVersion.
    await Identity.updateOne({ _id: s.boris._id }, { $inc: { tokenVersion: 1 } })
    const next = await feed(`?after=${encodeURIComponent(all.cursor)}`)
    expect(next.items).toEqual([expect.objectContaining({ iid: String(s.boris._id), tv: 1 })])
  })
})

describe('a master applies them', () => {
  it('a tokenVersion bump ends the person\'s sessions here at once; it never goes back down', async () => {
    const s = await aServerWithPeople()
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = s.nodeId
    await homeNewOrg(s.orgId)
    const session = await (await jwt()).sign({ ...(await sessionFor(s.anaMember, s.ana)), exp: Math.floor(Date.now() / 1000) + 3600 })
    expect((await call(s.app, 'GET', '/api/auth/me', session)).status).toBe(200)

    const ana = { iid: String(s.ana._id), email: s.ana.email, firstName: 'Ana', lastName: 'Shop', tv: 1, active: true }
    expect(await applyIdentityChanges([ana])).toBe(1)
    expect((await call(s.app, 'GET', '/api/auth/me', session)).status).toBe(401)
    expect(await applyIdentityChanges([{ ...ana, tv: 0 }])).toBe(0)
    expect(((await Identity.findById(s.ana._id).lean()) as any).tokenVersion).toBe(1)

    // A person this master does not hold is ignored; a deactivation applies.
    expect(await applyIdentityChanges([{ ...ana, iid: '0123456789abcdef01234567' }])).toBe(0)
    expect(await applyIdentityChanges([{ ...ana, active: false }])).toBe(1)
  })

  it('pulls from lgrai.app with the supervisor token, and keeps its cursor', async () => {
    const s = await aServerWithPeople()
    tmp = mkdtempSync(join(tmpdir(), 'lgr-feed-'))
    const file = join(tmp, 'node-token.json')
    writeFileSync(file, JSON.stringify({ server: 'https://lgrai.test', token: s.nodeToken, expiresAt: Math.floor(Date.now() / 1000) + 600 }))
    ;(config.outbox as any).tokenFile = file
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = s.nodeId
    await homeNewOrg(s.orgId)
    // lgrai.app, in this same process: its answer runs as global.
    const fake = (async (url: any, init: any) => {
      const u = new URL(String(url))
      ;(config.node as any).role = 'global'
      try {
        return await s.app.handle(new Request(`http://localhost${u.pathname}${u.search}`, { headers: init?.headers }))
      } finally {
        ;(config.node as any).role = 'master'
      }
    }) as any
    // Global has changed Boris's name; this master still holds the old one.
    await Identity.updateOne({ _id: s.boris._id }, { $set: { firstName: 'Borislav' } })
    await Identity.collection.updateOne({ _id: s.boris._id }, { $set: { firstName: 'Boris' } }) // the master's stale copy (same DB in the test)
    // In this one-process test global and the master share a database, so the change shows as a
    // difference only when the feed carries a value the copy lacks: feed it the global answer.
    const changed = await identityFeedTick(new Date(), (async (url: any, init: any) => {
      const res = await fake(url, init)
      const body = await res.json()
      body.items = body.items.map((i: any) => (i.iid === String(s.boris._id) ? { ...i, firstName: 'Borislav' } : i))
      return Response.json(body)
    }) as any)
    expect(changed).toBe(1)
    expect(((await Identity.findById(s.boris._id).lean()) as any).firstName).toBe('Borislav')
    const state: any = await NodeState.findById('identity-feed').lean()
    expect(typeof state.value.cursor).toBe('string')
    expect(state.value.fullAt).toBeTruthy()
  })
})
