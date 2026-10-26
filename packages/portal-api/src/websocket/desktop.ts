import { Desktop } from 'db/models'
import {
  clockSkewMs,
  loadActiveDesktop,
  verifyDesktopToken,
} from 'services/biz/desktop/desktop.service'
import { movedFor, type Moved } from 'services/biz/desktop/repoint.service'
import { logger } from 'services/logger'

/**
 * `/ws/desktop` — presence, update requests and revocation notices (FR-14.21).
 *
 * Protocol:
 *   Desktop → Server:
 *     { type: 'desktop:auth', token }              first message, within 10 s
 *     { type: 'desktop:heartbeat', clientTime }    every 30 s
 *   Server → Desktop:
 *     { type: 'desktop:authenticated', desktopId, serverTime }
 *     { type: 'desktop:error', code, message }
 *     { type: 'desktop:update' }                   an admin asked it to update (FR-14.22)
 *     { type: 'desktop:revoked', message }         stop the bridge, delete the key
 *     { type: 'desktop:repoint', instruction, node, name }   the org moved to its master (FR-20.82)
 *     { type: 'desktop:moved', node, name }        the same, when global cannot say where it answers
 *
 * ⚠ A desktop of an org that moved to its master is told so, at authentication, on its heartbeat,
 * and at the flip itself (`repointOrgDesktops`), and then closed. Nothing of it is written here: the
 * org's rows on global are the mirror now, which only the home writes. A shell older than P3-6b
 * ignores the new types and takes the `org_moved` error that follows, as any refusal.
 *
 * ⚠ The upgrade carries NO credential, deliberately: a token in a URL lands in ingress and proxy
 * logs, which is exactly what S-05 was. The credential is the first message, and a socket that has
 * not authenticated within 10 s is closed — that deadline is what keeps a tokenless upgrade safe.
 *
 * `/ws/tasks` used to trust a `?userId=` query parameter instead, which is the pattern this
 * endpoint was written to avoid; since #154 it authenticates the same way, with a user token.
 */

/**
 * How long a socket may stay silent before it is closed.
 *
 * ⚠ Exported so `desktop-ws.flow.test.ts` waits exactly this long rather than guessing. The
 * deadline is the thing that makes a tokenless upgrade safe — a socket that never authenticates
 * must not be able to sit there — so it is asserted, not assumed.
 */
export const AUTH_DEADLINE_MS = 10_000

/** desktopId → the live sockets for it. A desktop could reconnect before its old socket closes. */
const sockets = new Map<string, Set<any>>()

/**
 * ⚠ Keyed by `ws.raw`, not by the wrapper. Elysia hands every event a NEW `ElysiaWS` around the
 * same Bun socket, so a wrapper-keyed map means the close handler never finds what open registered
 * — the bug that left fiscal printers registered after their browser went away.
 */
const socketKey = (ws: any) => ws?.raw ?? ws
const state = new WeakMap<any, { timer: ReturnType<typeof setTimeout> | null; desktopId: string | null; orgId?: string }>()

function send(ws: any, msg: unknown): void {
  try {
    ws.send(JSON.stringify(msg))
  } catch {
    /* the socket is gone; nothing to do */
  }
}

function closeSocket(ws: any, reason: string): void {
  try {
    ws.close(4401, reason)
  } catch {
    try { ws.close() } catch { /* already gone */ }
  }
}

/** FR-20.82: where the desktop goes now, and the refusal an older shell understands; then closed. */
function sendMoved(ws: any, moved: Moved): void {
  if (moved.kind === 'repoint') send(ws, { type: 'desktop:repoint', instruction: moved.instruction, node: moved.node, name: moved.name })
  else send(ws, { type: 'desktop:moved', node: moved.node, name: moved.name })
  send(ws, { type: 'desktop:error', code: 'org_moved', message: `This organisation is now on its own server (${moved.name}).` })
  closeSocket(ws, 'org_moved')
}

export function handleDesktopOpen(ws: any): void {
  const timer = setTimeout(() => {
    if (state.get(socketKey(ws))?.desktopId) return
    logger.warn('Desktop socket closed: never authenticated')
    send(ws, { type: 'desktop:error', code: 'unauthenticated', message: 'Authentication timed out.' })
    closeSocket(ws, 'unauthenticated')
  }, AUTH_DEADLINE_MS)
  state.set(socketKey(ws), { timer, desktopId: null })
}

