import { randomBytes } from 'crypto'
import { hostname } from 'os'
import { LIVE_MOVE_STATES, MirrorState, NodePresence, Org, OrgHome, OrgMove, ServerNode, UPLINK_CHANNELS, type UplinkChannel } from 'db/models'
import { mongoose } from 'db/connection'
import { applyPage } from 'services/biz/replication/apply'
import { BSON, decodePage, type Page } from 'services/biz/replication/pages'
import { BlobFrameError, decodeBlobChunk, isBlobFrame, type BlobChunk } from 'services/biz/replication/blob-frame'
import { acceptChunk, blobUnavailable, wantBlobs } from 'services/biz/replication/mirror-blobs'
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
export const CLOSE = { badRequest: 4400, unauthenticated: 4401, revoked: 4403, timeout: 4408, replaced: 4409, homeChanged: 4410 } as const
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
  /**
   * FR-20.79 (P3-6a): on a bulk socket, the orgs homed at this node as its welcome named them. The
   * supervisor's pump pages only those, so when a move changes them the socket is welcomed again.
   */
  homes: string | null
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
    homes: null,
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
  // FR-20.64 (P3-2b): a mirror page is a binary frame, zstd from its first byte. FR-20.69 (P3-3): a
  // file's chunk is one too, behind its own magic.
  const bytes = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : null
  if (bytes && (isPage(bytes) || isBlobFrame(bytes))) {
    if (!conn.nodeId) {
      send(ws, { t: 'error', code: 'unauthenticated', message: 'Say hello first.' })
      close(ws, CLOSE.unauthenticated, 'unauthenticated')
      return
    }
    if (isPage(bytes)) await pageFrame(ws, conn, bytes)
    else await blobFrame(ws, conn, bytes)
    return
  }
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
  if (msg.t === 'blob-sync' || msg.t === 'blob-unavailable') {
    await blobMessage(ws, conn, msg)
    return
  }
  if (msg.t === 'hello') {
    send(ws, { t: 'error', code: 'bad_message', message: 'Already authenticated.' })
    return
  }
  send(ws, { t: 'error', code: 'bad_message', message: `Unknown frame: ${String(msg.t).slice(0, 40)}` })
}

const ZSTD = [0x28, 0xb5, 0x2f, 0xfd]
const isPage = (b: Uint8Array) => b.length > ZSTD.length && ZSTD.every((x, i) => b[i] === x)

/**
 * One mirror page from an authenticated master, on its bulk socket (FR-20.64–20.66): applied, and
 * answered with where the mirror stands. ⚠ The node is the one the token proved at `hello`, never what
 * the page says; a socket under a clone alarm, or of a master global no longer talks to, sends none.
 */
async function pageFrame(ws: any, conn: Conn, bytes: Uint8Array): Promise<void> {
  if (conn.ch !== 'bulk') {
    send(ws, { t: 'error', code: 'bad_channel', message: 'Pages travel on the bulk socket.' })
    return
  }
  let page: Page
  try {
    page = decodePage(bytes)
  } catch (e) {
    send(ws, { t: 'page-refused', reason: 'malformed', detail: e instanceof Error ? e.message.slice(0, 200) : 'not a page' })
    return
  }
  const base = { orgId: String(page.orgId), fromSeq: page.fromSeq, toSeq: page.toSeq }
  if (conn.suspended) return send(ws, { t: 'page-refused', ...base, reason: 'clone_alarm' })
  if (conn.outdated) return send(ws, { t: 'page-refused', ...base, reason: 'master_outdated' })
  try {
    const db = mongoose.connection.db
    if (!db) throw new Error('the database is not connected')
    const r = await applyPage(mongoose.connection.getClient() as any, db as any, page, { nodeId: conn.nodeId! })
    if (r.ok) {
      send(ws, {
        t: 'page-ack', ...base,
        watermark: r.watermark, chainHash: r.chainHash, applied: r.applied, deleted: r.deleted, setAside: r.setAside,
        ...(r.duplicate ? { duplicate: true } : {}),
        // EJSON: the master journals these ids again, and they must keep their BSON types.
        resend: r.resend.map(x => ({ coll: x.coll, ids: BSON.EJSON.serialize(x.ids, { relaxed: false }) })),
      })
    } else {
      send(ws, { t: 'page-refused', ...base, reason: r.refused, ...(r.detail ? { detail: r.detail } : {}), watermark: r.watermark, chainHash: r.chainHash })
    }
  } catch (e) {
    logger.error({ nodeId: conn.nodeId, ...base, err: e instanceof Error ? e.message : String(e) }, 'Mirror: a page could not be applied')
    send(ws, { t: 'page-error', ...base, message: 'The page could not be applied; send it again later.' })
  }
}

/** Why this socket may not carry an org's files at all, or null (as for pages). */
function blobChannelRefusal(conn: Conn): string | null {
  if (conn.ch !== 'bulk') return 'bad_channel'
  if (conn.suspended) return 'clone_alarm'
  if (conn.outdated) return 'master_outdated'
  return null
}

/**
 * FR-20.69 (P3-3): the master asks which of an org's files the mirror lacks (`blob-sync`), or says it
 * cannot send one global asked for (`blob-unavailable`). Global answers what ITS rows of that org
 * name, never what the master lists: an answer must not say what another org holds (FR-20.66).
 */
