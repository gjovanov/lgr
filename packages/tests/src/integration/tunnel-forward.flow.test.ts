import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { config } from 'config'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { makeNodeStub, nodeEnrollBody } from '../helpers/node-stub'
import { NodePresence, Org, OrgAddress, OrgHome } from 'db/models'
import { forgetAllHomes } from 'db/home/home'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { decodeTunFrame } from 'services/biz/tunnel/tunnel-frame'
import { handleUplinkMessage, handleUplinkOpen } from '../../../portal-api/src/websocket/uplink'
import { forgetAddressRoutes, tunnelRouter } from '../../../portal-api/src/tunnel/router'
import { resetEdgeLimits } from '../../../portal-api/src/tunnel/edge'
import { hopHeaders, verifyHop } from '../../../portal-api/src/tunnel/hop'
import { holderOf } from '../../../portal-api/src/tunnel/forward'
import { podAddr } from '../../../portal-api/src/tunnel/pod'

/**
 * The tunnel across lgrai.app's pods (FR-20.73, plan step P3-4d): a request to an org's address that
 * lands on a pod other than the one holding the server's uplink is forwarded there, as a hop. Here
 * the router is "this pod", and "the other pod" is a real server that checks the hop and answers.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'
const saved = { role: config.node.role }
const route = tunnelRouter()
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

beforeAll(async () => {
  await setupTestDB()
}, 60_000)
afterAll(async () => {
  await teardownTestDB()
}, 60_000)
beforeEach(() => {
  ;(config.node as any).role = 'global'
  forgetAddressRoutes()
  resetEdgeLimits()
})
afterEach(async () => {
  ;(config.node as any).role = saved.role
  forgetAllHomes()
  await clearCollections()
}, 60_000)

/** An org homed on a registered server with an active address; its socket connected here only if asked. */
async function shop(label: string, opts: { connect?: boolean } = {}) {
  const org = await createTestOrg({ slug: label } as any)
  const admin = await createTestUser(org._id, { role: 'admin' } as any)
  const stub = makeNodeStub()
  const { code } = await mintNodeEnrollmentCode(String(org._id), String(admin._id))
  await enrollNode({ ...nodeEnrollBody(stub, ENROLL), code } as any, [ENROLL])
  const token = (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN }), [TOKEN])).token
  await OrgAddress.collection.insertOne({ label, orgId: org._id, state: 'active', requestedBy: 'u', requestedAt: new Date() } as any)
  await OrgHome.collection.insertOne({ orgId: org._id, home: stub.nodeId, epoch: 1, state: 'active', since: new Date() } as any)
  await Org.collection.updateOne({ _id: org._id }, { $set: { homeEpochHighWater: 1 } })
  forgetAllHomes()
  const json: any[] = []
  const bin: Uint8Array[] = []
  const ws = {
    raw: { id: Math.random(), sendBinary: (b: Uint8Array) => { bin.push(new Uint8Array(b)) } },
    send: (s: any) => { if (typeof s === 'string') json.push(JSON.parse(s)); else bin.push(new Uint8Array(s)) },
    close: () => {},
  }
  if (opts.connect) {
    handleUplinkOpen(ws, 'interactive')
    await handleUplinkMessage(ws, JSON.stringify({ t: 'hello', v: 1, ch: 'interactive', token, bootNonce: `boot-${Math.random().toString(36).slice(2, 10)}`, versions: { app: '0.1.0', protocol: 1 } }))
  }
  return { orgId: String(org._id), nodeId: stub.nodeId, ws, json, bin }
}

/** The uplink's presence row, as the pod holding the socket writes it. */
async function heldBy(nodeId: string, addr: string | undefined, over: Record<string, unknown> = {}) {
  await NodePresence.collection.insertOne({ nodeId, channel: 'interactive', connId: `c-${Math.random()}`, bootNonce: 'b', podId: 'pod-b', connectedAt: new Date(), heartbeatAt: new Date(), ...(addr ? { podAddr: addr } : {}), ...over } as any)
}

