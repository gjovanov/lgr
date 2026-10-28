/**
 * A master's capture of its own writes (FR-20.61, plan step P3-1b): FR-16.18–16.23's change-stream
 * journal, on the master.
 *
 * - **One change stream on the database**, `fullDocument` and `fullDocumentBeforeChange` both
 *   `whenAvailable`, filtered to the collections the generated metadata calls replicated or split
 *   (`db/replication/meta.generated.ts`). Their pre- and post-images are switched on at start
 *   (`ensureCapturable`, FR-20.15): the API's user holds `dbAdmin` for it.
 * - **It journals every write, whatever issued it**: a route, a script, a `bulkWrite`, a `mongosh`
 *   fix. There is no write path to forget.
 * - **One transaction per batch** (up to 1,000 events or 200 ms): each org's `seq` advanced by its
 *   share, a journal row upserted per document, and the resume token saved, together. A batch is cut
 *   only where the commit time changes, so a transaction's writes are never split across two.
 * - **One tailer per master**: a lease on `repl_engine`, renewed every 5 s and gone after 15.
 * - **Seeding** an org journals every document it already has, with `$setOnInsert`: a live change
 *   that got there first keeps its row.
 * - ⚠ **Lost history is a full re-send, never a quiet continue.** On `ChangeStreamHistoryLost`, a
 *   resume token the server no longer knows, or an invalidate, the journal epoch goes up by one, the
 *   stream restarts at now, and every document of every captured org is journaled again by UPSERT,
 *   with a fresh seq: `$setOnInsert` would keep stale rows at or below the watermark, and the changes
 *   made in the gap would never be sent. What was DELETED in the gap is in no row: the reconcile
 *   (FR-20.70, `reconcile.ts`) journals again every id lgrai.app's copy holds, so each comes as it is
 *   here or as gone.
 * - **A document with no org is never journaled** (an `ExchangeRate` with `orgId: null`), nor one of
 *   an org that is not captured here.
 */
import { hostname } from 'node:os'
import type { mongo } from 'mongoose'
import { REPLICATION_META } from 'db/replication/meta.generated'
import { logger } from '../../logger/logger.js'

type ChangeStream = mongo.ChangeStream
type ChangeStreamDocument = mongo.ChangeStreamDocument
type ClientSession = mongo.ClientSession
type Db = mongo.Db
type MongoClient = mongo.MongoClient

export const ENGINE_ID = 'engine'
const JOURNAL = 'repl_journal'
const ORGS = 'repl_orgs'
const ENGINE = 'repl_engine'

export const LEASE_RENEW_MS = 5_000
export const LEASE_TTL_MS = 15_000
const BATCH_EVENTS = 1_000
const BATCH_MS = 200
/** How long a batch ending inside a transaction waits for the transaction's remaining events. */
const TXN_SETTLE_MS = 1_000
const SEED_PAGE = 500

/** Server codes that mean the stream cannot continue from where it was. */
const HISTORY_LOST = new Set([
  286, // ChangeStreamHistoryLost: the oplog no longer reaches back to the saved point
  280, // ChangeStreamFatalError: the saved event is not there (a restored or reverted cluster)
  260, // InvalidResumeToken
  50811, // the saved token does not even parse: nothing to resume from, so the same as lost
])

export interface Captured {
  coll: string
  model: string
  orgPath: 'orgId' | '_id'
}

/** The collections whose writes are journaled, by name: replicated and split, with an org to route by. */
export function capturedCollections(): Map<string, Captured> {
  const out = new Map<string, Captured>()
  for (const [model, e] of Object.entries(REPLICATION_META)) {
    if ((e.class === 'R' || e.class === 'S') && e.orgPath) out.set(e.collection, { coll: e.collection, model, orgPath: e.orgPath })
  }
  return out
}

/**
 * FR-20.15: every captured collection exists, and keeps pre- and post-images, before the stream
 * opens: a change to a collection created lazily later would carry no pre-image to route a delete by.
 */
