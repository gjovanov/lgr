/**
 * Moving an org from lgrai.app to its master (FR-20.79, plan step P3-6a, Part A.6.9): global's side.
 *
 * An admin starts it once the master is registered for the org at Full. Then, step by step, each one
 * a step in `org_moves.steps` and an audit entry, each idempotent:
 * 1. **Preflight**: no till open, no fiscal command in flight, no background job running for the
 *    org; the master live, healthy, at Full, with room; every member with a person has a local
 *    credential set on lgrai.app, or the admin names each one who has not.
 * 2. **Freeze**: global writes nothing of the org (`OrgHome.state = 'freezing'`: the home gate and
 *    the write guard refuse). The copy waits twice the home cache's lifetime, so no process still
 *    acts on a cached "home is here"; the org's desktop enrollment codes and keys are revoked.
 * 3. **Copy**: the type-exact move bundle and the org's files (`move-bundle.ts`, the files sidecar),
 *    which the master downloads with its node token. The bundle carries the org's people and their
 *    local credentials, sealed to the master's key (FR-20.40), so the site can sign in from the start.
 * 4. **Verify**: the master imports into an empty org and answers with its digests; they must equal
 *    global's, collection by collection, and it must hold every person and credential of the copy.
 * 5. **Flip**: in one transaction, the epoch up by one, the home the master, `homeEpochHighWater`
 *    with it, and the mirror's chain reset: the master's first pages re-send what the copy holds
 *    (idempotent), from a chain that starts at the move. Global keeps the documents as the mirror.
 *
 * Until the flip, an abort unfreezes global and nothing else changed. ⚠ The shop's desktops still
 * point at lgrai.app after the flip: until P3-6b re-points them, they pair again with the master.
 *
 * ⚠ **The audit trail is org data**, so global writes the org's entries only while the org is home
 * here: the start's entry is written before the freeze (and is in the copy), an abort's after the
 * unfreeze, and the flip's by the master once the org is home there (it reaches global as mirror).
 */
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import type { mongo } from 'mongoose'
import { config, nodeRole } from 'config'
import { mongoose } from 'db/connection'
import {
  BackgroundTask,
  DesktopEnrollmentCode,
  DesktopEnrollmentKey,
  LIVE_MOVE_STATES,
  OnpremCredential,
  Org,
  OrgHome,
  OrgMove,
  POSSession,
  ServerNode,
  User,
} from 'db/models'
import { HOME_CACHE_MS, forgetHome, homeOf } from 'db/home/home'
import { logger } from '../../logger/logger.js'
import { recordAuditEntry } from '../audit-log.service.js'
import { buildFilesSidecar } from '../backup/backup-files.service.js'
import { isSealPublicKey } from '../crypto/node-seal.js'
import { sealedCredentialsForMove } from '../identity/onprem-credentials.service.js'
import { presenceOfNodes } from '../node/node.service.js'
import { collectionDigests, digestMismatch, writeMoveBundle, type Digests } from './move-bundle.js'

type ObjectId = mongo.ObjectId

export class MoveError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly extra?: Record<string, unknown>) {
    super(message)
  }
}

/** How old a master's health may be for it to count as live. */
const HEALTH_FRESH_MS = 3 * 60_000
/** The least free disk a master needs to take an org (a floor; the copy is compressed). */
const MIN_FREE_BYTES = 1024 ** 3
/** A build that started this long ago and never finished is started again. */
const BUILD_LEASE_MS = 10 * 60_000

export interface PreflightCheck {
  name: string
  ok: boolean
  detail?: string
}

export interface MissingCredential {
  identityId: string
  name: string
  email?: string
}

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v)) as unknown as ObjectId

async function credentialsMissing(orgId: ObjectId): Promise<MissingCredential[]> {
  const members: any[] = await User.find({ orgId, isActive: true, identityId: { $ne: null } }, { identityId: 1, firstName: 1, lastName: 1, email: 1, username: 1 }).lean()
  if (!members.length) return []
  const have = new Set((await OnpremCredential.find({ orgId, identityId: { $in: members.map(m => m.identityId) } }, { identityId: 1 }).lean()).map((c: any) => String(c.identityId)))
  return members
    .filter(m => !have.has(String(m.identityId)))
    .map(m => ({ identityId: String(m.identityId), name: [m.firstName, m.lastName].filter(Boolean).join(' ') || m.username, email: m.email }))
}

