/**
 * What a FENCED master did after the cutoff (FR-20.84, plan step P3-6e): exported by the master,
 * received and kept by global, listed for a person to review. Bringing its sales into the home is
 * the audited import, the next step: nothing here writes any of it into the org.
 *
 * - **What it holds.** Every document the master's journal holds above the promotion's
 *   `fenceCutoff`, as a move carries it (`moveProjection`). A row of another journal epoch than the
 *   cutoff's was journaled again after a lost history, so whether global saw it is unknown: it goes
 *   too. A document gone since is listed as deleted. The bytes of the files those rows name come in
 *   the same artifact.
 * - **Sealed**: one zstd stream (`lgr-fenced/1`) with a header (org, node, promotion, cutoff, epoch,
 *   journal head), then per collection its documents in `_id` order, then the deletions, then the
 *   files, then a trailer with each section's count and sha256. Global checks the whole file against
 *   the sha256 the master announced, then every section against the trailer.
 * - ⚠ **One org's.** Every document must carry the header's org and every file must lie in its tree,
 *   or global refuses the bundle (AC 38).
 * - **Sent in chunks** at the offset global holds, so a cut link resumes where it stopped.
 * - ⚠ **Never discarded, never imported by itself.** The master keeps it under the org's `docs/`, and
 *   so does global, whose backups carry it: it is the evidence the audited import keeps (Прил. 42:
 *   full and unchanged content, with source and time). A bundle that fails its checks is `refused`,
 *   and kept as well.
 */
import { createHash } from 'node:crypto'
import { constants as fsConstants, createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rename, stat, truncate } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import type { mongo } from 'mongoose'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { FencedExport, FencedImportItem, Invoice, OrgMove, ServerNode, type FencedLegalDoc } from 'db/models'
import { logger } from '../../logger/logger.js'
import { splitLines } from '../backup/backup-files.service.js'
import { normalizeStored, resolveStored, validateStored } from '../files/stored-path.js'
import { idKey } from '../replication/pages.js'
import { digestMismatch, fileSha256, moveCollections, moveProjection, type Digests, type SectionDigest } from './move-bundle.js'
import { MoveError } from './move.service.js'

type Db = mongo.Db
type ObjectId = mongo.ObjectId
type Doc = Record<string, unknown>

export const FENCED_FORMAT = 'lgr-fenced/1'
/** One chunk of the upload. */
export const FENCED_CHUNK = 4 * 1024 * 1024
/** The largest export global takes: past it, a person brings it in by hand. */
export const FENCED_MAX_BYTES = 4 * 1024 ** 3
/** The review lists at most this many sales; the import reads them all from the bundle. */
const LEGAL_LISTED = 5_000

const EJSON = mongoose.mongo.BSON.EJSON
const JOURNAL = 'repl_journal'
const ORGS = 'repl_orgs'
const BATCH = 500

/** Where an export lives, on the master and on global alike: under the org's documents. */
export function fencedExportPath(orgId: string, moveId: string): string {
  return join(config.upload.dir, String(orgId), 'docs', 'fenced', `fenced-${moveId}.ndjson.zst`)
}

export interface FencedHeader {
  format: string
  orgId: string
  nodeId: string
  moveId: string
  cutoff: number
  journalEpoch?: number
  /** The org's journal head when the export was made: everything up to it is inside. */
  head: number
  exportedAt: string
}

export interface WrittenFencedExport {
  path: string
  sha256: string
  size: number
  documents: number
  deleted: number
  files: number
  /** Files a row names that were not on disk to send. */
  missingFiles: number
}

const section = () => ({ h: createHash('sha256'), count: 0 })
const digestOf = (s: { h: ReturnType<typeof createHash>; count: number }): SectionDigest => ({ count: s.count, sha256: s.h.digest('hex') })
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const orgOf = (orgPath: string | undefined, doc: Doc) => (orgPath === '_id' ? doc._id : doc.orgId)

/** The journal rows of an org that global may not have seen. */
export function aboveCutoff(cutoff: number, journalEpoch?: number) {
  return typeof journalEpoch === 'number'
    ? { $or: [{ journalEpoch: { $ne: journalEpoch } }, { seq: { $gt: cutoff } }] }
    : { seq: { $gt: cutoff } }
}

/** The stored paths of the files a row names: a document's current file, a File row's bytes. */
function pathsOf(coll: string, doc: Doc): string[] {
  if (coll === 'docfiles' && doc.archived !== true && typeof doc.currentPath === 'string') return [doc.currentPath]
  if (coll === 'files' && (doc.storageProvider ?? 'local') === 'local' && typeof doc.storagePath === 'string') return [doc.storagePath]
  return []
}