export async function ensureCapturable(db: Db): Promise<void> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name))
  for (const coll of capturedCollections().keys()) {
    if (existing.has(coll)) {
      await db.command({ collMod: coll, changeStreamPreAndPostImages: { enabled: true } })
    } else {
      await db.createCollection(coll, { changeStreamPreAndPostImages: { enabled: true } }).catch((e: any) => {
        // Created by someone else in between: switch it on there.
        if (e?.code !== 48) throw e
        return db.command({ collMod: coll, changeStreamPreAndPostImages: { enabled: true } })
      })
    }
  }
}

/** Who this process is, for the lease. */
export function holderId(): string {
  return `${process.pid}@${hostname()}:${Date.now().toString(36)}`
}

/** Take the lease, or keep it: `false` while another live tailer holds it. */
export async function takeLease(db: Db, me: string, now = new Date()): Promise<boolean> {
  const stale = new Date(now.getTime() - LEASE_TTL_MS)
  try {
    const r = await db.collection<any>(ENGINE).findOneAndUpdate(
      { _id: ENGINE_ID, $or: [{ holder: me }, { holder: { $exists: false } }, { holder: null }, { heartbeatAt: { $lt: stale } }] },
      { $set: { holder: me, heartbeatAt: now }, $setOnInsert: { journalEpoch: 1 } },
      { upsert: true, returnDocument: 'after' },
    )
    return r?.holder === me
  } catch (e: any) {
    // The singleton exists and another live holder has it: the upsert collided with it.
    if (e?.code === 11000) return false
    throw e
  }
}

export async function renewLease(db: Db, me: string, now = new Date()): Promise<boolean> {
  const r = await db.collection<any>(ENGINE).updateOne({ _id: ENGINE_ID, holder: me }, { $set: { heartbeatAt: now } })
  return r.matchedCount === 1
}

export async function releaseLease(db: Db, me: string): Promise<void> {
  await db.collection<any>(ENGINE).updateOne({ _id: ENGINE_ID, holder: me }, { $unset: { holder: '', heartbeatAt: '' } })
}

async function engineDoc(db: Db): Promise<{ journalEpoch: number; resumeToken?: unknown }> {
  const e = await db.collection<any>(ENGINE).findOne({ _id: ENGINE_ID })
  return { journalEpoch: e?.journalEpoch ?? 1, resumeToken: e?.resumeToken ?? undefined }
}

/** One journal change, routed. */
interface Change {
  orgId: unknown
  coll: string
  docId: unknown
  op: 'upsert' | 'delete'
  changedFields: string[]
  clusterTime: Date
}

const tsDate = (ts: any): Date => (ts && typeof ts.getHighBits === 'function' ? new Date(ts.getHighBits() * 1000) : new Date())

/**
 * Route a change event to its org. `known` answers a delete with no pre-image from the journal row
 * the document already has.
 */
export function route(ev: ChangeStreamDocument, captured: Map<string, Captured>, known: Map<string, unknown>): Change | null {
  const ns = (ev as any).ns?.coll as string | undefined
  if (!ns) return null
  const c = captured.get(ns)
  if (!c) return null
  const docId = (ev as any).documentKey?._id
  if (docId === undefined) return null
  const post = (ev as any).fullDocument
  const pre = (ev as any).fullDocumentBeforeChange
  const fromDoc = (d: any) => (d ? (c.orgPath === '_id' ? d._id : d.orgId) : undefined)
  const orgId = fromDoc(post) ?? fromDoc(pre) ?? known.get(`${ns}|${String(docId)}`) ?? (c.orgPath === '_id' ? docId : undefined)
  if (orgId === undefined || orgId === null) return null
  const clusterTime = tsDate((ev as any).clusterTime)
  switch (ev.operationType) {
    case 'insert':
    case 'replace':
      return { orgId, coll: ns, docId, op: 'upsert', changedFields: [], clusterTime }
    case 'update': {
      const d = (ev as any).updateDescription ?? {}
      const fields = new Set<string>([...Object.keys(d.updatedFields ?? {}), ...(d.removedFields ?? [])].map((f: string) => f.split('.')[0]))
      return { orgId, coll: ns, docId, op: 'upsert', changedFields: [...fields].sort(), clusterTime }
    }
    case 'delete':
      return { orgId, coll: ns, docId, op: 'delete', changedFields: [], clusterTime }
    default:
      return null
  }
}