/** FR-20.79 step 1. Every check, so the admin sees all of what stands in the way at once. */
export async function preflightMove(
  orgId: string,
  nodeId: string,
  allowMissing: readonly string[] = [],
  /** This process's fiscal commands in flight (`fiscal/in-flight`): `fiscal` builds on `services`, so the caller asks. */
  fiscalBusy = 0,
): Promise<{ ok: boolean; checks: PreflightCheck[]; missingCredentials: MissingCredential[] }> {
  const org = oid(orgId)
  const checks: PreflightCheck[] = []
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) })

  const home = await homeOf(org, { fresh: true })
  add('home', home.home === 'global' && home.state === 'active', home.home === 'global' ? `the org is ${home.state} here` : 'the org is already homed on a master')
  add('no_move', !(await OrgMove.exists({ orgId: org, state: { $in: [...LIVE_MOVE_STATES] } })), 'another move of this org is under way')

  const node: any = await ServerNode.findById(nodeId).lean()
  const registered = !!node && node.status === 'active' && (node.orgIds ?? []).some((id: unknown) => String(id) === orgId)
  add('registered', registered, 'the server is not registered for this organisation')
  add('full', node?.linkLevel === 'full', `the server is linked at ${node?.linkLevel ?? 'nothing'}: a move needs Full`)
  add('no_clone_alarm', !node?.cloneAlarm?.at, 'two machines answer as this server')
  add('seal_key', isSealPublicKey(node?.sealKey), 'the server has not given lgrai.app its seal key yet: its people\'s local credentials could not travel')
  const live = (await presenceOfNodes([nodeId])).get(nodeId)
  add('connected', !!live?.interactive && !!live?.bulk, 'the server is not connected on both of its sockets')
  const at = node?.health?.at ? new Date(node.health.at).getTime() : 0
  add('healthy', Date.now() - at <= HEALTH_FRESH_MS && node?.health?.api?.ok === true, at ? 'the server\'s API does not report healthy' : 'the server has sent no health report')
  const free = Number(node?.health?.disk?.freeBytes ?? 0)
  add('disk', free >= MIN_FREE_BYTES, `the server has ${Math.round(free / 1024 ** 2)} MB free`)

  add('no_till_open', !(await POSSession.exists({ orgId: org, status: { $in: ['opening_control', 'open', 'closing_control'] } })), 'a till session is open: close it first')
  add('no_fiscal_command', fiscalBusy === 0, 'a fiscal device is printing')
  add('no_job_running', !(await BackgroundTask.exists({ orgId: org, status: { $in: ['pending', 'processing'] } })), 'a background job of this organisation is running')

  const missing = await credentialsMissing(org)
  const allowed = new Set(allowMissing.map(String))
  const blocking = missing.filter(m => !allowed.has(m.identityId))
  add('credentials', !blocking.length, `${blocking.length} of the organisation's people have no local credential for the server yet`)
  return { ok: checks.every(c => c.ok), checks, missingCredentials: missing }
}

function step(name: string, ok = true, detail?: string) {
  return { name, at: new Date(), ok, ...(detail ? { detail: detail.slice(0, 500) } : {}) }
}

/** Start the move: preflight again, then freeze (FR-20.79 steps 1–2). */
export async function startMove(orgId: string, nodeId: string, by: { id: string; operatorCode?: string }, allowMissing: readonly string[] = [], fiscalBusy = 0) {
  if (nodeRole() !== 'global') throw new MoveError(404, 'not_found', 'Not found')
  const pre = await preflightMove(orgId, nodeId, allowMissing, fiscalBusy)
  if (!pre.ok) throw new MoveError(409, 'preflight_failed', 'The move cannot start yet.', { checks: pre.checks, missingCredentials: pre.missingCredentials })
  const org = oid(orgId)
  const home: any = await OrgHome.findOne({ orgId: org }).lean()
  const highWater = ((await Org.findById(org, { homeEpochHighWater: 1 }).lean()) as any)?.homeEpochHighWater
  const epoch: number = home?.epoch ?? highWater ?? 0
  const now = new Date()
  let move: any
  try {
    move = await OrgMove.create({
      orgId: org, kind: 'to_master', state: 'freezing', from: 'global', to: nodeId, epochFrom: epoch, epochTo: epoch + 1,
      startedBy: oid(by.id), startedAt: now, frozenAt: now, allowMissing: allowMissing.map(oid),
      steps: [step('preflight', true, `${pre.checks.length} checks`), step('freeze')],
    })
  } catch (e: any) {
    if (e?.code === 11000) throw new MoveError(409, 'move_in_progress', 'Another move of this organisation is under way.')
    throw e
  }
  // Before the freeze: the org's writes are refused here from it on, and this entry is in the copy.
  await recordAuditEntry({ orgId, userId: by.id, operatorCode: by.operatorCode, action: 'update', module: 'admin', entityType: 'org_move', entityId: String(move._id), entityName: `to ${nodeId}`, changes: [{ field: 'state', oldValue: 'active', newValue: 'freezing' }] })
  // The freeze: the home stays global, and writes nothing (FR-20.79 step 2).
  await OrgHome.updateOne({ orgId: org }, { $set: { home: 'global', epoch, state: 'freezing', since: now, changedBy: by.id } }, { upsert: true })
  forgetHome(org)
  logger.info({ orgId, nodeId, moveId: String(move._id) }, 'Move: the org is frozen on its way to a master')
  return move.toObject()
}