/**
 * The master: write the export of `orgId` to `path`. The org is fenced here, so nothing writes it
 * under the cursor. Written beside and renamed into place, so a crash never leaves half an export.
 */
export async function writeFencedExport(
  db: Db,
  h: { orgId: ObjectId; nodeId: string; moveId: string; cutoff: number; journalEpoch?: number },
  path: string,
): Promise<WrittenFencedExport> {
  const orgId = h.orgId
  const head = ((await db.collection<any>(ORGS).findOne({ orgId }, { projection: { seq: 1 } })) as any)?.seq ?? 0
  const above = aboveCutoff(h.cutoff, h.journalEpoch)
  const digests: Digests = {}
  const deleted = section()
  const files = section()
  const deletions: string[] = []
  const paths = new Set<string>()
  let documents = 0
  let missingFiles = 0
  async function* lines(): AsyncGenerator<Buffer> {
    const header: FencedHeader = {
      format: FENCED_FORMAT, orgId: String(orgId), nodeId: h.nodeId, moveId: h.moveId, cutoff: h.cutoff,
      ...(typeof h.journalEpoch === 'number' ? { journalEpoch: h.journalEpoch } : {}), head, exportedAt: new Date().toISOString(),
    }
    yield Buffer.from(`${JSON.stringify(header)}\n`)
    for (const e of moveCollections()) {
      const s = section()
      // Index-backed ({orgId, coll, docId}); the cutoff is a residual filter.
      const cursor = db.collection<any>(JOURNAL).find({ orgId, coll: e.collection, ...above }, { sort: { docId: 1 }, projection: { docId: 1, op: 1, clusterTime: 1 } })
      for (;;) {
        const batch: any[] = []
        while (batch.length < BATCH) {
          const r = await cursor.next()
          if (!r) break
          batch.push(r)
        }
        if (!batch.length) break
        const ids = batch.filter(r => r.op === 'upsert').map(r => r.docId)
        const docs = ids.length ? await db.collection(e.collection).find({ _id: { $in: ids } } as any, { promoteValues: false }).toArray() : []
        const byId = new Map(docs.map((d: any) => [idKey(d._id), d as Doc]))
        for (const r of batch) {
          const doc = r.op === 'upsert' ? byId.get(idKey(r.docId)) : undefined
          if (!doc) {
            deletions.push(`${EJSON.stringify({ coll: e.collection, id: r.docId, at: r.clusterTime ?? null } as any, { relaxed: false })}\n`)
            continue
          }
          // A journal row is one org's, and so is its document; anything else is not this export's.
          if (String(orgOf(e.orgPath, doc)) !== String(orgId)) continue
          if (!s.count) yield Buffer.from(`${JSON.stringify({ $coll: e.collection })}\n`)
          const line = `${EJSON.stringify(moveProjection(e, doc) as any, { relaxed: false })}\n`
          s.h.update(line)
          s.count++
          yield Buffer.from(line)
          for (const p of pathsOf(e.collection, doc)) paths.add(p)
        }
      }
      if (s.count) {
        digests[e.collection] = digestOf(s)
        documents += s.count
      }
    }
    if (deletions.length) {
      yield Buffer.from('{"$deleted":true}\n')
      for (const line of deletions) {
        deleted.h.update(line)
        deleted.count++
        yield Buffer.from(line)
      }
    }
    if (paths.size) {
      let opened = false
      for (const stored of [...paths].sort()) {
        let rel: string
        let content: Buffer
        try {
          rel = normalizeStored(stored)
          content = Buffer.from(await Bun.file(resolveStored(rel, orgId)).arrayBuffer())
        } catch (e: any) {
          missingFiles++
          logger.warn({ orgId: String(orgId), file: stored, err: e?.message }, 'Fenced export: a file a row names is not here to send')
          continue
        }
        if (!opened) yield Buffer.from('{"$files":true}\n')
        opened = true
        const line = `${JSON.stringify({ path: rel, size: content.length, sha256: sha(content), b64: content.toString('base64') })}\n`
        files.h.update(line)
        files.count++
        yield Buffer.from(line)
      }
    }
    yield Buffer.from(`${JSON.stringify({ $end: true, documents, digests, deleted: digestOf(deleted), files: digestOf(files), missingFiles })}\n`)
  }
  await mkdir(dirname(path), { recursive: true })
  const part = `${path}.writing`
  await pipeline(Readable.from(lines()), zlib.createZstdCompress(), createWriteStream(part))
  await rename(part, path)
  return { path, sha256: await fileSha256(path), size: (await stat(path)).size, documents, deleted: deleted.count, files: files.count, missingFiles }
}

