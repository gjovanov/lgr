/**
 * Re-seeding a master from lgrai.app's mirror (FR-20.71, plan step P3-7, AC 36): global's side.
 *
 * A master whose database went back underneath the mirror (a restore, a reverted disk) cannot continue
 * the mirror's chain, and its legal numbering is locked (`series-lock.service.ts`). The mirror is the
 * newest complete copy of the org there is, and it knows every delete made since the backup, so the
 * org's admin re-seeds the master FROM it: the master's copy of the org is REPLACED, never merged.
 * Merging only what it "lacks or holds older" would bring back drafts, reservations and files deleted
 * since the backup.
 *
 * 1. **Preflight** (`preflightReseed`): every check at once. The org's home is the server, active; no
 *    other move; the server registered at Full, with no clone alarm (which machine is real is decided
 *    first) and its seal key known; connected on both sockets, healthy, with room, no till open and no
 *    fiscal command printing; the mirror holds the org; and the server's database WENT BACK, as the
 *    server says (its org-state report) or the mirror's refusal of its history shows. ⚠ Re-seeding a
 *    server that did not go back would replace what it holds with an older copy.
 * 2. **Start** (`startReseed`, the slug typed): `org_moves {kind: 'reseed', state: 'copying'}`, the
 *    home's epoch at both ends: the home does not change. Nothing freezes here: global writes none of
 *    a master's org.
 * 3. **The copy** (`moveTick` → `buildReseedCopy`): the move bundle of global's MIRROR of the org, the
 *    people's local credentials sealed to the server's key, and a files sidecar from the mirror's
 *    content store, at the paths its rows name.
 * 4. **The server** (`move-worker.service.ts#reseedHere`) checks again that its database went back,
 *    freezes the org, keeps everything it is about to replace (for good: what it wrote that the
 *    mirror never received exists only there and on paper), replaces it with the copy, puts the files
 *    in place, and reports its digests and what it held that the copy lacked.
 * 5. **The flip** (`reseedCopied`): the server's digests equal the copy's; one transaction claims the
 *    move and deletes the mirror's chain (`mirror_state`), so the server's pages start a new one from
 *    0. They re-send what the mirror holds, unchanged, and tombstones only for what it never held:
 *    nothing on the mirror is deleted (FR-20.51). The server's bulk socket is welcomed again.
 *
 * Legal numbering stays locked: what the server issued after its last page and before the failure is
 * on paper and in the fiscal device only, so a person still records the last numbers, on the server.
 * ⚠ The org's audit trail is the server's to write (the org is home there): global writes none of it.
 */
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import type { mongo } from 'mongoose'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { LIVE_MOVE_STATES, MirrorState, Org, OrgMove, ServerNode } from 'db/models'
import { homeOf } from 'db/home/home'
import { logger } from '../../logger/logger.js'
import { isSealPublicKey } from '../crypto/node-seal.js'
import { sealedCredentialsForMove } from '../identity/onprem-credentials.service.js'
import { presenceOfNodes } from '../node/node.service.js'
import { buildMirrorFilesSidecar, mirrorFilesStatus, type MirrorFilesStatus } from '../replication/mirror-blobs.js'
import { digestMismatch, writeMoveBundle } from './move-bundle.js'
import { MoveError, abortMove, type CopyReport, type PreflightCheck } from './move.service.js'

type ObjectId = mongo.ObjectId

/** How old a master's health may be for it to count as live. */
const HEALTH_FRESH_MS = 3 * 60_000
/** The least free disk a master needs to take the copy (a floor; the copy is compressed). */
const MIN_FREE_BYTES = 1024 ** 3
/** The mirror's refusals that mean the master's history went back (`series-lock.service#WENT_BACK_REFUSALS`). */
const WENT_BACK: ReadonlySet<string> = new Set(['instance_changed', 'stale_journal', 'diverged'])

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v)) as unknown as ObjectId
const step = (name: string, ok = true, detail?: string) => ({ name, at: new Date(), ok, ...(detail ? { detail: detail.slice(0, 500) } : {}) })
const moveDir = (orgId: unknown) => join(config.upload.dir, String(orgId), 'backups', 'moves')

