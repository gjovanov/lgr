/**
 * The mirror's reconcile (FR-20.70, plan step P3-7f): lgrai.app's copy of an org made equal to its home
 * again, one way, the home winning, after the master lost the record of its changes.
 *
 * Lost history (FR-20.61, `historyLost`) raises the master's journal epoch, and every document the
 * master HAS is journaled again, so its pages bring each one as it is. What it DELETED in the gap is in
 * no row at all. So the master asks lgrai.app for every id lgrai.app's copy of the org holds, page by
 * page, and journals each again (`rejournal`): the next pages carry it as it is here, or as gone.
 *
 * - **The master drives it** (`mirrorReconcileTick`, every minute). It asks, journals, and keeps where
 *   it stands (`repl_orgs.reconcile`), so it goes on from there after a restart; asked twice, an id is
 *   only journaled twice. With every id asked, it tells lgrai.app where its journal stands, and the
 *   copy is reconciled once its watermark gets there (`mirror_state.reconcile`, `apply.ts`).
 * - **lgrai.app answers only the org's home**, registered for it at Full, with no clone alarm, and
 *   only with the ids of ITS copy of that org (FR-20.66).
 * - **One way.** Nothing on the master changes. On lgrai.app a document goes or changes only as the
 *   home's pages say, and an issued sale never goes (`apply.ts`, FR-20.51).
 * - ⚠ **Never for a database that went back.** Global applies the first page of a new journal epoch
 *   only if it continues the chain from the watermark: the master still holds the page global stands
 *   on. One that cannot is the re-seed's (P3-7d); made equal to it, the copy would lose what the home
 *   lost.
 */
import type { mongo } from 'mongoose'
import { nodeRole } from 'config'
import { mongoose } from 'db/connection'
import { OrgHome, ReplOrg } from 'db/models'
import { homeOf, thisNode } from 'db/home/home'
import { logger } from '../../logger/logger.js'
import { fetchWithTimeout } from '../outbound-fetch.js'
import { readNodeToken } from '../relay/outbox-worker.js'
import { ENGINE_ID, capturedCollections } from './capture.js'
import { captureOn } from './engine.js'
import { BSON, PAGE_DOCS, rejournal } from './pages.js'

type Db = mongo.Db
type ObjectId = mongo.ObjectId

const MIRROR = 'mirror_state'

const OBJECT_ID = /^[0-9a-f]{24}$/
const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v)) as unknown as ObjectId
/** Ids a page of the answer holds: what one `rejournal` takes. */
export const RECONCILE_IDS = PAGE_DOCS
/** Pages a master asks for in one tick, per org: the rest waits a minute. */
const PAGES_PER_TICK = 50

/**
 * The collections asked, in this order. The org's own document is not: no page deletes it, and its
 * home sends it again with every change.
 */
function reconcileOrder(): string[] {
  return [...capturedCollections().values()].filter(c => c.orgPath !== '_id').map(c => c.coll).sort()
}

export class ReconcileRefused extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

/** Global's database and its record of an org's home: Mongoose's own, unless a test gives others. */
export interface GlobalSide {
  db?: Db
  home?: (orgId: string) => Promise<{ home: string }>
}

function globalDb(o: GlobalSide): Db {
  const db = o.db ?? (mongoose.connection.db as unknown as Db | undefined)
  if (!db) throw new Error('the database is not connected')
  return db
}

/** Only the org's home, registered for it at Full and with no clone alarm, may ask (FR-20.66). */
async function mayReconcile(node: any, orgId: string, o: GlobalSide): Promise<void> {
  if (!OBJECT_ID.test(orgId) || !(node?.orgIds ?? []).some((id: unknown) => String(id) === orgId)) {
    throw new ReconcileRefused(404, 'not_found', 'No such organization on this server.')
  }
  if (node.cloneAlarm) throw new ReconcileRefused(409, 'clone_alarm', 'Two live uplinks share this server\'s id.')
  if (node.linkLevel !== 'full') throw new ReconcileRefused(409, 'not_full', 'The server is not linked at Full: lgrai.app keeps no copy of its data.')
  const home = await (o.home ?? (id => homeOf(id, { fresh: true })))(orgId)
  if (home.home !== String(node._id)) throw new ReconcileRefused(409, 'not_home', 'The organization is not written on this server.')
}