export class FencedExportError extends Error {
  readonly code = 'fenced_export_invalid'
}

export type FencedItem =
  | { kind: 'doc'; coll: string; doc: Doc }
  | { kind: 'deleted'; coll: string; id: unknown; at: Date | null }
  | { kind: 'file'; path: string; size: number; sha256: string; bytes: Buffer }

export interface FencedTrailer {
  header: FencedHeader
  documents: number
  digests: Digests
  deleted: number
  files: number
  missingFiles: number
}

const sameSection = (a: SectionDigest, b: any) => a.count === (b?.count ?? 0) && (a.count === 0 || a.sha256 === b?.sha256)

/**
 * Every item of an export, in order, each checked as it goes past: its format, its org and its
 * promotion, collections a move carries, documents of that org only, files inside its tree whose
 * bytes hash to what they say, and every section against the trailer.
 */
export async function* readFencedExport(path: string, expect: { orgId?: string; moveId?: string } = {}): AsyncGenerator<FencedItem, FencedTrailer> {
  const entries = new Map(moveCollections().map(e => [e.collection, e]))
  const seen: Record<string, { h: ReturnType<typeof createHash>; count: number }> = {}
  const deleted = section()
  const files = section()
  let header: FencedHeader | null = null
  let part: 'docs' | 'deleted' | 'files' = 'docs'
  let coll: string | null = null
  for await (const line of splitLines(createReadStream(path).pipe(zlib.createZstdDecompress()))) {
    if (!line) continue
    if (!header) {
      const h = JSON.parse(line)
      if (h?.format !== FENCED_FORMAT) throw new FencedExportError(`not a fenced export (${String(h?.format)})`)
      if (expect.orgId && h.orgId !== expect.orgId) throw new FencedExportError(`an export of another organisation (${String(h.orgId)})`)
      if (expect.moveId && h.moveId !== expect.moveId) throw new FencedExportError('an export of another promotion')
      header = h as FencedHeader
      continue
    }
    if (line.startsWith('{"$coll":')) {
      if (part !== 'docs') throw new FencedExportError('a collection after the deletions or the files')
      coll = JSON.parse(line).$coll
      if (!coll || !entries.has(coll)) throw new FencedExportError(`${String(coll)} is not a collection a move carries`)
      if (seen[coll]) throw new FencedExportError(`${coll} appears twice`)
      seen[coll] = section()
      continue
    }
    if (line === '{"$deleted":true}') {
      if (part !== 'docs') throw new FencedExportError('the deletions appear twice, or after the files')
      part = 'deleted'
      continue
    }
    if (line === '{"$files":true}') {
      if (part === 'files') throw new FencedExportError('the files appear twice')
      part = 'files'
      continue
    }
    if (line.startsWith('{"$end":')) {
      const t = JSON.parse(line)
      const got: Digests = Object.fromEntries(Object.entries(seen).map(([c, s]) => [c, digestOf(s)]))
      const bad = digestMismatch(got, t.digests ?? {})
      const ours = { deleted: digestOf(deleted), files: digestOf(files) }
      if (!sameSection(ours.deleted, t.deleted)) bad.push('deleted')
      if (!sameSection(ours.files, t.files)) bad.push('files')
      if (bad.length) throw new FencedExportError(`the export does not match its own digests: ${bad.join(', ')}`)
      const documents = Object.values(got).reduce((n, d) => n + d.count, 0)
      return { header, documents, digests: got, deleted: ours.deleted.count, files: ours.files.count, missingFiles: Number(t.missingFiles) || 0 }
    }
    if (part === 'deleted') {
      deleted.h.update(`${line}\n`)
      deleted.count++
      const d = EJSON.parse(line, { relaxed: false }) as any
      if (!entries.has(d?.coll)) throw new FencedExportError(`a deletion in ${String(d?.coll)}, which a move does not carry`)
      yield { kind: 'deleted', coll: d.coll, id: d.id, at: d.at instanceof Date ? d.at : null }
      continue
    }
    if (part === 'files') {
      files.h.update(`${line}\n`)
      files.count++
      const f = JSON.parse(line)
      let rel: string
      try {
        rel = validateStored(String(f?.path ?? ''))
      } catch (e: any) {
        throw new FencedExportError(`a file with a path that is not a stored path: ${e?.message ?? ''}`)
      }
      if (rel.split('/')[0] !== header.orgId) throw new FencedExportError(`a file outside the organisation's tree: ${rel}`)
      const bytes = Buffer.from(String(f.b64 ?? ''), 'base64')
      if (bytes.length !== f.size || sha(bytes) !== f.sha256) throw new FencedExportError(`${rel} does not hash to what it says`)
      yield { kind: 'file', path: rel, size: bytes.length, sha256: f.sha256, bytes }
      continue
    }
    if (!coll) throw new FencedExportError('a document before any collection')
    seen[coll].h.update(`${line}\n`)
    seen[coll].count++
    const doc = EJSON.parse(line, { relaxed: false }) as Doc
    // ⚠ AC 38: an export names one org, and carries nothing of another.
    if (String(orgOf(entries.get(coll)!.orgPath, doc)) !== header.orgId) throw new FencedExportError(`a document of another organisation in ${coll}`)
    yield { kind: 'doc', coll, doc }
  }
  throw new FencedExportError('the export ends without its trailer')
}

