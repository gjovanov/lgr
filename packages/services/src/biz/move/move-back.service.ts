/**
 * Moving an org from its master back to lgrai.app (FR-20.80, plan step P3-6c, Part A.6.9): global's
 * side. The org's data never travels as a copy: global's mirror already holds it, and the move waits
 * until the mirror holds ALL of it.
 *
 * 1. **Preflight** (`preflightMoveBack`): the org's home is one of its servers, registered, at Full,
 *    connected and healthy, with no till open and no fiscal command in flight there; its mirror is
 *    live; every file the mirror's rows name is on lgrai.app or on its way (one the server cannot send
 *    blocks the move unless the admin leaves it behind).
 * 2. **Asked** (`startMoveBack`, state `freezing`): the master's move worker freezes the org there,
 *    waits until its last writes are captured, and reports its journal head (`drained`).
 * 3. **Drained** (state `copying`): global answers what it still waits for: its pages up to that head,
 *    every file (a records-only org sends them now), then the master's digests of what it holds,
 *    compared ORDER-INSENSITIVELY with the mirror's over the home's parts (`home-digest.ts`).
 * 4. **Verified** (state `verifying`): the scheduler's tick puts every file back where its row says
 *    (`placeFilesBack`), since global reads an org homed here by path, then flips.
 * 5. **The flip**, in one transaction that first claims the move: the epoch up by one, the home
 *    global, `homeEpochHighWater` with it, the mirror's chain deleted. The master leaves the org on its
 *    next report and keeps a read-only copy. The answer that tells it carries one signed cloud
 *    re-point per desktop of the org (FR-20.82), which the master hands on: its desktops are connected
 *    to it, not here.
 *
 * Until the flip, an abort leaves the home where it was: the master unfreezes on its next report.
 * ⚠ The org's audit trail is written on the master (it is the org's data, and the master is its home
 * until the flip): global writes none of it here.
 */
import type { mongo } from 'mongoose'
import { mongoose } from 'db/connection'
import { LIVE_MOVE_STATES, MirrorState, Org, OrgHome, OrgMove, POSSession, ServerNode } from 'db/models'
import { forgetHome, homeOf } from 'db/home/home'
import { logger } from '../../logger/logger.js'
import { presenceOfNodes } from '../node/node.service.js'
import { cloudRepointsFor } from '../desktop/repoint.service.js'
import { dropMirrorBlobs, mirrorFilesStatus, placeFilesBack, type MirrorFilesStatus } from '../replication/mirror-blobs.js'
import { homeDigests } from './home-digest.js'
import { digestMismatch, type Digests } from './move-bundle.js'
import { MoveError, abortMove, type PreflightCheck } from './move.service.js'

type ObjectId = mongo.ObjectId

/** How old a master's health may be for it to count as live. */
const HEALTH_FRESH_MS = 3 * 60_000
/** A master that never froze the org for the move: given up after this. */
export const FREEZE_WAIT_MS = 30 * 60_000
/** A mirror that never drained: given up after this (files may be large; a slow uplink is slow). */
export const DRAIN_WAIT_MS = 6 * 3600_000

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v)) as unknown as ObjectId
const step = (name: string, ok = true, detail?: string) => ({ name, at: new Date(), ok, ...(detail ? { detail: detail.slice(0, 500) } : {}) })

