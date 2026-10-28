import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { Desktop } from 'db/models'
import { signDesktopToken, PRESENCE_ONLINE_MS } from 'services/biz/desktop/desktop.service'
import {
  handleDesktopOpen,
  handleDesktopMessage,
  handleDesktopClose,
  isDesktopOnline,
  AUTH_DEADLINE_MS,
  DESKTOP_TICK_MS,
  tickDesktops,
} from '../../../portal-api/src/websocket/desktop'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'

/**
 * `/ws/desktop` — the presence socket's authentication (FR-14.21, C14 §3).
 *
 * ⚠ The upgrade carries NO credential, deliberately: a token in a URL lands in ingress and proxy
 * logs, which is what S-05 was (`/ws/tasks` trusted a `?userId=` until #154). What makes that
 * safe is the pair of rules asserted here — the credential is the FIRST MESSAGE, and a socket
 * that has not authenticated within 10 s is closed. Neither is any use without the other.
 *
 * These drive the exported handlers with a stand-in socket, so the real token verification and
 * the real revocation read run — no listening server, no mock of the logic under test.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = (new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt

/** A stand-in for Elysia's ws wrapper. `raw` is the identity the handlers key on. */
function fakeWs() {
  const sent: any[] = []
  const closed: Array<{ code?: number; reason?: string }> = []
  return {
    raw: { id: Math.random() },
    send: (s: string) => { sent.push(JSON.parse(s)) },
    close: (code?: number, reason?: string) => { closed.push({ code, reason }) },
    sent,
    closed,
    last: (type: string) => [...sent].reverse().find(m => m.type === type),
    has: (type: string) => sent.some(m => m.type === type),
  }
}

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

async function seedDesktop(over: Record<string, unknown> = {}) {
  const org = await createTestOrg()
  const desktop = await Desktop.create({
    orgId: org._id,
    name: 'TILL-1',
    installationId: `inst-${Math.random()}`,
    machineId: 'machine-1',
    publicKey: 'x'.repeat(60),
    status: 'active',
    ...over,
  })
  const { token } = signDesktopToken({
    desktopId: String(desktop._id),
    orgId: String(org._id),
    keyEpoch: (desktop as any).keyEpoch ?? 1,
  })
  return { org, desktop, token }
}

describe('the liveness route the probe depends on', () => {
  it('answers anonymously and says nothing else', async () => {
    /**
     * ⚠ FR-14.17's reachability probe calls `/api/health` before deciding a till is offline.
     * It did not exist until now, so every probe paid a failed request and fell back to the
     * origin — working, but slower to notice a real outage and noisier in the logs.
     *
     * ⚠ The body is asserted to be the SMALLEST TRUE THING. Anyone can read this route, so a
     * version string or a hostname here would be free reconnaissance.
     */
    const { createApiApp } = await import('../../../portal-api/src/api.js')
    const app = createApiApp()
    const res = await app.handle(new Request('http://localhost/api/health'))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })

    const text = JSON.stringify(body).toLowerCase()
    for (const leak of ['version', 'host', 'mongo', 'uptime', 'env', 'commit']) {
      expect(text).not.toContain(leak)
    }
  })

  it('does not depend on the database', async () => {
    // ⚠ Liveness, not readiness. A check that fails when Mongo is slow turns a degraded hub
    // into an unreachable one — and the desktop's answer to "unreachable" is to stop showing
    // the app. This passes with no DB work having happened in this test at all.
    const { createApiApp } = await import('../../../portal-api/src/api.js')
    const res = await createApiApp().handle(new Request('http://localhost/api/health'))
    expect(res.status).toBe(200)
  })
})

