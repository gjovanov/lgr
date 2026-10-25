import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { createHmac } from 'crypto'
import { config } from 'config'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { makeNodeStub, nodeEnrollBody, type NodeStub } from '../helpers/node-stub'
import { createApiApp } from '../../../portal-api/src/api.js'
import { NodeEnrollmentCode, NodeEnrollmentKey, NodeEnrollmentKeyUse, Org, OrgHome, ServerNode } from 'db/models'
import { forgetAllHomes } from 'db/home/home'
import { GLOBAL_STATE_WRITES } from 'services/biz/route-class'
import {
  NODE_TOKEN_AUDIENCE,
  enrollNode,
  issueNodeToken,
  loadActiveNode,
  mintNodeEnrollmentCode,
  mintNodeEnrollmentKey,
  reapEphemeralNodes,
  revokeNodeForOrg,
  verifyNodeToken,
} from 'services/biz/node/node.service'

/**
 * Global's registry of masters (FR-20.2, plan step P2-1).
 *
 * The properties: a node row always names a key somebody holds (the registration is signed by it);
 * a code registers one master, once; one org can never cut another org's server off; the row is the
 * revocation list; and nothing here exists on a master.
 *
 * ⚠ `captureRejection`, never `.rejects` (CLAUDE.md).
 */

const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'

let app: any
beforeAll(async () => {
  await setupTestDB()
  app = createApiApp()
})
afterAll(async () => { await teardownTestDB() })
afterEach(async () => {
  await clearCollections()
  ;(config.node as any).role = 'global'
  forgetAllHomes()
})

const userSigner = (new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt
const userToken = (u: any, orgId: string) => userSigner.sign({
  id: String(u._id), email: u.email, username: u.username, firstName: u.firstName, lastName: u.lastName,
  role: u.role, orgId, permissions: [...(u.permissions ?? [])],
})
const call = (path: string, init: RequestInit = {}) => app.handle(new Request(`http://localhost${path}`, init))
const json = (method: string, body: unknown, token?: string): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
})

async function anOrg(slug?: string) {
  const org = await createTestOrg(slug ? ({ slug } as any) : undefined)
  const admin = await createTestUser(org._id, { role: 'admin' } as any)
  return { orgId: String(org._id), adminId: String(admin._id), admin, slug: (org as any).slug as string }
}

async function registered(stub: NodeStub = makeNodeStub(), org?: Awaited<ReturnType<typeof anOrg>>) {
  const o = org ?? await anOrg()
  const { code } = await mintNodeEnrollmentCode(o.orgId, o.adminId)
  const res = await enrollNode({ ...nodeEnrollBody(stub, ENROLL), code } as any, [ENROLL])
  return { ...o, stub, res }
}

const tokenFor = async (stub: NodeStub) => (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN }), [TOKEN])).token

