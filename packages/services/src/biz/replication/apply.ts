/**
 * The mirror apply (FR-20.65, FR-20.66, plan step P3-2a, Part A.6.4): global writes a master's page
 * into its mirror of the org, in one transaction, or refuses all of it.
 *
 * - **Isolation first** (FR-20.66). The page's hash is recomputed from its bytes; the sender must be
 *   registered for the org, not revoked there and not under a clone alarm (P2-1, FR-20.51), linked at
 *   Full (FR-20.54), and the org's home at the page's epoch; every row must be of a replicated
 *   collection, the page's org
 *   (`Org` by its `_id`), and every file path in it a stored path under that org (FR-20.24). Any
 *   failure refuses the page and raises an alarm. A compromised master can damage only its own org's
 *   mirror.
 * - **The chain** (FR-20.64). The first page starts at 0 with no previous hash; every other page
 *   continues from the watermark with the hash global holds there. A page that continues from the
 *   watermark with another history is a restore, a revert or a clone (FR-20.51). The last page applied
 *   again is acknowledged without writing.
 * - **One transaction, raw driver writes** (FR-20.65): the document is final as the home wrote it, so
 *   no Mongoose hook may touch it. `Org` by `{_id}`, every other document by `{_id, orgId}`; a split
 *   document is merged with the mirror's own fields on the server (`mirrorPipeline`); tombstones
 *   deleted; the watermark and the chain advanced last.
 * - **A unique key that collides never stops the page.** The mirror still holds a stale document of
 *   the same org with that key (two documents swapped it, and arrived in different pages): it is
 *   deleted in the same transaction, the page's document written, and the master asked to resend the
 *   stale one. A stale split document is parked under a placeholder key instead, because its global
 *   and node fields travel in no page. A key another org holds is refused, never deleted.
 * - **A membership's link to a person is global's to sanction** (FR-20.63). A `User` naming a person
 *   the mirror's copy does not already name is applied without the link, inert, with an alarm.
 */
import type { mongo } from 'mongoose'
import type { MetaEntry } from 'db/replication/generate'
import { homeOf, type OrgHomeInfo } from 'db/home/home'
import { logger } from '../../logger/logger.js'
import { validateStored } from '../files/stored-path.js'
import { mirrorPipeline } from './project.js'
import { PAGE_DOCS, chainHash, decodeDoc, decodePage, idKey, metaOf, type Page, type PageRow } from './pages.js'

type ClientSession = mongo.ClientSession
type Db = mongo.Db
type MongoClient = mongo.MongoClient
type ObjectId = mongo.ObjectId

const MIRROR = 'mirror_state'
const ALARMS_KEPT = 20
/** Collisions resolved in one page before it is given up as unresolvable (each costs one retry). */
const COLLISIONS_MAX = 50
/** States in which the home still sends: a move freezes the org and drains its last pages first. */
const SENDING: ReadonlySet<string> = new Set(['active', 'freezing', 'frozen'])

export type Refusal =
  /** The page's hash does not match its contents, or a row is not what it claims. */
  | 'forged'
  /** The sender is not the org's home at the page's epoch. */
  | 'not_home'
  /** The sender is not registered for the org: never enrolled for it, or revoked there (P2-1). */
  | 'not_registered'
  /** Two live uplinks share the sender's node id: neither's pages are accepted (FR-20.8, FR-20.51). */
  | 'clone_alarm'
  /** The master is linked at Control: the mirror is Full only, and Control sends no business data (FR-20.54). */
  | 'not_full'
  /** A row of another org, of a collection that does not replicate, a file path outside the org, an org tombstone. */
  | 'foreign'
  /** A document id, or a unique key, another org holds. */
  | 'foreign_collision'
  /** The mirror has no such org to write. */
  | 'org_missing'
  /** A different copy of the master's data (a restore): refused until a re-seed (FR-20.71, P3-7). */
  | 'instance_changed'
  /** An older journal epoch than the mirror's. */
  | 'stale_journal'
  /** A newer journal epoch: it waits for a reconcile (FR-20.61, FR-20.70). */
  | 'reconcile_required'
  /** The home epoch moved on: the move resets the mirror's chain (P3-6). */
  | 'epoch_changed'
  /** Continues from the watermark with another history: a restore, a revert or a clone (FR-20.51). */
  | 'diverged'
  /** Starts before the watermark: the master builds again from it. */
  | 'behind'
  /** Starts after the watermark: pages are missing. */
  | 'gap'

/** Refusals that need a person, not a resend. */
const ALARMING: ReadonlySet<Refusal> = new Set(['forged', 'not_home', 'not_registered', 'clone_alarm', 'foreign', 'foreign_collision', 'org_missing', 'instance_changed', 'stale_journal', 'diverged'])