/** The orgs captured here, as strings. */
async function capturedOrgs(db: Db, session?: ClientSession): Promise<Set<string>> {
  const rows = await db.collection<any>(ORGS).find({ enabled: true }, { session, projection: { orgId: 1 } }).toArray()
  return new Set(rows.map(r => String(r.orgId)))
}

/**
 * Journal one batch in one transaction: seqs, rows, and the resume token. ⚠ Aborts if the lease was
 * lost meanwhile: another tailer's work is never overwritten with this one's view.
 */
export async function journalBatch(client: MongoClient, db: Db, me: string, events: ChangeStreamDocument[], token: unknown): Promise<number> {
  const captured = capturedCollections()
  // A delete with no pre-image is routed by the row the document already has.
  const known = new Map<string, unknown>()
  const unrouted = events.filter(ev => ev.operationType === 'delete' && !(ev as any).fullDocumentBeforeChange)
  if (unrouted.length) {
    const ors = unrouted.map(ev => ({ coll: (ev as any).ns?.coll, docId: (ev as any).documentKey?._id }))
    for (const r of await db.collection<any>(JOURNAL).find({ $or: ors }, { projection: { coll: 1, docId: 1, orgId: 1 } }).toArray()) {
      known.set(`${r.coll}|${String(r.docId)}`, r.orgId)
    }
  }
  let written = 0
  const session = client.startSession()
  try {
    await session.withTransaction(async () => {
      const { journalEpoch } = await engineDoc(db)
      const orgs = await capturedOrgs(db, session)
      const byOrg = new Map<string, { orgId: unknown; changes: Change[] }>()
      for (const ev of events) {
        const ch = route(ev, captured, known)
        if (!ch || !orgs.has(String(ch.orgId))) continue
        const k = String(ch.orgId)
        if (!byOrg.has(k)) byOrg.set(k, { orgId: ch.orgId, changes: [] })
        byOrg.get(k)!.changes.push(ch)
      }
      const ops: any[] = []
      const now = new Date()
      for (const { orgId, changes } of byOrg.values()) {
        const r = await db.collection<any>(ORGS).findOneAndUpdate({ orgId, enabled: true }, { $inc: { seq: changes.length }, $set: { updatedAt: now } }, { session, returnDocument: 'after' })
        if (!r) continue
        let seq = r.seq - changes.length
        for (const c of changes) {
          seq++
          ops.push({
            updateOne: {
              filter: { orgId: c.orgId, coll: c.coll, docId: c.docId },
              update: { $set: { seq, op: c.op, changedFields: c.changedFields, clusterTime: c.clusterTime, journalEpoch, updatedAt: now } },
              upsert: true,
            },
          })
        }
      }
      if (ops.length) await db.collection(JOURNAL).bulkWrite(ops, { session, ordered: true })
      const last = events[events.length - 1] as any
      const saved = await db.collection<any>(ENGINE).updateOne(
        { _id: ENGINE_ID, holder: me },
        { $set: { resumeToken: token, lastBatchAt: now, lastEventAt: tsDate(last?.clusterTime), updatedAt: now } },
        { session },
      )
      if (saved.matchedCount !== 1) throw new LeaseLostError()
      written = ops.length
    })
  } finally {
    await session.endSession()
  }
  return written
}

export class LeaseLostError extends Error {
  constructor() {
    super('the replication lease was lost')
    this.name = 'LeaseLostError'
  }
}

/**
 * Journal every document `orgId` has in the captured collections. `upsert`: after lost history,
 * every row is rewritten with a fresh seq; otherwise `$setOnInsert`, so a live change keeps its row.
 */