describe('registering a master', () => {
  it('records the master under its own id, for the org whose admin minted the code', async () => {
    const { orgId, adminId, slug, stub, res } = await registered()
    expect(res).toMatchObject({ nodeId: stub.nodeId, orgId, orgSlug: slug, linkLevel: 'control' })
    const row = await ServerNode.findById(stub.nodeId).lean() as any
    expect(row).toMatchObject({ status: 'active', keyEpoch: 1, ephemeral: false, installationId: stub.installationId, publicKey: stub.publicKey })
    expect(row.orgIds.map(String)).toEqual([orgId])
    expect(String(row.enrolledBy)).toBe(adminId)
    const code = await NodeEnrollmentCode.findOne({ orgId }).lean() as any
    expect(code.usedAt).toBeTruthy()
    expect(code.usedByNodeId).toBe(stub.nodeId)
  })

  it('a code registers one master, once, with one flat refusal for everything else', async () => {
    const { orgId, adminId } = await anOrg()
    const { code } = await mintNodeEnrollmentCode(orgId, adminId)
    await enrollNode({ ...nodeEnrollBody(makeNodeStub(), ENROLL), code } as any, [ENROLL])
    const used = await captureRejection(enrollNode({ ...nodeEnrollBody(makeNodeStub(), ENROLL), code } as any, [ENROLL]))
    const unknown = await captureRejection(enrollNode({ ...nodeEnrollBody(makeNodeStub(), ENROLL), code: 'ZZZZ-ZZZZ' } as any, [ENROLL]))
    for (const e of [used, unknown]) expect({ status: e.statusCode, code: e.code }).toEqual({ status: 400, code: 'enroll_refused' })
    expect(used.message).toBe(unknown.message)

    const expired = await mintNodeEnrollmentCode(orgId, adminId)
    await NodeEnrollmentCode.updateOne({ _id: expired.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } })
    expect((await captureRejection(enrollNode({ ...nodeEnrollBody(makeNodeStub(), ENROLL), code: expired.code } as any, [ENROLL]))).code).toBe('enroll_refused')
  })

  it('of two masters racing for one code, exactly one registers', async () => {
    const { orgId, adminId } = await anOrg()
    const { code } = await mintNodeEnrollmentCode(orgId, adminId)
    const results = await Promise.allSettled([1, 2, 3].map(() => enrollNode({ ...nodeEnrollBody(makeNodeStub(), ENROLL), code } as any, [ENROLL])))
    expect(results.filter(r => r.status === 'fulfilled').length).toBe(1)
    expect(await ServerNode.countDocuments({})).toBe(1)
  })

  it('stops a code after 10 failed redemptions', async () => {
    const { orgId, adminId } = await anOrg()
    const { id, code } = await mintNodeEnrollmentCode(orgId, adminId)
    await NodeEnrollmentCode.updateOne({ _id: id }, { $set: { attempts: 10 } })
    const e = await captureRejection(enrollNode({ ...nodeEnrollBody(makeNodeStub(), ENROLL), code } as any, [ENROLL]))
    expect({ status: e.statusCode, code: e.code }).toEqual({ status: 429, code: 'enroll_refused' })
  })

  it('refuses a registration not signed by the key it registers, and consumes nothing', async () => {
    const { orgId, adminId } = await anOrg()
    const { id, code } = await mintNodeEnrollmentCode(orgId, adminId)
    const stub = makeNodeStub()
    const other = makeNodeStub()
    for (const proof of [
      other.assertion({ sub: stub.nodeId, audience: ENROLL }), // another key
      stub.assertion({ sub: other.nodeId, audience: ENROLL }), // for another node
      stub.assertion({ sub: stub.nodeId, audience: TOKEN }), // for another route
    ]) {
      const e = await captureRejection(enrollNode({ ...nodeEnrollBody(stub, ENROLL), proof, code } as any, [ENROLL]))
      expect({ status: e.statusCode, code: e.code }).toEqual({ status: 400, code: 'bad_proof' })
    }
    const row = await NodeEnrollmentCode.findById(id).lean() as any
    expect({ usedAt: row.usedAt, attempts: row.attempts }).toEqual({ usedAt: undefined, attempts: 0 })
    await enrollNode({ ...nodeEnrollBody(stub, ENROLL), code } as any, [ENROLL])
  })

  it('takes only a master id and an Ed25519 key', async () => {
    const { orgId, adminId } = await anOrg()
    const { code } = await mintNodeEnrollmentCode(orgId, adminId)
    const stub = makeNodeStub()
    const badId = await captureRejection(enrollNode({ ...nodeEnrollBody(stub, ENROLL), nodeId: 'kasa-1', code } as any, [ENROLL]))
    expect(badId.code).toBe('bad_request')
    const badKey = await captureRejection(enrollNode({ ...nodeEnrollBody(stub, ENROLL), publicKey: 'x'.repeat(60), code } as any, [ENROLL]))
    expect(badKey.code).toBe('bad_public_key')
  })

  it('a second org joins a master only through that master', async () => {
    const first = await registered()
    const second = await anOrg()
    const { id, code } = await mintNodeEnrollmentCode(second.orgId, second.adminId)

    // Another machine claiming the id: refused, and the second org's code given back.
    const impostor = makeNodeStub({ nodeId: first.stub.nodeId })
    const claimed = await captureRejection(enrollNode({ ...nodeEnrollBody(impostor, ENROLL), code } as any, [ENROLL]))
    expect({ status: claimed.statusCode, code: claimed.code }).toEqual({ status: 409, code: 'node_exists' })
    expect((await NodeEnrollmentCode.findById(id).lean() as any).usedAt).toBeUndefined()

    // The same key from another installation is a copied disk.
    const copied = await captureRejection(enrollNode({ ...nodeEnrollBody(first.stub, ENROLL), installationId: 'f'.repeat(32), code } as any, [ENROLL]))
    expect(copied.code).toBe('installation_mismatch')

    // The master itself: both orgs on one node.
    await enrollNode({ ...nodeEnrollBody(first.stub, ENROLL), code } as any, [ENROLL])
    const row = await ServerNode.findById(first.stub.nodeId).lean() as any
    expect(row.orgIds.map(String).sort()).toEqual([first.orgId, second.orgId].sort())
  })

  it('refuses a second active node on the same installation (a cloned disk)', async () => {
    const { stub } = await registered()
    const clone = makeNodeStub({ installationId: stub.installationId })
    const o = await anOrg()
    const { code } = await mintNodeEnrollmentCode(o.orgId, o.adminId)
    const e = await captureRejection(enrollNode({ ...nodeEnrollBody(clone, ENROLL), code } as any, [ENROLL]))
    expect({ status: e.statusCode, code: e.code }).toEqual({ status: 409, code: 'installation_in_use' })
  })

  it('a revoked master registers again with its new key, and its old tokens die', async () => {
    const { orgId, adminId, stub } = await registered()
    const old = verifyNodeToken(await tokenFor(stub))!
    await revokeNodeForOrg(orgId, stub.nodeId, adminId)
    const rekeyed = makeNodeStub({ nodeId: stub.nodeId, installationId: stub.installationId })
    const { code } = await mintNodeEnrollmentCode(orgId, adminId)
    await enrollNode({ ...nodeEnrollBody(rekeyed, ENROLL), code } as any, [ENROLL])
    const row = await ServerNode.findById(stub.nodeId).lean() as any
    expect({ status: row.status, keyEpoch: row.keyEpoch, revokedAt: row.revokedAt }).toEqual({ status: 'active', keyEpoch: 2, revokedAt: undefined })
    expect((await captureRejection(loadActiveNode(old))).code).toBe('key_rotated')
    // The old key cannot mint any more; the new one can.
    expect((await captureRejection(tokenFor(stub))).code).toBe('bad_assertion')
    expect(verifyNodeToken(await tokenFor(rekeyed))?.keyEpoch).toBe(2)
  })
})

