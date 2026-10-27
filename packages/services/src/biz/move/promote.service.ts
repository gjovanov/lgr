/**
 * Promoting the mirror when an org's master is lost for good (FR-20.81, plan step P3-6d): global's
 * side.
 *
 * The danger is not lost data: it is a master that is only cut off, still issuing invoices in the
 * shop from a counter above the mirror's, while global issues the same numbers to other customers.
 * So a promotion takes evidence, not a confirmation, and leaves the legal series frozen:
 * - **Evidence.**
 *   - The admin attests that the master PC is off, or destroyed, and that its tills are disconnected.
 *   - The master must have been silent for 24 h, unless the hardware is attested destroyed.
 *   - The admin types the org's slug.
 *   - The dialog shows the loss window: the mirror holds the org up to its last page.
 * - **The flip** (`moveBackTick`, as for a move back): whatever files global holds go back where
 *   their rows say, then one transaction: the epoch up by one, the home global, the mirror's chain
 *   deleted, and the legal series FROZEN (`OrgHome.seriesFrozen`).
 * - **The last numbers.** A person records, per legal series, the last number issued at the site
 *   (from the last printed documents and the fiscal device's report). Each series resumes above the
 *   higher of that and the mirror's (`recordLastNumbers`), and only then is numbering open again.
 * - **If the old master comes back,** it fences itself at the move's `fenceCutoff`
 *   (`move-worker.service.ts`): it writes nothing more for the org, and what it captured above the
 *   cutoff waits for the export (FR-20.84, P3-6e).
 */
import type { mongo } from 'mongoose'
import { mongoose } from 'db/connection'
import { LIVE_MOVE_STATES, MirrorState, Org, OrgHome, OrgMove, Sequence, ServerNode } from 'db/models'
import { homeOf } from 'db/home/home'
import { logger } from '../../logger/logger.js'
import { recordAuditEntry } from '../audit-log.service.js'
import { presenceOfNodes } from '../node/node.service.js'
import { mirrorFilesStatus, type MirrorFilesStatus } from '../replication/mirror-blobs.js'
import { LEGAL_SERIES, ensureSequenceAtLeast, isLegalSeries } from '../sequence.service.js'
import { MoveError, type PreflightCheck } from './move.service.js'
import { resetJournalHwm } from '../home/series-lock.service.js'

type ObjectId = mongo.ObjectId

/** How long a master must have been silent before its mirror may be promoted, unless destroyed. */
export const SILENCE_MS = 24 * 3600_000

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v)) as unknown as ObjectId
const step = (name: string, ok = true, detail?: string) => ({ name, at: new Date(), ok, ...(detail ? { detail: detail.slice(0, 500) } : {}) })

export interface PromotePreflight {
  ok: boolean
  checks: PreflightCheck[]
  nodeId: string | null
  /** The last change the mirror holds: anything the server wrote after it is not on lgrai.app. */
  lossFrom: string | null
  /** Since when the server has not been heard from, and whether that is the 24 h a promotion needs. */
  silenceSince: string | null
  silentLongEnough: boolean
  files: MirrorFilesStatus
}

/** FR-20.81. Every check at once; the silence is the attestation's to waive (hardware destroyed). */
export async function preflightPromote(orgId: string, now = new Date()): Promise<PromotePreflight> {
  const org = oid(orgId)
  const checks: PreflightCheck[] = []
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) })
  const home = await homeOf(org, { fresh: true })
  const nodeId = home.home === 'global' ? null : home.home
  add('home_master', !!nodeId, 'the organisation lives on lgrai.app: there is nothing to promote')
  add('no_move', !(await OrgMove.exists({ orgId: org, state: { $in: [...LIVE_MOVE_STATES] } })), 'another move of this org is under way')
  const live = nodeId ? (await presenceOfNodes([nodeId])).get(nodeId) : undefined
  // A server that answers moves the org back instead: promotion is for one that is gone.
  add('disconnected', !live?.interactive && !live?.bulk, 'the server is connected: move the organisation back instead')
  const mirror: any = await MirrorState.findOne({ orgId: org }, { lastPageAt: 1, watermark: 1 }).lean()
  add('mirror', !!mirror, 'lgrai.app holds no mirror of this organisation to promote')
  const node: any = nodeId ? await ServerNode.findById(nodeId, { lastSeenAt: 1 }).lean() : null
  const silenceSince = node?.lastSeenAt ? new Date(node.lastSeenAt) : null
  const silentLongEnough = !silenceSince || now.getTime() - silenceSince.getTime() >= SILENCE_MS
  return {
    ok: checks.every(c => c.ok),
    checks,
    nodeId,
    lossFrom: mirror?.lastPageAt ? new Date(mirror.lastPageAt).toISOString() : null,
    silenceSince: silenceSince ? silenceSince.toISOString() : null,
    silentLongEnough,
    files: await mirrorFilesStatus(orgId),
  }
}

