import { randomUUID } from 'node:crypto'
import { Desktop, Org } from 'db/models'
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
 *     { type: 'desktop:tick', serverTime }         every 15 s, so a shell blocked on its read
 *                                                  sends the heartbeat that is due
 *                                                  (`DESKTOP_TICK_MS`); a shell ignores it
 *     { type: 'desktop:repoint', instruction, node, name }   the org moved to its master (FR-20.82)
 *     { type: 'desktop:moved', node, name }        the same, when global cannot say where it answers
 *
 * ⚠ A desktop of an org that moved to its master is told so, at authentication, on its heartbeat,
 * and at the flip itself (`repointOrgDesktops`), and then closed. Nothing of it is written here: the
 * org's rows on global are the mirror now, which only the home writes. A shell older than P3-6b
 * ignores the new types and takes the `org_moved` error that follows, as any refusal.
 *
 * ⚠ Several pods (FR-24): a desktop's socket is on ONE of them, and an admin's request lands on
 * any. So what an admin does reaches the socket through the row, at its next heartbeat (#565): a
 * revoke is a heartbeat that finds the row no longer active, an update request is
 * `updateRequestedAt`, and `lastPresence.connId` tells every pod that a socket is held. On the pod
 * that holds it, the notice still goes at once.
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

/**
 * How often an authenticated desktop is woken (`desktop:tick`).
 *
 * ⚠ A shell up to desktop-v0.1.6 BLOCKS on its socket's read, and sends its 30 s heartbeat only
 * when something arrives - and between the acks to its own heartbeats nothing did, so its
 * heartbeats came at Bun's idle-ping cadence. Measured on lgrai.app: a connected desktop's
 * `lastSeenAt` went from 51 s to 91 s old with no heartbeat in between. With FR-14.21's 75 s
 * window that is a connected till read stale or offline. The tick wakes the read; an old shell
 * ignores its type (`classify` → None) and sends the heartbeat that was due. A shell that keeps
 * its own clock (#328) needs no tick, and ignores it the same way.
 */
export const DESKTOP_TICK_MS = 15_000

/**
 * How long an admin's update request stays deliverable (FR-14.22, #565). It reaches a socket on
 * another pod at that socket's next heartbeat, so this needs to cover a heartbeat (30 s) and the
 * tick that wakes it, and no more. "Update now" means now: a till that was switched off checks for
 * updates when it starts, and must not take a request from hours ago as new.
 */
export const UPDATE_REQUEST_TTL_MS = 120_000

/** desktopId → the live sockets for it. A desktop could reconnect before its old socket closes. */
const sockets = new Map<string, Set<any>>()

/**
 * ⚠ Keyed by `ws.raw`, not by the wrapper. Elysia hands every event a NEW `ElysiaWS` around the
 * same Bun socket, so a wrapper-keyed map means the close handler never finds what open registered
 * — the bug that left fiscal printers registered after their browser went away.
 */
const socketKey = (ws: any) => ws?.raw ?? ws
interface SocketState {
  timer: ReturnType<typeof setTimeout> | null
  desktopId: string | null
  orgId?: string
  /** This socket, among every socket of every pod: what the row's `lastPresence.connId` names. */
  connId?: string
  /** The newest `updateRequestedAt` this socket has had, delivered or too old to deliver. */
  updateSeen?: number
  /** Told its org moved: the row here is the mirror now, and nothing of it is written. */
  retired?: boolean
}
const state = new WeakMap<any, SocketState>()

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
  const st = state.get(socketKey(ws))
  if (st) st.retired = true
  if (moved.kind === 'repoint') send(ws, { type: 'desktop:repoint', instruction: moved.instruction, node: moved.node, name: moved.name })
  else send(ws, { type: 'desktop:moved', node: moved.node, name: moved.name })
  send(ws, { type: 'desktop:error', code: 'org_moved', message: `This organisation is now on its own server (${moved.name}).` })
  closeSocket(ws, 'org_moved')
}

/** FR-14.22: the notice, then the close. The shell stops its bridge and deletes its key. */
function sendRevoked(ws: any, orgName: string): void {
  send(ws, { type: 'desktop:revoked', message: `This desktop was removed from ${orgName}.` })
  closeSocket(ws, 'desktop_revoked')
}

async function orgName(orgId: string | undefined): Promise<string> {
  const org: any = orgId ? await Org.findById(orgId).select('name').lean() : null
  return org?.name ?? 'the organization'
}

/**
 * An admin's update request this socket has not had yet (#565): sent when it is recent, and
 * remembered either way, so a heartbeat never sends the same request twice.
 */