/** FR-20.80 step 1. Every check, so the admin sees all of what stands in the way at once. */
export async function preflightMoveBack(orgId: string, allowMissingFiles = false): Promise<{ ok: boolean; checks: PreflightCheck[]; files: MirrorFilesStatus; nodeId: string | null }> {
  const org = oid(orgId)
  const checks: PreflightCheck[] = []
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) })

  const home = await homeOf(org, { fresh: true })
  const nodeId = home.home === 'global' ? null : home.home
  add('home_master', !!nodeId && home.state === 'active', nodeId ? `the org is ${home.state} on its server` : 'the org already lives on lgrai.app')
  add('no_move', !(await OrgMove.exists({ orgId: org, state: { $in: [...LIVE_MOVE_STATES] } })), 'another move of this org is under way')

  const node: any = nodeId ? await ServerNode.findById(nodeId).lean() : null
  add('registered', !!node && node.status === 'active' && (node.orgIds ?? []).some((id: unknown) => String(id) === orgId), 'the server is not registered for this organisation')
  add('full', node?.linkLevel === 'full', `the server is linked at ${node?.linkLevel ?? 'nothing'}: a move back needs Full`)
  add('no_clone_alarm', !node?.cloneAlarm?.at, 'two machines answer as this server')
  const live = nodeId ? (await presenceOfNodes([nodeId])).get(nodeId) : undefined
  add('connected', !!live?.interactive && !!live?.bulk, 'the server is not connected on both of its sockets')
  const at = node?.health?.at ? new Date(node.health.at).getTime() : 0
  add('healthy', Date.now() - at <= HEALTH_FRESH_MS && node?.health?.api?.ok === true, at ? 'the server\'s API does not report healthy' : 'the server has sent no health report')
  // What the server itself says (its health, a minute old at most), and what its pages brought here.
  const tillsOpen = await POSSession.exists({ orgId: org, status: { $in: ['opening_control', 'open', 'closing_control'] } })
  add('no_till_open', node?.health?.api?.posOpen === 0 && !tillsOpen, node?.health?.api?.posOpen == null ? 'the server cannot say whether a till is open' : 'a till session is open on the server: close it first')
  add('no_fiscal_command', node?.health?.api?.fiscalInFlight === 0, 'a fiscal device is printing on the server, or the server cannot say')

  const mirror: any = await MirrorState.findOne({ orgId: org }, { watermark: 1, reconcileRequired: 1 }).lean()
  add('mirror_live', !!mirror && !mirror.reconcileRequired, mirror ? 'the mirror waits for a reconcile (a new journal epoch on the server)' : 'the server has not mirrored this organisation yet')

  const files = await mirrorFilesStatus(orgId)
  const lost = files.missingOnMaster + files.failing
  add('files', lost === 0 || allowMissingFiles, `${lost} files are not on lgrai.app, and the server cannot send them`)
  return { ok: checks.every(c => c.ok), checks, files, nodeId }
}

/** Start the move back: global records it, and the master freezes the org on its next report (step 2). */
export async function startMoveBack(orgId: string, by: { id: string }, opts: { allowMissingFiles?: boolean } = {}) {
  const pre = await preflightMoveBack(orgId, !!opts.allowMissingFiles)
  if (!pre.ok || !pre.nodeId) throw new MoveError(409, 'preflight_failed', 'The move back cannot start yet.', { checks: pre.checks, files: pre.files })
  const org = oid(orgId)
  const home = await homeOf(org, { fresh: true })
  try {
    const move = await OrgMove.create({
      orgId: org, kind: 'to_global', state: 'freezing', from: pre.nodeId, to: 'global', epochFrom: home.epoch, epochTo: home.epoch + 1,
      startedBy: oid(by.id), startedAt: new Date(), allowMissing: [], allowMissingFiles: !!opts.allowMissingFiles,
      steps: [step('preflight', true, `${pre.checks.length} checks`), step('asked', true, `the server ${pre.nodeId} freezes the organisation`)],
    })
    logger.info({ orgId, nodeId: pre.nodeId, moveId: String(move._id) }, 'Move back: asked; the server freezes the organisation')
    return move.toObject()
  } catch (e: any) {
    if (e?.code === 11000) throw new MoveError(409, 'move_in_progress', 'Another move of this organisation is under way.')
    throw e
  }
}

export interface DrainReport {
  /** The org's journal head on the master, once its last writes are captured. */
  head: number
  journalEpoch?: number
  /** The master's `homeDigests`, sent once global asks for them (`need: 'digests'`). */
  digests?: Digests
}