export interface ReseedPreflight {
  ok: boolean
  checks: PreflightCheck[]
  nodeId: string | null
  /** Why the server's database is said to have gone back, and since when. */
  wentBack: { at?: Date | string; reason: string; detail?: string } | null
  /** The last page the mirror applied: the copy holds the org up to there. */
  lastPageAt: string | null
  files: MirrorFilesStatus
}

/** FR-20.71. Every check, so the admin sees all of what stands in the way at once. Writes nothing. */
export async function preflightReseed(orgId: string): Promise<ReseedPreflight> {
  const org = oid(orgId)
  const checks: PreflightCheck[] = []
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) })

  const home = await homeOf(org, { fresh: true })
  const nodeId = home.home === 'global' ? null : home.home
  add('home_master', !!nodeId && home.state === 'active', nodeId ? `the organisation is ${home.state} on its server` : 'the organisation lives on lgrai.app: there is no server to re-seed')
  add('no_move', !(await OrgMove.exists({ orgId: org, state: { $in: [...LIVE_MOVE_STATES] } })), 'another move of this organisation is under way')

  const node: any = nodeId ? await ServerNode.findById(nodeId).lean() : null
  add('registered', !!node && node.status === 'active' && (node.orgIds ?? []).some((id: unknown) => String(id) === orgId), 'the server is not registered for this organisation')
  add('full', node?.linkLevel === 'full', `the server is linked at ${node?.linkLevel ?? 'nothing'}: a re-seed needs Full`)
  add('no_clone_alarm', !node?.cloneAlarm?.at, 'two machines answer as this server: decide which one is real first')
  add('seal_key', isSealPublicKey(node?.sealKey), 'the server has not given lgrai.app its seal key yet: its people\'s local credentials could not travel')
  const live = nodeId ? (await presenceOfNodes([nodeId])).get(nodeId) : undefined
  add('connected', !!live?.interactive && !!live?.bulk, 'the server is not connected on both of its sockets')
  const at = node?.health?.at ? new Date(node.health.at).getTime() : 0
  add('healthy', Date.now() - at <= HEALTH_FRESH_MS && node?.health?.api?.ok === true, at ? 'the server\'s API does not report healthy' : 'the server has sent no health report')
  const free = Number(node?.health?.disk?.freeBytes ?? 0)
  add('disk', free >= MIN_FREE_BYTES, `the server has ${Math.round(free / 1024 ** 2)} MB free`)
  add('no_till_open', node?.health?.api?.posOpen === 0, node?.health?.api?.posOpen == null ? 'the server cannot say whether a till is open' : 'a till session is open on the server: close it first')
  add('no_fiscal_command', node?.health?.api?.fiscalInFlight === 0, 'a fiscal device is printing on the server, or the server cannot say')

  const mirror: any = await MirrorState.findOne({ orgId: org }, { chainHash: 1, lastPageAt: 1, lastRefusal: 1 }).lean()
  add('mirror', !!mirror?.chainHash, 'lgrai.app holds no copy of this organisation to re-seed from')
  // What the server says of itself (P3-7c), or the mirror's own refusal of its history.
  const said = (node?.orgState ?? []).find((s: any) => String(s.orgId) === orgId)?.wentBack
  const r = mirror?.lastRefusal
  const refused = r && WENT_BACK.has(r.reason) && (!mirror.lastPageAt || new Date(r.at) > new Date(mirror.lastPageAt))
    ? { at: r.at, reason: r.reason, ...(r.detail ? { detail: r.detail } : {}) }
    : null
  const wentBack = said?.reason ? { ...(said.at ? { at: said.at } : {}), reason: said.reason, ...(said.detail ? { detail: said.detail } : {}) } : refused
  add('went_back', !!wentBack, 'the server\'s database did not go back: a re-seed would replace what it holds with lgrai.app\'s copy, which is no newer')
  return {
    ok: checks.every(c => c.ok),
    checks,
    nodeId,
    wentBack,
    lastPageAt: mirror?.lastPageAt ? new Date(mirror.lastPageAt).toISOString() : null,
    files: await mirrorFilesStatus(orgId),
  }
}