function deliverPendingUpdate(ws: any, requestedAt: Date | string | undefined, now = Date.now()): void {
  const st = state.get(socketKey(ws))
  const at = requestedAt ? new Date(requestedAt).getTime() : 0
  if (!st || !at || at <= (st.updateSeen ?? 0)) return
  st.updateSeen = at
  if (now - at <= UPDATE_REQUEST_TTL_MS) send(ws, { type: 'desktop:update' })
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
      const connId = randomUUID()
      state.set(socketKey(ws), { timer: null, desktopId: id, orgId, connId })
      if (!sockets.has(id)) sockets.set(id, new Set())
      sockets.get(id)!.add(ws)
      await Desktop.updateOne({ _id: desktop._id }, { $set: { lastSeenAt: new Date(), 'lastPresence.connId': connId } })
      send(ws, { type: 'desktop:authenticated', desktopId: id, serverTime: new Date().toISOString() })
      // A request made while it was reconnecting, on whichever pod.
      deliverPendingUpdate(ws, desktop.updateRequestedAt)
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
    // ⚠ Only an ACTIVE row. A revoke the other pod served reaches this socket here, within one
    // heartbeat (#565): no row matched means revoked, or an ephemeral row deleted. An error is not
    // that, and is never read as it.
    const row: any = await Desktop.findOneAndUpdate(
      { _id: st.desktopId, status: 'active' },
      {
        $set: {
          lastSeenAt: new Date(),
          // Recorded, never used to correct anything server-side: a wrong clock on a till is worth
          // SHOWING an admin, because it breaks fiscal device time sync.
          'lastPresence.clockSkewMs': clockSkewMs(msg.clientTime),
          'lastPresence.connId': st.connId,
        },
      },
      { projection: { updateRequestedAt: 1 } },
    ).lean()
    if (!row) {
      sendRevoked(ws, await orgName(st.orgId))
      return
    }
    send(ws, { type: 'desktop:heartbeat:ack', serverTime: new Date().toISOString() })
    deliverPendingUpdate(ws, row.updateRequestedAt)
    return
  }

  send(ws, { type: 'desktop:error', code: 'bad_message', message: `Unknown type: ${msg.type}` })
}

/** Returns the row's write, for a test to await; the close event does not wait for it. */
export function handleDesktopClose(ws: any): Promise<unknown> | undefined {
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
  // The row stops naming this socket, unless a newer one, here or on another pod, has taken over.
  // ⚠ Never for a desktop told its org moved: its rows here are the mirror, which only the home writes.
  if (st.retired || !st.connId) return
  return Desktop.updateOne(
    { _id: st.desktopId, 'lastPresence.connId': st.connId },
    { $unset: { 'lastPresence.connId': 1 } },
  ).catch((e: any) => logger.warn({ desktopId: st.desktopId, error: e?.message }, 'Could not clear a closed desktop socket'))
}

/**
 * Wake every authenticated desktop on this process (`DESKTOP_TICK_MS`). Returns how many sockets
 * were told. Never an unauthenticated one: before `desktop:auth` a socket hears nothing it did not
 * ask for.
 */
export function tickDesktops(): number {
  let told = 0
  const serverTime = new Date().toISOString()
  for (const set of sockets.values()) {
    for (const ws of set) {
      send(ws, { type: 'desktop:tick', serverTime })
      told++
    }
  }
  return told
}

let ticker: ReturnType<typeof setInterval> | null = null

export function setupDesktopWS(app: any): void {
  app.ws('/ws/desktop', {
    open(ws: any) { handleDesktopOpen(ws) },
    message(ws: any, message: any) { void handleDesktopMessage(ws, message) },
    close(ws: any) { handleDesktopClose(ws) },
  })
  if (!ticker) {
    ticker = setInterval(tickDesktops, DESKTOP_TICK_MS)
    // It must never be what keeps a process alive (a test run, a graceful stop).
    ;(ticker as any).unref?.()
  }
  logger.info('Desktop WebSocket endpoint registered at /ws/desktop')
}

/**
 * Whether THIS process holds a socket for it. ⚠ Not FR-14.21's `online` on its own: with several
 * pods the socket is often elsewhere, and `presenceOf` reads the row for that (#565).
 */
export function isDesktopOnline(desktopId: string): boolean {
  return (sockets.get(desktopId)?.size ?? 0) > 0
}

/**
 * Ask a desktop to check for an update (FR-14.22). Returns false when this process holds no socket
 * for it. The caller records `requestedAt` on the row first, so a socket on another pod has it at
 * its next heartbeat; this sends it at once to the ones here, and marks them as having had it.
 *
 * ⚠ It carries no version and no URL. The desktop decides what to install, under every FR-14.28
 * safety rule — signature, no downgrade, deferral while the fiscal bridge is busy. A server that
 * pushed a URL here would be a way to make a till install something.
 */
export function requestDesktopUpdate(desktopId: string, requestedAt = new Date()): boolean {
  const set = sockets.get(desktopId)
  if (!set?.size) return false
  for (const ws of set) {
    const st = state.get(socketKey(ws))
    if (st) st.updateSeen = Math.max(st.updateSeen ?? 0, requestedAt.getTime())
    send(ws, { type: 'desktop:update' })
  }
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

/**
 * Tell a revoked desktop why, so it can stop its bridge and delete its key (FR-14.22). Only the
 * sockets on this process; one on another pod hears at its next heartbeat (#565).
 */
export function notifyDesktopRevoked(desktopId: string, orgName: string): void {
  const set = sockets.get(desktopId)
  if (!set?.size) return
  for (const ws of set) sendRevoked(ws, orgName)
}
