import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { config } from 'config'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { makeNodeStub, nodeEnrollBody } from '../helpers/node-stub'
import { Org, OrgAddress, OrgHome } from 'db/models'
import { forgetAllHomes } from 'db/home/home'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { TUN_KIND, TUN_WINDOW, decodeTunFrame, encodeTunFrame, stripCookieDomain } from 'services/biz/tunnel/tunnel-frame'
import { handleUplinkClose, handleUplinkMessage, handleUplinkOpen } from '../../../portal-api/src/websocket/uplink'
import { addressLabel, forgetAddressRoutes, tunnelRouter } from '../../../portal-api/src/tunnel/router'
import { ANON_PER_CLIENT, resetEdgeLimits } from '../../../portal-api/src/tunnel/edge'
import { openStreams, setTunnelIdleMs } from '../../../portal-api/src/tunnel/streams'

/**
 * The tunnel on lgrai.app (FR-20.72–20.74, FR-20.78, plan step P3-4b): a request to an org's address,
 * carried over its server's interactive uplink socket, as global sees it. The server here is a stand-in
 * answering through the same socket handler a real one reaches; the real supervisor's half is P3-4c.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'
const saved = { role: config.node.role }
const route = tunnelRouter()

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
  setTunnelIdleMs(120_000)
})
afterEach(async () => {
  ;(config.node as any).role = saved.role
  forgetAllHomes()
  await clearCollections()
}, 60_000)

/** A stand-in server's interactive socket: what global sends it, JSON and binary apart. */
function fakeNode() {
  const json: any[] = []
  const bin: Uint8Array[] = []
  const ws = {
    raw: { id: Math.random(), sendBinary: (b: Uint8Array) => { bin.push(new Uint8Array(b)) } },
    send: (s: any) => { if (typeof s === 'string') json.push(JSON.parse(s)); else bin.push(new Uint8Array(s)) },
    close: () => {},
  }
  return {
    ws,
    json,
    bin,
    opens: () => json.filter(m => m.t === 'tun-open'),
    frames: (sid: number) => bin.map(b => decodeTunFrame(b)!).filter(f => f && f.sid === sid),
    credits: (sid: number) => json.filter(m => m.t === 'tun-credit' && m.sid === sid).reduce((n, m) => n + m.bytes, 0),
    say: (msg: unknown) => handleUplinkMessage(ws, JSON.stringify(msg)),
    data: (sid: number, payload: string | Uint8Array, end = false, kind: number = TUN_KIND.body) =>
      handleUplinkMessage(ws, encodeTunFrame({ kind: kind as any, sid, end, payload: typeof payload === 'string' ? new TextEncoder().encode(payload) : payload })),
  }
}

const until = async <T>(f: () => T | undefined | null | false, ms = 5000): Promise<T> => {
  const end = Date.now() + ms
  for (;;) {
    const v = f()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(5)
  }
}

/** An org homed on a registered server with an active address, and the server connected. */
async function shop(label = 'shop-a', opts: { connect?: boolean; state?: string; noticeUntil?: Date; home?: 'node' | 'global' } = {}) {
  const org = await createTestOrg({ slug: label } as any)
  const admin = await createTestUser(org._id, { role: 'admin' } as any)
  const stub = makeNodeStub()
  const { code } = await mintNodeEnrollmentCode(String(org._id), String(admin._id))
  await enrollNode({ ...nodeEnrollBody(stub, ENROLL), code } as any, [ENROLL])
  const token = (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN }), [TOKEN])).token
  await OrgAddress.collection.insertOne({ label, orgId: org._id, state: opts.state ?? 'active', requestedBy: 'u', requestedAt: new Date(), ...(opts.noticeUntil ? { noticeUntil: opts.noticeUntil } : {}) } as any)
  if ((opts.home ?? 'node') === 'node') {
    await OrgHome.collection.insertOne({ orgId: org._id, home: stub.nodeId, epoch: 1, state: 'active', since: new Date() } as any)
    await Org.collection.updateOne({ _id: org._id }, { $set: { homeEpochHighWater: 1 } })
  }
  forgetAllHomes()
  const node = fakeNode()
  const connect = async (n = node) => {
    handleUplinkOpen(n.ws, 'interactive')
    await handleUplinkMessage(n.ws, JSON.stringify({ t: 'hello', v: 1, ch: 'interactive', token, bootNonce: `boot-${Math.random().toString(36).slice(2, 10)}`, versions: { app: '0.1.0', protocol: 1 } }))
  }
  if (opts.connect !== false) await connect()
  return { org, orgId: String(org._id), nodeId: stub.nodeId, node, connect }
}