/** Start the re-seed: the slug typed, every check passing. Global builds the copy on its next tick. */
export async function startReseed(orgId: string, by: { id: string }, slug: string, now = new Date()) {
  const org: any = await Org.findById(oid(orgId), { slug: 1 }).lean()
  if (!org || slug !== org.slug) throw new MoveError(422, 'slug_mismatch', 'Type the organisation\'s address name exactly to confirm.')
  const pre = await preflightReseed(orgId)
  if (!pre.ok || !pre.nodeId) throw new MoveError(409, 'preflight_failed', 'The re-seed cannot start yet.', { checks: pre.checks })
  const home = await homeOf(oid(orgId), { fresh: true })
  try {
    const move = await OrgMove.create({
      orgId: oid(orgId), kind: 'reseed', state: 'copying', from: 'global', to: pre.nodeId, epochFrom: home.epoch, epochTo: home.epoch,
      startedBy: oid(by.id), startedAt: now, allowMissing: [],
      // Never built: `moveTick` takes it as a build that died long ago.
      buildingAt: new Date(0),
      steps: [step('preflight', true, `${pre.checks.length} checks`), step('asked', true, `the server went back (${pre.wentBack?.reason ?? 'unknown'})`)],
    })
    logger.warn({ orgId, nodeId: pre.nodeId, moveId: String(move._id), wentBack: pre.wentBack?.reason }, 'Re-seed: asked; lgrai.app builds its copy for the server')
    return move.toObject()
  } catch (e: any) {
    if (e?.code === 11000) throw new MoveError(409, 'move_in_progress', 'Another move of this organisation is under way.')
    throw e
  }
}

/**
 * The copy (step 3): the bundle of global's mirror of the org, and its files from the content store.
 * `move` is claimed by `moveTick` (`buildingAt`), so two pods never build one.
 */
export async function buildReseedCopy(move: any): Promise<void> {
  const orgId: ObjectId = move.orgId
  const home = await homeOf(orgId, { fresh: true })
  if (home.home !== move.to || home.state !== 'active') throw new Error('the organisation is no longer written on that server')
  const node: any = await ServerNode.findById(move.to).lean()
  if (!node) throw new Error('the server is no longer registered')
  const credentials = await sealedCredentialsForMove(node, String(orgId))
  const dir = moveDir(orgId)
  const bundle = await writeMoveBundle(mongoose.connection.db as any, orgId, join(dir, `move-${String(move._id)}.ndjson.zst`), { credentials })
  const files = await buildMirrorFilesSidecar(String(orgId), `move-${String(move._id)}`)
  const kept = await OrgMove.updateOne(
    { _id: move._id, state: 'copying' },
    {
      $set: {
        bundle: { file: bundle.file, sha256: bundle.sha256, bytes: bundle.bytes, documents: bundle.documents, people: bundle.people, credentials: bundle.credentials },
        files: { file: files.filename, sha256: files.sha256, bytes: files.bytes, count: files.count },
        digests: bundle.digests,
      },
      $push: { steps: step('copy', true, `${bundle.documents} documents of lgrai.app's copy, ${bundle.people} people, ${bundle.credentials} credentials, ${files.count} files${files.missing ? `, ${files.missing} files lgrai.app does not hold` : ''}`) },
    },
  )
  if (!kept.matchedCount) {
    // Aborted while it was built: the abort found nothing to delete, so it goes now.
    await rm(join(dir, bundle.file), { force: true }).catch(() => {})
    await rm(files.absolutePath, { force: true }).catch(() => {})
    return
  }
  logger.info({ moveId: String(move._id), documents: bundle.documents, files: files.count, missing: files.missing }, 'Re-seed: the copy of lgrai.app\'s mirror is ready for the server')
}

