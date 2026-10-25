/**
 * Pages (FR-20.64, plan step P3-2a, Part A.6.4): what a master sends its mirror on lgrai.app, and
 * the hash chain that ties every page to the ones before it.
 *
 * - **Contents.** The journal rows above global's watermark, in seq order. Each row carries the
 *   document **as it is when the page is built**, read in one snapshot with the rows, or a tombstone
 *   when it is gone. A split document carries its home's parts only (FR-20.63).
 * - **BSON, zstd.** Each document travels as its own BSON bytes, which the chain hashes and global
 *   applies as they are: no codec, and no number changing type on the way (an integral `Double`
 *   read back into JavaScript and written again would come out an `Int32`).
 * - **At most 1,000 documents or 4 MB** a page, cut between rows.
 * - **The chain.** A page's hash covers the previous page's hash, its header, and per row
 *   `(seq, coll, id, op, sha256(document))`. ⚠ A master continues only from a page it built itself
 *   (`ReplOrg.pages`): global tells it the watermark and the hash it holds, and a restored, reverted
 *   or cloned master does not have that page, so it cannot continue that chain (FR-20.51).
 * - **Only when the journal is whole.** An org is paged only once its seeding at the current journal
 *   epoch has finished: seeding hands out seqs outside the tailer's transactions, so until it ends a
 *   lower seq can still appear below a page already sent, and would never be.
 */
import { createHash, randomBytes } from 'node:crypto'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import type { mongo } from 'mongoose'
import { mongoose } from 'db/connection'
import { REPLICATION_META } from 'db/replication/meta.generated'
import type { MetaEntry } from 'db/replication/generate'
import { ENGINE_ID, capturedCollections } from './capture.js'
import { homePart } from './project.js'

type Binary = mongo.Binary
type Db = mongo.Db
type MongoClient = mongo.MongoClient
type ObjectId = mongo.ObjectId

export const BSON = mongoose.mongo.BSON

export const PAGE_VERSION = 1
export const PAGE_DOCS = 1_000
export const PAGE_BYTES = 4 * 1024 * 1024
/** A page decodes to at most this: 4 MB, or one document of up to 16 MB, and the frame around it. */
const PAGE_DECODED_MAX = 20 * 1024 * 1024
/** The pages a master remembers building: enough for every page in flight when a link drops. */
export const KEPT_PAGES = 32
const JOURNAL = 'repl_journal'
const ORGS = 'repl_orgs'
const ENGINE = 'repl_engine'

export interface PageRow {
  seq: number
  coll: string
  /** The document's `_id`, as it is typed (an ObjectId, mostly). */
  id: unknown
  /** `u`: the document as it is now; `d`: it is gone. */
  op: 'u' | 'd'
  doc?: Binary
}

export interface Page {
  v: number
  orgId: ObjectId
  nodeId: string
  /** The home epoch it is sent under (FR-20.3). */
  epoch: number
  instanceEpoch: string
  journalEpoch: number
  /** Exclusive: the watermark this page continues from. */
  fromSeq: number
  /** Inclusive: the last row's seq, the watermark once it is applied. */
  toSeq: number
  prevHash: string
  chainHash: string
  builtAt: Date
  rows: PageRow[]
}

const META_BY_COLL = new Map<string, MetaEntry>(Object.values(REPLICATION_META).map(e => [e.collection, e]))

/** The metadata of a collection, by its name. */
export function metaOf(coll: string): MetaEntry | undefined {
  return META_BY_COLL.get(coll)
}

/** A number as JavaScript has it, whatever BSON type carried it (`promoteValues: false` keeps wrappers). */
export function num(v: unknown): number {
  if (typeof v === 'number') return v
  const t = (v as any)?._bsontype
  if (t === 'Long') return (v as any).toNumber()
  if (t === 'Int32' || t === 'Double') return (v as any).value
  return Number.NaN
}

