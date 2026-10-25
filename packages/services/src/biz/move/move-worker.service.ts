/**
 * A master taking an org from lgrai.app (FR-20.79 steps 3–6, plan step P3-6a): its side of the move.
 *
 * Every 10 s on a registered master, it asks global for its moves (`GET /api/node/v1/moves`, the node
 * token the supervisor keeps, out through the supervisor's egress) and does what each one's state asks:
 * - **`copying`**: the org's home here becomes `frozen` at the move's new epoch, so nothing else writes
 *   it; the copy and the files are downloaded and checked against their sha256, imported into an
 *   EMPTY org (raw writes, type-exact) with the org's people and their local credentials, and the
 *   digests of what is now in the database sent back.
 * - **`done`**: the home here becomes `active` at that epoch, and the arrival goes into the org's
 *   audit trail. From the capture's next tick the org is journaled, and its pages flow to the mirror
 *   from the start of a new chain.
 * - **`aborted`**: what it imported is removed, and the home record with it. ⚠ Only for the org this
 *   worker itself froze for that move: it never touches an org that was home here before, and of
 *   the people only those it added, once no other membership here points at them.
 *
 * Each move's progress is kept in `node_state` (`move:<id>`), so a restart picks it up where it was.
 */
import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import type { mongo } from 'mongoose'
import { config, nodeRole } from 'config'
import { mongoose } from 'db/connection'
import { Identity, LocalCredential, NodeState, OrgHome, User } from 'db/models'
import { forgetHome, thisNode } from 'db/home/home'
import { logger } from '../../logger/logger.js'
import { recordAuditEntry } from '../audit-log.service.js'
import { fetchWithTimeout } from '../outbound-fetch.js'
import { readNodeToken, type NodeToken } from '../relay/outbox-worker.js'
import { restoreFilesSidecar } from '../backup/backup-files.service.js'
import { forgetFeedCursors } from '../identity/identity-feed.service.js'
import { applyCredentialChanges } from '../identity/onprem-credentials.service.js'
import { masterSealKey } from '../node/node-seal-key.js'
import { discardMoveImport, fileSha256, importMoveBundle, orgHasData } from './move-bundle.js'

type ObjectId = mongo.ObjectId

interface MoveView {
  id: string
  orgId: string
  state: string
  epochTo: number
  startedBy?: string
  bundle?: { sha256: string; bytes: number }
  files?: { sha256: string; bytes: number }
}

interface Phase {
  phase: string
  /** The people this move added here: what an abort may remove again. */
  people?: string[]
  /** What the import answers global with, kept until global has it. */
  copy?: { digests: Record<string, { count: number; sha256: string }>; people: number; credentials: number }
}

const DOWNLOAD_MS = 30 * 60_000
let running = false

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v)) as unknown as ObjectId
const key = (moveId: string) => `move:${moveId}`

async function phaseOf(moveId: string): Promise<Phase | null> {
  const row: any = await NodeState.findById(key(moveId)).lean()
  return row?.value?.phase ? (row.value as Phase) : null
}

async function setPhase(moveId: string, phase: string, extra: Record<string, unknown> = {}) {
  await NodeState.updateOne({ _id: key(moveId) }, { $set: { value: { phase, at: new Date(), ...extra } } }, { upsert: true })
}

type Fetch = typeof fetch

function caller(token: NodeToken, fetchImpl: Fetch) {
  return (path: string, init: RequestInit = {}, timeoutMs = 30_000) =>
    fetchWithTimeout(new URL(path, token.server), { ...init, headers: { authorization: `Bearer ${token.token}`, ...(init.headers ?? {}) } }, { timeoutMs, fetchImpl })
}
type Call = ReturnType<typeof caller>

async function download(call: Call, path: string, to: string, want: { sha256: string; bytes: number }) {
  const res = await call(path, {}, DOWNLOAD_MS)
  if (!res.ok) throw new Error(`${path} answered ${res.status}`)
  await Bun.write(to, res)
  const sha = await fileSha256(to)
  if (sha !== want.sha256) throw new Error(`${path} arrived with another sha256 than global's`)
}

