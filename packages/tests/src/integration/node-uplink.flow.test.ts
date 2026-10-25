import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { config } from 'config'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { makeNodeStub, nodeEnrollBody, type NodeStub } from '../helpers/node-stub'
import { NodePresence, OrgHome, ServerNode } from 'db/models'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode, revokeNodeForOrg } from 'services/biz/node/node.service'
import {
  CLOSE,
  DEAD_AFTER_MS,
  HELLO_DEADLINE_MS,
  UPLINK_PATH,
  handleUplinkClose,
  handleUplinkMessage,
  handleUplinkOpen,
  isTrusted,
  notifyNodeRevoked,
  setupUplinkWS,
  tickConn,
} from '../../../portal-api/src/websocket/uplink'

/**
 * The uplink, global's side (FR-20.52, plan step P2-2a).
 *
 * The properties: the URL carries no credential and nothing is heard before `hello`; the row is the
 * revocation list, re-read on every tick; one live connection per node and channel, the same
 * supervisor taking its own place back, and a second machine with the same id raising the clone
 * alarm on BOTH sockets and on the node.
 */

const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => {
  await clearCollections()
  ;(config.node as any).role = 'global'
})

function fakeWs() {
  const sent: any[] = []
  const closed: Array<{ code?: number; reason?: string }> = []
  return {
    raw: { id: Math.random() },
    send: (s: string) => { sent.push(JSON.parse(s)) },
    close: (code?: number, reason?: string) => { closed.push({ code, reason }) },
    sent,
    closed,
    last: (t: string) => [...sent].reverse().find(m => m.t === t),
    has: (t: string) => sent.some(m => m.t === t),
  }
}

async function aNode(stub: NodeStub = makeNodeStub()) {
  const org = await createTestOrg()
  const admin = await createTestUser(org._id, { role: 'admin' } as any)
  const { code } = await mintNodeEnrollmentCode(String(org._id), String(admin._id))
  await enrollNode({ ...nodeEnrollBody(stub, ENROLL), code } as any, [ENROLL])
  const token = async () => (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN }), [TOKEN])).token
  return { stub, orgId: String(org._id), adminId: String(admin._id), token }
}

const hello = (token: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ t: 'hello', v: 1, ch: 'interactive', token, bootNonce: 'boot-aaaaaaaa', versions: { app: '0.1.0', protocol: 1 }, ...extra })

async function connected(token: string, extra: Record<string, unknown> = {}) {
  const ws = fakeWs()
  handleUplinkOpen(ws, (extra.ch as string) ?? 'interactive')
  await handleUplinkMessage(ws, hello(token, extra))
  return ws
}

describe('nothing is heard before hello', () => {
  it('a wrong channel is refused at once', async () => {
    const ws = fakeWs()
    handleUplinkOpen(ws, 'everything')
    expect(ws.closed[0]?.code).toBe(CLOSE.badRequest)
    await handleUplinkClose(ws)
  })

  it('a first frame that is not hello closes the socket', async () => {
    const ws = fakeWs()
    handleUplinkOpen(ws, 'interactive')
    await handleUplinkMessage(ws, JSON.stringify({ t: 'ping' }))
    expect(ws.closed[0]?.code).toBe(CLOSE.unauthenticated)
    await handleUplinkClose(ws)
  })

  it('a token that is not a node token, or a malformed hello, is refused', async () => {
    const { token } = await aNode()
    const bad = fakeWs()
    handleUplinkOpen(bad, 'interactive')
    await handleUplinkMessage(bad, hello('not.a.token'))
    expect(bad.closed[0]?.code).toBe(CLOSE.unauthenticated)
    const wrongCh = fakeWs()
    handleUplinkOpen(wrongCh, 'bulk')
    await handleUplinkMessage(wrongCh, hello(await token()))
    expect(wrongCh.closed[0]?.code).toBe(CLOSE.badRequest)
    const noNonce = fakeWs()
    handleUplinkOpen(noNonce, 'interactive')
    await handleUplinkMessage(noNonce, hello(await token(), { bootNonce: 'x' }))
    expect(noNonce.closed[0]?.code).toBe(CLOSE.badRequest)
    for (const ws of [bad, wrongCh, noNonce]) await handleUplinkClose(ws)
  })

  it('a socket that says nothing for 10 s is closed', async () => {
    const ws = fakeWs()
    handleUplinkOpen(ws, 'interactive')
    await Bun.sleep(HELLO_DEADLINE_MS + 250)
    expect(ws.closed[0]?.code).toBe(CLOSE.unauthenticated)
    await handleUplinkClose(ws)
  }, HELLO_DEADLINE_MS + 5000)
})

