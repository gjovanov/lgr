import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { Identity } from 'db/models'
import { taskStore } from 'services/background/task.store'
import { forgetIdentity } from 'services/biz/identity/session.service'
import {
  setupWebSocket,
  sendNotification,
  handleTasksOpen,
  handleTasksMessage,
  handleTasksClose,
  AUTH_DEADLINE_MS,
} from '../../../portal-api/src/websocket/ws.server'
import { signDesktopToken } from 'services/biz/desktop/desktop.service'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'

/**
 * `/ws/tasks` — background-task progress and notifications (#154).
 *
 * ⚠ Until #154 the socket subscribed to whichever user its `?userId=` named, without checking any
 * credential: knowing a user id (an ObjectId, not a secret) was enough to read that user's task
 * progress. These assert the replacement — the credential is the FIRST MESSAGE, a socket that
 * never sends one is closed, and a token for A never receives B's messages.
 *
 * They drive the exported handlers with a stand-in socket, so the real token verification and the
 * real revocation read run — no listening server, no mock of the logic under test.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = (new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt

/** A stand-in for Elysia's ws wrapper. `raw` is the identity the handlers key on. */
function fakeWs(query: Record<string, string> = {}) {
  const sent: any[] = []
  const closed: Array<{ code?: number; reason?: string }> = []
  return {
    raw: { id: Math.random() },
    data: { query },
    send: (s: string) => { sent.push(JSON.parse(s)) },
    close: (code?: number, reason?: string) => { closed.push({ code, reason }) },
    sent,
    closed,
    last: (type: string) => [...sent].reverse().find(m => m.type === type),
    has: (type: string) => sent.some(m => m.type === type),
  }
}

/** Every socket a test opened, closed afterwards so no subscription or timer outlives it. */
const opened: any[] = []
function open(query: Record<string, string> = {}) {
  const ws = fakeWs(query)
  handleTasksOpen(ws)
  opened.push(ws)
  return ws
}

async function sessionFor(over: Record<string, unknown> = {}) {
  const org = await createTestOrg()
  const user = await createTestUser(org._id)
  const id = String(user._id)
  const token = await signer.sign({ id, orgId: String(org._id), role: 'admin', ...over })
  return { org, user, id, token }
}

function emitTask(userId: string, orgId = 'org') {
  const taskId = `t-${Math.random()}`
  taskStore.set(taskId, {
    id: taskId,
    orgId,
    userId,
    type: 'test',
    status: 'processing',
    params: {},
    progress: 50,
    logs: [],
    createdAt: new Date(),
  })
  return taskId
}

beforeAll(async () => {
  await setupTestDB()
  // Registers the taskStore → socket broadcast. The app stand-in only has to accept `.ws()`.
  setupWebSocket({ ws: () => undefined } as any)
})
afterAll(async () => {
  taskStore.clear()
  await teardownTestDB()
})
afterEach(async () => {
  for (const ws of opened.splice(0)) handleTasksClose(ws)
  taskStore.clear()
  await clearCollections()
})

