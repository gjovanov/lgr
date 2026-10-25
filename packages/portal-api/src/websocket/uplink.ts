import { randomBytes } from 'crypto'
import { hostname } from 'os'
import { NodePresence, OrgHome, ServerNode, UPLINK_CHANNELS, type UplinkChannel } from 'db/models'
import { config } from 'config'
import { loadActiveNode, NodeError, sanitizeHealth, verifyNodeToken, type NodeTokenClaims } from 'services/biz/node/node.service'
import { meetsMinimum } from 'services/biz/desktop/version'
import { issueLicences, licenceTerms } from 'services/biz/licence/licence-issue.service'
import { logger } from 'services/logger'

/**
 * The uplink, global's side (FR-20.52, plan step P2-2a): a registered master's two sockets,
 * `wss://lgrai.app/api/node/v1/uplink?ch=interactive|bulk`. Global only.
 *
 * - **The URL carries no credential.** The first frame is `hello`, with a node access token, and
 *   it must come within 10 s. Until then nothing else is heard.
 * - **The row is the revocation list.** The node is re-read every 30 s (and the revocation route
 *   says so at once, here): revoked → 4403, which stops the uplink and never the shop; a new key →
 *   4401, which makes the master authenticate again.
 * - **Presence** is a row per `(node, channel)` in `node_presence`, heartbeated by the master's pings
 *   (every 30 s; a socket silent for 75 s is dead).
 * - ⚠ **A clone** is a second LIVE connection from the same node id with ANOTHER boot nonce: a
 *   cloned disk, or a restored copy running beside the original (FR-20.8, FR-20.51). Both are told
 *   (`clone-alarm`), the node carries the alarm until an admin re-registers it, and global accepts
 *   neither's pages or tunnel traffic. The same supervisor reconnecting carries the same boot nonce
 *   and simply takes its own place back.
 *
 * Close codes: 4400 a malformed hello, 4401 unauthenticated, 4403 revoked, 4408 silent too long,
 * 4409 replaced by the same supervisor's newer connection.
 *
 * Control (FR-20.57, FR-20.58, plan step P2-3a): the master's `health` every 60 s on the interactive
 * socket is kept on its node; a master older than `NODE_MIN_MASTER_VERSION` is answered
 * `master_outdated`, and is not trusted for pages or the tunnel while it stays connected for updates.
 *
 * Licences (FR-20.55, plan step P2-3b), on the interactive socket only: one per entitled org in
 * `welcome`, then an `entitlements` frame when the terms change (re-checked every 10 minutes, and at
 * once on this pod when a sys-admin changes a pilot) and once a day regardless. ⚠ Sent to an
 * outdated master too: an old build that cannot update must not also lose its licence.
 */

export const UPLINK_PATH = '/api/node/v1/uplink'
export const HELLO_DEADLINE_MS = 10_000
export const TICK_MS = 30_000
export const DEAD_AFTER_MS = 75_000
export const CLOSE = { badRequest: 4400, unauthenticated: 4401, revoked: 4403, timeout: 4408, replaced: 4409 } as const
/** One health frame per this long per socket is kept; the rest are dropped. */
export const HEALTH_EVERY_MS = 20_000
/** How often a connection's licences are re-checked, and resent even when nothing changed. */
export const LICENCE_RECHECK_MS = 10 * 60_000
export const LICENCE_RESEND_MS = 24 * 60 * 60_000

const POD = hostname()

interface Conn {
  connId: string
  ch: UplinkChannel | null
  helloTimer: ReturnType<typeof setTimeout> | null
  tick: ReturnType<typeof setInterval> | null
  nodeId: string | null
  claims: NodeTokenClaims | null
  bootNonce: string | null
  lastFrameAt: number
  lastSeenWrite: number
  /** A clone alarm stands: pages and tunnel traffic are not accepted from this socket. */
  suspended: boolean
  alarmed: boolean
  /** FR-20.58: older than the minimum; connected for its update, trusted for nothing else. */
  outdated: boolean
  lastHealthAt: number
  /** FR-20.55: when the licences were last looked at and last sent, and their terms as sent, by org. */
  licencesCheckedAt: number
  licencesSentAt: number
  licenceTerms: Map<string, string>
}