describe('tokens', () => {
  it('a signed assertion buys a 15-minute token, and the visit is recorded', async () => {
    const { stub } = await registered()
    const before = Date.now()
    const { token, expiresAt } = await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN }), [TOKEN], '10.0.0.7')
    const claims = verifyNodeToken(token)!
    expect({ nodeId: claims.nodeId, keyEpoch: claims.keyEpoch, aud: claims.aud }).toEqual({ nodeId: stub.nodeId, keyEpoch: 1, aud: NODE_TOKEN_AUDIENCE })
    const ttl = Math.round((expiresAt.getTime() - Date.now()) / 1000)
    expect(ttl).toBeGreaterThan(14 * 60)
    expect(ttl).toBeLessThanOrEqual(15 * 60)
    const row = await ServerNode.findById(stub.nodeId).lean() as any
    expect(new Date(row.lastSeenAt).getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(row.presence.ip).toBe('10.0.0.7')
  })

  it('refuses another key, another audience, a long lifetime and a replay', async () => {
    const { stub } = await registered()
    const now = Math.floor(Date.now() / 1000)
    const cases = [
      makeNodeStub().assertion({ sub: stub.nodeId, audience: TOKEN }),
      stub.assertion({ sub: stub.nodeId, audience: ENROLL }),
      stub.assertion({ sub: stub.nodeId, audience: TOKEN, iat: now, exp: now + 3600 }),
      stub.assertion({ sub: 'master-aaaaaaaaaaaaaaaa', audience: TOKEN }),
      'not.a.jws',
    ]
    for (const a of cases) expect((await captureRejection(issueNodeToken(a, [TOKEN]))).code).toBe('bad_assertion')
    const once = stub.assertion({ sub: stub.nodeId, audience: TOKEN, jti: 'once' })
    await issueNodeToken(once, [TOKEN])
    expect((await captureRejection(issueNodeToken(once, [TOKEN]))).code).toBe('assertion_replayed')
  })

  it('is its own kind: a token signed with the user or desktop secret, or `alg: none`, is nothing', async () => {
    const { stub } = await registered()
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const body = b64({ nodeId: stub.nodeId, keyEpoch: 1, aud: NODE_TOKEN_AUDIENCE, iat: now, exp: now + 600 })
    for (const secret of [config.jwt.secret, config.desktop.tokenSecret]) {
      const head = b64({ alg: 'HS256', typ: 'JWT' })
      const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
      expect(verifyNodeToken(`${head}.${body}.${sig}`)).toBeNull()
    }
    expect(verifyNodeToken(`${b64({ alg: 'none' })}.${body}.`)).toBeNull()
  })
})