export interface PromoteEvidence {
  hardware: 'off' | 'destroyed'
  tillsDisconnected: boolean
  /** The org's slug, typed by the admin. */
  slug: string
}

/** Promote the mirror: the move is recorded verified, and the move-back tick places the files and flips. */
export async function promote(orgId: string, by: { id: string }, evidence: PromoteEvidence, now = new Date()) {
  const pre = await preflightPromote(orgId, now)
  if (!pre.ok || !pre.nodeId) throw new MoveError(409, 'preflight_failed', 'The mirror cannot be promoted.', { checks: pre.checks })
  const org: any = await Org.findById(orgId, { slug: 1 }).lean()
  if (!org || evidence.slug !== org.slug) throw new MoveError(422, 'slug_mismatch', 'Type the organisation\'s address name exactly to confirm.')
  if (evidence.tillsDisconnected !== true) throw new MoveError(422, 'tills_connected', 'The tills must be disconnected from the server first.')
  if (evidence.hardware !== 'destroyed' && !pre.silentLongEnough) {
    throw new MoveError(409, 'not_silent_long_enough', 'The server has been silent for less than 24 hours: wait, or attest that it is destroyed.', { silenceSince: pre.silenceSince })
  }
  const home = await homeOf(orgId, { fresh: true })
  const mirror: any = await MirrorState.findOne({ orgId }, { watermark: 1, journalEpoch: 1 }).lean()
  try {
    const move = await OrgMove.create({
      orgId: oid(orgId), kind: 'promote', state: 'verifying', from: pre.nodeId, to: 'global', epochFrom: home.epoch, epochTo: home.epoch + 1,
      startedBy: oid(by.id), startedAt: now, verifiedAt: now, allowMissing: [],
      // Whatever files global holds is what it gets: the server is gone.
      allowMissingFiles: true,
      evidence: { hardware: evidence.hardware, tillsDisconnected: true, ...(pre.silenceSince ? { silenceSince: new Date(pre.silenceSince) } : {}), attestedAt: now },
      ...(pre.lossFrom ? { lossFrom: new Date(pre.lossFrom) } : {}),
      fenceCutoff: mirror?.watermark ?? 0,
      ...(typeof mirror?.journalEpoch === 'number' ? { fenceJournalEpoch: mirror.journalEpoch } : {}),
      steps: [step('preflight', true, `${pre.checks.length} checks`), step('attested', true, `${evidence.hardware}, tills disconnected, silent since ${pre.silenceSince ?? 'never seen'}`)],
    })
    logger.warn({ orgId, nodeId: pre.nodeId, moveId: String(move._id), hardware: evidence.hardware, lossFrom: pre.lossFrom }, 'Promotion: the mirror becomes the home; legal numbering freezes until the site\'s last numbers are recorded')
    return move.toObject()
  } catch (e: any) {
    if (e?.code === 11000) throw new MoveError(409, 'move_in_progress', 'Another move of this organisation is under way.')
    throw e
  }
}

export interface LegalSeries {
  prefix: string
  year: number
  /** What lgrai.app's counter says: the mirror's highest, or what was recorded. */
  last: number
}