const req = (url: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(url, { ...init, headers: { host: new URL(url).host, ...(init.headers ?? {}) } })
const call = (r: Request, server: any = null) => route({ request: r, server }) as Promise<Response | undefined>
const AUTH = { authorization: 'Bearer a-masters-session' }

describe('the address in the Host (FR-20.72)', () => {
  it('a label under the apex; lgrai.app\'s own names pass; a deeper name is no address', () => {
    expect(addressLabel('shop-a.lgrai.app')).toBe('shop-a')
    expect(addressLabel('Shop-A.LGRAI.app:443')).toBe('shop-a')
    expect(addressLabel('shop-a.lgrai.app.')).toBe('shop-a')
    expect(addressLabel('lgrai.app')).toBeNull()
    expect(addressLabel('www.lgrai.app')).toBeNull()
    expect(addressLabel('api.lgrai.app')).toBeNull()
    expect(addressLabel('localhost:4001')).toBeNull()
    expect(addressLabel('a.b.lgrai.app')).toBe('')
    expect(addressLabel('evil-lgrai.app')).toBeNull()
  })

  it('only an active address of an org homed on its registered server tunnels; the rest answer like nothing is there', async () => {
    expect(await call(req('https://nowhere.lgrai.app/'))).toMatchObject({ status: 404 })
    const json = await call(req('https://nowhere.lgrai.app/api/x', { headers: { accept: 'application/json' } }))
    expect([json!.status, (await json!.json()).code]).toEqual([404, 'address_unknown'])
    await shop('asked-only', { state: 'requested' })
    expect((await call(req('https://asked-only.lgrai.app/', { headers: AUTH })))!.status).toBe(404)
    await shop('lives-on-global', { home: 'global' })
    expect((await call(req('https://lives-on-global.lgrai.app/', { headers: AUTH })))!.status).toBe(404)
    await shop('retired-shop', { state: 'retired', noticeUntil: new Date(Date.now() + 86_400_000) })
    const retired = await call(req('https://retired-shop.lgrai.app/'))
    expect([retired!.status, await retired!.text()]).toEqual([410, expect.stringContaining('This address was retired')])
    await shop('long-gone', { state: 'retired', noticeUntil: new Date(Date.now() - 1000) })
    expect((await call(req('https://long-gone.lgrai.app/')))!.status).toBe(404)
    await shop('not-connected', { connect: false })
    const offline = await call(req('https://not-connected.lgrai.app/', { headers: AUTH }))
    expect([offline!.status, offline!.headers.get('retry-after'), await offline!.text()]).toEqual([503, '60', expect.stringContaining('not connected')])
    // On a master, and for lgrai.app's own hosts: nothing here.
    expect(await call(req('https://lgrai.app/api/health'))).toBeUndefined()
    ;(config.node as any).role = 'master'
    expect(await call(req('https://not-connected.lgrai.app/'))).toBeUndefined()
  })
})

describe('the edge (FR-20.78)', () => {
  it('without a credential only the static UI, "Sign in with LGR" and WebSockets go through; the rest is 401 here', async () => {
    const s = await shop()
    const refused = await call(req('https://shop-a.lgrai.app/api/invoices', { method: 'POST', body: '{}' }))
    expect([refused!.status, (await refused!.json()).code]).toEqual([401, 'unauthenticated'])
    expect((await call(req('https://shop-a.lgrai.app/api/invoices')))!.status).toBe(401)
    expect(s.node.opens()).toHaveLength(0)
    // The static UI, and the sign-in flow, reach the server.
    void call(req('https://shop-a.lgrai.app/settings'))
    void call(req('https://shop-a.lgrai.app/api/auth/idp/config'))
    void call(req('https://shop-a.lgrai.app/api/auth/idp/redeem', { method: 'POST', body: '{"code":"c"}' }))
    await until(() => s.node.opens().length === 3)
    expect(s.node.opens().map(o => `${o.method} ${o.path}`)).toEqual(['GET /settings', 'GET /api/auth/idp/config', 'POST /api/auth/idp/redeem'])
    // A `__Host-` cookie is a credential (the master validates it), an empty one is not.
    void call(req('https://shop-a.lgrai.app/api/me', { headers: { cookie: 'theme=dark; __Host-auth=tok' } }))
    await until(() => s.node.opens().length === 4)
    expect((await call(req('https://shop-a.lgrai.app/api/me', { headers: { cookie: '__Host-auth=' } })))!.status).toBe(401)
  })

  it('anonymous requests are limited per client', async () => {
    await shop('limited', { connect: false })
    const statuses: string[] = []
    for (let i = 0; i <= ANON_PER_CLIENT; i++) {
      const r = (await call(req('https://limited.lgrai.app/', { headers: { 'x-real-ip': '198.51.100.7' } })))!
      statuses.push(`${r.status}:${(await r.text()).includes('Too many requests') ? 'busy' : 'offline'}`)
    }
    expect(statuses.slice(0, ANON_PER_CLIENT).every(s => s === '503:offline')).toBe(true)
    expect(statuses[ANON_PER_CLIENT]).toBe('503:busy')
    // Another client still gets through.
    const other = (await call(req('https://limited.lgrai.app/', { headers: { 'x-real-ip': '198.51.100.8' } })))!
    expect(await other.text()).toContain('not connected')
  })
})

describe('a request through the tunnel (FR-20.73)', () => {
  it('reaches the server with the address as Host, no client X-LGR-* or forwarding headers, and the client\'s address', async () => {
    const s = await shop()
    const answer = call(req('https://shop-a.lgrai.app/api/things?x=1', {
      headers: { ...AUTH, 'x-lgr-source': 'lan', 'x-lgr-front': 'forged', 'x-forwarded-for': '10.0.0.1', 'x-real-ip': '203.0.113.9', connection: 'keep-alive, x-secret', 'x-secret': 'hop', accept: 'application/json' },
    }))
    const open = await until(() => s.node.opens()[0])
    expect(open).toMatchObject({ kind: 'http', method: 'GET', path: '/api/things?x=1', host: 'shop-a.lgrai.app', body: false, client: { ip: '203.0.113.9' } })
    const names = (open.headers as Array<[string, string]>).map(h => h[0])
    expect(names).toContain('authorization')
    expect(names).toContain('accept')
    for (const n of ['x-lgr-source', 'x-lgr-front', 'x-forwarded-for', 'x-real-ip', 'connection', 'x-secret', 'host']) expect(names).not.toContain(n)
    await s.node.say({ t: 'tun-head', sid: open.sid, status: 200, headers: [['content-type', 'application/json'], ['set-cookie', '__Host-auth=abc; Path=/; Domain=lgrai.app; Secure; HttpOnly'], ['connection', 'close']] })
    await s.node.data(open.sid, '{"ok":', false)
    await s.node.data(open.sid, 'true}', true)
    const res = (await answer)!
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBe('__Host-auth=abc; Path=/; Secure; HttpOnly')
    expect(res.headers.get('connection')).toBeNull()
    // None of lgrai.app's own headers: the response is the server's.
    expect(res.headers.get('cross-origin-resource-policy')).toBeNull()
    expect(await res.json()).toEqual({ ok: true })
    expect(openStreams(s.node.ws)).toBe(0)
    expect(stripCookieDomain('a=b; domain=.lgrai.app; Path=/')).toBe('a=b; Path=/')
  })

  it('a large upload waits for the server\'s credit; a large download is granted back as it is read', async () => {
    const s = await shop()
    const upload = new Uint8Array(600 * 1024).map((_, i) => i % 251)
    const answer = call(req('https://shop-a.lgrai.app/api/upload', { method: 'POST', body: upload, headers: AUTH }))
    const open = await until(() => s.node.opens()[0])
    expect(open.body).toBe(true)
    // The window, and no more, until the server grants.
    await until(() => s.node.frames(open.sid).reduce((n, f) => n + f.payload.length, 0) >= TUN_WINDOW)
    await Bun.sleep(50)
    expect(s.node.frames(open.sid).reduce((n, f) => n + f.payload.length, 0)).toBe(TUN_WINDOW)
    await s.node.say({ t: 'tun-credit', sid: open.sid, bytes: 1024 * 1024 })
    await until(() => s.node.frames(open.sid).some(f => f.end))
    const got = new Uint8Array(s.node.frames(open.sid).flatMap(f => [...f.payload]))
    expect(got.length).toBe(upload.length)
    expect(got.every((b, i) => b === upload[i])).toBe(true)

    // A download of 600 KB: the server sends what it may, global grants back as the body is read.
    await s.node.say({ t: 'tun-head', sid: open.sid, status: 200, headers: [['content-type', 'application/octet-stream']] })
    const res = (await answer)!
    const reading = res.arrayBuffer()
    let sent = 0
    while (sent < upload.length) {
      const allowed = TUN_WINDOW + s.node.credits(open.sid)
      if (sent >= allowed) {
        await Bun.sleep(2)
        continue
      }
      const n = Math.min(64 * 1024, upload.length - sent, allowed - sent)
      await s.node.data(open.sid, upload.subarray(sent, sent + n), sent + n === upload.length)
      sent += n
    }
    const body = new Uint8Array(await reading)
    expect(body.length).toBe(upload.length)
    expect(body.every((b, i) => b === upload[i])).toBe(true)
    expect(s.node.credits(open.sid)).toBeGreaterThan(0)
  })

  it('the server\'s error is a 502; a stream that moves nothing is closed (504)', async () => {
    const s = await shop()
    const failing = call(req('https://shop-a.lgrai.app/api/x', { headers: AUTH }))
    const open = await until(() => s.node.opens()[0])
    await s.node.say({ t: 'tun-error', sid: open.sid, code: 'api_down', message: 'The API is not running.' })
    const r = (await failing)!
    expect([r.status, (await r.json()).code]).toEqual([502, 'api_down'])
    setTunnelIdleMs(150)
    const silent = (await call(req('https://shop-a.lgrai.app/api/slow', { headers: AUTH })))!
    expect([silent.status, (await silent.json()).code]).toEqual([504, 'idle'])
    // The server was told to stop.
    expect(s.node.json.some(m => m.t === 'tun-cancel')).toBe(true)
  })

  it('the link drops before an answer: a GET is tried once more on the server\'s next socket, a POST is not', async () => {
    const s = await shop()
    const get = call(req('https://shop-a.lgrai.app/api/list', { headers: AUTH }))
    const post = call(req('https://shop-a.lgrai.app/api/save', { method: 'POST', body: 'x', headers: AUTH }))
    await until(() => s.node.opens().length === 2)
    await handleUplinkClose(s.node.ws)
    const postRes = (await post)!
    expect([postRes.status, await postRes.text()]).toEqual([503, expect.stringContaining('not connected')])
    // The server comes back: the GET runs again there.
    const again = fakeNode()
    await s.connect(again)
    const reopened = await until(() => again.opens()[0])
    expect(reopened).toMatchObject({ method: 'GET', path: '/api/list' })
    await again.say({ t: 'tun-head', sid: reopened.sid, status: 200, headers: [] })
    await again.data(reopened.sid, 'listed', true)
    const getRes = (await get)!
    expect([getRes.status, await getRes.text()]).toEqual([200, 'listed'])
  })
})

describe('a WebSocket through the tunnel (FR-20.73)', () => {
  it('opens on the server once the browser is in, holds the browser\'s first messages until the server accepts, and closes both ways', async () => {
    const s = await shop()
    let data: any = null
    const server = { upgrade: (_r: Request, opts: any) => { data = opts.data; return true } }
    const sent: any[] = []
    const closed: any[] = []
    const browser = { send: (m: any) => sent.push(m), close: (code: number, reason: string) => closed.push({ code, reason }) }
    const r = await call(req('https://shop-a.lgrai.app/ws/tasks', { headers: { upgrade: 'websocket', 'sec-websocket-key': 'k', 'sec-websocket-protocol': 'lgr' } }), server)
    expect(r!.status).toBe(101)
    data.open(browser)
    const open = await until(() => s.node.opens()[0])
    expect(open).toMatchObject({ kind: 'ws', path: '/ws/tasks', host: 'shop-a.lgrai.app' })
    expect(open.headers).toContainEqual(['sec-websocket-protocol', 'lgr'])
    expect((open.headers as Array<[string, string]>).some(h => h[0] === 'sec-websocket-key')).toBe(false)
    data.message(browser, '{"t":"auth","token":"x"}')
    expect(s.node.frames(open.sid)).toHaveLength(0)
    await s.node.say({ t: 'tun-ws-open', sid: open.sid })
    const first = s.node.frames(open.sid)
    expect(first.map(f => [f.kind, new TextDecoder().decode(f.payload)])).toEqual([[TUN_KIND.wsText, '{"t":"auth","token":"x"}']])
    data.message(browser, Buffer.from([1, 2, 3]))
    expect(s.node.frames(open.sid)[1]).toMatchObject({ kind: TUN_KIND.wsBinary })
    await s.node.data(open.sid, '{"t":"progress"}', false, TUN_KIND.wsText)
    expect(sent).toEqual(['{"t":"progress"}'])
    await s.node.say({ t: 'tun-ws-close', sid: open.sid, code: 4001, reason: 'bye' })
    expect(closed).toEqual([{ code: 4001, reason: 'bye' }])
    expect(openStreams(s.node.ws)).toBe(0)

    // And from the browser's side.
    const r2 = await call(req('https://shop-a.lgrai.app/ws/tasks', { headers: { upgrade: 'websocket' } }), server)
    expect(r2!.status).toBe(101)
    data.open(browser)
    const open2 = await until(() => s.node.opens()[1])
    data.close(browser, 1000, 'done')
    expect(s.node.json.find(m => m.t === 'tun-ws-close' && m.sid === open2.sid)).toMatchObject({ code: 1000, reason: 'done' })
  })

  it('a server that is not connected gets no upgrade: the notice answers', async () => {
    await shop('ws-offline', { connect: false })
    let upgraded = false
    const r = await call(req('https://ws-offline.lgrai.app/ws/tasks', { headers: { upgrade: 'websocket' } }), { upgrade: () => { upgraded = true; return true } })
    expect([r!.status, upgraded]).toEqual([503, false])
  })
})
