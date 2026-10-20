import type { Elysia } from 'elysia'
import { taskStore } from 'services/background/task.store'
import { asSessionUser } from 'services/biz/session-token'
import { liveSessionUser } from 'services/biz/identity/session.service'
import { logger } from 'services/logger'
import { verifyToken } from '../auth/verify-token.js'

/**
 * `/ws/tasks` — background-task progress and notifications for the signed-in user (#154).
 *
 * Protocol:
 *   Client → Server:
 *     { type: 'auth', token }         first message, within 10 s — the user's session token
 *     { type: 'ping' }                keepalive, after authenticating
 *   Server → Client:
 *     { type: 'authenticated' }
 *     { type: 'error', code, message }
 *     { type: 'pong', timestamp }
 *     { type: 'task:update', data }   one of THIS user's tasks moved
 *     { type: 'notification', data }
 *
 * ⚠ Until #154 the socket subscribed to whichever user its `?userId=` named, with no credential at
 * all. User ids are ObjectIds and not secret, so anyone could read anyone's task progress. The
 * query parameter is now IGNORED: the only subscription is to the user the token names.
 *
 * ⚠ The upgrade carries NO credential, deliberately — a token in a URL lands in ingress and proxy
 * logs (S-05). The credential is the first message, and a socket that has not authenticated
 * within `AUTH_DEADLINE_MS` is closed. Same shape as `/ws/desktop`, with a user token.
 */

/** Exported so the flow test waits exactly this long rather than guessing. */
export const AUTH_DEADLINE_MS = 10_000

/** userId → the live sockets subscribed for that user. */
const connections = new Map<string, Set<any>>()

/**
 * ⚠ Keyed by `ws.raw`, not by the wrapper: Elysia hands every event a NEW `ElysiaWS` around the
 * same Bun socket, so a wrapper-keyed map would never find, on close, what open registered.
 */
const socketKey = (ws: any) => ws?.raw ?? ws
const state = new WeakMap<any, { timer: ReturnType<typeof setTimeout> | null; userId: string | null }>()

function send(ws: any, msg: unknown): void {
  try {
    ws.send(JSON.stringify(msg))
  } catch {
    /* the socket is gone; nothing to do */
  }
}

function refuse(ws: any, message: string): void {
  send(ws, { type: 'error', code: 'unauthenticated', message })
  try {
    ws.close(4401, 'unauthenticated')
  } catch {
    try { ws.close() } catch { /* already gone */ }
  }
}

function broadcast(userId: string, msg: unknown): void {
  const userConns = connections.get(userId)
  if (!userConns) return
  const message = JSON.stringify(msg)
  for (const ws of userConns) {
    try {
      ws.send(message)
    } catch {
      userConns.delete(ws)
    }
  }
}

export function handleTasksOpen(ws: any): void {
  const timer = setTimeout(() => {
    if (state.get(socketKey(ws))?.userId) return
    logger.warn('Task socket closed: never authenticated')
    refuse(ws, 'Authentication timed out.')
  }, AUTH_DEADLINE_MS)
  state.set(socketKey(ws), { timer, userId: null })
}

export async function handleTasksMessage(ws: any, raw: any): Promise<void> {
  let msg: any
  try {
    msg = typeof raw === 'object' && raw !== null && !Buffer.isBuffer(raw)
      ? raw
      : JSON.parse(typeof raw === 'string' ? raw : raw.toString())
  } catch {
    return // ignore invalid messages
  }

  const st = state.get(socketKey(ws))

  if (msg?.type === 'auth') {
    if (st?.userId) return // already authenticated; a second auth cannot move the subscription
    // The same three steps every HTTP auth plugin takes: signature, session shape (no identity-only
    // or oauth_pending token), and revocation (a password change ends every session).
    const user = await liveSessionUser(asSessionUser(await verifyToken(msg.token)))
    if (!user) {
      refuse(ws, 'A signed-in session is required.')
      return
    }
    // The socket may have closed while the token was being checked.
    const current = state.get(socketKey(ws))
    if (!current) return
    if (current.timer) clearTimeout(current.timer)
    state.set(socketKey(ws), { timer: null, userId: user.id })
    if (!connections.has(user.id)) connections.set(user.id, new Set())
    connections.get(user.id)!.add(ws)
    send(ws, { type: 'authenticated' })
    logger.info({ userId: user.id }, 'WebSocket connected')
    return
  }

  // ⚠ Deny by default: until it has authenticated, `auth` is the only thing a socket may say.
  if (!st?.userId) {
    send(ws, { type: 'error', code: 'unauthenticated', message: 'Authenticate first.' })
    return
  }

  if (msg?.type === 'ping') {
    send(ws, { type: 'pong', timestamp: Date.now() })
  }
}

export function handleTasksClose(ws: any): void {
  const st = state.get(socketKey(ws))
  if (st?.timer) clearTimeout(st.timer)
  state.delete(socketKey(ws))
  if (!st?.userId) return
  const set = connections.get(st.userId)
  if (set) {
    // The set holds the wrapper `open`/`message` saw; drop it by its raw identity.
    for (const s of set) if (socketKey(s) === socketKey(ws)) set.delete(s)
    if (!set.size) connections.delete(st.userId)
  }
  logger.info({ userId: st.userId }, 'WebSocket disconnected')
}

export function setupWebSocket(app: Elysia<any, any, any, any, any, any, any, any>) {
  // Listen for task updates and broadcast to the task's own user
  taskStore.on('task:update', (event) => {
    const task = taskStore.get(event.taskId)
    if (!task) return
    broadcast(task.userId, { type: 'task:update', data: event })
  })

  return app.ws('/ws/tasks', {
    open(ws) { handleTasksOpen(ws) },
    message(ws, message: any) { void handleTasksMessage(ws, message) },
    close(ws) { handleTasksClose(ws) },
  })
}

export function sendNotification(userId: string, notification: object) {
  broadcast(userId, { type: 'notification', data: notification })
}