const key = (ws: any) => ws?.raw ?? ws
const conns = new WeakMap<any, Conn>()
/** Live sockets on this process, by node id: what a revocation tells at once. */
const byNode = new Map<string, Set<any>>()

function send(ws: any, msg: unknown): void {
  try {
    ws.send(JSON.stringify(msg))
  } catch {
    /* gone */
  }
}

function close(ws: any, code: number, reason: string): void {
  try {
    ws.close(code, reason)
  } catch {
    try { ws.close() } catch { /* already gone */ }
  }
}

function parse(raw: any): any {
  if (typeof raw === 'object' && raw !== null && !Buffer.isBuffer(raw) && !(raw instanceof ArrayBuffer)) return raw
  try {
    return JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'))
  } catch {
    return null
  }
}

export function handleUplinkOpen(ws: any, channel: unknown): void {
  const conn: Conn = {
    connId: randomBytes(12).toString('hex'),
    ch: UPLINK_CHANNELS.includes(channel as UplinkChannel) ? (channel as UplinkChannel) : null,
    helloTimer: null,
    tick: null,
    nodeId: null,
    claims: null,
    bootNonce: null,
    lastFrameAt: Date.now(),
    lastSeenWrite: 0,
    suspended: false,
    alarmed: false,
    outdated: false,
    lastHealthAt: 0,
    licencesCheckedAt: 0,
    licencesSentAt: 0,
    licenceTerms: new Map(),
  }
  conns.set(key(ws), conn)
  if (!conn.ch) {
    send(ws, { t: 'error', code: 'bad_channel', message: 'ch is interactive or bulk.' })
    close(ws, CLOSE.badRequest, 'bad_channel')
    return
  }
  conn.helloTimer = setTimeout(() => {
    if (conns.get(key(ws))?.nodeId) return
    send(ws, { t: 'error', code: 'unauthenticated', message: 'No hello within 10 s.' })
    close(ws, CLOSE.unauthenticated, 'unauthenticated')
  }, HELLO_DEADLINE_MS)
}

export async function handleUplinkMessage(ws: any, raw: any): Promise<void> {
  const conn = conns.get(key(ws))
  if (!conn) return
  conn.lastFrameAt = Date.now()
  const msg = parse(raw)
  if (!msg || typeof msg.t !== 'string') {
    send(ws, { t: 'error', code: 'bad_message', message: 'A frame is a JSON object with a `t`.' })
    return
  }

  if (!conn.nodeId) {
    // ⚠ Deny by default: before `hello`, nothing else is heard.
    if (msg.t !== 'hello') {
      send(ws, { t: 'error', code: 'unauthenticated', message: 'Say hello first.' })
      close(ws, CLOSE.unauthenticated, 'unauthenticated')
      return
    }
    await hello(ws, conn, msg)
    return
  }

  if (msg.t === 'ping') {
    await heartbeat(conn)
    send(ws, { t: 'pong', serverTime: new Date().toISOString() })
    return
  }
  if (msg.t === 'health') {
    // Interactive only, from a socket that holds its place, at most one per 20 s.
    if (conn.ch !== 'interactive' || conn.suspended || Date.now() - conn.lastHealthAt < HEALTH_EVERY_MS) return
    conn.lastHealthAt = Date.now()
    await ServerNode.updateOne({ _id: conn.nodeId, status: 'active' }, { $set: { health: sanitizeHealth(msg) } })
    return
  }
  if (msg.t === 'hello') {
    send(ws, { t: 'error', code: 'bad_message', message: 'Already authenticated.' })
    return
  }
  send(ws, { t: 'error', code: 'bad_message', message: `Unknown frame: ${String(msg.t).slice(0, 40)}` })
}

