import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { config } from 'config'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../api/src/api.js'
import { makeNodeStub, nodeEnrollBody, type NodeStub } from '../helpers/node-stub'
import { NodeTraffic, ServerNode } from 'db/models'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { flushTraffic, nodeRouteName, pendingTraffic, trafficKind } from 'services/biz/node/node-traffic'
import { CLOSE, handleUplinkClose, handleUplinkMessage, handleUplinkOpen, tickConn } from '../../../api/src/websocket/uplink'

/**
 * What a master sent lgrai.app (FR-20.54, AC 26): global's record of each master's traffic, per day,
 * link level, channel and kind of message, with what each kind carries. And the level itself, re-read
 * with the node's row: a master registered again at Control stops paging and carries no remote user.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'
const saved = { role: config.node.role, sysAdmins: config.backup.sysAdmins }
const open: any[] = []

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => {
  for (const ws of open.splice(0)) await handleUplinkClose(ws)
  await flushTraffic().catch(() => 0)
  ;(config.node as any).role = saved.role
  ;(config.backup as any).sysAdmins = saved.sysAdmins
  await clearCollections()
})

function fakeWs() {
  const sent: any[] = []
  const closed: Array<{ code?: number; reason?: string }> = []
  const ws = {
    raw: { id: Math.random() },
    send: (s: string) => { sent.push(JSON.parse(s)) },
    close: (code?: number, reason?: string) => { closed.push({ code, reason }) },
    sent,
    closed,
  }
  open.push(ws)
  return ws
}

async function aNode(level: 'control' | 'full' = 'control', stub: NodeStub = makeNodeStub()) {
  ;(config.node as any).role = 'global'
  const org = await createTestOrg()
  const admin = await createTestUser(org._id, { role: 'admin', email: `admin-${stub.nodeId.slice(-6)}@a.test` } as any)
  const { code } = await mintNodeEnrollmentCode(String(org._id), String(admin._id))
  await enrollNode({ ...nodeEnrollBody(stub, ENROLL, { linkLevel: level }), code } as any, [ENROLL])
  const token = async () => (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN }), [TOKEN])).token
  return { stub, nodeId: stub.nodeId, org, orgId: String(org._id), admin, token }
}

async function connected(token: string, ch: 'interactive' | 'bulk') {
  const ws = fakeWs()
  handleUplinkOpen(ws, ch)
  await handleUplinkMessage(ws, JSON.stringify({ t: 'hello', v: 1, ch, token, bootNonce: `boot-${ch}-aaaa`, versions: { app: '0.1.0', protocol: 1 } }))
  expect(ws.sent[0]?.t).toBe('welcome')
  return ws
}

/** The node's record as `level|channel|kind|carries|n`, sorted. */
async function recordOf(nodeId: string): Promise<string[]> {
  await flushTraffic()
  const rows = await NodeTraffic.find({ nodeId }).lean()
  return rows.map((r: any) => `${r.level}|${r.channel}|${r.kind}|${r.carries}|${r.n}`).sort()
}