/** The org's legal series: what a person must give the last site number of. This year's always. */
export async function legalSeriesOf(orgId: string, now = new Date()): Promise<LegalSeries[]> {
  const rows: any[] = await Sequence.find({ orgId, $or: [{ prefix: { $in: [...LEGAL_SERIES] } }, { prefix: { $regex: '^UNP-' } }] }, { prefix: 1, year: 1, lastNumber: 1 }).lean()
  const out = new Map<string, LegalSeries>()
  for (const r of rows) {
    const unp = String(r.prefix).startsWith('UNP-')
    // A display override lives on a year-0 row of a yearly series: not a counter.
    if (!unp && r.year === 0) continue
    // A legacy per-operator УНП counter is not a series of its own (migration 0001).
    if (unp && !/^UNP-[^-]{8}$/.test(r.prefix)) continue
    out.set(`${r.prefix}|${r.year}`, { prefix: r.prefix, year: r.year, last: r.lastNumber ?? 0 })
  }
  for (const prefix of LEGAL_SERIES) {
    const key = `${prefix}|${now.getFullYear()}`
    if (!out.has(key)) out.set(key, { prefix, year: now.getFullYear(), last: 0 })
  }
  return [...out.values()].sort((a, b) => a.prefix.localeCompare(b.prefix) || a.year - b.year)
}

/**
 * The last numbers issued at the site, recorded by a person: each legal series resumes above the
 * higher of that and lgrai.app's own, and numbering opens again. Every series lgrai.app knows must be
 * given, so none is opened by omission.
 */
export async function recordLastNumbers(
  orgId: string,
  by: { id: string; operatorCode?: string },
  series: Array<{ prefix: string; year: number; last: number }>,
  /** FR-20.51: the mirror's numbers when linked (P3-7): each series resumes above them too. */
  floor: Array<{ prefix: string; year: number; last: number }> | null = null,
) {
  const home: any = await OrgHome.findOne({ orgId }, { seriesFrozen: 1 }).lean()
  if (!home?.seriesFrozen?.since) throw new MoveError(409, 'not_frozen', 'Numbering is not waiting for the site\'s last numbers.')
  for (const s of series) {
    if (!isLegalSeries(s.prefix) || !Number.isSafeInteger(s.year) || s.year < 0 || !Number.isSafeInteger(s.last) || s.last < 0) {
      throw new MoveError(422, 'bad_series', `${s.prefix} ${s.year}: not a legal series and a number`)
    }
  }
  const given = new Set(series.map(s => `${s.prefix}|${s.year}`))
  const known = await legalSeriesOf(orgId)
  const missing = known.filter(s => !given.has(`${s.prefix}|${s.year}`))
  if (missing.length) throw new MoveError(422, 'series_missing', 'Give the last number of every series.', { missing })
  for (const s of series) await ensureSequenceAtLeast(orgId, s.prefix, s.year, s.last)
  // Never below what lgrai.app's mirror holds, when it could be asked.
  for (const f of floor ?? []) {
    if (isLegalSeries(f.prefix) && Number.isSafeInteger(f.year) && Number.isSafeInteger(f.last) && f.last > 0) await ensureSequenceAtLeast(orgId, f.prefix, f.year, f.last)
  }
  await OrgHome.updateOne({ orgId }, { $unset: { seriesFrozen: '' }, $set: { seriesUnlockedAt: new Date() } })
  // On a master, the journal's mark starts again from here (P3-7): the unlock settled what it showed.
  await resetJournalHwm(orgId)
  if (home.seriesFrozen.moveId) {
    await OrgMove.updateOne({ _id: oid(home.seriesFrozen.moveId) }, { $push: { steps: step('last_numbers', true, series.map(s => `${s.prefix} ${s.year}: ${s.last}`).join(', ')) } })
  }
  // The org is home here: its trail records who opened its numbering again, and from where.
  const was = new Map(known.map(s => [`${s.prefix}|${s.year}`, s.last]))
  await recordAuditEntry({
    orgId, userId: by.id, operatorCode: by.operatorCode, action: 'update', module: 'admin',
    entityType: 'sequence', entityId: String(home.seriesFrozen.moveId ?? orgId), entityName: 'last numbers issued at the site',
    changes: series.map(s => ({ field: `${s.prefix} ${s.year}`, oldValue: was.get(`${s.prefix}|${s.year}`) ?? null, newValue: s.last })),
  })
  logger.info({ orgId, series: series.length }, 'Promotion: the site\'s last numbers are recorded; legal numbering resumes above them')
  return legalSeriesOf(orgId)
}