export type ApplyResult =
  | {
      ok: true
      /** The last page applied, sent again: acknowledged, nothing written. */
      duplicate?: true
      watermark: number
      chainHash: string
      applied: number
      deleted: number
      /** Stale documents a collision removed: the master sends them again (`rejournal`). */
      resend: Array<{ coll: string; ids: unknown[] }>
      alarms: string[]
    }
  | { ok: false; refused: Refusal; detail?: string; watermark: number; chainHash: string }

export interface ApplyContext {
  /** The node the transport authenticated: never the page's own word. */
  nodeId: string
  /** The org's home as global records it; `homeOf` by default. */
  home?: (orgId: ObjectId) => Promise<OrgHomeInfo>
  now?: Date
}

class Refused extends Error {
  constructor(readonly reason: Refusal, readonly detail?: string) {
    super(`page refused: ${reason}${detail ? ` (${detail})` : ''}`)
  }
}

/** The mirror_state row changed between our read and our write: read again. */
class Raced extends Error {}

/** FR-20.66, FR-20.24: the fields holding a stored file path, by collection. */
const FILE_PATHS: Record<string, (d: Record<string, any>) => unknown[]> = {
  docfiles: d => [d.currentPath],
  files: d => (d.storageProvider == null || d.storageProvider === 'local' ? [d.storagePath] : []),
  archiveunits: d => (d.path == null ? [] : [d.path]),
}

function pathProblem(coll: string, doc: Record<string, any>, orgId: ObjectId): string | null {
  for (const p of FILE_PATHS[coll]?.(doc) ?? []) {
    if (typeof p !== 'string') return `${coll} ${String(doc._id)}: a file path that is not text`
    try {
      validateStored(p)
    } catch (e: any) {
      return `${coll} ${String(doc._id)}: ${e?.message ?? e}`
    }
    if (p.split('/')[0] !== String(orgId)) return `${coll} ${String(doc._id)}: a file path under another org`
  }
  return null
}

interface Prepared {
  row: PageRow
  entry: MetaEntry
  doc?: Record<string, any>
}

/**
 * Everything FR-20.66 asks of the rows, before anything is written. ⚠ The chain hash proves a page
 * is whole, not who wrote it (anyone can compute one): authorship is the transport's node token and
 * the home check, and the shape of the seqs is checked here.
 */
function prepare(page: Page): Prepared[] {
  if (!page.rows.length || page.rows.length > PAGE_DOCS) throw new Refused('forged', `a page of ${page.rows.length} rows`)
  let last = page.fromSeq
  for (const row of page.rows) {
    if (row.seq <= last) throw new Refused('forged', 'the rows are not in ascending seq order above the page start')
    last = row.seq
  }
  if (last !== page.toSeq) throw new Refused('forged', 'the page ends at another seq than its last row')
  const out: Prepared[] = []
  for (const row of page.rows) {
    const entry = metaOf(row.coll)
    if (!entry || (entry.class !== 'R' && entry.class !== 'S') || !entry.orgPath) throw new Refused('foreign', `${row.coll} does not replicate`)
    if (row.op === 'd') {
      if (entry.orgPath === '_id') throw new Refused('foreign', 'an org is never deleted by a page')
      out.push({ row, entry })
      continue
    }
    let doc: Record<string, any>
    try {
      doc = decodeDoc(row.doc!)
    } catch {
      throw new Refused('forged', `${row.coll}: a row whose document does not decode`)
    }
    if (doc._id === undefined || idKey(doc._id) !== idKey(row.id)) throw new Refused('forged', `${row.coll}: a row whose document is another`)
    const docOrg = entry.orgPath === '_id' ? doc._id : doc.orgId
    if (docOrg?._bsontype !== 'ObjectId' || String(docOrg) !== String(page.orgId)) throw new Refused('foreign', `${row.coll} ${String(doc._id)} is not the page's org`)
    const bad = pathProblem(row.coll, doc, page.orgId)
    if (bad) throw new Refused('foreign', bad)
    out.push({ row, entry, doc })
  }
  return out
}