describe('a registered master connects', () => {
  it('is welcomed with its orgs, their homes and its link level, and its presence is recorded', async () => {
    const { stub, orgId, token } = await aNode()
    await OrgHome.create({ orgId, home: 'global', epoch: 2 })
    const ws = await connected(await token())
    const welcome = ws.last('welcome')
    expect(welcome.suspended).toBe(false)
    expect(welcome.orgs).toEqual([{ orgId, home: 'global', homeEpoch: 2, state: 'active', linkLevel: 'control' }])
    expect(isTrusted(ws)).toBe(true)
    const row: any = await NodePresence.findOne({ nodeId: stub.nodeId, channel: 'interactive' }).lean()
    expect(row.bootNonce).toBe('boot-aaaaaaaa')

    const before = row.heartbeatAt.getTime()
    await Bun.sleep(20)
    await handleUplinkMessage(ws, JSON.stringify({ t: 'ping' }))
    expect(ws.has('pong')).toBe(true)
    expect(((await NodePresence.findOne({ nodeId: stub.nodeId }).lean()) as any).heartbeatAt.getTime()).toBeGreaterThan(before)

    // A clean close gives the row up.
    await handleUplinkClose(ws)
    expect(await NodePresence.countDocuments({ nodeId: stub.nodeId })).toBe(0)
  })

  it('the two channels are separate places', async () => {
    const { stub, token } = await aNode()
    const a = await connected(await token())
    const b = await connected(await token(), { ch: 'bulk' })
    expect([a.has('welcome'), b.has('welcome'), a.has('clone-alarm'), b.has('clone-alarm')]).toEqual([true, true, false, false])
    expect(await NodePresence.countDocuments({ nodeId: stub.nodeId })).toBe(2)
    for (const ws of [a, b]) await handleUplinkClose(ws)
  })
})

describe('one live connection per node and channel', () => {
  it('the same supervisor reconnecting takes its own place back (the old socket is closed 4409)', async () => {
    const { stub, token } = await aNode()
    const first = await connected(await token())
    const second = await connected(await token())
    expect(first.closed[0]?.code).toBe(CLOSE.replaced)
    expect(second.has('clone-alarm')).toBe(false)
    expect(isTrusted(second)).toBe(true)
    const row: any = await NodePresence.findOne({ nodeId: stub.nodeId }).lean()
    expect((await ServerNode.findById(stub.nodeId).lean() as any).cloneAlarm).toBeUndefined()
    await handleUplinkClose(first)
    // The old one closing does not take the newer one's row with it.
    expect(((await NodePresence.findOne({ nodeId: stub.nodeId }).lean()) as any).connId).toBe(row.connId)
    await handleUplinkClose(second)
  })

  it('another machine with the same id raises the clone alarm on both sockets and on the node', async () => {
    const { stub, token } = await aNode()
    const original = await connected(await token())
    const clone = await connected(await token(), { bootNonce: 'boot-bbbbbbbb' })
    expect(clone.has('clone-alarm')).toBe(true)
    expect(clone.last('welcome').suspended).toBe(true)
    expect(isTrusted(clone)).toBe(false)
    const node: any = await ServerNode.findById(stub.nodeId).lean()
    expect(node.cloneAlarm.bootNonces.sort()).toEqual(['boot-aaaaaaaa', 'boot-bbbbbbbb'])

    // The original hears it on its next tick (on another pod, the same way).
    expect(original.has('clone-alarm')).toBe(false)
    await tickConn(original)
    expect(original.has('clone-alarm')).toBe(true)
    expect(isTrusted(original)).toBe(false)

    // The alarm stands across reconnects, until an admin registers the node again.
    for (const ws of [original, clone]) await handleUplinkClose(ws)
    const back = await connected(await token())
    expect(back.has('clone-alarm')).toBe(true)
    await handleUplinkClose(back)
  })

  it('a holder silent for 75 s is dead, and another boot takes its place without an alarm', async () => {
    const { stub, token } = await aNode()
    const stale = await connected(await token())
    await NodePresence.updateOne({ nodeId: stub.nodeId }, { $set: { heartbeatAt: new Date(Date.now() - DEAD_AFTER_MS - 1000) } })
    const restarted = await connected(await token(), { bootNonce: 'boot-cccccccc' })
    expect(restarted.has('clone-alarm')).toBe(false)
    expect(isTrusted(restarted)).toBe(true)
    // The stale one, on its tick, finds the row held by another boot: it is suspended, not trusted.
    await tickConn(stale)
    expect(isTrusted(stale)).toBe(false)
    for (const ws of [stale, restarted]) await handleUplinkClose(ws)
  })
})