/** The live move of an org, or its last one. */
export async function currentMove(orgId: string) {
  return OrgMove.findOne({ orgId: oid(orgId) }).sort({ startedAt: -1 }).lean()
}

function moveDir(orgId: unknown) {
  return join(config.upload.dir, String(orgId), 'backups', 'moves')
}

async function unfreeze(orgId: ObjectId, epoch: number) {
  await OrgHome.updateOne({ orgId, home: 'global', state: 'freezing' }, { $set: { state: 'active', epoch, since: new Date() } })
  forgetHome(orgId)
}

/** Abort a move before its flip: global unfreezes, and the copy is deleted. */
export async function abortMove(moveId: string, reason: string, by?: { id: string; operatorCode?: string }) {
  const move: any = await OrgMove.findOneAndUpdate(
    { _id: oid(moveId), state: { $in: ['freezing', 'copying', 'verifying'] } },
    { $set: { state: 'aborted', error: reason.slice(0, 2000), endedAt: new Date() }, $push: { steps: step('abort', false, reason) } },
    { new: true },
  ).lean()
  if (!move) throw new MoveError(409, 'not_abortable', 'The move is past its flip, or already over.')
  await unfreeze(move.orgId, move.epochFrom)
  await rm(join(moveDir(move.orgId), `move-${moveId}.ndjson.zst`), { force: true }).catch(() => {})
  await rm(join(moveDir(move.orgId), `move-${moveId}.files.ndjson.zst`), { force: true }).catch(() => {})
  // An abort the move itself makes (a failed copy, a mismatch) is the starting admin's move.
  await recordAuditEntry({ orgId: String(move.orgId), userId: by?.id ?? String(move.startedBy), operatorCode: by?.operatorCode, action: 'update', module: 'admin', entityType: 'org_move', entityId: moveId, entityName: `to ${move.to}`, changes: [{ field: 'state', oldValue: 'live', newValue: 'aborted' }] })
  logger.warn({ orgId: String(move.orgId), moveId, reason }, 'Move: aborted; the org is unfrozen on lgrai.app')
  return move
}

/**
 * The scheduler's tick: a frozen move whose wait is over gets its copy (FR-20.79 steps 2–3). The
 * transition is claimed by a conditional update, so two pods never build one copy twice.
 */
export async function moveTick(now = new Date()): Promise<number> {
  if (nodeRole() !== 'global') return 0
  let built = 0
  const due = new Date(now.getTime() - 2 * HOME_CACHE_MS)
  const stale = new Date(now.getTime() - BUILD_LEASE_MS)
  for (;;) {
    const move: any = await OrgMove.findOneAndUpdate(
      { $or: [{ state: 'freezing', frozenAt: { $lte: due } }, { state: 'copying', bundle: { $exists: false }, buildingAt: { $lt: stale } }] },
      { $set: { state: 'copying', buildingAt: now } },
      { new: true },
    ).lean()
    if (!move) break
    try {
      await buildCopy(move, now)
      built++
    } catch (e: any) {
      logger.error({ moveId: String(move._id), err: e?.message ?? String(e) }, 'Move: the copy could not be built')
      await abortMove(String(move._id), `the copy could not be built: ${e?.message ?? e}`).catch(() => {})
    }
  }
  return built
}