describe('the credential is the first message, never the URL', () => {
  it('authenticates a desktop and reports it online', async () => {
    const { desktop, token } = await seedDesktop()
    const ws = fakeWs()
    handleDesktopOpen(ws)
    await handleDesktopMessage(ws, JSON.stringify({ type: 'desktop:auth', token }))

    expect(ws.has('desktop:authenticated')).toBe(true)
    expect(ws.last('desktop:authenticated').desktopId).toBe(String(desktop._id))
    expect(isDesktopOnline(String(desktop._id))).toBe(true)

    handleDesktopClose(ws)
    expect(isDesktopOnline(String(desktop._id))).toBe(false)
  })

  it('refuses and CLOSES on a bad token', async () => {
    await seedDesktop()
    const ws = fakeWs()
    handleDesktopOpen(ws)
    await handleDesktopMessage(ws, JSON.stringify({ type: 'desktop:auth', token: 'not-a-token' }))

    expect(ws.last('desktop:error').code).toBe('unauthenticated')
    expect(ws.closed.length).toBe(1)
    handleDesktopClose(ws)
  })

  it('refuses a USER token — it is not a desktop credential', async () => {
    // ⚠ The two secrets are separate by construction (`DESKTOP_TOKEN_SECRET`), and this is the
    // socket half of that boundary. A user token verified here would make every signed-in
    // browser a desktop.
    const { org } = await seedDesktop()
    const user = await createTestUser(org._id)
    const userToken = await signer.sign({ id: String(user._id), orgId: String(org._id), role: 'admin' })

    const ws = fakeWs()
    handleDesktopOpen(ws)
    await handleDesktopMessage(ws, JSON.stringify({ type: 'desktop:auth', token: userToken }))

    expect(ws.last('desktop:error').code).toBe('unauthenticated')
    expect(ws.closed.length).toBe(1)
    handleDesktopClose(ws)
  })

  it('refuses a REVOKED desktop, whatever its token proves', async () => {
    // The row is the revocation list, read here as on every HTTP request.
    const { desktop, token } = await seedDesktop()
    await Desktop.updateOne({ _id: desktop._id }, { $set: { status: 'revoked' } })

    const ws = fakeWs()
    handleDesktopOpen(ws)
    await handleDesktopMessage(ws, JSON.stringify({ type: 'desktop:auth', token }))

    expect(ws.has('desktop:authenticated')).toBe(false)
    expect(ws.closed.length).toBe(1)
    expect(isDesktopOnline(String(desktop._id))).toBe(false)
    handleDesktopClose(ws)
  })
})

describe('deny by default, before authentication', () => {
  it('answers a heartbeat from an unauthenticated socket with an error, not an ack', async () => {
    // ⚠ "Harmless as far as anyone checked" is not a rule. Until it has authenticated,
    // `desktop:auth` is the only thing a socket may say.
    const ws = fakeWs()
    handleDesktopOpen(ws)
    await handleDesktopMessage(ws, JSON.stringify({ type: 'desktop:heartbeat', clientTime: new Date().toISOString() }))

    expect(ws.has('desktop:heartbeat:ack')).toBe(false)
    expect(ws.last('desktop:error').code).toBe('unauthenticated')
    handleDesktopClose(ws)
  })

  it('refuses an unknown message type without crashing the socket', async () => {
    const { token } = await seedDesktop()
    const ws = fakeWs()
    handleDesktopOpen(ws)
    await handleDesktopMessage(ws, JSON.stringify({ type: 'desktop:auth', token }))
    await handleDesktopMessage(ws, JSON.stringify({ type: 'desktop:whatever' }))

    expect(ws.last('desktop:error').code).toBe('bad_message')
    handleDesktopClose(ws)
  })

  it('refuses malformed JSON', async () => {
    const ws = fakeWs()
    handleDesktopOpen(ws)
    await handleDesktopMessage(ws, 'not json at all')
    expect(ws.last('desktop:error').code).toBe('bad_message')
    handleDesktopClose(ws)
  })

  it('acknowledges a heartbeat once authenticated, and records the skew', async () => {
    const { desktop, token } = await seedDesktop()
    const ws = fakeWs()
    handleDesktopOpen(ws)
    await handleDesktopMessage(ws, JSON.stringify({ type: 'desktop:auth', token }))

    // A clock three hours fast — recorded for an admin to SEE, never used to correct anything.
    const clientTime = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()
    await handleDesktopMessage(ws, JSON.stringify({ type: 'desktop:heartbeat', clientTime }))

    expect(ws.has('desktop:heartbeat:ack')).toBe(true)
    const row: any = await Desktop.findById(desktop._id).lean()
    expect(Math.abs(row.lastPresence?.clockSkewMs ?? 0)).toBeGreaterThan(2 * 60 * 60 * 1000)
    handleDesktopClose(ws)
  })
})