describe('the row is the revocation list', () => {
  it('a revoked node is closed 4403 on its next tick, and told at once by the revocation', async () => {
    const { stub, orgId, adminId, token } = await aNode()
    const ws = await connected(await token())
    await revokeNodeForOrg(orgId, stub.nodeId, adminId)
    expect(notifyNodeRevoked(stub.nodeId)).toBe(1)
    expect(ws.has('revoked')).toBe(true)
    expect(ws.closed[0]?.code).toBe(CLOSE.revoked)
    await handleUplinkClose(ws)

    // Another pod's socket learns it from the re-read.
    const again = await aNode()
    const other = await connected(await again.token())
    await revokeNodeForOrg(again.orgId, again.stub.nodeId, again.adminId)
    await tickConn(other)
    expect(other.closed[0]?.code).toBe(CLOSE.revoked)
    await handleUplinkClose(other)
  })

  it('a hello from a revoked node is closed 4403, not retried as unauthenticated', async () => {
    const { stub, orgId, adminId, token } = await aNode()
    const t = await token()
    await revokeNodeForOrg(orgId, stub.nodeId, adminId)
    const ws = await connected(t)
    expect(ws.closed[0]?.code).toBe(CLOSE.revoked)
    await handleUplinkClose(ws)
  })

  it('a socket silent for 75 s is closed 4408', async () => {
    const { token } = await aNode()
    const ws = await connected(await token())
    await tickConn(ws, Date.now() + DEAD_AFTER_MS + 1000)
    expect(ws.closed[0]?.code).toBe(CLOSE.timeout)
    await handleUplinkClose(ws)
  })
})

describe('over a real socket', () => {
  it('a master connects to the mounted route, is welcomed, and is refused without a hello', async () => {
    const { token } = await aNode()
    // Mounted as unified.ts mounts it: beside the whole API, whose /api tree must not swallow it.
    const app = new Elysia().use(createApiApp())
    setupUplinkWS(app)
    app.listen({ hostname: '127.0.0.1', port: 0 })
    const port = (app.server as any).port
    try {
      const frames: any[] = []
      const ws = new WebSocket(`ws://127.0.0.1:${port}${UPLINK_PATH}?ch=interactive`)
      ws.onmessage = e => frames.push(JSON.parse(String(e.data)))
      await new Promise<void>((ok, fail) => { ws.onopen = () => ok(); ws.onerror = () => fail(new Error('no socket')) })
      ws.send(hello(await token()))
      for (let i = 0; i < 50 && !frames.some(f => f.t === 'welcome'); i++) await Bun.sleep(20)
      expect(frames.find(f => f.t === 'welcome')?.orgs?.length).toBe(1)
      ws.send(JSON.stringify({ t: 'ping' }))
      for (let i = 0; i < 50 && !frames.some(f => f.t === 'pong'); i++) await Bun.sleep(20)
      expect(frames.some(f => f.t === 'pong')).toBe(true)
      ws.close()

      const anon = new WebSocket(`ws://127.0.0.1:${port}${UPLINK_PATH}?ch=interactive`)
      const code = await new Promise<number>(ok => {
        anon.onopen = () => anon.send(JSON.stringify({ t: 'ping' }))
        anon.onclose = e => ok(e.code)
      })
      expect(code).toBe(CLOSE.unauthenticated)
    } finally {
      app.stop(true)
    }
  })
})