describe('taking an org off a master', () => {
  it('is per org: the master keeps its other orgs, and is revoked with its last', async () => {
    const a = await registered()
    const b = await anOrg()
    const { code } = await mintNodeEnrollmentCode(b.orgId, b.adminId)
    await enrollNode({ ...nodeEnrollBody(a.stub, ENROLL), code } as any, [ENROLL])
    const token = verifyNodeToken(await tokenFor(a.stub))!

    expect((await revokeNodeForOrg(a.orgId, a.stub.nodeId, a.adminId)).outcome).toBe('removed')
    expect((await loadActiveNode(token)).orgIds.map(String)).toEqual([b.orgId])
    // A is no longer on it, so A cannot touch it again.
    expect((await captureRejection(revokeNodeForOrg(a.orgId, a.stub.nodeId, a.adminId))).statusCode).toBe(404)

    expect((await revokeNodeForOrg(b.orgId, a.stub.nodeId, b.adminId, 'stolen')).outcome).toBe('revoked')
    expect((await captureRejection(loadActiveNode(token))).code).toBe('node_revoked')
    expect((await captureRejection(tokenFor(a.stub))).code).toBe('node_revoked')
    const row = await ServerNode.findById(a.stub.nodeId).lean() as any
    expect({ status: row.status, reason: row.revokeReason, orgs: row.orgIds.map(String) }).toEqual({ status: 'revoked', reason: 'stolen', orgs: [b.orgId] })
  })

  it('two orgs leaving at once leave a revoked master, never an active one with no org', async () => {
    const a = await registered()
    const b = await anOrg()
    const { code } = await mintNodeEnrollmentCode(b.orgId, b.adminId)
    await enrollNode({ ...nodeEnrollBody(a.stub, ENROLL), code } as any, [ENROLL])
    await Promise.all([revokeNodeForOrg(a.orgId, a.stub.nodeId, a.adminId), revokeNodeForOrg(b.orgId, a.stub.nodeId, b.adminId)])
    const row = await ServerNode.findById(a.stub.nodeId).lean() as any
    expect(row.status).toBe('revoked')
    expect(row.orgIds.length).toBe(1)
  })
})