/** "The other pod": a real server that records each request, checks its hop, and answers. */
function otherPod() {
  const seen: Array<{ method: string; path: string; headers: Record<string, string>; hop: { clientIp: string | null } | null; body: Buffer }> = []
  const download = randomBytes(600_000)
  const gz = gzipSync(Buffer.from('a compressed answer, '.repeat(2000)))
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, srv) {
      const url = new URL(request.url)
      const headers = Object.fromEntries(request.headers as any) as Record<string, string>
      const hop = verifyHop(request)
      if (url.pathname === '/ws/echo') {
        seen.push({ method: request.method, path: url.pathname, headers, hop, body: Buffer.alloc(0) })
        if (srv.upgrade(request, { data: {} })) return undefined as any
        return new Response('no upgrade', { status: 400 })
      }
      const body = Buffer.from(await request.arrayBuffer())
      seen.push({ method: request.method, path: url.pathname + url.search, headers, hop, body })
      if (url.pathname === '/download') return new Response(download, { headers: { 'content-type': 'application/octet-stream' } })
      if (url.pathname === '/gz') return new Response(gz, { headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' } })
      if (url.pathname === '/away') return new Response(null, { status: 302, headers: { location: '/elsewhere' } })
      const h = new Headers({ 'content-type': 'application/json', 'x-from': 'pod-b' })
      h.append('set-cookie', '__Host-a=1; Path=/; Secure')
      h.append('set-cookie', '__Host-b=2; Path=/; Secure')
      return new Response(JSON.stringify({ bytes: body.length, sha256: sha(body) }), { status: 201, headers: h })
    },
    websocket: {
      message(ws, m) { ws.send(typeof m === 'string' ? `echo:${m}` : m) },
    },
  })
  return { server, seen, download, gz, addr: `http://127.0.0.1:${server.port}` }
}