async function buildCopy(move: any, now: Date) {
  const orgId: ObjectId = move.orgId
  // A start that died between its claim and its freeze: the org may have been written all along.
  if (!(await OrgHome.exists({ orgId, home: 'global', state: 'freezing', epoch: move.epochFrom }))) {
    throw new Error('the org is not frozen for this move')
  }
  // The org's desktops are enrolled with global until P3-6b re-points them; no new one is, from now.
  // ⚠ Raw: global's own records, which the write guard refuses for a frozen org like its data. After
  // the wait, so a code a pod minted on a cached "active" during the freeze is revoked as well.
  const codes = await DesktopEnrollmentCode.collection.updateMany({ orgId, usedAt: null, expiresAt: { $gt: now } }, { $set: { expiresAt: now } })
  const keys = await DesktopEnrollmentKey.collection.updateMany({ orgId, revokedAt: null }, { $set: { revokedAt: now } })
  const db = mongoose.connection.db as any
  const dir = moveDir(orgId)
  // FR-20.40: the people's verifiers, sealed to the master's key as the credential feed seals them.
  const node: any = await ServerNode.findById(move.to).lean()
  if (!node) throw new Error('the server is no longer registered')
  const credentials = await sealedCredentialsForMove(node, String(orgId))
  const bundle = await writeMoveBundle(db, orgId, join(dir, `move-${String(move._id)}.ndjson.zst`), { credentials })
  const files = await buildFilesSidecar(String(orgId), `move-${String(move._id)}`, { subdir: 'moves', root: 'org' })
  const kept = await OrgMove.updateOne(
    { _id: move._id, state: 'copying' },
    {
      $set: {
        bundle: { file: bundle.file, sha256: bundle.sha256, bytes: bundle.bytes, documents: bundle.documents, people: bundle.people, credentials: bundle.credentials },
        files: { file: files.filename, sha256: files.sha256, bytes: files.bytes, count: files.count },
        digests: bundle.digests,
      },
      $push: { steps: { $each: [step('revoke_enrollment', true, `${codes.modifiedCount} codes, ${keys.modifiedCount} keys`), step('copy', true, `${bundle.documents} documents, ${bundle.people} people, ${bundle.credentials} credentials, ${files.count} files`)] } },
    },
  )
  if (!kept.matchedCount) {
    // Aborted while it was built: the abort found no files to delete, so they go now.
    await rm(join(dir, bundle.file), { force: true }).catch(() => {})
    await rm(files.absolutePath, { force: true }).catch(() => {})
    return
  }
  logger.info({ moveId: String(move._id), documents: bundle.documents, files: files.count }, 'Move: the copy is ready for the master')
}

/** What a node is told of its moves: the live ones, and those that ended in the last month. */
export async function movesForNode(nodeId: string) {
  // A month: a master off the network for days after its copy still learns its move ended.
  const since = new Date(Date.now() - 30 * 24 * 3600_000)
  const rows: any[] = await OrgMove.find({ to: nodeId, $or: [{ state: { $in: [...LIVE_MOVE_STATES] } }, { endedAt: { $gte: since } }] }).sort({ startedAt: 1 }).lean()
  return rows.map(m => ({
    id: String(m._id), orgId: String(m.orgId), state: m.state, epochTo: m.epochTo, startedBy: String(m.startedBy),
    ...(m.bundle && m.state === 'copying' ? { bundle: { sha256: m.bundle.sha256, bytes: m.bundle.bytes }, files: { sha256: m.files.sha256, bytes: m.files.bytes } } : {}),
  }))
}

/** A move of this node in `copying` with its copy built, or a refusal. */
export async function copyFor(nodeId: string, moveId: string): Promise<{ bundle: string; files: string }> {
  const m: any = await OrgMove.findOne({ _id: oid(moveId), to: nodeId, state: 'copying', bundle: { $exists: true } }).lean()
  if (!m) throw new MoveError(404, 'not_found', 'No such move for this server.')
  return { bundle: join(moveDir(m.orgId), m.bundle.file), files: join(moveDir(m.orgId), m.files.file) }
}

export interface CopyReport {
  digests: Digests
  /** The copy's people the master holds, and the copy's credentials it kept. */
  people: number
  credentials: number
}