export interface IdsPage {
  /** The collection these ids are of; null once every one has been answered. */
  coll: string | null
  ids: unknown[]
  /** Where the next page starts; null after the last. */
  next: { coll: string; after?: unknown } | null
  /** lgrai.app holds no copy of the org (no chain): there is nothing to reconcile. */
  none?: true
}

/**
 * Global: the next page of the ids lgrai.app's copy of `orgId` holds, from `from` (absent: from the
 * beginning). Empty collections are skipped within the one answer.
 */
export async function mirrorIdsFor(node: any, orgId: string, from: { coll?: string; after?: unknown } = {}, o: GlobalSide & { limit?: number } = {}): Promise<IdsPage> {
  await mayReconcile(node, orgId, o)
  const db = globalDb(o)
  const org = oid(orgId)
  const st: any = await db.collection<any>(MIRROR).findOne({ orgId: org }, { projection: { chainHash: 1 } })
  if (!st?.chainHash) return { coll: null, ids: [], next: null, none: true }
  const order = reconcileOrder()
  let i = from.coll === undefined ? 0 : order.indexOf(from.coll)
  if (i < 0) throw new ReconcileRefused(400, 'bad_request', 'Not a collection that replicates.')
  const size = Math.max(2, Math.min(o.limit ?? RECONCILE_IDS, RECONCILE_IDS))
  const half = Math.floor(size / 2)
  for (let after = from.after; i < order.length; i++, after = undefined) {
    const coll = db.collection<any>(order[i])
    const ids: unknown[] = []
    if (after === undefined) {
      // Every replicated model is keyed by an ObjectId, and `$gt` compares within one BSON type, so
      // the ObjectIds are paged by it. An id of another kind a raw write left comes first, once.
      const odd = await coll.find({ orgId: org, _id: { $not: { $type: 'objectId' } } }, { projection: { _id: 1 }, limit: half, promoteValues: false }).toArray()
      if (odd.length === half) logger.warn({ orgId, coll: order[i] }, 'Reconcile: more documents keyed by something other than an ObjectId than one page holds; the rest are not asked')
      ids.push(...odd.map(d => d._id))
    }
    const room = size - ids.length
    const filter = after === undefined ? { orgId: org, _id: { $type: 'objectId' } } : { orgId: org, _id: { $gt: after } }
    const rest = await coll.find(filter as any, { projection: { _id: 1 }, sort: { _id: 1 }, limit: room, promoteValues: false }).toArray()
    ids.push(...rest.map(d => d._id))
    if (!ids.length) continue
    const more = rest.length === room
    const next = more ? { coll: order[i], after: rest[rest.length - 1]._id } : i + 1 < order.length ? { coll: order[i + 1] } : null
    return { coll: order[i], ids, next }
  }
  return { coll: null, ids: [], next: null }
}

/**
 * Global: the master journaled again every id this copy holds, and its journal stood at `head` then.
 * The copy is reconciled once its watermark gets there, at the reported journal epoch.
 */