const jwt = async () => ((new Elysia().use((await import('@elysiajs/jwt')).default({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt)
const bearer = async (user: any, orgId: string) => (await jwt()).sign({ id: String(user._id), email: user.email, username: user.username, role: user.role, orgId, permissions: [] })
const call = (app: any, method: string, path: string, token?: string, body?: unknown) => app.handle(new Request(`http://localhost${path}`, {
  method,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined,
}))

describe('what a master sent, by channel and kind (AC 26)', () => {
  it('every frame after hello is counted at the level global holds, with what its kind carries', async () => {
    const n = await aNode('control')
    const inter = await connected(await n.token(), 'interactive')
    const bulk = await connected(await n.token(), 'bulk')
    await handleUplinkMessage(inter, JSON.stringify({ t: 'ping', n: 1 }))
    await handleUplinkMessage(inter, JSON.stringify({ t: 'ping', n: 2 }))
    await handleUplinkMessage(inter, { t: 'health', versions: { app: '0.1.0' } })
    await handleUplinkMessage(bulk, JSON.stringify({ t: 'ping', n: 1 }))
    // A mirror page at Control is refused, and was still sent: it is counted.
    await handleUplinkMessage(bulk, new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3, 4]))
    expect(bulk.sent.some(m => m.t === 'page-refused')).toBe(true)
    // A frame type not on the list, a prototype key among them, is `other` and carries `unknown`.
    await handleUplinkMessage(inter, JSON.stringify({ t: 'mystery' }))
    await handleUplinkMessage(inter, JSON.stringify({ t: 'constructor' }))
    expect(await recordOf(n.nodeId)).toEqual([
      'control|bulk|hello|control|1',
      'control|bulk|page|mirror|1',
      'control|bulk|ping|control|1',
      'control|interactive|health|control|1',
      'control|interactive|hello|control|1',
      'control|interactive|other|unknown|2',
      'control|interactive|ping|control|2',
    ])
    const page: any = await NodeTraffic.findOne({ nodeId: n.nodeId, kind: 'page' }).lean()
    expect(page.bytes).toBe(8)
    expect(page.day).toBe(new Date().toISOString().slice(0, 10))
  })

  it('nothing is counted before a master says who it is', async () => {
    const n = await aNode('control')
    const ws = fakeWs()
    handleUplinkOpen(ws, 'interactive')
    await handleUplinkMessage(ws, JSON.stringify({ t: 'ping' }))
    expect(ws.closed[0]?.code).toBe(CLOSE.unauthenticated)
    const bad = fakeWs()
    handleUplinkOpen(bad, 'interactive')
    await handleUplinkMessage(bad, JSON.stringify({ t: 'hello', v: 1, ch: 'interactive', token: 'not.a.token', bootNonce: 'boot-bbbbbbbb' }))
    expect(bad.closed[0]?.code).toBe(CLOSE.unauthenticated)
    expect(pendingTraffic()).toBe(0)
    expect(await recordOf(n.nodeId)).toEqual([])
  })

  it('a request to the node API is counted by its route, whatever it was answered; without a node token it is not', async () => {
    const n = await aNode('control')
    const app = new Elysia().use(createApiApp())
    const token = await n.token()
    expect((await call(app, 'GET', '/api/node/v1/self', token)).status).toBe(200)
    // The mail relay is off by default at Control: refused, and counted as the mail it carried.
    const mail = { outboxId: 'mail:1', orgId: n.orgId, to: 'customer@buyer.test', subject: 'Invoice 1', html: '<p>Hi</p>' }
    expect((await call(app, 'POST', '/api/node/v1/relay/mail', token, mail)).status).toBe(403)
    // A body the route does not take is refused before its handler, and still counted.
    expect((await call(app, 'POST', '/api/node/v1/relay/mail', token, { orgId: n.orgId })).status).toBe(422)
    expect((await call(app, 'GET', '/api/node/v1/self')).status).toBe(401)
    const record = await recordOf(n.nodeId)
    expect(record).toEqual(['control|http|GET /self|control|1', 'control|http|POST /relay/mail|mail|2'])
    const relayed: any = await NodeTraffic.findOne({ nodeId: n.nodeId, kind: 'POST /relay/mail' }).lean()
    expect(relayed.bytes).toBeGreaterThan(JSON.stringify(mail).length)
  })

  it('the sys-admin reads it; nobody else does', async () => {
    const n = await aNode('control')
    const inter = await connected(await n.token(), 'interactive')
    await handleUplinkMessage(inter, JSON.stringify({ t: 'ping', n: 1 }))
    const app = new Elysia().use(createApiApp())
    const path = `/api/admin/nodes/${n.nodeId}/traffic`
    const admin = await bearer(n.admin, n.orgId)
    expect((await call(app, 'GET', path)).status).toBe(401)
    ;(config.backup as any).sysAdmins = []
    expect((await call(app, 'GET', path, admin)).status).toBe(403)
    ;(config.backup as any).sysAdmins = [n.admin.email]
    const r = await call(app, 'GET', `${path}?day=${new Date().toISOString().slice(0, 10)}`, admin)
    expect(r.status).toBe(200)
    const body: any = await r.json()
    expect(body.rows.map((x: any) => `${x.channel}|${x.kind}|${x.carries}|${x.n}`).sort()).toEqual(['interactive|hello|control|1', 'interactive|ping|control|1'])
    expect(body.rows.every((x: any) => x.level === 'control' && !('nodeId' in x))).toBe(true)
    expect((await call(app, 'GET', `${path}?day=yesterday`, admin)).status).toBe(422)
    const week: any = await (await call(app, 'GET', `${path}?days=7`, admin)).json()
    expect(week.rows).toHaveLength(2)
  })

  it('a kind is named from the closed list only', () => {
    expect(trafficKind('interactive', 'ping')).toEqual({ kind: 'ping', carries: 'control' })
    expect(trafficKind('bulk', 'page')).toEqual({ kind: 'page', carries: 'mirror' })
    expect(trafficKind('interactive', 'tun-head')).toEqual({ kind: 'tun-head', carries: 'tunnel' })
    expect(trafficKind('interactive', 'POST /relay/mail')).toEqual({ kind: 'other', carries: 'unknown' })
    expect(trafficKind('http', 'POST /relay/mail')).toEqual({ kind: 'POST /relay/mail', carries: 'mail' })
    expect(trafficKind('http', 'POST /relay/documents')).toEqual({ kind: 'POST /relay/documents', carries: 'documents' })
    expect(trafficKind('http', 'POST /moves/:id/copied')).toEqual({ kind: 'POST /moves/:id/copied', carries: 'move' })
    expect(trafficKind('http', 'GET /reconcile/ids')).toEqual({ kind: 'GET /reconcile/ids', carries: 'mirror' })
    expect(trafficKind('http', 'POST /new-thing')).toEqual({ kind: 'other', carries: 'unknown' })
    expect(trafficKind('http', 'toString')).toEqual({ kind: 'other', carries: 'unknown' })
    expect(nodeRouteName('post', '/api/node/v1/relay/mail')).toBe('POST /relay/mail')
    expect(nodeRouteName('GET', '/api/node/v1/moves/:id/:part')).toBe('GET /moves/:id/:part')
  })
})

describe('the link level is re-read with the row (FR-20.54)', () => {
  it('registered again at Control: the bulk socket is welcomed again, and the record keeps the two levels apart', async () => {
    const n = await aNode('full')
    const inter = await connected(await n.token(), 'interactive')
    const bulk = await connected(await n.token(), 'bulk')
    expect(bulk.sent[0].orgs[0].linkLevel).toBe('full')
    await handleUplinkMessage(inter, JSON.stringify({ t: 'ping', n: 1 }))
    const { code } = await mintNodeEnrollmentCode(n.orgId, String(n.admin._id))
    const app = new Elysia().use(createApiApp())
    const audience = 'http://localhost/api/node/v1/enroll'
    const r = await call(app, 'POST', '/api/node/v1/enroll', undefined, { ...nodeEnrollBody(n.stub, audience, { linkLevel: 'control' }), code })
    expect(r.status).toBe(200)
    expect((await r.json() as any).linkLevel).toBe('control')
    expect(bulk.closed).toEqual([{ code: CLOSE.homeChanged, reason: 'level_changed' }])
    expect(inter.closed).toEqual([])
    await handleUplinkMessage(inter, JSON.stringify({ t: 'ping', n: 2 }))
    expect((await recordOf(n.nodeId)).filter(x => x.includes('|ping|'))).toEqual([
      'control|interactive|ping|control|1',
      'full|interactive|ping|control|1',
    ])
    // Welcomed again, the bulk socket hears the new level: the pump pages nothing at Control.
    const again = await connected(await n.token(), 'bulk')
    expect(again.sent[0].orgs[0].linkLevel).toBe('control')
  })

  it('a level changed on another pod is taken on the next tick', async () => {
    const n = await aNode('full')
    const bulk = await connected(await n.token(), 'bulk')
    const inter = await connected(await n.token(), 'interactive')
    await ServerNode.updateOne({ _id: n.nodeId }, { $set: { linkLevel: 'control' } })
    await tickConn(bulk)
    await tickConn(inter)
    expect(bulk.closed).toEqual([{ code: CLOSE.homeChanged, reason: 'level_changed' }])
    expect(inter.closed).toEqual([])
    // Nothing changes when nothing changed.
    const steady = await connected(await n.token(), 'bulk')
    await tickConn(steady)
    expect(steady.closed).toEqual([])
  })
})