// ── Global ─────────────────────────────────────────────────────────────────────────────────────

/** A plain number from what canonical EJSON parses into (`Double`, `Int32`, `Long`). */
const num = (v: any): number | undefined => {
  if (v === null || v === undefined) return undefined
  if (typeof v === 'number') return v
  if (typeof v?.toNumber === 'function') return v.toNumber()
  const n = Number(typeof v?.valueOf === 'function' ? v.valueOf() : v)
  return Number.isFinite(n) ? n : undefined
}
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** The promotion a master asks about: of an org it was home of, and finished. */
async function promotionFor(nodeId: string, moveId: string) {
  if (!/^[0-9a-f]{24}$/.test(moveId)) throw new MoveError(404, 'not_found', 'No such promotion.')
  const m: any = await OrgMove.findById(moveId).lean()
  if (!m || m.kind !== 'promote' || m.from !== nodeId) throw new MoveError(404, 'not_found', 'No such promotion of an organisation this server was home of.')
  if (m.state !== 'done') throw new MoveError(409, 'not_done', 'The promotion has not finished.')
  return m
}

export interface FencedStatus {
  state: 'none' | 'receiving' | 'received' | 'refused'
  received: number
  size?: number
  sha256?: string
  error?: string
}

/** Where global stands with a promotion's export: the master resumes from `received`. */
export async function fencedExportStatus(nodeId: string, moveId: string): Promise<FencedStatus> {
  const m = await promotionFor(nodeId, moveId)
  const row: any = await FencedExport.findOne({ moveId: m._id }).lean()
  if (!row) return { state: 'none', received: 0 }
  return { state: row.state, received: row.received, size: row.size, sha256: row.sha256, ...(row.error ? { error: row.error } : {}) }
}

/**
 * One chunk of a promotion's export, at `offset`. The first chunk fixes the export's size and sha256
 * for good; a chunk anywhere but where global stands is answered with where that is. The last one
 * makes it whole: checked, summarized, kept.
 */