async function report(call: Call, moveId: string, path: 'copied' | 'failed', body: unknown) {
  const res = await call(`/api/node/v1/moves/${moveId}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`global answered ${res.status} to ${path}`)
  return res.json().catch(() => ({}))
}

/**
 * What a move imported here, removed: the org's documents, the credentials delivered for it, and
 * the people it added that no membership here points at any more.
 */
async function discardOrg(orgId: ObjectId, people: readonly string[]): Promise<number> {
  const n = await discardMoveImport(mongoose.connection.db as any, orgId)
  await LocalCredential.deleteMany({ forOrgId: orgId, source: 'lgrai' })
  if (people.length) {
    const still = new Set((await User.distinct('identityId', { identityId: { $in: people } })).map(String))
    const gone = people.filter(id => !still.has(id))
    if (gone.length) await Identity.deleteMany({ _id: { $in: gone } })
  }
  return n
}

async function takeCopy(call: Call, m: MoveView) {
  const orgId = oid(m.orgId)
  const db = mongoose.connection.db as any
  const home: any = await OrgHome.findOne({ orgId }).lean()
  const mine = home && home.home === thisNode() && home.state === 'frozen' && home.epoch === m.epochTo
  if (home && !mine && (home.home !== 'global' || home.state !== 'active')) {
    await report(call, m.id, 'failed', { reason: `this server holds the org already (${home.state})` })
    await setPhase(m.id, 'refused')
    return
  }
  const before = await phaseOf(m.id)
  let people: string[] = before?.people ?? []
  // A retry of this worker's own import starts clean; anything else in the org refuses the move.
  if (mine) await discardOrg(orgId, people)
  else if (await orgHasData(db, orgId)) {
    await report(call, m.id, 'failed', { reason: 'this server already holds data of the org' })
    await setPhase(m.id, 'refused')
    return
  }
  const seal = await masterSealKey()
  const nodeId = config.node.id
  if (!seal || !nodeId) {
    await report(call, m.id, 'failed', { reason: 'this server has no seal key or node id yet' })
    await setPhase(m.id, 'failed')
    return
  }
  await OrgHome.updateOne({ orgId }, { $set: { home: thisNode(), epoch: m.epochTo, state: 'frozen', since: new Date() } }, { upsert: true })
  forgetHome(orgId)
  await setPhase(m.id, 'importing', { people })

  const dir = join(config.upload.dir, m.orgId, 'backups', 'moves')
  await mkdir(dir, { recursive: true })
  const bundlePath = join(dir, `move-${m.id}.ndjson.zst`)
  const filesPath = join(dir, `move-${m.id}.files.ndjson.zst`)
  try {
    await download(call, `/api/node/v1/moves/${m.id}/bundle`, bundlePath, m.bundle!)
    await download(call, `/api/node/v1/moves/${m.id}/files`, filesPath, m.files!)
    const imported = await importMoveBundle(db, orgId, bundlePath, {
      onNewPeople: async ids => {
        people = [...new Set([...people, ...ids.map(String)])]
        await setPhase(m.id, 'importing', { people })
      },
      applyCredentials: items => applyCredentialChanges(items, seal, nodeId),
    })
    const files = await restoreFilesSidecar(filesPath, m.orgId)
    if (files.checksumFailures.length || files.refused.length) {
      throw new Error(`${files.checksumFailures.length} files arrived damaged and ${files.refused.length} were refused`)
    }
    // What changed about these people on lgrai.app while the copy travelled reaches them next.
    await forgetFeedCursors()
    const copy = { digests: imported.digests, people: imported.people, credentials: imported.credentials }
    await setPhase(m.id, 'imported', { people, copy })
    logger.info({ orgId: m.orgId, moveId: m.id, documents: imported.documents, people: imported.people, credentials: imported.credentials, files: files.written }, 'Move: the copy is imported here')
  } catch (e: any) {
    logger.error({ orgId: m.orgId, moveId: m.id, err: e?.message ?? String(e) }, 'Move: the copy could not be taken')
    await discardOrg(orgId, people).catch(() => {})
    await OrgHome.deleteOne({ orgId, home: thisNode(), state: 'frozen', epoch: m.epochTo })
    forgetHome(orgId)
    await report(call, m.id, 'failed', { reason: String(e?.message ?? e).slice(0, 500) }).catch(() => {})
    await setPhase(m.id, 'failed', { people })
  } finally {
    await rm(bundlePath, { force: true }).catch(() => {})
    await rm(filesPath, { force: true }).catch(() => {})
  }
  await sendCopied(call, m)
}

/**
 * The digests to global (FR-20.79 step 4). A report lost on the way is sent again on the next tick,
 * and the import stays: only global's answer decides whether the move goes on.
 */
async function sendCopied(call: Call, m: MoveView) {
  const at = await phaseOf(m.id)
  if (at?.phase !== 'imported' || !at.copy) return
  let answer: any
  try {
    answer = await report(call, m.id, 'copied', at.copy)
  } catch (e: any) {
    logger.warn({ orgId: m.orgId, moveId: m.id, err: e?.message ?? String(e) }, 'Move: the digests did not reach lgrai.app; sent again on the next round')
    return
  }
  await setPhase(m.id, answer?.ok === false ? 'mismatch' : 'reported', { people: at.people ?? [] })
  logger.info({ orgId: m.orgId, moveId: m.id, ok: answer?.ok !== false, mismatch: answer?.mismatch }, 'Move: lgrai.app answered the copy\'s digests')
}

async function activate(m: MoveView, at: Phase) {
  const orgId = oid(m.orgId)
  const r = await OrgHome.updateOne({ orgId, home: thisNode(), epoch: m.epochTo, state: 'frozen' }, { $set: { state: 'active', since: new Date() } })
  forgetHome(orgId)
  if (r.modifiedCount) {
    // The org's own record of where it lives, written where it lives now (it reaches global as mirror).
    if (m.startedBy) {
      await recordAuditEntry({ orgId: m.orgId, userId: m.startedBy, action: 'update', module: 'admin', entityType: 'org_move', entityId: m.id, entityName: 'from lgrai.app', changes: [{ field: 'home', oldValue: 'global', newValue: thisNode() }] })
    }
    logger.info({ orgId: m.orgId, epoch: m.epochTo }, 'Move: the org is home here now')
  }
  await setPhase(m.id, 'active', { people: at.people ?? [] })
}

async function discard(m: MoveView, at: Phase) {
  const orgId = oid(m.orgId)
  if (await OrgHome.exists({ orgId, home: thisNode(), epoch: m.epochTo, state: 'frozen' })) {
    const n = await discardOrg(orgId, at.people ?? [])
    await OrgHome.deleteOne({ orgId, home: thisNode(), state: 'frozen', epoch: m.epochTo })
    forgetHome(orgId)
    logger.warn({ orgId: m.orgId, moveId: m.id, documents: n }, 'Move: aborted on lgrai.app; what was imported here is removed')
  }
  await setPhase(m.id, 'discarded')
}

/** The master's scheduler tick. One pass at a time; a failure is retried on the next. */
export async function moveWorkerTick(now = new Date(), fetchImpl: Fetch = fetch): Promise<number> {
  if (nodeRole() !== 'master' || running) return 0
  const token = readNodeToken(config.outbox.tokenFile, now.getTime())
  if (!token) return 0
  running = true
  let acted = 0
  try {
    const call = caller(token, fetchImpl)
    const res = await call('/api/node/v1/moves')
    if (!res.ok) return 0
    const moves: MoveView[] = ((await res.json()) as any)?.moves ?? []
    for (const m of moves) {
      const at = await phaseOf(m.id)
      if (m.state === 'copying' && m.bundle && m.files && (at === null || at.phase === 'importing' || at.phase === 'failed')) {
        await takeCopy(call, m)
        acted++
      } else if (m.state === 'copying' && at?.phase === 'imported') {
        await sendCopied(call, m)
        acted++
      } else if (m.state === 'done' && (at?.phase === 'reported' || at?.phase === 'imported')) {
        await activate(m, at)
        acted++
      } else if (m.state === 'aborted' && at !== null && !['discarded', 'refused'].includes(at.phase)) {
        await discard(m, at)
        acted++
      }
    }
  } catch (e: any) {
    logger.warn({ err: e?.message ?? String(e) }, 'Move: lgrai.app could not be asked about moves this round')
  } finally {
    running = false
  }
  return acted
}
