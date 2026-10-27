/**
 * The mirror's dead letters (FR-20.65, plan step P3-2c): documents of a master's page that global set
 * aside instead of writing (`mirror_dead_letters`), so the rest of the page applied and the org's
 * mirror went on. The apply writes them (`apply.ts`); this is what is read and re-asked for.
 *
 * - **Asked for again, ever less often.** An open one whose `retryAt` has come rides the org's next
 *   page acknowledgement as a `resend` (the master journals it again, and the next page carries it as
 *   it is). Set aside again, it waits twice as long: 5 minutes, then 10, … up to a day.
 * - **Resolved by the page that writes it**, whatever made that possible: someone removed the
 *   conflict, or the document changed on the master.
 */
import type { mongo } from 'mongoose'
import { mongoose } from 'db/connection'
import { idKey } from './pages.js'

type Db = mongo.Db
type ClientSession = mongo.ClientSession
type ObjectId = mongo.ObjectId

export const DEAD = 'mirror_dead_letters'
/** At most this many documents of one page are set aside; past it the page fails and is sent again. */
export const DEAD_MAX = 100
/** Dead letters asked for again with one acknowledgement. */
const RESEND_MAX = 100
/** How long a re-asked one waits before it is asked again, unless a page sets it aside sooner. */
const ASKED_WAIT_MS = 10 * 60_000
const FIRST_WAIT_MS = 5 * 60_000
const MAX_WAIT_MS = 24 * 3600_000

/** When a dead letter set aside for the `attempts`-th time may be asked for again. */
export function retryAfterMs(attempts: number): number {
  return Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** Math.max(0, Math.min(16, attempts - 1)))
}

export interface SetAside {
  coll: string
  id: unknown
  reason: 'foreign_collision' | 'write_error'
  detail: string
}

/**
 * In the apply's transaction: record each document set aside. Returns those set aside for the first
 * time (they raise an alarm; one set aside again does not).
 */
export async function recordSetAside(db: Db, session: ClientSession, orgId: ObjectId, nodeId: string, page: { fromSeq: number; toSeq: number; journalEpoch: number }, items: SetAside[], now: Date): Promise<SetAside[]> {
  const fresh: SetAside[] = []
  for (const it of items) {
    const prior: any = await db.collection<any>(DEAD).findOne({ orgId, coll: it.coll, docId: it.id }, { session, projection: { attempts: 1, status: 1 } })
    const attempts = prior?.status === 'open' ? Number(prior.attempts ?? 1) + 1 : 1
    await db.collection<any>(DEAD).updateOne(
      { orgId, coll: it.coll, docId: it.id },
      {
        $set: {
          nodeId, reason: it.reason, detail: it.detail.slice(0, 500), page, status: 'open', attempts,
          retryAt: new Date(now.getTime() + retryAfterMs(attempts)), at: now, updatedAt: now,
        },
        $unset: { resolvedAt: '' },
      },
      { session, upsert: true },
    )
    if (attempts === 1) fresh.push(it)
  }
  return fresh
}

/** In the apply's transaction: the documents this page wrote, or deleted, are no longer set aside. */
export async function resolveWritten(db: Db, session: ClientSession, orgId: ObjectId, written: Array<{ coll: string; id: unknown }>, now: Date): Promise<number> {
  if (!written.length || !(await db.collection<any>(DEAD).findOne({ orgId, status: 'open' }, { session, projection: { _id: 1 } }))) return 0
  const byColl = new Map<string, unknown[]>()
  for (const w of written) byColl.set(w.coll, [...(byColl.get(w.coll) ?? []), w.id])
  let n = 0
  for (const [coll, ids] of byColl) {
    const r = await db.collection<any>(DEAD).updateMany({ orgId, status: 'open', coll, docId: { $in: ids } }, { $set: { status: 'resolved', resolvedAt: now, updatedAt: now } }, { session })
    n += r.modifiedCount
  }
  return n
}

/**
 * After a page applied: the org's open dead letters whose time has come, to ask the master for with
 * the acknowledgement. Each is then left alone for a while: a resend that fails again sets it aside
 * with a longer wait. `skip` holds `coll|idKey(id)` of what the page itself carried.
 */
export async function dueForResend(db: Db, orgId: ObjectId, now: Date, skip: ReadonlySet<string> = new Set()): Promise<Array<{ coll: string; id: unknown }>> {
  const due: any[] = await db.collection<any>(DEAD).find({ orgId, status: 'open', retryAt: { $lte: now } }, { projection: { coll: 1, docId: 1 }, limit: RESEND_MAX, promoteValues: false }).toArray()
  const out = due.filter(d => !skip.has(`${d.coll}|${idKey(d.docId)}`))
  if (out.length) await db.collection<any>(DEAD).updateMany({ _id: { $in: out.map(d => d._id) } }, { $set: { retryAt: new Date(now.getTime() + ASKED_WAIT_MS), updatedAt: now } })
  return out.map(d => ({ coll: d.coll, id: d.docId }))
}

/** For the Servers page: how many documents of the org's copy are set aside, and the first few. */
export async function mirrorDeadLetterStatus(orgId: string, db: Db = mongoose.connection.db as unknown as Db): Promise<{ open: number; items: Array<{ coll: string; id: string; reason: string; detail: string | null; at: Date; attempts: number }> }> {
  if (!/^[0-9a-f]{24}$/.test(orgId) || !db) return { open: 0, items: [] }
  const org = new mongoose.Types.ObjectId(orgId) as unknown as ObjectId
  const [open, items] = await Promise.all([
    db.collection<any>(DEAD).countDocuments({ orgId: org, status: 'open' }),
    db.collection<any>(DEAD).find({ orgId: org, status: 'open' }, { sort: { at: -1 }, limit: 20, projection: { coll: 1, docId: 1, reason: 1, detail: 1, at: 1, attempts: 1 } }).toArray(),
  ])
  return { open, items: items.map((d: any) => ({ coll: d.coll, id: String(d.docId), reason: d.reason, detail: d.detail ?? null, at: d.at, attempts: Number(d.attempts ?? 1) })) }
}