/** What the server says it replaced (step 4), as it reports its digests. */
export interface ReplacedReport {
  file: string
  documents: number
  onlyThere: number
  sales: number
  salesNumbers: string[]
}

/**
 * The server replaced its copy of the org and answers with its digests (step 5). Equal to the copy's,
 * with every person and credential: the flip. ⚠ Compared with the copy's own digests, never with the
 * mirror's as it is now: global's own fields of a split document (an Org's billing, say) may change
 * meanwhile, and the copy is what the server was given. `m` is claimed `verifying` by `copied`.
 */
export async function reseedCopied(m: any, theirs: CopyReport & { replaced?: ReplacedReport }) {
  const bad = digestMismatch(m.digests ?? {}, theirs?.digests ?? {})
  if (theirs?.people !== (m.bundle?.people ?? 0)) bad.push('people')
  if (theirs?.credentials !== (m.bundle?.credentials ?? 0)) bad.push('credentials')
  const replaced = theirs?.replaced
    ? {
        file: String(theirs.replaced.file ?? '').slice(0, 300),
        documents: Number(theirs.replaced.documents) || 0,
        onlyThere: Number(theirs.replaced.onlyThere) || 0,
        sales: Number(theirs.replaced.sales) || 0,
        salesNumbers: (Array.isArray(theirs.replaced.salesNumbers) ? theirs.replaced.salesNumbers : []).slice(0, 50).map(s => String(s).slice(0, 60)),
      }
    : undefined
  if (replaced) {
    await OrgMove.updateOne({ _id: m._id }, { $set: { replaced }, $push: { steps: step('replaced', true, `${replaced.documents} documents kept on the server; ${replaced.onlyThere} not in lgrai.app's copy, ${replaced.sales} of them issued sales`) } })
  }
  if (bad.length) {
    await abortMove(String(m._id), `the server's copy differs from lgrai.app's in ${bad.join(', ')}`)
    return { ok: false, mismatch: bad }
  }
  if (await flipReseed(m)) return { ok: true, epoch: m.epochTo, orgId: String(m.orgId), kind: 'reseed' }
  const now: any = await OrgMove.findById(m._id, { state: 1 }).lean()
  return now?.state === 'done' ? { ok: true, epoch: m.epochTo, orgId: String(m.orgId), kind: 'reseed' } : { ok: false, state: now?.state ?? 'gone' }
}

/**
 * The flip, in one transaction that first claims the move: the mirror's chain goes, so the server's
 * pages start a new one from 0. Its documents stay as they are: the mirror loses nothing.
 */
async function flipReseed(m: any): Promise<boolean> {
  const session = await mongoose.startSession()
  let flipped = false
  try {
    await session.withTransaction(async () => {
      flipped = false
      const now = new Date()
      const claimed = await OrgMove.updateOne({ _id: m._id, state: 'verifying' }, { $set: { state: 'done', endedAt: now }, $push: { steps: { $each: [step('flip', true, 'the mirror\'s chain starts again from the server\'s copy'), step('done')] } } }, { session })
      if (!claimed.modifiedCount) return
      await mongoose.connection.db!.collection('mirror_state').deleteOne({ orgId: m.orgId }, { session })
      flipped = true
    })
  } finally {
    await session.endSession()
  }
  if (!flipped) return false
  await rm(join(moveDir(m.orgId), m.bundle.file), { force: true }).catch(() => {})
  await rm(join(moveDir(m.orgId), m.files.file), { force: true }).catch(() => {})
  logger.warn({ orgId: String(m.orgId), nodeId: m.to }, 'Re-seed: the server holds lgrai.app\'s copy again; the mirror\'s chain starts again from it')
  return true
}