async function hello(ws: any, conn: Conn, msg: any): Promise<void> {
  if (msg.v !== 1 || msg.ch !== conn.ch || typeof msg.bootNonce !== 'string' || msg.bootNonce.length < 8 || msg.bootNonce.length > 64) {
    send(ws, { t: 'error', code: 'bad_hello', message: 'hello needs v 1, the URL\'s ch, and a bootNonce.' })
    close(ws, CLOSE.badRequest, 'bad_hello')
    return
  }
  const claims = verifyNodeToken(msg.token)
  if (!claims) {
    send(ws, { t: 'error', code: 'unauthenticated', message: 'Invalid server token.' })
    close(ws, CLOSE.unauthenticated, 'unauthenticated')
    return
  }
  let node
  try {
    node = await loadActiveNode(claims)
  } catch (e) {
    const revoked = e instanceof NodeError && e.code === 'node_revoked'
    send(ws, { t: 'error', code: e instanceof NodeError ? e.code : 'unauthenticated', message: e instanceof Error ? e.message : 'Refused.' })
    close(ws, revoked ? CLOSE.revoked : CLOSE.unauthenticated, revoked ? 'node_revoked' : 'unauthenticated')
    return
  }
  if (conn.helloTimer) clearTimeout(conn.helloTimer)
  conn.helloTimer = null
  conn.nodeId = node._id
  conn.claims = claims
  conn.bootNonce = msg.bootNonce
  if (!byNode.has(node._id)) byNode.set(node._id, new Set())
  byNode.get(node._id)!.add(ws)

  const claim = await claimPresence(conn)
  if (claim === 'clone' || node.cloneAlarm?.at) await alarm(ws, conn, claim === 'clone')
  // FR-20.58: a version global no longer talks to (and one that names none) is outdated.
  conn.outdated = !meetsMinimum(msg?.versions?.app, config.node.minMasterVersion)

  const homes = await OrgHome.find({ orgId: { $in: node.orgIds } }).lean()
  const homeOf = new Map(homes.map((h: any) => [String(h.orgId), h]))
  // FR-20.55: a licence per entitled org, on the interactive socket. A failure sends none: the
  // master keeps what it holds, and the 10-minute re-check tries again.
  const licences = conn.ch === 'interactive'
    ? await issueLicences(node._id, node.orgIds).catch(e => { logger.warn({ err: String(e), nodeId: node._id }, 'licences were not issued'); return new Map() })
    : new Map()
  if (conn.ch === 'interactive') {
    conn.licencesCheckedAt = conn.licencesSentAt = Date.now()
    for (const [orgId, l] of licences) conn.licenceTerms.set(orgId, licenceTerms(l.entitlement))
  }
  send(ws, {
    t: 'welcome',
    serverTime: new Date().toISOString(),
    minMasterVersion: config.node.minMasterVersion,
    suspended: conn.suspended,
    outdated: conn.outdated,
    orgs: node.orgIds.map((id: any) => {
      const h: any = homeOf.get(String(id))
      const licence = licences.get(String(id))
      return {
        orgId: String(id), home: h?.home ?? 'global', homeEpoch: h?.epoch ?? 0, state: h?.state ?? 'active', linkLevel: node.linkLevel,
        ...(licence ? { entitlements: licence.jws } : {}),
      }
    }),
  })
  if (conn.outdated) {
    send(ws, {
      t: 'master_outdated',
      minMasterVersion: config.node.minMasterVersion,
      message: `This server runs ${String(msg?.versions?.app ?? 'an unknown version').slice(0, 40)}; lgrai.app needs ${config.node.minMasterVersion} or later. Update it: replication and remote access are paused until then.`,
    })
  }
  await ServerNode.updateOne({ _id: node._id, status: 'active' }, { $set: { lastSeenAt: new Date() } })
  conn.lastSeenWrite = Date.now()
  conn.tick = setInterval(() => { void tickConn(ws).catch(e => logger.warn({ err: String(e) }, 'uplink tick failed')) }, TICK_MS)
  logger.info({ nodeId: node._id, ch: conn.ch, connId: conn.connId, suspended: conn.suspended }, 'Uplink connected')
}

/**
 * Take this connection's `(node, channel)` row: when there is none, when its holder has been silent
 * for 75 s, or when it is the same supervisor's (the same boot nonce) reconnecting. Otherwise the row
 * belongs to a LIVE connection with another boot nonce, and this one is a clone.
 */