/** Whether the page applies, is the last one again, or is refused (FR-20.64, FR-20.61, FR-20.71). */
function decide(st: Record<string, any> | null, page: Page): 'genesis' | 'apply' | 'duplicate' {
  const chain: string = st?.chainHash || ''
  if (!chain) {
    if (page.fromSeq !== 0 || page.prevHash !== '') throw new Refused('gap', 'the mirror has no page yet: the first starts at 0')
    return 'genesis'
  }
  if (st!.instanceEpoch !== page.instanceEpoch) throw new Refused('instance_changed', `the mirror was sent instance ${st!.instanceEpoch}`)
  if (page.journalEpoch > st!.journalEpoch) throw new Refused('reconcile_required', `journal epoch ${page.journalEpoch} after ${st!.journalEpoch}`)
  if (page.journalEpoch < st!.journalEpoch) throw new Refused('stale_journal', `journal epoch ${page.journalEpoch} before ${st!.journalEpoch}`)
  if (page.epoch !== st!.epoch) throw new Refused('epoch_changed', `home epoch ${page.epoch}, the mirror's chain is of ${st!.epoch}`)
  const watermark: number = st!.watermark ?? 0
  if (page.fromSeq === watermark) {
    if (page.prevHash !== chain) throw new Refused('diverged', `the page continues another chain from ${watermark}`)
    return 'apply'
  }
  if (page.fromSeq < watermark) {
    if (page.toSeq === watermark && page.chainHash === chain) return 'duplicate'
    throw new Refused('behind', `the mirror is at ${watermark}`)
  }
  throw new Refused('gap', `the mirror is at ${watermark}`)
}

/**
 * A membership's link to a person, as global sanctions it (FR-20.63), and the person fields a
 * membership the mirror has never seen starts with. ⚠ Sanctioned today means the mirror's copy
 * already names that person: the move's initial copy, or a link global made. A.6.8's `member-join`
 * will be the other way in.
 */
async function membership(db: Db, session: ClientSession, orgId: ObjectId, doc: Record<string, any>): Promise<{ doc: Record<string, any>; fallbacks: Record<string, unknown>; alarm?: string }> {
  const current = await db.collection<any>('users').findOne({ _id: doc._id, orgId }, { session, projection: { identityId: 1 } })
  let out = doc
  let alarm: string | undefined
  if (doc.identityId != null && !(current?.identityId != null && String(current.identityId) === String(doc.identityId))) {
    out = { ...doc }
    delete out.identityId
    alarm = `membership ${String(doc._id)} names a person global never linked to it (${String(doc.identityId)}): applied without the link`
  }
  // The person fields are global's: a membership seen for the first time has none yet. Inert ones
  // keep the mirror's own rules (required, unique per org) without naming anybody.
  const fallbacks = current ? {} : { email: `${String(doc._id)}@inert.invalid`, firstName: String(out.username ?? ''), lastName: '' }
  return { doc: out, fallbacks, alarm }
}

const locks = new Map<string, Promise<unknown>>()

/** One page of an org at a time in this process; across processes the transaction decides. */
async function serially<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = locks.get(key) ?? Promise.resolve()
  const run = before.catch(() => {}).then(fn)
  const tail = run.catch(() => {})
  locks.set(key, tail)
  try {
    return await run
  } finally {
    if (locks.get(key) === tail) locks.delete(key)
  }
}

async function where(db: Db, orgId: ObjectId): Promise<{ watermark: number; chainHash: string }> {
  const st = await db.collection<any>(MIRROR).findOne({ orgId }, { projection: { watermark: 1, chainHash: 1 } })
  return { watermark: st?.watermark ?? 0, chainHash: st?.chainHash ?? '' }
}

async function refuse(db: Db, page: Page, r: Refused, now: Date): Promise<ApplyResult> {
  const alarm = ALARMING.has(r.reason)
  const update: Record<string, any> = {
    $inc: { refused: 1 },
    $set: { lastRefusal: { reason: r.reason, at: now, ...(r.detail ? { detail: r.detail.slice(0, 500) } : {}) }, updatedAt: now },
    $setOnInsert: { watermark: 0, chainHash: '' },
  }
  if (alarm) update.$push = { alarms: { $each: [{ kind: r.reason, at: now, ...(r.detail ? { detail: r.detail.slice(0, 500) } : {}) }], $slice: -ALARMS_KEPT } }
  await db.collection<any>(MIRROR).updateOne({ orgId: page.orgId }, update, { upsert: true })
  if (r.reason === 'reconcile_required') {
    await db.collection<any>(MIRROR).updateOne({ orgId: page.orgId, reconcileRequired: { $exists: false } }, { $set: { reconcileRequired: { journalEpoch: page.journalEpoch, since: now } } })
  }
  const log = { orgId: String(page.orgId), nodeId: page.nodeId, reason: r.reason, detail: r.detail, fromSeq: page.fromSeq, toSeq: page.toSeq }
  if (alarm) logger.warn(log, 'Mirror: a page was refused')
  else logger.info(log, 'Mirror: a page was refused')
  return { ok: false, refused: r.reason, ...(r.detail ? { detail: r.detail } : {}), ...(await where(db, page.orgId)) }
}