/** One key for an id, the way MongoDB compares them: `5`, `Int32(5)` and `5.0` are the same id. */
export function idKey(v: unknown): string {
  const t = (v as any)?._bsontype
  if (t === 'ObjectId') return `o:${String(v)}`
  if (typeof v === 'string') return `s:${v}`
  if (typeof v === 'number' || t === 'Int32' || t === 'Double' || t === 'Long') return `n:${num(v)}`
  return `x:${BSON.EJSON.stringify(v as any, { relaxed: false })}`
}

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')

/** A Binary's own bytes. */
export function bytesOf(b: Binary): Uint8Array {
  return b.buffer.subarray(0, b.position)
}

/** A row as the chain hashes it. The id by its BSON bytes, so its type is part of the hash. */
export function rowLine(r: PageRow): string {
  const id = Buffer.from(BSON.serialize({ i: r.id as any })).toString('hex')
  return `${r.seq}\t${r.coll}\t${id}\t${r.op}\t${r.doc ? sha256(bytesOf(r.doc)) : ''}`
}

/** The chain hash of a page: the one before it, its header, and its rows (FR-20.64). */
export function chainHash(p: Pick<Page, 'prevHash' | 'orgId' | 'epoch' | 'instanceEpoch' | 'journalEpoch' | 'fromSeq' | 'toSeq'>, rows: PageRow[]): string {
  const h = createHash('sha256')
  h.update(`lgr-page/${PAGE_VERSION}\n${p.prevHash}\n${String(p.orgId)}\n${p.epoch}\n${p.instanceEpoch}\n${p.journalEpoch}\n${p.fromSeq}\n${p.toSeq}\n${rows.length}\n`)
  for (const r of rows) h.update(`${rowLine(r)}\n`)
  return h.digest('hex')
}

/** A page on the wire: BSON, zstd. */
export function encodePage(p: Page): Uint8Array {
  return zstdCompressSync(BSON.serialize(p as any))
}

export class PageFormatError extends Error {
  readonly code = 'page_malformed'
}

/** A page off the wire. Its documents stay bytes until applied; nothing here trusts what it says. */
export function decodePage(bytes: Uint8Array): Page {
  let raw: Record<string, any>
  try {
    raw = BSON.deserialize(zstdDecompressSync(bytes, { maxOutputLength: PAGE_DECODED_MAX }), { promoteValues: false })
  } catch (e: any) {
    throw new PageFormatError(`not a page: ${e?.code ?? e?.message ?? e}`)
  }
  if (num(raw.v) !== PAGE_VERSION) throw new PageFormatError(`page version ${String(raw.v)} is not ${PAGE_VERSION}`)
  if (raw.orgId?._bsontype !== 'ObjectId') throw new PageFormatError('a page names no org')
  if (!Array.isArray(raw.rows)) throw new PageFormatError('a page has no rows')
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : (() => { throw new PageFormatError('a page field is not what it should be') })())
  const int = (v: unknown) => {
    const n = num(v)
    if (!Number.isSafeInteger(n) || n < 0) throw new PageFormatError('a page number is not a whole number')
    return n
  }
  const rows: PageRow[] = raw.rows.map((r: any) => {
    if (r?.op !== 'u' && r?.op !== 'd') throw new PageFormatError('a row is neither a document nor a tombstone')
    if (r.op === 'u' && r.doc?._bsontype !== 'Binary') throw new PageFormatError('a row carries no document')
    return { seq: int(r.seq), coll: str(r.coll, 120), id: r.id, op: r.op, ...(r.op === 'u' ? { doc: r.doc } : {}) }
  })
  return {
    v: PAGE_VERSION,
    orgId: raw.orgId,
    nodeId: str(raw.nodeId, 80),
    epoch: int(raw.epoch),
    instanceEpoch: str(raw.instanceEpoch, 64),
    journalEpoch: int(raw.journalEpoch),
    fromSeq: int(raw.fromSeq),
    toSeq: int(raw.toSeq),
    prevHash: str(raw.prevHash, 64),
    chainHash: str(raw.chainHash, 64),
    builtAt: raw.builtAt instanceof Date ? raw.builtAt : new Date(0),
    rows,
  }
}