export async function reconcileReported(node: any, orgId: string, body: { journalEpoch: number; head: number; asked: number }, o: GlobalSide = {}, now = new Date()): Promise<{ ok: true; done: boolean; none?: true; stale?: true }> {
  await mayReconcile(node, orgId, o)
  const { journalEpoch, head, asked } = body
  for (const [k, v] of Object.entries({ journalEpoch, head, asked })) {
    if (!Number.isSafeInteger(v) || v < (k === 'journalEpoch' ? 1 : 0)) throw new ReconcileRefused(400, 'bad_request', `${k} is not a count`)
  }
  const org = oid(orgId)
  const db = globalDb(o)
  const st: any = await db.collection<any>(MIRROR).findOne({ orgId: org }, { projection: { chainHash: 1, journalEpoch: 1, watermark: 1, reconcile: 1 } })
  if (!st?.chainHash) return { ok: true, done: false, none: true }
  if ((st.journalEpoch ?? 1) > journalEpoch) return { ok: true, done: false, stale: true }
  // Raw writes, like the apply's: `mirror_state` is global's node state, outside every replicated document.
  if (st.reconcile?.journalEpoch === journalEpoch) {
    await db.collection<any>(MIRROR).updateOne({ orgId: org, 'reconcile.journalEpoch': journalEpoch }, { $set: { 'reconcile.head': head, 'reconcile.reportedAt': now, 'reconcile.asked': asked, updatedAt: now }, $unset: { 'reconcile.doneAt': '' } })
  } else {
    // The report came before the first page of the epoch: that page goes on with this record.
    await db.collection<any>(MIRROR).updateOne({ orgId: org }, { $set: { reconcile: { journalEpoch, since: now, head, reportedAt: now, asked, deleted: 0, kept: [] }, updatedAt: now } })
  }
  // ⚠ Against the watermark as it is NOW: a page applied while this was written read no `head`.
  const done = await db.collection<any>(MIRROR).updateOne(
    { orgId: org, journalEpoch, watermark: { $gte: head }, 'reconcile.journalEpoch': journalEpoch, 'reconcile.doneAt': { $exists: false } },
    { $set: { 'reconcile.doneAt': now, updatedAt: now } },
  )
  if (done.modifiedCount) logger.info({ orgId, nodeId: String(node._id), journalEpoch }, 'Mirror: the reconcile is done; the copy is its home\'s again')
  return { ok: true, done: !!done.modifiedCount }
}

/** Global: the last reconcile of lgrai.app's copy of `orgId`, for the Servers page; null when none ran. */
export async function mirrorReconcileStatus(orgId: string, o: GlobalSide = {}): Promise<{ since: Date; doneAt: Date | null; deleted: number; kept: Array<{ number: string; at: Date }>; asked: number | null } | null> {
  if (!OBJECT_ID.test(orgId)) return null
  const st: any = await globalDb(o).collection<any>(MIRROR).findOne({ orgId: oid(orgId) }, { projection: { reconcile: 1 } })
  const r = st?.reconcile
  if (!r) return null
  return {
    since: r.since,
    doneAt: r.doneAt ?? null,
    deleted: Number(r.deleted ?? 0),
    kept: (r.kept ?? []).map((k: any) => ({ number: String(k.number ?? k.id), at: k.at })),
    asked: typeof r.asked === 'number' ? r.asked : null,
  }
}

/**
 * Master: for each org written here whose journal is whole at an epoch lgrai.app's copy was not yet
 * reconciled at, ask for the copy's ids and journal them again, up to `PAGES_PER_TICK` pages a tick.
 * Returns how many ids were journaled.
 */
export async function mirrorReconcileTick(fetchImpl: typeof fetch = fetch, now = new Date()): Promise<number> {
  if (nodeRole() !== 'master' || !captureOn()) return 0
  const token = readNodeToken()
  if (!token) return 0
  const db = mongoose.connection.db as any
  if (!db) return 0
  const client = mongoose.connection.getClient() as any
  const engine = await db.collection('repl_engine').findOne({ _id: ENGINE_ID })
  const journalEpoch: number = engine?.journalEpoch ?? 1
  if (journalEpoch <= 1) return 0
  const homes: any[] = await OrgHome.find({ home: thisNode(), state: { $nin: ['fenced', 'hold'] } }, { orgId: 1 }).lean()
  let journaled = 0
  for (const h of homes) {
    const repl: any = await ReplOrg.findOne({ orgId: h.orgId }).lean()
    // The journal must be whole at this epoch first: until then no page of it is built either.
    if (!repl?.enabled || repl.seededEpoch !== journalEpoch || (repl.reconciledEpoch ?? 1) >= journalEpoch) continue
    journaled += await reconcileOrg(String(h.orgId), repl, journalEpoch, token, fetchImpl, client, db, now)
  }
  return journaled
}