describe('the authentication deadline', () => {
  it(
    'closes a socket that never authenticates, having sent it nothing of value',
    async () => {
      // ⚠ This is what makes a tokenless upgrade safe. Without it, anyone could hold sockets
      // open on the hub indefinitely without ever proving anything.
      const ws = fakeWs()
      handleDesktopOpen(ws)
      await Bun.sleep(AUTH_DEADLINE_MS + 250)

      expect(ws.closed.length).toBe(1)
      expect(ws.last('desktop:error').code).toBe('unauthenticated')
      // Nothing was leaked to a caller that proved nothing.
      expect(ws.has('desktop:authenticated')).toBe(false)
      handleDesktopClose(ws)
    },
    AUTH_DEADLINE_MS + 5000,
  )

  it(
    'does NOT close a socket that authenticated in time',
    async () => {
      const { desktop, token } = await seedDesktop()
      const ws = fakeWs()
      handleDesktopOpen(ws)
      await handleDesktopMessage(ws, JSON.stringify({ type: 'desktop:auth', token }))
      await Bun.sleep(AUTH_DEADLINE_MS + 250)

      expect(ws.closed.length).toBe(0)
      expect(isDesktopOnline(String(desktop._id))).toBe(true)
      handleDesktopClose(ws)
    },
    AUTH_DEADLINE_MS + 5000,
  )
})

describe('a revoked desktop is told at once (FR-14.22)', () => {
  it('the revoke route sends the notice down its socket and closes it', async () => {
    // ⚠ `notifyDesktopRevoked` was written and never called: the first field lane (vmtest T-0)
    // revoked a desktop, and its shell still did not know two minutes later.
    const { desktopController } = await import('../../../portal-api/src/controllers/desktop.controller')
    const { org, desktop, token } = await seedDesktop()
    const ws = fakeWs()
    handleDesktopOpen(ws)
    await handleDesktopMessage(ws, JSON.stringify({ type: 'desktop:auth', token }))
    expect(isDesktopOnline(String(desktop._id))).toBe(true)

    const admin = await createTestUser(org._id, { role: 'admin' } as any)
    const adminToken = await signer.sign({ id: String(admin._id), orgId: String(org._id), role: 'admin', permissions: ['admin.settings'] })
    const app = new Elysia().use(desktopController)
    const res = await app.handle(new Request(`http://localhost/org/${org._id}/desktops/${desktop._id}/revoke`, {
      method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'test' }),
    }))
    expect(res.status).toBe(200)

    expect(ws.last('desktop:revoked')?.message).toContain((org as any).name)
    expect(ws.closed.length).toBe(1)
    handleDesktopClose(ws)
    expect(isDesktopOnline(String(desktop._id))).toBe(false)
  })
})

describe('the tick wakes a shell blocked on its read (FR-14.21)', () => {
  it('reaches every authenticated socket, and never one that has not authenticated', async () => {
    // ⚠ A shell up to desktop-v0.1.6 sends its heartbeat only when its blocking read returns. On
    // lgrai.app a connected desktop's `lastSeenAt` went from 51 s to 91 s old with no heartbeat in
    // between, so with the 75 s window a connected till read stale or offline.
    const { token } = await seedDesktop()
    const authed = fakeWs()
    handleDesktopOpen(authed)
    await handleDesktopMessage(authed, JSON.stringify({ type: 'desktop:auth', token }))
    const anonymous = fakeWs()
    handleDesktopOpen(anonymous)

    const told = tickDesktops()
    expect(told).toBeGreaterThanOrEqual(1)
    expect(typeof authed.last('desktop:tick')?.serverTime).toBe('string')
    expect(anonymous.has('desktop:tick')).toBe(false)

    handleDesktopClose(authed)
    handleDesktopClose(anonymous)
    expect(tickDesktops()).toBe(told - 1)
  })

  it('comes often enough that a heartbeat due every 30 s is never later than the online window', () => {
    // The worst case for a shell that only wakes on the tick: its 30 s became due just after one.
    expect(30_000 + DESKTOP_TICK_MS).toBeLessThan(PRESENCE_ONLINE_MS)
  })
})