/** A row's document, its numbers kept as the types they were. */
export function decodeDoc(b: Binary): Record<string, unknown> {
  return BSON.deserialize(bytesOf(b), { promoteValues: false })
}

/**
 * Which copy of this master's data this is (FR-20.71): made once, the first time it is asked for. A
 * restore makes a new one (P3-7).
 */
export async function instanceEpoch(db: Db): Promise<string> {
  const r = await db.collection<any>('node_instance').findOneAndUpdate(
    { _id: 'instance' },
    { $setOnInsert: { instanceEpoch: randomBytes(16).toString('hex'), createdAt: new Date() } },
    { upsert: true, returnDocument: 'after' },
  )
  return r!.instanceEpoch
}

export interface BuildOptions {
  /** Global's watermark and the chain hash it holds there (FR-20.67): 0 and '' for its first page. */
  after: number
  afterHash: string
  /** This master, and the home epoch it holds the org at (`OrgHome` on this node). */
  nodeId: string
  maxDocs?: number
  maxBytes?: number
  now?: Date
}

export type Built =
  | { page: Page; bytes: Uint8Array }
  | { empty: true }
  | { refused: 'not_home' | 'not_ready' | 'chain_unknown'; detail: string }

const asObjectId = (v: unknown): ObjectId => ((v as any)?._bsontype === 'ObjectId' ? (v as ObjectId) : new mongoose.Types.ObjectId(String(v)) as unknown as ObjectId)

/**
 * The next page of `orgId` after global's watermark, or why there is none. Records the page in the
 * master's own chain (`ReplOrg.pages`) before returning it, so the next page can continue from it.
 */
export async function buildPage(client: MongoClient, db: Db, orgId: unknown, o: BuildOptions): Promise<Built> {
  const org = asObjectId(orgId)
  const maxDocs = Math.max(1, Math.min(o.maxDocs ?? PAGE_DOCS, PAGE_DOCS))
  const maxBytes = Math.max(1, Math.min(o.maxBytes ?? PAGE_BYTES, PAGE_BYTES))

  const home = await db.collection<any>('org_homes').findOne({ orgId: org })
  if (!home || home.home !== o.nodeId || home.state === 'fenced' || home.state === 'hold') {
    return { refused: 'not_home', detail: `this node is not the org's home${home ? ` (${home.home === o.nodeId ? home.state : 'another node'})` : ''}` }
  }
  const [engine, repl] = await Promise.all([
    db.collection<any>(ENGINE).findOne({ _id: ENGINE_ID }),
    db.collection<any>(ORGS).findOne({ orgId: org }),
  ])
  const journalEpoch: number = engine?.journalEpoch ?? 1
  if (!repl?.enabled || !repl.seededAt || repl.seededEpoch !== journalEpoch) {
    return { refused: 'not_ready', detail: `the org's journal is not whole at journal epoch ${journalEpoch} yet` }
  }
  let prevHash = ''
  if (o.after !== 0 || o.afterHash !== '') {
    const mine = ((repl.pages ?? []) as Array<{ toSeq: number; hash: string }>).some(p => num(p.toSeq) === o.after && p.hash === o.afterHash)
    if (!mine) return { refused: 'chain_unknown', detail: `this master built no page ending at ${o.after} with the hash global holds` }
    prevHash = o.afterHash
  }

  const captured = capturedCollections()
  // One snapshot for the rows and their documents: a page is one moment of the org.
  const session = client.startSession({ snapshot: true })
  let rows: PageRow[] = []
  try {
    const journal = await db.collection<any>(JOURNAL)
      .find({ orgId: org, seq: { $gt: o.after } }, { session, sort: { seq: 1 }, limit: maxDocs, projection: { coll: 1, docId: 1, seq: 1, op: 1 }, promoteValues: false })
      .toArray()
    const docs = new Map<string, Record<string, unknown>>()
    const byColl = new Map<string, unknown[]>()
    for (const j of journal) {
      if (!captured.has(j.coll)) continue
      if (!byColl.has(j.coll)) byColl.set(j.coll, [])
      byColl.get(j.coll)!.push(j.docId)
    }
    for (const [coll, ids] of byColl) {
      const c = captured.get(coll)!
      const filter = c.orgPath === '_id' ? { _id: { $in: ids } } : { _id: { $in: ids }, orgId: org }
      for (const d of await db.collection<any>(coll).find(filter as any, { session, promoteValues: false }).toArray()) {
        docs.set(`${coll}|${idKey(d._id)}`, d)
      }
    }
    let bytes = 0
    for (const j of journal) {
      const entry = metaOf(j.coll)
      if (!entry || !captured.has(j.coll)) continue
      const doc = docs.get(`${j.coll}|${idKey(j.docId)}`)
      const row: PageRow = doc
        ? { seq: num(j.seq), coll: j.coll, id: doc._id, op: 'u', doc: new BSON.Binary(BSON.serialize(homePart(doc, entry) as any)) }
        : { seq: num(j.seq), coll: j.coll, id: j.docId, op: 'd' }
      const size = (row.doc ? row.doc.position : 0) + 96
      if (rows.length && bytes + size > maxBytes) break
      rows.push(row)
      bytes += size
    }
  } finally {
    await session.endSession()
  }
  if (!rows.length) return { empty: true }

  const page: Page = {
    v: PAGE_VERSION,
    orgId: org,
    nodeId: o.nodeId,
    epoch: num(home.epoch),
    instanceEpoch: await instanceEpoch(db),
    journalEpoch,
    fromSeq: o.after,
    toSeq: rows[rows.length - 1].seq,
    prevHash,
    chainHash: '',
    builtAt: o.now ?? new Date(),
    rows,
  }
  page.chainHash = chainHash(page, rows)
  // ⚠ Recorded before it can be sent: a page global applies is one this master can continue from.
  await db.collection<{ orgId: ObjectId; pages: Array<{ toSeq: number; hash: string; at: Date }> }>(ORGS).updateOne(
    { orgId: org },
    { $push: { pages: { $each: [{ toSeq: page.toSeq, hash: page.chainHash, at: page.builtAt }], $slice: -KEPT_PAGES } } },
  )
  return { page, bytes: encodePage(page) }
}