async function reconcileOrg(orgId: string, repl: any, journalEpoch: number, token: { token: string; server: string }, fetchImpl: typeof fetch, client: any, db: any, now: Date): Promise<number> {
  const org = oid(orgId)
  let cur: { journalEpoch: number; coll?: string; after?: unknown; asked: number; startedAt: Date } =
    repl.reconcile?.journalEpoch === journalEpoch ? repl.reconcile : { journalEpoch, asked: 0, startedAt: now }
  if (repl.reconcile?.journalEpoch !== journalEpoch) {
    await ReplOrg.updateOne({ orgId: org }, { $set: { reconcile: cur } })
    logger.warn({ orgId, journalEpoch }, 'Reconcile: this server lost the record of its changes; lgrai.app\'s copy of the organization is made equal to it again (FR-20.70)')
  }
  const auth = { authorization: `Bearer ${token.token}` }
  let journaled = 0
  try {
    for (let n = 0; n < PAGES_PER_TICK; n++) {
      const url = new URL('/api/node/v1/reconcile/ids', token.server)
      url.searchParams.set('orgId', orgId)
      if (cur.coll !== undefined) url.searchParams.set('coll', cur.coll)
      if (cur.after !== undefined) url.searchParams.set('after', BSON.EJSON.stringify(cur.after as any, { relaxed: false }))
      const res = await fetchWithTimeout(url, { headers: auth }, { timeoutMs: 30_000, fetchImpl })
      if (!res.ok) throw new Error(`lgrai.app answered ${res.status} for the copy's ids`)
      const page: IdsPage = BSON.EJSON.parse(await res.text(), { relaxed: false }) as any
      if (page.none) {
        // lgrai.app holds no copy of the org: its first pages will bring everything there is.
        await ReplOrg.updateOne({ orgId: org }, { $set: { reconciledEpoch: journalEpoch }, $unset: { reconcile: '' } })
        return journaled
      }
      if (page.coll && page.ids.length) journaled += await rejournal(client, db, org, page.coll, page.ids)
      cur = { journalEpoch, ...(page.next ? { coll: page.next.coll, ...(page.next.after !== undefined ? { after: page.next.after } : {}) } : {}), asked: cur.asked + page.ids.length, startedAt: cur.startedAt }
      await ReplOrg.updateOne({ orgId: org, 'reconcile.journalEpoch': journalEpoch }, { $set: { reconcile: cur } })
      if (!page.next) {
        // Every id the copy holds is journaled again: where the journal stands now, the copy must get.
        const head = Number(((await ReplOrg.findOne({ orgId: org }, { seq: 1 }).lean()) as any)?.seq ?? 0)
        const done = await fetchWithTimeout(
          new URL('/api/node/v1/reconcile/done', token.server),
          { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ orgId, journalEpoch, head, asked: cur.asked }) },
          { timeoutMs: 15_000, fetchImpl },
        )
        if (!done.ok) throw new Error(`lgrai.app answered ${done.status} for the reconcile's end`)
        await ReplOrg.updateOne({ orgId: org }, { $set: { reconciledEpoch: journalEpoch }, $unset: { reconcile: '' } })
        logger.info({ orgId, journalEpoch, asked: cur.asked, head }, 'Reconcile: every id of lgrai.app\'s copy is journaled again; its pages take the copy there')
        return journaled
      }
    }
  } catch (e) {
    // Where it stood is kept: the next tick goes on from there.
    logger.warn({ orgId, journalEpoch, err: e instanceof Error ? e.message : String(e) }, 'Reconcile: lgrai.app could not be asked; again in a minute')
  }
  return journaled
}