async function claimPresence(conn: Conn): Promise<'claimed' | 'replaced' | 'clone'> {
  const now = new Date()
  const stale = new Date(now.getTime() - DEAD_AFTER_MS)
  const ours = { connId: conn.connId, bootNonce: conn.bootNonce!, podId: POD, connectedAt: now, heartbeatAt: now }
  const before = await NodePresence.findOneAndUpdate(
    { nodeId: conn.nodeId, channel: conn.ch, $or: [{ heartbeatAt: { $lt: stale } }, { bootNonce: conn.bootNonce }] },
    { $set: ours, $unset: { clone: 1 } },
    { new: false },
  ).lean()
  if (before) {
    if ((before as any).connId !== conn.connId) replaceLocal(conn.nodeId!, (before as any).connId)
    return 'replaced'
  }
  try {
    await NodePresence.create({ nodeId: conn.nodeId, channel: conn.ch, ...ours })
    return 'claimed'
  } catch (e: any) {
    if (e?.code !== 11000) throw e
    return 'clone'
  }
}

/** The same supervisor's older socket on this process: closed, since the newer one holds the row now. */
function replaceLocal(nodeId: string, connId: string): void {
  for (const other of byNode.get(nodeId) ?? []) {
    const c = conns.get(key(other))
    if (c?.connId === connId) {
      send(other, { t: 'error', code: 'replaced', message: 'A newer connection from this server took over.' })
      close(other, CLOSE.replaced, 'replaced')
    }
  }
}

async function raiseCloneAlarm(conn: Conn): Promise<void> {
  const now = new Date()
  const row = await NodePresence.findOneAndUpdate(
    { nodeId: conn.nodeId, channel: conn.ch },
    { $set: { clone: { bootNonce: conn.bootNonce, at: now } } },
    { new: true },
  ).lean()
  const nonces = [...new Set([(row as any)?.bootNonce, conn.bootNonce].filter(Boolean))]
  await ServerNode.updateOne({ _id: conn.nodeId }, { $set: { cloneAlarm: { at: now, channel: conn.ch, bootNonces: nonces } } })
  logger.error({ nodeId: conn.nodeId, ch: conn.ch, bootNonces: nonces }, 'CLONE ALARM: two live uplinks from one server id')
}

async function heartbeat(conn: Conn): Promise<void> {
  const now = new Date()
  // Only the row's holder heartbeats it: a clone answering pings must not keep the original's row alive.
  await NodePresence.updateOne({ nodeId: conn.nodeId, channel: conn.ch, connId: conn.connId }, { $set: { heartbeatAt: now } })
  if (Date.now() - conn.lastSeenWrite > 60_000) {
    conn.lastSeenWrite = Date.now()
    await ServerNode.updateOne({ _id: conn.nodeId, status: 'active' }, { $set: { lastSeenAt: now } })
  }
}

/** Every 30 s: liveness, the row (revocation, a new key), and an alarm raised from another pod. */
export async function tickConn(ws: any, now = Date.now()): Promise<void> {
  const conn = conns.get(key(ws))
  if (!conn?.nodeId || !conn.claims) return
  if (now - conn.lastFrameAt > DEAD_AFTER_MS) {
    send(ws, { t: 'error', code: 'timeout', message: 'Nothing heard for 75 s.' })
    close(ws, CLOSE.timeout, 'timeout')
    return
  }
  let node
  try {
    node = await loadActiveNode(conn.claims)
  } catch (e) {
    const revoked = e instanceof NodeError && e.code === 'node_revoked'
    send(ws, { t: revoked ? 'revoked' : 'error', code: e instanceof NodeError ? e.code : 'unauthenticated', message: e instanceof Error ? e.message : 'Refused.' })
    close(ws, revoked ? CLOSE.revoked : CLOSE.unauthenticated, revoked ? 'node_revoked' : 'key_rotated')
    return
  }
  const row: any = await NodePresence.findOne({ nodeId: conn.nodeId, channel: conn.ch }).lean()
  if (!row) {
    // Nobody holds the row (its holder closed, or the floor removed it): take it again.
    if ((await claimPresence(conn)) === 'clone') await alarm(ws, conn, true)
    return
  }
  if (row.connId !== conn.connId) {
    if (row.bootNonce === conn.bootNonce) {
      // The same supervisor's newer connection, on another process: this one is the stale one.
      send(ws, { t: 'error', code: 'replaced', message: 'A newer connection from this server took over.' })
      close(ws, CLOSE.replaced, 'replaced')
      return
    }
    // Another machine's connection holds it: this one is a clone, or the original beside one.
    await alarm(ws, conn, false)
    return
  }
  if (row.clone) {
    await alarm(ws, conn, false)
    return
  }
  if (conn.ch === 'interactive' && now - conn.licencesCheckedAt >= LICENCE_RECHECK_MS) {
    await sendLicences(ws, conn, node.orgIds, now - conn.licencesSentAt >= LICENCE_RESEND_MS, now)
  }
}