export type DrainAnswer =
  | { ok: true; epoch: number; orgId: string; repoints?: Array<{ desktopId: string; instruction: string }> }
  | { ok: false; state: 'aborted'; error?: string }
  | { wait: 'pages'; watermark: number; head: number }
  | { wait: 'files'; files: MirrorFilesStatus }
  | { need: 'digests' }
  | { wait: 'digests'; mismatch: string[] }
  | { wait: 'placing' }

async function waitOn(m: any, on: string, detail?: string) {
  if (m.waiting?.on === on) return
  await OrgMove.updateOne({ _id: m._id, state: { $in: ['freezing', 'copying'] } }, { $set: { waiting: { on, since: new Date(), ...(detail ? { detail: detail.slice(0, 500) } : {}) } }, $push: { steps: step(`waiting_${on}`, true, detail) } })
}

/**
 * The master is frozen and has captured its last writes (FR-20.80 step 2): what global still waits
 * for, or the flip's outcome once it ran. Sent again on every one of the master's ticks.
 */
export async function drained(nodeId: string, moveId: string, report: DrainReport): Promise<DrainAnswer> {
  const m: any = await OrgMove.findOne({ _id: oid(moveId), kind: 'to_global', from: nodeId }).lean()
  if (!m) throw new MoveError(404, 'not_found', 'No such move back for this server.')
  // Signed afresh on every answer: they last 30 days, and the master may ask again after a restart.
  if (m.state === 'done') return { ok: true, epoch: m.epochTo, orgId: String(m.orgId), repoints: await cloudRepointsFor(String(m.orgId), m.epochTo) }
  if (m.state === 'aborted') return { ok: false, state: 'aborted', ...(m.error ? { error: m.error } : {}) }
  if (m.state === 'verifying') return { wait: 'placing' }
  if (!Number.isSafeInteger(report?.head) || report.head < 0) throw new MoveError(422, 'bad_report', 'A drain report names the journal head.')
  if (m.state === 'freezing') {
    await OrgMove.updateOne({ _id: m._id, state: 'freezing' }, { $set: { state: 'copying', drainedAt: new Date(), head: report.head, ...(report.journalEpoch ? { journalEpoch: report.journalEpoch } : {}) }, $push: { steps: step('frozen', true, `journal head ${report.head}`) } })
  } else if (report.head !== m.head) {
    await OrgMove.updateOne({ _id: m._id }, { $set: { head: report.head } })
  }

  // The mirror holds every page up to the frozen head, of the same journal.
  const st: any = await MirrorState.findOne({ orgId: m.orgId }, { watermark: 1, journalEpoch: 1 }).lean()
  const watermark = st?.watermark ?? 0
  if (watermark < report.head || (report.journalEpoch && st?.journalEpoch && st.journalEpoch !== report.journalEpoch)) {
    await waitOn(m, 'pages', `${watermark} of ${report.head}`)
    return { wait: 'pages', watermark, head: report.head }
  }
  // Every file its rows name, or every one the server can still send when the admin left the rest.
  const files = await mirrorFilesStatus(String(m.orgId))
  if (!files.complete && (!m.allowMissingFiles || files.waiting + files.arriving > 0)) {
    await waitOn(m, 'files', `${files.held} of ${files.referenced}`)
    return { wait: 'files', files }
  }
  if (!report.digests) return { need: 'digests' }
  // ⚠ Order-insensitive, over the home's parts: the mirror orders split documents its own way.
  const bad = digestMismatch(await homeDigests(mongoose.connection.db as any, m.orgId), report.digests)
  if (bad.length) {
    await waitOn(m, 'digests', bad.join(', '))
    return { wait: 'digests', mismatch: bad }
  }
  await OrgMove.updateOne({ _id: m._id, state: 'copying' }, { $set: { state: 'verifying', verifiedAt: new Date() }, $unset: { waiting: '' }, $push: { steps: step('verified', true, `${Object.keys(report.digests).length} collections equal, ${files.held} files`) } })
  logger.info({ orgId: String(m.orgId), moveId, head: report.head }, 'Move back: the mirror holds everything; its files go back in place')
  return { wait: 'placing' }
}