describe('reusable keys and the reaper (the field lanes)', () => {
  it('need the org setting, on use as well as on minting', async () => {
    const { orgId, adminId } = await anOrg()
    expect((await captureRejection(mintNodeEnrollmentKey(orgId, adminId, { name: 'lane' }))).code).toBe('ephemeral_keys_disabled')
    await Org.updateOne({ _id: orgId }, { $set: { 'settings.node.ephemeralKeysEnabled': true } })
    const { secret } = await mintNodeEnrollmentKey(orgId, adminId, { name: 'lane', maxUses: 2 })

    const one = makeNodeStub()
    await enrollNode({ ...nodeEnrollBody(one, ENROLL), enrollmentKey: secret } as any, [ENROLL])
    await enrollNode({ ...nodeEnrollBody(makeNodeStub(), ENROLL), enrollmentKey: secret } as any, [ENROLL])
    expect((await captureRejection(enrollNode({ ...nodeEnrollBody(makeNodeStub(), ENROLL), enrollmentKey: secret } as any, [ENROLL]))).code).toBe('enroll_refused')
    expect((await NodeEnrollmentKey.findOne({ orgId }).lean() as any).uses).toBe(2)
    expect(await NodeEnrollmentKeyUse.countDocuments({ orgId })).toBe(2)
    expect((await ServerNode.findById(one.nodeId).lean() as any).ephemeral).toBe(true)

    // A replayed registration through a reusable key is refused, and counted once.
    const { secret: again } = await mintNodeEnrollmentKey(orgId, adminId, { name: 'lane 2' })
    const body = { ...nodeEnrollBody(makeNodeStub(), ENROLL), enrollmentKey: again }
    await enrollNode(body as any, [ENROLL])
    expect((await captureRejection(enrollNode(body as any, [ENROLL]))).code).toBe('bad_proof')

    await Org.updateOne({ _id: orgId }, { $set: { 'settings.node.ephemeralKeysEnabled': false } })
    expect((await captureRejection(enrollNode({ ...nodeEnrollBody(makeNodeStub(), ENROLL), enrollmentKey: again } as any, [ENROLL]))).code).toBe('ephemeral_keys_disabled')
  })

  it('of two masters racing for a key\'s last use, one registers', async () => {
    const { orgId, adminId } = await anOrg()
    await Org.updateOne({ _id: orgId }, { $set: { 'settings.node.ephemeralKeysEnabled': true } })
    const { secret } = await mintNodeEnrollmentKey(orgId, adminId, { name: 'lane', maxUses: 1 })
    const results = await Promise.allSettled([1, 2, 3].map(() => enrollNode({ ...nodeEnrollBody(makeNodeStub(), ENROLL), enrollmentKey: secret } as any, [ENROLL])))
    expect(results.filter(r => r.status === 'fulfilled').length).toBe(1)
    expect((await NodeEnrollmentKey.findOne({ orgId }).lean() as any).uses).toBe(1)
  })

  it('a shop\'s master stays permanent when a lane\'s key adds an org to it', async () => {
    const shop = await registered()
    const lane = await anOrg()
    await Org.updateOne({ _id: lane.orgId }, { $set: { 'settings.node.ephemeralKeysEnabled': true } })
    const { secret } = await mintNodeEnrollmentKey(lane.orgId, lane.adminId, { name: 'lane' })
    await enrollNode({ ...nodeEnrollBody(shop.stub, ENROLL), enrollmentKey: secret } as any, [ENROLL])
    expect((await ServerNode.findById(shop.stub.nodeId).lean() as any).ephemeral).toBe(false)
  })

  it('reaps ephemeral masters silent for 24 h, and never a permanent one', async () => {
    const { orgId, adminId } = await anOrg()
    await Org.updateOne({ _id: orgId }, { $set: { 'settings.node.ephemeralKeysEnabled': true } })
    const { secret } = await mintNodeEnrollmentKey(orgId, adminId, { name: 'lane' })
    const quiet = makeNodeStub()
    const recent = makeNodeStub()
    for (const s of [quiet, recent]) await enrollNode({ ...nodeEnrollBody(s, ENROLL), enrollmentKey: secret } as any, [ENROLL])
    const shop = await registered()
    await ServerNode.updateMany({ _id: { $in: [quiet.nodeId, shop.stub.nodeId] } }, { $set: { lastSeenAt: new Date(Date.now() - 365 * 24 * 3600_000) } })
    await ServerNode.updateOne({ _id: recent.nodeId }, { $set: { lastSeenAt: new Date(Date.now() - 23 * 3600_000) } })

    expect(await reapEphemeralNodes()).toBe(1)
    expect(await ServerNode.findById(quiet.nodeId)).toBeNull()
    expect(await ServerNode.findById(recent.nodeId)).not.toBeNull()
    expect(await ServerNode.findById(shop.stub.nodeId)).not.toBeNull()
  })
})