/**
 * Send this connection the licences whose terms changed since it was last sent them (all of them
 * when `force`). A re-signed licence with the same terms is no news. Returns how many were sent.
 */
async function sendLicences(ws: any, conn: Conn, orgIds: readonly unknown[], force: boolean, now = Date.now()): Promise<number> {
  conn.licencesCheckedAt = now
  let licences
  try {
    licences = await issueLicences(conn.nodeId!, orgIds)
  } catch (e) {
    logger.warn({ err: String(e), nodeId: conn.nodeId }, 'licences were not issued')
    return 0
  }
  let sent = 0
  for (const [orgId, l] of licences) {
    const terms = licenceTerms(l.entitlement)
    if (!force && conn.licenceTerms.get(orgId) === terms) continue
    send(ws, { t: 'entitlements', orgId, jws: l.jws })
    conn.licenceTerms.set(orgId, terms)
    sent++
  }
  if (force) conn.licencesSentAt = now
  return sent
}

/**
 * A courtesy when a sys-admin changes an org's pilot: the interactive sockets on this process of every
 * master holding the org hear it now. The 10-minute re-check is the rule, on every pod.
 */
export async function notifyEntitlementsChanged(orgId: string): Promise<number> {
  const nodes = await ServerNode.find({ orgIds: orgId, status: 'active' }).select('_id orgIds').lean()
  let told = 0
  for (const n of nodes as any[]) {
    for (const ws of byNode.get(String(n._id)) ?? []) {
      const conn = conns.get(key(ws))
      if (conn?.nodeId && conn.ch === 'interactive') told += await sendLicences(ws, conn, n.orgIds, false)
    }
  }
  return told
}

/** Suspend this socket and tell it, once; `raise` also records the alarm on the node. */
async function alarm(ws: any, conn: Conn, raise: boolean): Promise<void> {
  conn.suspended = true
  if (raise) await raiseCloneAlarm(conn)
  if (conn.alarmed) return
  conn.alarmed = true
  send(ws, { t: 'clone-alarm', nodeId: conn.nodeId, ch: conn.ch, message: 'Another machine is connected as this server. Neither is trusted until an administrator registers the real one again.' })
}

export async function handleUplinkClose(ws: any): Promise<void> {
  const conn = conns.get(key(ws))
  if (!conn) return
  conns.delete(key(ws))
  if (conn.helloTimer) clearTimeout(conn.helloTimer)
  if (conn.tick) clearInterval(conn.tick)
  if (!conn.nodeId) return
  const set = byNode.get(conn.nodeId)
  set?.delete(ws)
  if (set && !set.size) byNode.delete(conn.nodeId)
  // Only its own row: a newer connection may hold it already.
  await NodePresence.deleteOne({ nodeId: conn.nodeId, channel: conn.ch, connId: conn.connId }).catch(() => {})
  logger.info({ nodeId: conn.nodeId, ch: conn.ch, connId: conn.connId }, 'Uplink closed')
}

/** A courtesy when a node is revoked: its sockets here are told at once. The 30 s re-read is the rule. */
export function notifyNodeRevoked(nodeId: string): number {
  let told = 0
  for (const ws of byNode.get(nodeId) ?? []) {
    send(ws, { t: 'revoked', code: 'node_revoked', message: 'This server has been removed.' })
    close(ws, CLOSE.revoked, 'node_revoked')
    told++
  }
  return told
}

/** Whether a socket may send pages or tunnel traffic: authenticated, not under a clone alarm, not outdated. */
export function isTrusted(ws: any): boolean {
  const conn = conns.get(key(ws))
  return !!conn?.nodeId && !conn.suspended && !conn.outdated
}

export function setupUplinkWS(app: any): void {
  app.ws(UPLINK_PATH, {
    open(ws: any) { handleUplinkOpen(ws, ws.data?.query?.ch) },
    message(ws: any, message: any) { void handleUplinkMessage(ws, message) },
    close(ws: any) { void handleUplinkClose(ws) },
  })
  logger.info(`Uplink WebSocket endpoint registered at ${UPLINK_PATH}`)
}
