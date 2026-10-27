import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { makeNodeStub, nodeEnrollBody } from '../helpers/node-stub'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import { OrgHome, OrgMove, ServerNode } from 'db/models'
import { forgetAllHomes } from 'db/home/home'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { homeStatus } from 'services/biz/home/home-status.service'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { handleUplinkClose, handleUplinkMessage, handleUplinkOpen } from '../../../portal-api/src/websocket/uplink'

/**
 * Where an org lives, as every member reads it for the read-only banner (FR-20.75, plan step P3-5).
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'
const saved = { role: config.node.role, id: (config.node as any).id }
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const sockets: any[] = []
let app: any
let n = 0

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp())
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

afterEach(async () => {
  for (const ws of sockets.splice(0)) await handleUplinkClose(ws)
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  forgetAllHomes()
  await clearCollections()
}, 60_000)

const db = () => mongoose.connection.db as any

async function bearerFor(user: any, orgId: unknown, role = 'member') {
  return (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId: String(orgId), role, email: user.email, username: user.username,
    firstName: 'A', lastName: 'B', permissions: DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS], ownRecordsModules: [],
  })
}

/** An org on lgrai.app, with a member; homed on a master when `master` is set. */
async function shop(opts: { master?: boolean; connected?: boolean } = {}) {
  ;(config.node as any).role = 'global'
  const org = await createTestOrg({ slug: `home-status-${++n}` } as any)
  const admin = await createTestUser(org._id, { role: 'admin' } as any)
  const member = await createTestUser(org._id, { role: 'member' } as any)
  let nodeId = ''
  if (opts.master) {
    const stub = makeNodeStub()
    nodeId = stub.nodeId
    const { code } = await mintNodeEnrollmentCode(String(org._id), String(admin._id))
    await enrollNode({ ...nodeEnrollBody(stub, ENROLL, { linkLevel: 'full', name: 'Kasa server' }), code } as any, [ENROLL])
    await ServerNode.updateOne({ _id: nodeId }, { $set: { lastSeenAt: new Date('2026-10-27T10:00:00Z') } })
    if (opts.connected) {
      const token = (await issueNodeToken(stub.assertion({ sub: nodeId, audience: TOKEN }), [TOKEN])).token
      for (const ch of ['interactive', 'bulk'] as const) {
        const ws = { raw: { id: Math.random() }, send: () => {}, close: () => {} }
        handleUplinkOpen(ws, ch)
        await handleUplinkMessage(ws, JSON.stringify({ t: 'hello', v: 1, ch, token, bootNonce: 'boot-home', versions: { app: '0.1.0', protocol: 1 } }))
        sockets.push(ws)
      }
    }
    await OrgHome.collection.insertOne({ orgId: org._id, home: nodeId, epoch: 1, state: 'active', since: new Date() } as any)
    await db().collection('orgs').updateOne({ _id: org._id }, { $set: { homeEpochHighWater: 1 } })
    await db().collection('mirror_state').insertOne({ orgId: org._id, nodeId, watermark: 9, chainHash: 'c'.repeat(64), lastPageAt: new Date('2026-10-27T09:59:00Z'), refused: 0, alarms: [] })
    forgetAllHomes()
  }
  return { orgId: String(org._id), oid: org._id as any, admin, member, nodeId, bearer: await bearerFor(member, org._id) }
}

const get = (bearer: string | null, orgId: string) => app.handle(new Request(`http://localhost/api/org/${orgId}/home`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} })) as Promise<Response>

describe('where an org lives (FR-20.75)', () => {
  it('written here: nothing to say', async () => {
    const s = await shop()
    expect(await homeStatus(s.orgId)).toEqual({ home: 'here', state: 'active', epoch: 0, moving: false })
  }, 60_000)

  it('on lgrai.app, homed on its server: which one, connected or since when not, and as of when the copy holds', async () => {
    const on = await shop({ master: true, connected: true })
    expect(await homeStatus(on.orgId)).toEqual({
      home: 'master', state: 'active', epoch: 1, moving: false,
      server: { id: on.nodeId, name: 'Kasa server' }, online: true, since: null, asOf: '2026-10-27T09:59:00.000Z',
    })
    const off = await shop({ master: true })
    expect(await homeStatus(off.orgId)).toMatchObject({ home: 'master', online: false, since: '2026-10-27T10:00:00.000Z', asOf: '2026-10-27T09:59:00.000Z' })
    // A move under way freezes it wherever it lives.
    await OrgMove.collection.insertOne({ orgId: off.oid, kind: 'to_global', state: 'freezing', from: off.nodeId, to: 'global', epochFrom: 1, epochTo: 2, startedBy: off.admin._id, startedAt: new Date(), steps: [], allowMissing: [] } as any)
    expect(await homeStatus(off.orgId)).toMatchObject({ moving: true })
  }, 60_000)

  it('on a master, for an org that went back to lgrai.app: the read-only copy it keeps', async () => {
    const s = await shop()
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = makeNodeStub().nodeId
    await OrgHome.collection.insertOne({ orgId: s.oid, home: 'global', epoch: 2, state: 'active', since: new Date('2026-10-27T11:00:00Z') } as any)
    forgetAllHomes()
    expect(await homeStatus(s.orgId)).toEqual({ home: 'global', state: 'active', epoch: 2, moving: false, since: '2026-10-27T11:00:00.000Z' })
  }, 60_000)

  it('any member reads it; nobody anonymous, and nobody of another org', async () => {
    const s = await shop({ master: true })
    const r = await get(s.bearer, s.orgId)
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ home: 'master', server: { name: 'Kasa server' } })
    expect((await get(null, s.orgId)).status).toBe(401)
    const other = await shop()
    expect((await get(other.bearer, s.orgId)).status).toBe(403)
  }, 60_000)
})