/**
 * The scheduler's tick for moves back: a verified one gets its files put back and its flip; one whose
 * master never froze, or whose mirror never drained, is given up. Each transition claimed by a
 * conditional update, so two pods never run one twice.
 */
export async function moveBackTick(now = new Date(), hooks: { flippedBack?: (nodeId: string, orgId: string) => void } = {}): Promise<number> {
  let acted = 0
  for (const m of (await OrgMove.find({ kind: 'to_global', state: { $in: ['freezing', 'copying'] } }).lean()) as any[]) {
    const since = m.state === 'freezing' ? m.startedAt : m.drainedAt ?? m.startedAt
    const limit = m.state === 'freezing' ? FREEZE_WAIT_MS : DRAIN_WAIT_MS
    if (now.getTime() - new Date(since).getTime() > limit) {
      await abortMove(String(m._id), m.state === 'freezing' ? 'the server never froze the organisation' : `the mirror never caught up (${m.waiting?.on ?? 'unknown'}: ${m.waiting?.detail ?? ''})`).catch(() => {})
      acted++
    }
  }
  for (;;) {
    // A placement that died half-way is taken again after ten minutes; it is idempotent.
    const m: any = await OrgMove.findOneAndUpdate(
      { kind: 'to_global', state: 'verifying', $or: [{ placingAt: { $exists: false } }, { placingAt: { $lt: new Date(now.getTime() - 10 * 60_000) } }] },
      { $set: { placingAt: now } },
      { new: true },
    ).lean()
    if (!m) break
    acted++
    try {
      const placed = await placeFilesBack(String(m.orgId))
      if (placed.missing && !m.allowMissingFiles) throw new Error(`${placed.missing} files are not on lgrai.app to put back`)
      await OrgMove.updateOne({ _id: m._id }, { $set: { placed: { placed: placed.placed, present: placed.present, missing: placed.missing } }, $push: { steps: step('files_placed', true, `${placed.placed} placed, ${placed.present} already there, ${placed.missing} left behind, ${placed.conflicts} conflicting rows`) } })
      if (await flipBack(m)) {
        hooks.flippedBack?.(m.from, String(m.orgId))
        // Every file is where its row says now: the content store has done its work.
        const dropped = await dropMirrorBlobs(String(m.orgId)).catch(() => 0)
        logger.info({ orgId: String(m.orgId), nodeId: m.from, epoch: m.epochTo, blobs: dropped }, 'Move back: lgrai.app is the organisation\'s home again')
      }
    } catch (e: any) {
      logger.error({ moveId: String(m._id), err: e?.message ?? String(e) }, 'Move back: the files could not be put back')
      await abortMove(String(m._id), `the files could not be put back: ${e?.message ?? e}`).catch(() => {})
    }
  }
  return acted
}

/**
 * FR-20.80 steps 4–6, in one transaction that first claims the move: a flip that lost to an abort, or
 * a second one, changes nothing.
 */
async function flipBack(m: any): Promise<boolean> {
  const session = await mongoose.startSession()
  let flipped = false
  try {
    await session.withTransaction(async () => {
      flipped = false
      const now = new Date()
      const claimed = await OrgMove.updateOne({ _id: m._id, state: 'verifying' }, { $set: { state: 'done', endedAt: now }, $push: { steps: { $each: [step('flip', true, `epoch ${m.epochTo}, home lgrai.app`), step('done')] } } }, { session })
      if (!claimed.modifiedCount) return
      await OrgHome.updateOne({ orgId: m.orgId }, { $set: { home: 'global', epoch: m.epochTo, state: 'active', since: now, changedBy: String(m.startedBy) } }, { session, upsert: true })
      await Org.collection.updateOne({ _id: m.orgId }, { $set: { homeEpochHighWater: m.epochTo } }, { session })
      // No more pages: the org is written here again.
      await mongoose.connection.db!.collection('mirror_state').deleteOne({ orgId: m.orgId }, { session })
      flipped = true
    })
  } finally {
    await session.endSession()
  }
  if (flipped) forgetHome(m.orgId)
  return flipped
}