export async function receiveFencedChunk(nodeId: string, moveId: string, at: { offset: number; size: number; sha256: string }, bytes: Uint8Array): Promise<FencedStatus & { offsetMismatch?: true }> {
  const m = await promotionFor(nodeId, moveId)
  if (!Number.isSafeInteger(at.size) || at.size < 1 || at.size > FENCED_MAX_BYTES) throw new MoveError(422, 'bad_size', `An export is between 1 byte and ${FENCED_MAX_BYTES} bytes.`)
  if (!/^[0-9a-f]{64}$/.test(at.sha256)) throw new MoveError(422, 'bad_sha256', 'The export\'s sha256 is 64 lower-case hex digits.')
  if (!Number.isSafeInteger(at.offset) || at.offset < 0 || bytes.length < 1 || bytes.length > FENCED_CHUNK || at.offset + bytes.length > at.size) {
    throw new MoveError(422, 'bad_chunk', `A chunk is 1 to ${FENCED_CHUNK} bytes, inside the export.`)
  }
  let row: any = await FencedExport.findOne({ moveId: m._id }).lean()
  if (!row) {
    try {
      row = (await FencedExport.create({ orgId: m.orgId, moveId: m._id, nodeId, size: at.size, sha256: at.sha256, received: 0, state: 'receiving' })).toObject()
    } catch (e: any) {
      if (e?.code !== 11000) throw e
      row = await FencedExport.findOne({ moveId: m._id }).lean()
    }
  }
  // ⚠ Never replaced: what arrived first is the evidence.
  if (row.size !== at.size || row.sha256 !== at.sha256) {
    throw new MoveError(409, 'export_changed', 'This promotion\'s export was announced with another size or sha256, and is never replaced.')
  }
  if (row.state !== 'receiving') return { state: row.state, received: row.received, size: row.size, sha256: row.sha256 }
  if (at.offset !== row.received) return { state: 'receiving', received: row.received, size: row.size, sha256: row.sha256, offsetMismatch: true }
  const part = `${fencedExportPath(String(m.orgId), String(m._id))}.part`
  await mkdir(dirname(part), { recursive: true })
  // Never truncated: a slow retry of an earlier chunk must not cut off the ones after it.
  const fh = await open(part, fsConstants.O_RDWR | fsConstants.O_CREAT)
  try {
    await fh.write(bytes, 0, bytes.length, at.offset)
  } finally {
    await fh.close()
  }
  const end = at.offset + bytes.length
  const moved = await FencedExport.updateOne({ _id: row._id, state: 'receiving', received: at.offset }, { $set: { received: end } })
  if (!moved.modifiedCount) {
    const now: any = await FencedExport.findById(row._id).lean()
    return { state: now.state, received: now.received, size: now.size, sha256: now.sha256 }
  }
  if (end < at.size) return { state: 'receiving', received: end, size: row.size, sha256: row.sha256 }
  return finishFencedExport(String(row._id))
}

/** The whole export, checked and summarized; refused, and kept, when it fails either. */
async function finishFencedExport(id: string): Promise<FencedStatus> {
  const row: any = await FencedExport.findById(id).lean()
  const final = fencedExportPath(String(row.orgId), String(row.moveId))
  const part = `${final}.part`
  const refuse = async (error: string) => {
    await FencedExport.updateOne({ _id: row._id }, { $set: { state: 'refused', error: error.slice(0, 2000), receivedAt: new Date() } })
    logger.error({ orgId: String(row.orgId), moveId: String(row.moveId), nodeId: row.nodeId, error }, 'Fenced export: refused, and kept')
    return { state: 'refused' as const, received: row.size, size: row.size, sha256: row.sha256, error }
  }
  // A tail left from a row removed by hand would change the hash: the export is `size` bytes.
  await truncate(part, row.size)
  const got = await fileSha256(part)
  if (got !== row.sha256) return refuse(`it arrived with another sha256 (${got.slice(0, 12)}…) than the one announced`)
  await rename(part, final)
  let summary
  try {
    summary = await summarizeFencedExport(final, { orgId: String(row.orgId), moveId: String(row.moveId) })
  } catch (e: any) {
    return refuse(e instanceof FencedExportError ? e.message : `it could not be read: ${e?.message ?? e}`)
  }
  const { header, ...rest } = summary
  await FencedExport.updateOne(
    { _id: row._id },
    { $set: { state: 'received', receivedAt: new Date(), cutoff: header.cutoff, ...(typeof header.journalEpoch === 'number' ? { journalEpoch: header.journalEpoch } : {}), head: header.head, exportedAt: new Date(header.exportedAt), summary: rest } },
  )
  logger.warn({ orgId: String(row.orgId), moveId: String(row.moveId), nodeId: row.nodeId, documents: rest.documents, legal: rest.legal.length }, 'Fenced export: what the replaced server did after the cutoff has arrived, for review')
  return { state: 'received', received: row.size, size: row.size, sha256: row.sha256 }
}

export interface FencedSummary {
  header: FencedHeader
  documents: number
  deleted: number
  files: number
  missingFiles: number
  byColl: Record<string, number>
  legal: FencedLegalDoc[]
  legalTruncated?: boolean
}

/** What an export holds, by collection, and its sales and invoices by number: what the review shows. */
export async function summarizeFencedExport(path: string, expect: { orgId?: string; moveId?: string } = {}): Promise<FencedSummary> {
  const byColl: Record<string, number> = {}
  const legal: FencedLegalDoc[] = []
  let legalTruncated = false
  const items = readFencedExport(path, expect)
  for (;;) {
    const next = await items.next()
    if (next.done) {
      const t = next.value
      return { header: t.header, documents: t.documents, deleted: t.deleted, files: t.files, missingFiles: t.missingFiles, byColl, legal, ...(legalTruncated ? { legalTruncated } : {}) }
    }
    const it = next.value
    if (it.kind !== 'doc') continue
    byColl[it.coll] = (byColl[it.coll] ?? 0) + 1
    if (it.coll !== 'invoices') continue
    if (legal.length >= LEGAL_LISTED) {
      legalTruncated = true
      continue
    }
    const d: any = it.doc
    legal.push({
      coll: it.coll, id: String(d._id), number: str(d.invoiceNumber), type: str(d.type), direction: str(d.direction), status: str(d.status),
      ...(d.issueDate instanceof Date ? { issueDate: d.issueDate } : {}), total: num(d.total), currency: str(d.currency),
    })
  }
}