/** The collision a failed attempt hit, if that is what it was. */
function collisionOf(e: any): { p: Prepared; keyPattern: Record<string, unknown>; keyValue: Record<string, unknown> } | null {
  if (e?.code !== 11000 || !e.lgrRow) return null
  return { p: e.lgrRow as Prepared, keyPattern: e.keyPattern ?? {}, keyValue: e.keyValue ?? {} }
}

/**
 * Apply one page from `ctx.nodeId` to the mirror in `db` (global's database). Bytes as they came off
 * the wire, or a decoded page.
 */
export async function applyPage(client: MongoClient, db: Db, input: Uint8Array | Page, ctx: ApplyContext): Promise<ApplyResult> {
  const now = ctx.now ?? new Date()
  const page = input instanceof Uint8Array ? decodePage(input) : input
  return serially(String(page.orgId), async () => {
    let prepared: Prepared[]
    try {
      if (chainHash(page, page.rows) !== page.chainHash) throw new Refused('forged', 'the chain hash does not match the page')
      if (page.nodeId !== ctx.nodeId) throw new Refused('not_home', 'the page names another sender')
      // Global's registry, read fresh: a node revoked for this org, or under a clone alarm, writes
      // nothing, whatever the home record still says.
      const node = await db.collection<any>('nodes').findOne({ _id: ctx.nodeId }, { projection: { status: 1, orgIds: 1, cloneAlarm: 1, linkLevel: 1 } })
      if (!node || node.status !== 'active' || !(node.orgIds ?? []).some((id: unknown) => String(id) === String(page.orgId))) {
        throw new Refused('not_registered', node?.status === 'active' ? 'the node is not registered for this org' : 'the node is not registered')
      }
      if (node.cloneAlarm) throw new Refused('clone_alarm', 'two live uplinks share this node id')
      // ⚠ Enforced here, not trusted to the master: at Control no business data leaves the building.
      if (node.linkLevel !== 'full') throw new Refused('not_full', `the master is linked at ${String(node.linkLevel ?? 'control')}: the mirror is Full only`)
      const home = await (ctx.home ?? (id => homeOf(id, { fresh: true })))(page.orgId)
      if (home.home !== ctx.nodeId || home.epoch !== page.epoch || !SENDING.has(home.state)) {
        throw new Refused('not_home', `the org's home is ${home.home === ctx.nodeId ? 'this node' : 'another node'} at epoch ${home.epoch} (${home.state})`)
      }
      prepared = prepare(page)
    } catch (e) {
      if (e instanceof Refused) return refuse(db, page, e, now)
      throw e
    }

    /** Stale documents that hold a key the page needs: deleted, or parked (split ones), first. */
    const stale: Array<{ coll: string; id: unknown; park?: Record<string, string> }> = []
    const resend = new Map<string, Map<string, unknown>>()
    const inPage = new Set(prepared.filter(p => p.doc).map(p => `${p.row.coll}|${idKey(p.doc!._id)}`))
    let raced = 0
    for (let collisions = 0; ; ) {
      let duplicate = false
      let applied = 0
      let deleted = 0
      let alarms: string[] = []
      const session = client.startSession()
      try {
        await session.withTransaction(
          async () => {
            duplicate = false
            applied = 0
            deleted = 0
            alarms = []
            const mirror = db.collection<any>(MIRROR)
            const st = await mirror.findOne({ orgId: page.orgId }, { session })
            const decision = decide(st, page)
            if (decision === 'duplicate') {
              duplicate = true
              return
            }
            for (const s of stale) {
              const coll = db.collection<any>(s.coll)
              if (s.park) await coll.updateOne({ _id: s.id, orgId: page.orgId }, { $set: s.park }, { session })
              else await coll.deleteOne({ _id: s.id, orgId: page.orgId }, { session })
            }
            for (const p of prepared) {
              try {
                const coll = db.collection<any>(p.row.coll)
                if (!p.doc) {
                  deleted += (await coll.deleteOne({ _id: p.row.id, orgId: page.orgId }, { session })).deletedCount
                } else if (p.entry.class === 'R') {
                  await coll.replaceOne({ _id: p.doc._id, orgId: page.orgId }, p.doc, { upsert: true, session })
                  applied++
                } else if (p.entry.orgPath === '_id') {
                  const r = await coll.updateOne({ _id: p.doc._id }, mirrorPipeline(p.doc, p.entry), { session })
                  if (r.matchedCount !== 1) throw new Refused('org_missing', 'the mirror has no such org')
                  applied++
                } else {
                  let doc = p.doc
                  let fallbacks: Record<string, unknown> = {}
                  if (p.row.coll === 'users') {
                    const m = await membership(db, session, page.orgId, p.doc)
                    doc = m.doc
                    fallbacks = m.fallbacks
                    if (m.alarm) alarms.push(m.alarm)
                  }
                  await coll.updateOne({ _id: doc._id, orgId: page.orgId }, mirrorPipeline(doc, p.entry, fallbacks), { upsert: true, session })
                  applied++
                }
              } catch (e: any) {
                if (e && typeof e === 'object' && e.code === 11000) e.lgrRow = p
                throw e
              }
            }
            // The watermark and the chain, last (FR-20.65).
            const set: Record<string, unknown> = {
              nodeId: page.nodeId,
              epoch: page.epoch,
              instanceEpoch: page.instanceEpoch,
              journalEpoch: page.journalEpoch,
              watermark: page.toSeq,
              chainHash: page.chainHash,
              lastPageAt: now,
              refused: 0,
              updatedAt: now,
            }
            const update: Record<string, any> = { $set: set }
            if (alarms.length) update.$push = { alarms: { $each: alarms.map(detail => ({ kind: 'membership_unsanctioned', at: now, detail: detail.slice(0, 500) })), $slice: -ALARMS_KEPT } }
            if (decision === 'genesis') {
              // A refusal may have left a row with no chain: the first page takes it.
              await mirror.updateOne({ orgId: page.orgId, $or: [{ chainHash: '' }, { chainHash: { $exists: false } }] }, update, { session, upsert: true })
            } else {
              const r = await mirror.updateOne({ orgId: page.orgId, watermark: st!.watermark, chainHash: st!.chainHash }, update, { session })
              if (r.matchedCount !== 1) throw new Raced()
            }
          },
          { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' },
        )
      } catch (e: any) {
        if (e instanceof Refused) return refuse(db, page, e, now)
        const c = collisionOf(e)
        if (!c) {
          // Another apply of this org took the chain first, or the genesis row appeared under us.
          if ((e instanceof Raced || e?.code === 11000) && ++raced <= 3) continue
          throw e
        }
        if (++collisions > COLLISIONS_MAX) throw new Error(`the page collides more than ${COLLISIONS_MAX} times`)
        const id = c.p.doc!._id
        const holder = await db.collection<any>(c.p.row.coll).findOne(c.keyPattern._id !== undefined ? { _id: id } : { $and: [c.keyValue, { _id: { $ne: id } }] })
        if (!holder) continue // gone meanwhile: the next attempt meets no collision
        const holderOrg = c.p.entry.orgPath === '_id' ? holder._id : holder.orgId
        if (String(holderOrg) !== String(page.orgId)) {
          return refuse(db, page, new Refused('foreign_collision', `${c.p.row.coll} ${String(id)}: ${JSON.stringify(Object.keys(c.keyPattern))} is another org's`), now)
        }
        // ⚠ A split document is parked, never deleted: global's own fields and the node's (a
        // membership's person, its sanctioned link) are not in any page, so the resend could not
        // bring them back. Its key moves aside until the resend writes the real one.
        const park = c.p.entry.class === 'S'
          ? Object.fromEntries(Object.keys(c.keyPattern).filter(k => k !== 'orgId').map(k => [k, `~stale~${String(holder._id)}`]))
          : undefined
        stale.push({ coll: c.p.row.coll, id: holder._id, ...(park ? { park } : {}) })
        if (!inPage.has(`${c.p.row.coll}|${idKey(holder._id)}`)) {
          if (!resend.has(c.p.row.coll)) resend.set(c.p.row.coll, new Map())
          resend.get(c.p.row.coll)!.set(idKey(holder._id), holder._id)
        }
        logger.info({ orgId: String(page.orgId), coll: c.p.row.coll, key: Object.keys(c.keyPattern) }, 'Mirror: a stale document held a unique key; it is replaced, and the master asked to resend it')
        continue
      } finally {
        await session.endSession()
      }
      if (duplicate) return { ok: true, duplicate: true, ...(await where(db, page.orgId)), applied: 0, deleted: 0, resend: [], alarms: [] }
      for (const a of alarms) logger.warn({ orgId: String(page.orgId), nodeId: page.nodeId }, `Mirror: ${a}`)
      return {
        ok: true,
        watermark: page.toSeq,
        chainHash: page.chainHash,
        applied,
        deleted,
        resend: [...resend].map(([coll, ids]) => ({ coll, ids: [...ids.values()] })),
        alarms,
      }
    }
  })
}
