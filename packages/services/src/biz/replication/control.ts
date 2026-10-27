/**
 * What the supervisor asks the API for over the control socket (FR-20.64, plan step P3-2b, Part
 * A.6.4): the next page of an org, a resend after a collision, and where each org's journal stands.
 * The supervisor sends the pages on the bulk socket and hands global's answers back; it never reads
 * a page, so nothing it says decides what one holds.
 */
import { config } from 'config'
import { REPLICATION_META } from 'db/replication/meta.generated'
import { mongoose } from 'db/connection'
import { thisNode } from 'db/home/home'
import { ENGINE_ID } from './capture.js'
import { captureOn } from './engine.js'
import { BSON, PAGE_BYTES, PAGE_DOCS, buildPage, rejournal } from './pages.js'
import { noteWentBack } from '../home/series-lock.service.js'

const OBJECT_ID = /^[0-9a-f]{24}$/
const HASH = /^(?:[0-9a-f]{64})?$/
const REPLICATED = new Set(Object.values(REPLICATION_META).filter(e => (e.class === 'R' || e.class === 'S') && e.orgPath).map(e => e.collection))

export class ControlAskError extends Error {
  readonly status = 400
}

export interface PageAsk {
  orgId: string
  /** Global's watermark and the chain hash it holds there, as global last said (0 and '' at first). */
  after: number
  afterHash: string
  maxDocs?: number
  /** FR-20.52 (P3-2c): at most this many bytes of documents, so a paced supervisor's page fits its line's moment. */
  maxBytes?: number
}

export type PageAnswer =
  | { status: 200; bytes: Uint8Array; fromSeq: number; toSeq: number; chainHash: string; rows: number }
  | { status: 204 }
  | { status: 409; refused: string; detail: string }

export function readPageAsk(body: any): PageAsk {
  const orgId = String(body?.orgId ?? '')
  const after = Number(body?.after)
  const afterHash = String(body?.afterHash ?? '')
  const maxDocs = body?.maxDocs === undefined ? undefined : Number(body.maxDocs)
  const maxBytes = body?.maxBytes === undefined ? undefined : Number(body.maxBytes)
  if (!OBJECT_ID.test(orgId)) throw new ControlAskError('orgId is not an org id')
  if (!Number.isSafeInteger(after) || after < 0) throw new ControlAskError('after is not a seq')
  if (!HASH.test(afterHash)) throw new ControlAskError('afterHash is not a chain hash')
  if ((after === 0) !== (afterHash === '')) throw new ControlAskError('the first page starts at 0 with no hash, every other page from both')
  if (maxDocs !== undefined && (!Number.isSafeInteger(maxDocs) || maxDocs < 1 || maxDocs > PAGE_DOCS)) throw new ControlAskError(`maxDocs is 1..${PAGE_DOCS}`)
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PAGE_BYTES)) throw new ControlAskError(`maxBytes is 1..${PAGE_BYTES}`)
  return { orgId, after, afterHash, ...(maxDocs ? { maxDocs } : {}), ...(maxBytes ? { maxBytes } : {}) }
}

function handles() {
  const db = mongoose.connection.db
  if (!db) throw new Error('the database is not connected')
  return { db: db as any, client: mongoose.connection.getClient() as any }
}

/** The next page of an org above global's watermark, or why there is none. */
export async function pageFor(ask: PageAsk): Promise<PageAnswer> {
  // FR-20.54: at Control the mirror is off, and so is the capture it is sent from.
  if (!captureOn()) return { status: 409, refused: 'not_full', detail: 'this master is not linked at Full' }
  const { db, client } = handles()
  const built = await buildPage(client, db, ask.orgId, { after: ask.after, afterHash: ask.afterHash, nodeId: thisNode(), maxDocs: ask.maxDocs, maxBytes: ask.maxBytes })
  if ('empty' in built) return { status: 204 }
  if ('refused' in built) {
    // FR-20.51 (P3-7): the mirror holds pages this database never built: it went back under it, and
    // its legal numbering locks. The supervisor stops the org without a word to global.
    if (built.wentBack) await noteWentBack(ask.orgId, 'mirror_ahead', built.detail).catch(() => false)
    return { status: 409, refused: built.refused, detail: built.detail }
  }
  return { status: 200, bytes: built.bytes, fromSeq: built.page.fromSeq, toSeq: built.page.toSeq, chainHash: built.page.chainHash, rows: built.page.rows.length }
}

export interface ResendAsk {
  orgId: string
  coll: string
  ids: unknown[]
}

/** A resend as global asked for it, passed through by the supervisor: the ids keep their BSON types (EJSON). */
export function readResendAsk(text: string): ResendAsk {
  let body: any
  try {
    body = BSON.EJSON.parse(text, { relaxed: false })
  } catch {
    throw new ControlAskError('a resend is EJSON')
  }
  const orgId = String(body?.orgId ?? '')
  const coll = String(body?.coll ?? '')
  if (!OBJECT_ID.test(orgId)) throw new ControlAskError('orgId is not an org id')
  if (!REPLICATED.has(coll)) throw new ControlAskError(`${coll} does not replicate`)
  if (!Array.isArray(body?.ids) || !body.ids.length || body.ids.length > PAGE_DOCS) throw new ControlAskError(`ids is 1..${PAGE_DOCS} ids`)
  return { orgId, coll, ids: body.ids }
}

/** Journal the documents global asked for again, so the next page carries them as they are now. */
export async function resendFor(ask: ResendAsk): Promise<{ journaled: number }> {
  const { db, client } = handles()
  return { journaled: await rejournal(client, db, ask.orgId, ask.coll, ask.ids) }
}

/** Where each captured org's journal stands: what the supervisor pages, and the status page shows. */
export async function replicationStatus(): Promise<Record<string, unknown>> {
  if (!captureOn()) return { capture: false, orgs: [] }
  const { db } = handles()
  const [engine, orgs] = await Promise.all([
    db.collection('repl_engine').findOne({ _id: ENGINE_ID }),
    db.collection('repl_orgs').find({ enabled: true }, { projection: { orgId: 1, seq: 1, seededAt: 1, seededEpoch: 1, pages: { $slice: -1 } } }).toArray(),
  ])
  const journalEpoch = engine?.journalEpoch ?? 1
  return {
    capture: true,
    node: config.node.id ?? null,
    journalEpoch,
    tailing: !!engine?.holder,
    lastBatchAt: engine?.lastBatchAt ?? null,
    orgs: orgs.map((o: any) => ({
      orgId: String(o.orgId),
      seq: o.seq ?? 0,
      ready: !!o.seededAt && o.seededEpoch === journalEpoch,
      lastPage: o.pages?.[0] ? { toSeq: o.pages[0].toSeq, at: o.pages[0].at } : null,
    })),
  }
}