describe('/ws/tasks authentication (#154)', () => {
  it('ignores ?userId= — naming a user subscribes to nothing', async () => {
    const victim = await sessionFor()
    const ws = open({ userId: victim.id })

    emitTask(victim.id)
    sendNotification(victim.id, { title: 'private' })

    expect(ws.has('task:update')).toBe(false)
    expect(ws.has('notification')).toBe(false)
  })

  it('answers nothing but an auth until the socket has authenticated', async () => {
    const ws = open()
    await handleTasksMessage(ws, JSON.stringify({ type: 'ping' }))

    expect(ws.has('pong')).toBe(false)
    expect(ws.last('error').code).toBe('unauthenticated')
  })

  it('subscribes a valid session to its OWN user, and never to another', async () => {
    const a = await sessionFor()
    const b = await sessionFor()
    const ws = open({ userId: b.id }) // the old parameter, pointing at someone else

    await handleTasksMessage(ws, JSON.stringify({ type: 'auth', token: a.token }))
    expect(ws.has('authenticated')).toBe(true)
    expect(ws.closed.length).toBe(0)

    const mine = emitTask(a.id)
    emitTask(b.id)
    sendNotification(a.id, { title: 'for A' })
    sendNotification(b.id, { title: 'for B' })

    const updates = ws.sent.filter(m => m.type === 'task:update')
    expect(updates.map(m => m.data.taskId)).toEqual([mine])
    const notes = ws.sent.filter(m => m.type === 'notification')
    expect(notes.map(m => m.data.title)).toEqual(['for A'])

    await handleTasksMessage(ws, JSON.stringify({ type: 'ping' }))
    expect(ws.has('pong')).toBe(true)
  })

  it('a second auth cannot move an authenticated socket to another user', async () => {
    const a = await sessionFor()
    const b = await sessionFor()
    const ws = open()
    await handleTasksMessage(ws, JSON.stringify({ type: 'auth', token: a.token }))
    await handleTasksMessage(ws, JSON.stringify({ type: 'auth', token: b.token }))

    emitTask(b.id)
    expect(ws.has('task:update')).toBe(false)
  })

  it('refuses and closes on a forged, malformed or missing token', async () => {
    const a = await sessionFor()
    const forged = await new Elysia()
      .use(jwt({ name: 'jwt', secret: 'not-the-server-secret-xxxxxxxxxxxxxxxx' }))
      .decorator.jwt.sign({ id: a.id, orgId: String(a.org._id), role: 'admin' })

    for (const token of [forged, 'not-a-jwt', undefined]) {
      const ws = open()
      await handleTasksMessage(ws, JSON.stringify({ type: 'auth', token }))
      expect(ws.has('authenticated')).toBe(false)
      expect(ws.last('error').code).toBe('unauthenticated')
      expect(ws.closed[0]?.code).toBe(4401)

      emitTask(a.id)
      expect(ws.has('task:update')).toBe(false)
    }
  })

  it('refuses a token that is not an org session (identity-only, desktop)', async () => {
    const a = await sessionFor()
    // An identity-only token (no org chosen yet) carries no `id`/`orgId`.
    const identityOnly = await signer.sign({ iid: 'x', type: 'identity' })
    const { token: desktopToken } = signDesktopToken({ desktopId: a.id, orgId: String(a.org._id), keyEpoch: 1 })

    for (const token of [identityOnly, desktopToken]) {
      const ws = open()
      await handleTasksMessage(ws, JSON.stringify({ type: 'auth', token }))
      expect(ws.has('authenticated')).toBe(false)
      expect(ws.closed[0]?.code).toBe(4401)
    }
  })

  it('refuses a session revoked by a password change (tv mismatch)', async () => {
    const identity = await Identity.create({
      email: `p-${Math.random()}@lgr.test`,
      firstName: 'Per',
      lastName: 'Son',
      tokenVersion: 1,
    })
    const stale = await sessionFor({ iid: String(identity._id), tv: 0 })
    forgetIdentity(identity._id)

    const ws = open()
    await handleTasksMessage(ws, JSON.stringify({ type: 'auth', token: stale.token }))
    expect(ws.has('authenticated')).toBe(false)
    expect(ws.closed[0]?.code).toBe(4401)
  })

  it('stops delivering once the socket closes', async () => {
    const a = await sessionFor()
    const ws = open()
    await handleTasksMessage(ws, JSON.stringify({ type: 'auth', token: a.token }))
    // Elysia hands close a NEW wrapper around the same raw socket.
    handleTasksClose({ raw: ws.raw })

    emitTask(a.id)
    expect(ws.has('task:update')).toBe(false)
  })

  it(
    'closes a socket that never authenticates within the deadline',
    async () => {
      const victim = await sessionFor()
      const ws = open({ userId: victim.id })

      await Bun.sleep(AUTH_DEADLINE_MS + 250)

      expect(ws.closed[0]?.code).toBe(4401)
      expect(ws.last('error').code).toBe('unauthenticated')
      expect(ws.has('authenticated')).toBe(false)
    },
    AUTH_DEADLINE_MS + 5000,
  )

  it(
    'does NOT close a socket that authenticated in time',
    async () => {
      const a = await sessionFor()
      const ws = open()
      await handleTasksMessage(ws, JSON.stringify({ type: 'auth', token: a.token }))

      await Bun.sleep(AUTH_DEADLINE_MS + 250)

      expect(ws.closed.length).toBe(0)
    },
    AUTH_DEADLINE_MS + 5000,
  )
})