describe('over HTTP', () => {
  it('a master registers and authenticates end to end, and the node routes deny by default', async () => {
    const o = await anOrg()
    const { code } = await mintNodeEnrollmentCode(o.orgId, o.adminId)
    const stub = makeNodeStub()
    const reg = await call('/api/node/v1/enroll', json('POST', { ...nodeEnrollBody(stub, 'http://localhost/api/node/v1/enroll'), code }))
    expect(reg.status).toBe(200)
    expect((await reg.json()).nodeId).toBe(stub.nodeId)
    const tok = await call('/api/node/v1/token', json('POST', { assertion: stub.assertion({ sub: stub.nodeId, audience: 'http://localhost/api/node/v1/token' }) }))
    expect(tok.status).toBe(200)
    const { accessToken } = await tok.json()

    expect((await call('/api/node/v1/self')).status).toBe(401)
    expect((await call('/api/node/v1/self', { headers: { authorization: `Bearer ${await userToken(o.admin, o.orgId)}` } })).status).toBe(401)
    const self = await call('/api/node/v1/self', { headers: { authorization: `Bearer ${accessToken}` } })
    expect(self.status).toBe(200)
    expect((await self.json()).orgs.map((x: any) => x.slug)).toEqual([o.slug])

    // A shop's master cannot unregister itself.
    const del = await call('/api/node/v1/self', { method: 'DELETE', headers: { authorization: `Bearer ${accessToken}` } })
    expect({ status: del.status, code: (await del.json()).code }).toEqual({ status: 403, code: 'not_ephemeral' })
  })

  it('the Servers page: admins only, their org only, and never the key', async () => {
    const a = await registered()
    const b = await registered()
    const member = await createTestUser(a.orgId, { role: 'member', permissions: ['invoicing.read'] } as any)
    const adminA = await userToken(a.admin, a.orgId)

    expect((await call(`/api/org/${a.orgId}/nodes`, { headers: { authorization: `Bearer ${await userToken(member, a.orgId)}` } })).status).toBe(403)
    expect((await call(`/api/org/${b.orgId}/nodes`, { headers: { authorization: `Bearer ${adminA}` } })).status).toBe(403)

    const list = await (await call(`/api/org/${a.orgId}/nodes`, { headers: { authorization: `Bearer ${adminA}` } })).json()
    expect(list.nodes.map((n: any) => n.id)).toEqual([a.stub.nodeId])
    expect(Object.keys(list.nodes[0])).not.toContain('publicKey')
    expect(Object.keys(list.nodes[0])).not.toContain('installationId')
    expect((await call(`/api/org/${a.orgId}/nodes/${b.stub.nodeId}`, { headers: { authorization: `Bearer ${adminA}` } })).status).toBe(404)
    expect((await call(`/api/org/${a.orgId}/nodes/${b.stub.nodeId}/revoke`, json('POST', {}, adminA))).status).toBe(404)

    const minted = await (await call(`/api/org/${a.orgId}/nodes/enrollment-codes`, json('POST', {}, adminA))).json()
    expect(minted.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    const state = async () => (await (await call(`/api/org/${a.orgId}/nodes/enrollment-codes/${minted.id}`, { headers: { authorization: `Bearer ${adminA}` } })).json()).state
    expect(await state()).toBe('unused')
    await enrollNode({ ...nodeEnrollBody(makeNodeStub(), ENROLL), code: minted.code } as any, [ENROLL])
    expect(await state()).toBe('used')
  })

  it('an org whose home is a master can still revoke it, and register another', async () => {
    const a = await registered()
    await OrgHome.create({ orgId: a.orgId, home: a.stub.nodeId, epoch: 1 })
    await Org.updateOne({ _id: a.orgId }, { $set: { homeEpochHighWater: 1 } })
    forgetAllHomes()
    const adminA = await userToken(a.admin, a.orgId)
    const minted = await call(`/api/org/${a.orgId}/nodes/enrollment-codes`, json('POST', {}, adminA))
    expect(minted.status).toBe(200)
    const revoked = await call(`/api/org/${a.orgId}/nodes/${a.stub.nodeId}/revoke`, json('POST', { reason: 'lost' }, adminA))
    expect({ status: revoked.status, outcome: (await revoked.json()).outcome }).toEqual({ status: 200, outcome: 'revoked' })
  })

  it('exists on global only: every node route is 404 on a master', async () => {
    const a = await registered()
    const adminA = await userToken(a.admin, a.orgId)
    ;(config.node as any).role = 'master'
    expect((await call('/api/node/v1/enroll', json('POST', { ...nodeEnrollBody(makeNodeStub(), ENROLL), code: 'AAAA-AAAA' }))).status).toBe(404)
    expect((await call('/api/node/v1/self')).status).toBe(404)
    expect((await call(`/api/org/${a.orgId}/nodes`, { headers: { authorization: `Bearer ${adminA}` } })).status).toBe(404)
  })

  it('every global-state write is a mounted route', () => {
    const mounted = new Set(((createApiApp() as any).routes as Array<{ method: string; path: string }>).map(r => `${r.method} ${r.path}`))
    expect([...GLOBAL_STATE_WRITES].filter(k => !mounted.has(k))).toEqual([])
  })
})