async function blobMessage(ws: any, conn: Conn, msg: any): Promise<void> {
  const orgId = typeof msg.orgId === 'string' && /^[0-9a-f]{24}$/.test(msg.orgId) ? msg.orgId : null
  if (!orgId) return send(ws, { t: 'error', code: 'bad_message', message: `${msg.t} names no org.` })
  const no = blobChannelRefusal(conn)
  if (no === 'bad_channel') return send(ws, { t: 'error', code: 'bad_channel', message: 'Files travel on the bulk socket.' })
  try {
    if (msg.t === 'blob-sync') {
      if (no) return send(ws, { t: 'blob-refused', orgId, reason: no })
      send(ws, await wantBlobs(conn.nodeId!, orgId))
    } else if (!no) {
      await blobUnavailable(conn.nodeId!, orgId, String(msg.sha256 ?? ''), String(msg.reason ?? 'missing'))
    }
  } catch (e) {
    logger.error({ nodeId: conn.nodeId, orgId, t: msg.t, err: e instanceof Error ? e.message : String(e) }, "Mirror: an org's files could not be looked at")
    send(ws, { t: 'blob-error', orgId, message: "The mirror could not look at this org's files; ask again later." })
  }
}

/** FR-20.69 (P3-3): one chunk of a file global asked for, written where the mirror stands. */
async function blobFrame(ws: any, conn: Conn, bytes: Uint8Array): Promise<void> {
  const no = blobChannelRefusal(conn)
  if (no === 'bad_channel') return send(ws, { t: 'error', code: 'bad_channel', message: 'Files travel on the bulk socket.' })
  let chunk: BlobChunk
  try {
    chunk = decodeBlobChunk(bytes)
  } catch (e) {
    return send(ws, { t: 'blob-refused', reason: 'malformed', detail: e instanceof BlobFrameError ? e.message : 'not a file chunk' })
  }
  const base = { orgId: chunk.orgId, sha256: chunk.sha256 }
  if (no) return send(ws, { t: 'blob-refused', ...base, reason: no })
  try {
    send(ws, await acceptChunk(conn.nodeId!, chunk))
  } catch (e) {
    logger.error({ nodeId: conn.nodeId, ...base, offset: chunk.offset, err: e instanceof Error ? e.message : String(e) }, 'Mirror: a file chunk could not be written')
    send(ws, { t: 'blob-error', ...base, message: 'The chunk could not be written; send it again later.' })
  }
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
  if (conn.ch === 'bulk') conn.homes = homesAt(node._id, homes)
  // FR-20.67: the bulk socket is told where each mirror stands, the master's own restore or not.
  const mirrors = conn.ch === 'bulk'
    ? new Map((await MirrorState.find({ orgId: { $in: node.orgIds } }).lean()).map((m: any) => [String(m.orgId), m]))
    : new Map()
  // FR-20.69 (P3-3): whether each org's files travel too, or its records only.
  const metadataOnly = conn.ch === 'bulk'
    ? new Set((await Org.find({ _id: { $in: node.orgIds }, 'settings.node.mirrorFiles': false }, { _id: 1 }).lean()).map((o: any) => String(o._id)))
    : new Set<string>()
  // FR-20.80 (P3-6c): a move back takes every file, whatever the org chose.
  if (metadataOnly.size) {
    for (const m of await OrgMove.find({ orgId: { $in: [...metadataOnly] }, kind: 'to_global', state: { $in: [...LIVE_MOVE_STATES] } }, { orgId: 1 }).lean()) metadataOnly.delete(String((m as any).orgId))
  }
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
      const m: any = mirrors.get(String(id))
      return {
        orgId: String(id), home: h?.home ?? 'global', homeEpoch: h?.epoch ?? 0, state: h?.state ?? 'active', linkLevel: node.linkLevel,
        ...(licence ? { entitlements: licence.jws } : {}),
        ...(conn.ch === 'bulk' ? { mirror: { watermark: m?.watermark ?? 0, chainHash: m?.chainHash ?? '', journalEpoch: m?.journalEpoch ?? null, instanceEpoch: m?.instanceEpoch ?? null }, files: metadataOnly.has(String(id)) ? 'metadata' : 'all' } : {}),
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
  // A move on another process (or one whose own close was lost): welcomed again within a tick.
  if (conn.ch === 'bulk' && conn.homes !== null) {
    const homes = await OrgHome.find({ orgId: { $in: node.orgIds } }, { orgId: 1, home: 1, epoch: 1, state: 1 }).lean()
    if (homesAt(conn.nodeId, homes) !== conn.homes) close(ws, CLOSE.homeChanged, 'home_changed')
  }
}

/** The orgs homed at `nodeId`, with their epoch and state, as one comparable string. */
function homesAt(nodeId: string, homes: readonly any[]): string {
  return homes
    .filter(h => h.home === nodeId)
    .map(h => `${String(h.orgId)}:${h.epoch}:${h.state}`)
    .sort()
    .join(',')
}

/**
 * FR-20.79 (P3-6a): an org's home changed for this node, so its bulk socket is closed and the
 * supervisor connects again (within a second, `uplink.rs`) to a welcome that names the new homes.
 * This process only: any other one notices on its next tick.
 */
export function rewelcomeNode(nodeId: string): number {
  let n = 0
  for (const ws of byNode.get(nodeId) ?? []) {
    if (conns.get(key(ws))?.ch !== 'bulk') continue
    close(ws, CLOSE.homeChanged, 'home_changed')
    n++
  }
  return n
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