/**
 * The master imported the copy and answers with its digests (FR-20.79 step 4). Equal, with every
 * person and credential of the copy held: the flip (step 5). Not: the move is aborted, with what
 * differs.
 */
export async function copied(nodeId: string, moveId: string, theirs: CopyReport) {
  // `verifying` too: a report sent again after this process died between the two steps finishes it.
  const m: any = await OrgMove.findOneAndUpdate(
    { _id: oid(moveId), to: nodeId, state: { $in: ['copying', 'verifying'] }, bundle: { $exists: true } },
    { $set: { state: 'verifying' }, $push: { steps: step('imported') } },
    { new: true },
  ).lean()
  if (!m) {
    // Flipped already (the answer was lost on the way): the master is told so, not refused.
    const done = await OrgMove.exists({ _id: oid(moveId), to: nodeId, state: 'done' })
    if (done) return { ok: true, epoch: ((await OrgMove.findById(moveId, { epochTo: 1 }).lean()) as any)?.epochTo }
    throw new MoveError(409, 'not_copying', 'The move is not waiting for this server\'s copy.')
  }
  // Global's own digests, of what it froze: the copy was built from them, and nothing moved since.
  const ours = await collectionDigests(mongoose.connection.db as any, m.orgId)
  const bad = [...new Set([...digestMismatch(ours, m.digests ?? {}), ...digestMismatch(ours, theirs?.digests ?? {})])]
  if (theirs?.people !== (m.bundle.people ?? 0)) bad.push('people')
  if (theirs?.credentials !== (m.bundle.credentials ?? 0)) bad.push('credentials')
  if (bad.length) {
    await abortMove(moveId, `the copy differs from lgrai.app's in ${bad.join(', ')}`)
    return { ok: false, mismatch: bad }
  }
  if (await flip(m)) return { ok: true, epoch: m.epochTo }
  // An abort, or another process's flip, got there first: say which.
  const now: any = await OrgMove.findById(m._id, { state: 1 }).lean()
  return now?.state === 'done' ? { ok: true, epoch: m.epochTo } : { ok: false, state: now?.state ?? 'gone' }
}

/**
 * FR-20.79 step 5, in one transaction, which first claims the move: a flip that lost to an abort,
 * or a second one, changes nothing. ⚠ A late second flip would otherwise delete the mirror's new
 * chain, which the master's first pages have started by then.
 */
async function flip(m: any): Promise<boolean> {
  const session = await mongoose.startSession()
  let flipped = false
  try {
    await session.withTransaction(async () => {
      flipped = false
      const now = new Date()
      const claimed = await OrgMove.updateOne({ _id: m._id, state: 'verifying' }, { $set: { state: 'done', endedAt: now }, $push: { steps: { $each: [step('flip', true, `epoch ${m.epochTo}, home ${m.to}`), step('done')] } } }, { session })
      if (!claimed.modifiedCount) return
      await OrgHome.updateOne({ orgId: m.orgId }, { $set: { home: m.to, epoch: m.epochTo, state: 'active', since: now, changedBy: String(m.startedBy) } }, { session, upsert: true })
      await Org.collection.updateOne({ _id: m.orgId }, { $set: { homeEpochHighWater: m.epochTo } }, { session })
      // The mirror's chain starts again at the move: the master's first pages re-send the copy.
      await mongoose.connection.db!.collection('mirror_state').deleteOne({ orgId: m.orgId }, { session })
      flipped = true
    })
  } finally {
    await session.endSession()
  }
  if (!flipped) return false
  forgetHome(m.orgId)
  // The copy has done its work: the master holds the org now, and global the mirror.
  await rm(join(moveDir(m.orgId), m.bundle.file), { force: true }).catch(() => {})
  await rm(join(moveDir(m.orgId), m.files.file), { force: true }).catch(() => {})
  logger.info({ orgId: String(m.orgId), nodeId: m.to, epoch: m.epochTo }, 'Move: the org\'s home is its master now')
  return true
}

/** The master could not take the copy: the move ends, and global unfreezes. */
export async function copyFailed(nodeId: string, moveId: string, reason: string) {
  const m = await OrgMove.exists({ _id: oid(moveId), to: nodeId, state: { $in: ['copying', 'verifying'] } })
  if (!m) throw new MoveError(409, 'not_copying', 'The move is not waiting for this server.')
  return abortMove(moveId, `the server could not take the copy: ${reason}`)
}