/**
 * Journal these documents again with fresh seqs, so the next page carries them as they are now:
 * global's `resend` after a collision (FR-20.65). One transaction with the seqs, like a tailer batch,
 * so seqs still become visible in order.
 */
export async function rejournal(client: MongoClient, db: Db, orgId: unknown, coll: string, ids: unknown[]): Promise<number> {
  const c = capturedCollections().get(coll)
  if (!c || !ids.length) return 0
  const org = asObjectId(orgId)
  const wanted = ids.slice(0, PAGE_DOCS)
  let written = 0
  const session = client.startSession()
  try {
    await session.withTransaction(async () => {
      written = 0
      const engine = await db.collection<any>(ENGINE).findOne({ _id: ENGINE_ID }, { session })
      const filter = c.orgPath === '_id' ? { _id: { $in: wanted } } : { _id: { $in: wanted }, orgId: org }
      const present = new Set((await db.collection<any>(coll).find(filter as any, { session, projection: { _id: 1 } }).toArray()).map(d => idKey(d._id)))
      const r = await db.collection<any>(ORGS).findOneAndUpdate({ orgId: org, enabled: true }, { $inc: { seq: wanted.length }, $set: { updatedAt: new Date() } }, { session, returnDocument: 'after' })
      if (!r) return
      let seq = r.seq - wanted.length
      const now = new Date()
      const ops = wanted.map(id => ({
        updateOne: {
          filter: { orgId: org, coll, docId: id },
          update: { $set: { seq: ++seq, op: present.has(idKey(id)) ? 'upsert' : 'delete', changedFields: [], clusterTime: now, journalEpoch: engine?.journalEpoch ?? 1, updatedAt: now } },
          upsert: true,
        },
      }))
      await db.collection(JOURNAL).bulkWrite(ops, { session, ordered: true })
      written = ops.length
    })
  } finally {
    await session.endSession()
  }
  return written
}