export async function handleDesktopMessage(ws: any, raw: any): Promise<void> {
  let msg: any
  try {
    msg = typeof raw === 'object' && raw !== null && !Buffer.isBuffer(raw)
      ? raw
      : JSON.parse(typeof raw === 'string' ? raw : raw.toString())
  } catch {
    send(ws, { type: 'desktop:error', code: 'bad_message', message: 'Invalid JSON.' })
    return
  }

  const st = state.get(socketKey(ws))

  if (msg.type === 'desktop:auth') {
    const claims = verifyDesktopToken(msg.token)
    if (!claims) {
      send(ws, { type: 'desktop:error', code: 'unauthenticated', message: 'Invalid desktop token.' })
      closeSocket(ws, 'unauthenticated')
      return
    }
    try {
      // The row is the revocation list — checked here as on every HTTP request.
      const desktop = await loadActiveDesktop(claims)
      const id = String(desktop._id)
      if (st?.timer) clearTimeout(st.timer)
      const orgId = String(desktop.orgId)
      const moved = await movedFor(id, orgId)
      if (moved) {
        state.set(socketKey(ws), { timer: null, desktopId: null })
        logger.info({ desktopId: id, orgId, node: moved.node, kind: moved.kind }, 'Desktop of an org that moved: told where to go')
        sendMoved(ws, moved)
        return
      }
      state.set(socketKey(ws), { timer: null, desktopId: id, orgId })
      if (!sockets.has(id)) sockets.set(id, new Set())
      sockets.get(id)!.add(ws)
      await Desktop.updateOne({ _id: desktop._id }, { $set: { lastSeenAt: new Date() } })
      send(ws, { type: 'desktop:authenticated', desktopId: id, serverTime: new Date().toISOString() })
      logger.info({ desktopId: id, orgId: String(desktop.orgId) }, 'Desktop socket authenticated')
    } catch (e: any) {
      send(ws, { type: 'desktop:error', code: e?.code ?? 'unauthenticated', message: e?.message ?? 'Refused.' })
      closeSocket(ws, e?.code ?? 'unauthenticated')
    }
    return
  }

  // ⚠ Deny by default: until it has authenticated, `desktop:auth` is the only thing a socket may
  // say. "Harmless as far as anyone checked" is not a rule.
  if (!st?.desktopId) {
    send(ws, { type: 'desktop:error', code: 'unauthenticated', message: 'Authenticate first.' })
    return
  }

  if (msg.type === 'desktop:heartbeat') {
    // A move that flipped on another process: told on the next heartbeat (the home is cached 5 s).
    const moved = st.orgId ? await movedFor(st.desktopId, st.orgId) : null
    if (moved) {
      sendMoved(ws, moved)
      return
    }
    await Desktop.updateOne(
      { _id: st.desktopId },
      {
        $set: {
          lastSeenAt: new Date(),
          // Recorded, never used to correct anything server-side: a wrong clock on a till is worth
          // SHOWING an admin, because it breaks fiscal device time sync.
          'lastPresence.clockSkewMs': clockSkewMs(msg.clientTime),
        },
      },
    )
    send(ws, { type: 'desktop:heartbeat:ack', serverTime: new Date().toISOString() })
    return
  }

  send(ws, { type: 'desktop:error', code: 'bad_message', message: `Unknown type: ${msg.type}` })
}

export function handleDesktopClose(ws: any): void {
  const st = state.get(socketKey(ws))
  if (st?.timer) clearTimeout(st.timer)
  state.delete(socketKey(ws))
  if (!st?.desktopId) return
  const set = sockets.get(st.desktopId)
  if (set) {
    set.delete(ws)
    if (!set.size) sockets.delete(st.desktopId)
  }
  logger.info({ desktopId: st.desktopId }, 'Desktop socket closed')
}

export function setupDesktopWS(app: any): void {
  app.ws('/ws/desktop', {
    open(ws: any) { handleDesktopOpen(ws) },
    message(ws: any, message: any) { void handleDesktopMessage(ws, message) },
    close(ws: any) { handleDesktopClose(ws) },
  })
  logger.info('Desktop WebSocket endpoint registered at /ws/desktop')
}

/** `online` in FR-14.21's sense: a socket is registered right now. */
export function isDesktopOnline(desktopId: string): boolean {
  return (sockets.get(desktopId)?.size ?? 0) > 0
}

/**
 * Ask a desktop to check for an update (FR-14.22). Returns false when it has no live socket.
 *
 * ⚠ It carries no version and no URL. The desktop decides what to install, under every FR-14.28
 * safety rule — signature, no downgrade, deferral while the fiscal bridge is busy. A server that
 * pushed a URL here would be a way to make a till install something.
 */
export function requestDesktopUpdate(desktopId: string): boolean {
  const set = sockets.get(desktopId)
  if (!set?.size) return false
  for (const ws of set) send(ws, { type: 'desktop:update' })
  return true
}

/**
 * FR-20.82 (P3-6b): the org just moved to its master (the flip). Its desktops connected to this
 * process are told at once; any other process tells its own on their next heartbeat. Returns how many.
 */
export async function repointOrgDesktops(orgId: string): Promise<number> {
  let told = 0
  for (const [desktopId, set] of [...sockets]) {
    for (const ws of [...set]) {
      if (state.get(socketKey(ws))?.orgId !== orgId) continue
      const moved = await movedFor(desktopId, orgId)
      if (!moved) continue
      sendMoved(ws, moved)
      told++
    }
  }
  return told
}

/** Tell a revoked desktop why, so it can stop its bridge and delete its key (FR-14.22). */
export function notifyDesktopRevoked(desktopId: string, orgName: string): void {
  const set = sockets.get(desktopId)
  if (!set?.size) return
  for (const ws of set) {
    send(ws, { type: 'desktop:revoked', message: `This desktop was removed from ${orgName}.` })
    closeSocket(ws, 'desktop_revoked')
  }
}