const req = (url: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(url, { ...init, headers: { host: new URL(url).host, ...(init.headers ?? {}) } })
const call = (r: Request, server: any = null) => route({ request: r, server }) as Promise<Response | undefined>
const until = async <T>(f: () => T | undefined | null | false, ms = 5000): Promise<T> => {
  const end = Date.now() + ms
  for (;;) {
    const v = f()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(5)
  }
}

describe('the hop between two pods (FR-20.73, P3-4d)', () => {
  it('is signed over the time, the method, the Host, the path and the browser\'s address; nothing else verifies', () => {
    const at = (path: string, headers: Record<string, string>, method = 'POST', host = 'shop-a.lgrai.app') =>
      new Request(`http://${host}${path}`, { method, headers: { host, ...headers } })
    const h = hopHeaders('POST', 'shop-a.lgrai.app', '/api/x?y=1', '203.0.113.7')
    expect(verifyHop(at('/api/x?y=1', h))).toEqual({ clientIp: '203.0.113.7' })
    expect(verifyHop(at('/api/x?y=2', h))).toBeNull()
    expect(verifyHop(at('/api/x?y=1', h, 'PUT'))).toBeNull()
    expect(verifyHop(at('/api/x?y=1', h, 'POST', 'shop-b.lgrai.app'))).toBeNull()
    expect(verifyHop(at('/api/x?y=1', { ...h, 'x-lgr-hop-client': '6.6.6.6' }))).toBeNull()
    expect(verifyHop(at('/api/x?y=1', h), Date.now() + 31_000)).toBeNull()
    expect(verifyHop(at('/api/x?y=1', { ...h, 'x-lgr-hop': `${Math.floor(Date.now() / 1000)}.${'A'.repeat(43)}` }))).toBeNull()
    expect(verifyHop(at('/api/x?y=1', { 'x-lgr-hop': 'nonsense' }))).toBeNull()
    expect(verifyHop(at('/api/x?y=1', {}))).toBeNull()
    expect(verifyHop(at('/', hopHeaders('GET', 'shop-a.lgrai.app', '/', null), 'GET'))).toEqual({ clientIp: null })
  })

  it('the pod that holds a socket: a fresh presence row naming another pod; never this pod, a stale row, a clone or no address', async () => {
    await heldBy('master-aaaaaaaaaaaaaaaa', 'http://10.244.4.9:4001')
    expect(await holderOf('master-aaaaaaaaaaaaaaaa')).toBe('http://10.244.4.9:4001')
    await heldBy('master-bbbbbbbbbbbbbbbb', podAddr() ?? 'http://127.0.0.1:1')
    expect(await holderOf('master-bbbbbbbbbbbbbbbb')).toBe(podAddr() ? null : 'http://127.0.0.1:1')
    await heldBy('master-cccccccccccccccc', 'http://10.244.4.9:4001', { heartbeatAt: new Date(Date.now() - 80_000) })
    expect(await holderOf('master-cccccccccccccccc')).toBeNull()
    await heldBy('master-dddddddddddddddd', 'http://10.244.4.9:4001', { clone: { bootNonce: 'x', at: new Date() } })
    expect(await holderOf('master-dddddddddddddddd')).toBeNull()
    await heldBy('master-eeeeeeeeeeeeeeee', undefined)
    expect(await holderOf('master-eeeeeeeeeeeeeeee')).toBeNull()
    await NodePresence.collection.insertOne({ nodeId: 'master-ffffffffffffffff', channel: 'bulk', connId: 'c', bootNonce: 'b', podId: 'p', connectedAt: new Date(), heartbeatAt: new Date(), podAddr: 'http://10.244.4.9:4001' } as any)
    expect(await holderOf('master-ffffffffffffffff')).toBeNull()
  })
})

describe('a request that lands on the other pod (FR-20.73, P3-4d)', () => {
  it('is forwarded to the pod holding the socket, as a hop with the browser\'s address, and answered from there', async () => {
    const b = otherPod()
    try {
      const s = await shop('fwd-shop')
      await heldBy(s.nodeId, b.addr)
      const upload = randomBytes(600_000)
      const res = await call(req('https://fwd-shop.lgrai.app/api/things?x=1', {
        method: 'POST',
        body: upload,
        headers: { authorization: 'Bearer a-masters-session', 'x-real-ip': '198.51.100.4', 'x-lgr-hop': 'forged.by-the-browser', 'x-lgr-hop-client': '6.6.6.6', 'content-type': 'application/octet-stream' },
      }))
      expect([res!.status, res!.headers.get('x-from'), res!.headers.getSetCookie()]).toEqual([201, 'pod-b', ['__Host-a=1; Path=/; Secure', '__Host-b=2; Path=/; Secure']])
      expect(await res!.json()).toEqual({ bytes: upload.length, sha256: sha(upload) })
      const got = b.seen[0]
      expect([got.method, got.path, got.headers.host, got.headers.authorization, got.hop]).toEqual(['POST', '/api/things?x=1', 'fwd-shop.lgrai.app', 'Bearer a-masters-session', { clientIp: '198.51.100.4' }])

      // An answer passes as it is: compressed bytes stay compressed, a redirect stays a redirect.
      const gz = await call(req('https://fwd-shop.lgrai.app/gz', { headers: { authorization: 'Bearer x' } }))
      expect([gz!.headers.get('content-encoding'), sha(new Uint8Array(await gz!.arrayBuffer()))]).toEqual(['gzip', sha(b.gz)])
      const away = await call(req('https://fwd-shop.lgrai.app/away', { headers: { authorization: 'Bearer x' } }))
      expect([away!.status, away!.headers.get('location')]).toEqual([302, '/elsewhere'])
      const down = await call(req('https://fwd-shop.lgrai.app/download', { headers: { authorization: 'Bearer x' } }))
      expect(sha(new Uint8Array(await down!.arrayBuffer()))).toBe(sha(b.download))
      // The edge ran here, once: an anonymous API call never leaves this pod.
      const before = b.seen.length
      const anon = await call(req('https://fwd-shop.lgrai.app/api/things'))
      expect([anon!.status, b.seen.length]).toEqual([401, before])
    } finally {
      b.server.stop(true)
    }
  })

  it('the other pod gone: the notice answers', async () => {
    const s = await shop('fwd-gone')
    await heldBy(s.nodeId, 'http://127.0.0.1:1')
    const res = await call(req('https://fwd-gone.lgrai.app/', { headers: { accept: 'text/html' } }))
    expect(res!.status).toBe(503)
  })

  it('a WebSocket is accepted here and opened on the other pod, both ways', async () => {
    const b = otherPod()
    try {
      const s = await shop('fwd-ws')
      await heldBy(s.nodeId, b.addr)
      let data: any = null
      const server = { upgrade: (_r: Request, opts: any) => { data = opts.data; return true } }
      const sent: any[] = []
      const closed: any[] = []
      const browser = { send: (m: any) => sent.push(m), close: (code: number, reason: string) => closed.push({ code, reason }) }
      const r = await call(req('https://fwd-ws.lgrai.app/ws/echo', { headers: { upgrade: 'websocket', 'sec-websocket-key': 'k', 'x-real-ip': '198.51.100.9' } }), server)
      expect(r!.status).toBe(101)
      data.open(browser)
      // The browser's first message waits for the other side.
      data.message(browser, 'hello')
      await until(() => sent.length >= 1)
      data.message(browser, Buffer.from([1, 2, 3]))
      await until(() => sent.length >= 2)
      expect([sent[0], Array.from(sent[1] as Uint8Array)]).toEqual(['echo:hello', [1, 2, 3]])
      const up = b.seen.find(x => x.path === '/ws/echo')!
      expect([up.headers.host, up.hop]).toEqual(['fwd-ws.lgrai.app', { clientIp: '198.51.100.9' }])
      data.close(browser, 1000, 'done')
      expect(closed).toEqual([])
    } finally {
      b.server.stop(true)
    }
  })
})

describe('a hop that arrives here (FR-20.73, P3-4d)', () => {
  it('has passed the edge already, keeps the browser\'s address, and is never forwarded again', async () => {
    const s = await shop('hop-here', { connect: true })
    const path = '/api/things'
    const hop = hopHeaders('POST', 'hop-here.lgrai.app', path, '198.51.100.4')
    // Anonymous, yet through: the edge ran on the pod that forwarded it.
    const pending = call(req(`https://hop-here.lgrai.app${path}`, { method: 'POST', body: 'x', headers: { ...hop, 'x-real-ip': '10.244.0.7' } }))
    const open = await until(() => s.json.find(m => m.t === 'tun-open'))
    expect([open.path, open.client]).toEqual([path, { ip: '198.51.100.4' }])
    await until(() => s.bin.map(b => decodeTunFrame(b)).some(f => f?.sid === open.sid && f.end))
    await handleUplinkMessage(s.ws, JSON.stringify({ t: 'tun-head', sid: open.sid, status: 204, headers: [] }))
    expect((await pending)!.status).toBe(204)

    // Not connected here, and another pod named: a hop is not sent on again.
    const b = otherPod()
    try {
      const t = await shop('hop-away')
      await heldBy(t.nodeId, b.addr)
      const res = await call(req('https://hop-away.lgrai.app/', { headers: { ...hopHeaders('GET', 'hop-away.lgrai.app', '/', '198.51.100.4'), accept: 'text/html' } }))
      expect([res!.status, b.seen.length]).toEqual([503, 0])
      // A hop that does not verify is the client's own request: the edge applies.
      const forged = await call(req('https://hop-away.lgrai.app/api/things', { headers: { 'x-lgr-hop': `${Math.floor(Date.now() / 1000)}.${'A'.repeat(43)}`, 'x-lgr-hop-client': '1.2.3.4' } }))
      expect([forged!.status, b.seen.length]).toEqual([401, 0])
    } finally {
      b.server.stop(true)
    }
  })
})