export async function seedOrg(db: Db, orgId: unknown, mode: 'insert-only' | 'upsert'): Promise<number> {
  const { journalEpoch } = await engineDoc(db)
  let total = 0
  for (const c of capturedCollections().values()) {
    const filter = c.orgPath === '_id' ? { _id: orgId } : { orgId }
    let after: unknown = undefined
    for (;;) {
      const page = await db.collection<any>(c.coll).find(after === undefined ? filter : { $and: [filter, { _id: { $gt: after } }] }, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(SEED_PAGE).toArray()
      if (!page.length) break
      const r = await db.collection<any>(ORGS).findOneAndUpdate({ orgId }, { $inc: { seq: page.length } }, { returnDocument: 'after' })
      if (!r) return total
      let seq = r.seq - page.length
      const now = new Date()
      const ops = page.map(d => {
        seq++
        const row = { seq, op: 'upsert', changedFields: [], clusterTime: now, journalEpoch, updatedAt: now }
        return {
          updateOne: {
            filter: { orgId, coll: c.coll, docId: d._id },
            update: mode === 'upsert' ? { $set: row } : { $setOnInsert: row },
            upsert: true,
          },
        }
      })
      await db.collection(JOURNAL).bulkWrite(ops, { ordered: false })
      total += page.length
      after = page[page.length - 1]._id
    }
  }
  // FR-20.70 (P3-7f): a first seeding starts a copy from nothing, so there is nothing on lgrai.app to
  // reconcile at this epoch. After lost history (`upsert`) the epoch has moved past it, and it waits.
  const reconciled = mode === 'insert-only' ? { reconciledEpoch: journalEpoch } : {}
  await db.collection<any>(ORGS).updateOne({ orgId }, { $set: { seededAt: new Date(), seededEpoch: journalEpoch, ...reconciled } })
  return total
}

/** Capture `orgIds` from now on: rows made for the new ones, and those seeded. Returns the newly seeded. */
export async function enableOrgs(db: Db, orgIds: unknown[]): Promise<unknown[]> {
  const fresh: unknown[] = []
  for (const orgId of orgIds) {
    const r = await db.collection<any>(ORGS).updateOne({ orgId }, { $setOnInsert: { orgId, enabled: true, seq: 0 } }, { upsert: true })
    if (r.upsertedCount) fresh.push(orgId)
  }
  for (const orgId of fresh) {
    const n = await seedOrg(db, orgId, 'insert-only')
    logger.info({ orgId: String(orgId), documents: n }, 'Replication: an org is captured, its documents journaled')
  }
  return fresh
}

/** Lost history (FR-20.61): the epoch up by one, the stream from now, every captured org again by upsert. */
export async function historyLost(db: Db, me: string, reason: string): Promise<number> {
  const r = await db.collection<any>(ENGINE).findOneAndUpdate(
    { _id: ENGINE_ID, holder: me },
    { $inc: { journalEpoch: 1 }, $unset: { resumeToken: '' }, $set: { epochReason: reason.slice(0, 300), epochAt: new Date() } },
    { returnDocument: 'after' },
  )
  if (!r) throw new LeaseLostError()
  logger.error({ journalEpoch: r.journalEpoch, reason }, 'Replication: the change history was lost; the journal epoch goes up and every document is journaled again')
  return r.journalEpoch
}

async function reseedAll(db: Db): Promise<void> {
  for (const row of await db.collection<any>(ORGS).find({ enabled: true }, { projection: { orgId: 1 } }).toArray()) {
    await seedOrg(db, row.orgId, 'upsert')
  }
}

/**
 * Where the stream starts, saved before anything is seeded: a resume token for "now". ⚠ Seeding
 * first and opening the stream after would miss every write in between, for good.
 */
export async function establishToken(db: Db, me: string): Promise<unknown> {
  const stream = db.watch([{ $match: { 'ns.coll': { $in: [...capturedCollections().keys()] } } }])
  try {
    // An empty getMore still answers with the server's own resume token for the point it reached.
    await stream.tryNext()
    const token = stream.resumeToken
    const saved = await db.collection<any>(ENGINE).updateOne({ _id: ENGINE_ID, holder: me }, { $set: { resumeToken: token } })
    if (saved.matchedCount !== 1) throw new LeaseLostError()
    return token
  } finally {
    await stream.close().catch(() => {})
  }
}

export interface TailerOptions {
  client: MongoClient
  db: Db
  me: string
  /** Stop when this resolves or aborts. */
  signal?: AbortSignal
  /** Tests: called after each batch is written. */
  onBatch?: (written: number) => void
}

export function isHistoryLost(e: any): boolean {
  return HISTORY_LOST.has(e?.code) || /resume token|history.*lost|ChangeStreamHistoryLost/i.test(String(e?.message ?? ''))
}

/**
 * Tail until stopped, the lease is lost, or an error that is not lost history. Holds the lease while
 * it runs and renews it every 5 s.
 */
export async function tail(o: TailerOptions): Promise<void> {
  const { client, db, me } = o
  const captured = [...capturedCollections().keys()]
  let renewAt = Date.now() + LEASE_RENEW_MS
  // ⚠ Journal first, then tell the observer. Never `o.onBatch?.(await journalBatch(...))`: with no observer
  // the optional call skips evaluating its argument, and nothing is ever journaled.
  const flush = async (batch: ChangeStreamDocument[]) => {
    const written = await journalBatch(client, db, me, batch, (batch[batch.length - 1] as any)._id)
    o.onBatch?.(written)
  }
  for (;;) {
    if (o.signal?.aborted) return
    const { resumeToken } = await engineDoc(db)
    const stream: ChangeStream = db.watch(
      [{ $match: { $or: [{ 'ns.coll': { $in: captured } }, { operationType: { $in: ['invalidate', 'dropDatabase'] } }] } }],
      { fullDocument: 'whenAvailable', fullDocumentBeforeChange: 'whenAvailable', showExpandedEvents: true, ...(resumeToken ? { startAfter: resumeToken as any } : {}) },
    )
    const close = () => void stream.close().catch(() => {})
    o.signal?.addEventListener('abort', close, { once: true })
    try {
      let batch: ChangeStreamDocument[] = []
      let batchStarted = 0
      let restart = false
      while (!o.signal?.aborted) {
        if (Date.now() >= renewAt) {
          if (!(await renewLease(db, me))) throw new LeaseLostError()
          renewAt = Date.now() + LEASE_RENEW_MS
        }
        const ev = await stream.tryNext()
        if (ev) {
          if (ev.operationType === 'invalidate' || ev.operationType === 'dropDatabase' || (ev.operationType === 'drop' && captured.includes((ev as any).ns?.coll))) {
            // A dropped collection takes its deletes with it: only a full re-journal is honest.
            if (batch.length) await flush(batch)
            batch = []
            await historyLost(db, me, `the change stream was invalidated (${ev.operationType})`)
            restart = true
            break
          }
          // Cut only where the commit time changes: a transaction's events share it.
          const last = batch[batch.length - 1] as any
          const sameCommit = last && String(last.clusterTime) === String((ev as any).clusterTime)
          if (batch.length >= BATCH_EVENTS && !sameCommit) {
            await flush(batch)
            batch = []
          }
          if (!batch.length) batchStarted = Date.now()
          batch.push(ev)
          continue
        }
        if (batch.length && Date.now() - batchStarted >= BATCH_MS) {
          const last = batch[batch.length - 1] as any
          // A batch ending in a transaction waits a moment for the rest of it.
          if (last.txnNumber !== undefined && Date.now() - batchStarted < BATCH_MS + TXN_SETTLE_MS) continue
          await flush(batch)
          batch = []
        }
      }
      if (batch.length && !o.signal?.aborted) await flush(batch)
      if (!restart) return
    } catch (e: any) {
      // Asked to stop: the closed stream is the stop, not a failure.
      if (o.signal?.aborted) return
      if (e instanceof LeaseLostError || !isHistoryLost(e)) throw e
      await historyLost(db, me, `${e?.codeName ?? e?.code ?? ''} ${e?.message ?? e}`.trim())
    } finally {
      o.signal?.removeEventListener('abort', close)
      await stream.close().catch(() => {})
    }
    // A new stream from now, then every document again: a write during the re-seed is in the stream.
    await establishToken(db, me)
    await reseedAll(db)
  }
}