export interface FencedLegalView extends FencedLegalDoc {
  /** `absent`: new to global. `same_id`: global has this document (made before the cutoff, changed after). `collision`: global gave its number to another document. */
  onGlobal: 'absent' | 'same_id' | 'collision'
  collidesWith?: { id: string; number: string; type?: string; issueDate?: Date; total?: number }
  /** What the audited import did with it, once it ran (P3-6e). */
  imported?: { outcome: string; reason?: string; detail?: string }
}

/** An org's fenced exports, newest first, each sale checked against what global holds now. */
export async function fencedExportsOf(orgId: string) {
  const rows: any[] = await FencedExport.find({ orgId }).sort({ createdAt: -1 }).lean()
  const out = []
  for (const r of rows) {
    const legal: FencedLegalDoc[] = r.summary?.legal ?? []
    const ids = legal.map(l => l.id).filter(id => /^[0-9a-f]{24}$/.test(id))
    const numbers = [...new Set(legal.map(l => l.number).filter((n): n is string => !!n))]
    const [present, sameNumber]: [any[], any[]] = await Promise.all([
      ids.length ? Invoice.find({ orgId, _id: { $in: ids } }, { _id: 1 }).lean() : [],
      numbers.length ? Invoice.find({ orgId, invoiceNumber: { $in: numbers } }, { invoiceNumber: 1, type: 1, issueDate: 1, total: 1 }).lean() : [],
    ])
    const has = new Set(present.map(p => String(p._id)))
    // What the import did with each sale, once it ran.
    const outcomes = new Map(((await FencedImportItem.find({ exportId: r._id, coll: 'invoices' }, { docKey: 1, outcome: 1, reason: 1, detail: 1 }).lean()) as any[])
      .map(i => [i.docKey, { outcome: i.outcome, ...(i.reason ? { reason: i.reason } : {}), ...(i.detail ? { detail: i.detail } : {}) }]))
    // The server's name, even once it is removed: the list of active servers would not have it.
    const node: any = await ServerNode.findById(r.nodeId, { name: 1 }).lean()
    const byNumber = new Map<string, any[]>()
    for (const g of sameNumber) byNumber.set(g.invoiceNumber, [...(byNumber.get(g.invoiceNumber) ?? []), g])
    const view: FencedLegalView[] = legal.map(l => {
      const done = outcomes.get(l.id)
      const other = (l.number ? byNumber.get(l.number) ?? [] : []).find(g => String(g._id) !== l.id)
      if (other) return { ...l, onGlobal: 'collision', collidesWith: { id: String(other._id), number: other.invoiceNumber, type: other.type, issueDate: other.issueDate, total: other.total }, ...(done ? { imported: done } : {}) }
      // Once imported, the sale IS lgrai.app's own: say so, not "already here".
      return { ...l, onGlobal: has.has(l.id) && done?.outcome !== 'imported' ? 'same_id' : 'absent', ...(done ? { imported: done } : {}) }
    })
    out.push({
      id: String(r._id), moveId: String(r.moveId), nodeId: r.nodeId, nodeName: node?.name ?? null, state: r.state, size: r.size, received: r.received,
      import: r.import ? { state: r.import.state, requestedAt: r.import.requestedAt ?? null, doneAt: r.import.doneAt ?? null, counts: r.import.counts ?? null, error: r.import.error ?? null } : null,
      receivedAt: r.receivedAt ?? null, exportedAt: r.exportedAt ?? null, cutoff: r.cutoff ?? null, head: r.head ?? null, error: r.error ?? null,
      summary: r.summary ? { documents: r.summary.documents, deleted: r.summary.deleted, files: r.summary.files, missingFiles: r.summary.missingFiles, byColl: r.summary.byColl, legalTruncated: !!r.summary.legalTruncated } : null,
      legal: view,
      collisions: view.filter(v => v.onGlobal === 'collision').length,
    })
  }
  return out
}
