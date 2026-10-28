import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import zlib from 'node:zlib'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { FencedExport, Invoice, NodeState, OrgHome, OrgMove } from 'db/models'
import { forgetAllHomes } from 'db/home/home'
import {
  FENCED_FORMAT, fencedExportPath, fencedExportStatus, fencedExportsOf, readFencedExport, receiveFencedChunk, writeFencedExport,
  type FencedItem,
} from 'services/biz/move/fenced-export.service'
import { moveWorkerTick } from 'services/biz/move/move-worker.service'

/**
 * A fenced master's export of what it did after the promotion's cutoff (FR-20.84, plan step P3-6e):
 * built by the master, sent in chunks, checked and kept by global, listed for review.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const saved = { role: config.node.role, id: (config.node as any).id, tokenFile: config.outbox.tokenFile, upload: config.upload.dir }
let root = ''
let n = 0
const NODE = 'master-fencedexporttest'
const EJSON = mongoose.mongo.BSON.EJSON

beforeAll(async () => {
  await setupTestDB()
}, 60_000)
afterAll(async () => {
  await teardownTestDB()
}, 60_000)
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lgr-fx-'))
  ;(config.upload as any).dir = join(root, 'master')
})
afterEach(async () => {
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.outbox as any).tokenFile = saved.tokenFile
  ;(config.upload as any).dir = saved.upload
  forgetAllHomes()
  rmSync(root, { recursive: true, force: true })
  await clearCollections()
}, 60_000)

const db = () => mongoose.connection.db as any
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const oid = () => new mongoose.Types.ObjectId()

/**
 * A master's org after a promotion took it over at `cutoff` 10 of journal epoch 2: what the journal
 * holds below and above it, a deletion, a document of the epoch before, a file, and a file gone.
 */
async function site() {
  const org = await createTestOrg({ slug: `fenced-${++n}` } as any)
  const orgId = org._id as any
  const admin = await createTestUser(orgId, { role: 'admin' } as any)
  const ids = { before: oid(), after: oid(), oldEpoch: oid(), gone: oid(), invoice: oid(), doc: oid(), fileRow: oid() }
  const now = new Date()
  await db().collection('contacts').insertMany([
    { _id: ids.before, orgId, companyName: 'Seen by global', type: 'customer' },
    { _id: ids.after, orgId, companyName: 'Made after the cutoff', type: 'customer' },
    { _id: ids.oldEpoch, orgId, companyName: 'Journaled again after a lost history', type: 'customer' },
  ])
  await db().collection('invoices').insertOne({ _id: ids.invoice, orgId, type: 'cash_sale', direction: 'outgoing', invoiceNumber: 'CS-2026-00043', status: 'paid', issueDate: now, total: 24.5, currency: 'EUR', lines: [] })
  const content = randomBytes(3000)
  const rel = `${String(orgId)}/docs/2026-10-27/after.pdf`
  mkdirSync(dirname(join(config.upload.dir, ...rel.split('/'))), { recursive: true })
  writeFileSync(join(config.upload.dir, ...rel.split('/')), content)
  await db().collection('docfiles').insertOne({ _id: ids.doc, orgId, docType: 'invoice', docNumber: 'x', docDate: '2026-10-27', originalName: 'after.pdf', currentPath: rel, currentChecksum: sha(content), version: 1, mimeType: 'application/pdf', size: content.length, status: 'uploaded', uploadedAt: now })
  await db().collection('files').insertOne({ _id: ids.fileRow, orgId, originalName: 'gone.pdf', storagePath: `${String(orgId)}/files/gone.pdf`, storageProvider: 'local', mimeType: 'application/pdf', size: 1 })
  const row = (coll: string, docId: unknown, seq: number, op: 'upsert' | 'delete' = 'upsert', journalEpoch = 2) =>
    ({ orgId, coll, docId, seq, op, changedFields: [], clusterTime: now, journalEpoch, updatedAt: now })
  await db().collection('repl_journal').insertMany([
    row('contacts', ids.before, 7),
    row('contacts', ids.after, 11),
    row('contacts', ids.oldEpoch, 3, 'upsert', 1),
    row('contacts', ids.gone, 12, 'delete'),
    row('invoices', ids.invoice, 13),
    row('docfiles', ids.doc, 14),
    row('files', ids.fileRow, 15),
  ])
  await db().collection('repl_orgs').insertOne({ orgId, enabled: true, seq: 15, pages: [] })
  return { orgId: String(orgId), oid: orgId, admin, ids, content, rel }
}

async function itemsOf(path: string, expect: { orgId?: string; moveId?: string } = {}) {
  const items: FencedItem[] = []
  const gen = readFencedExport(path, expect)
  for (;;) {
    const r = await gen.next()
    if (r.done) return { items, trailer: r.value }
    items.push(r.value)
  }
}

/** A promotion of the site's org, done, from NODE. */
async function promotion(orgId: unknown, extra: Record<string, unknown> = {}) {
  return (await OrgMove.create({
    orgId, kind: 'promote', state: 'done', from: NODE, to: 'global', epochFrom: 1, epochTo: 2, startedBy: oid(), startedAt: new Date(), endedAt: new Date(),
    fenceCutoff: 10, fenceJournalEpoch: 2, allowMissing: [], ...extra,
  } as any)).toObject() as any
}

/** Bundle lines into an export, its trailer computed: for the exports a master would never write. */
function craft(path: string, header: Record<string, unknown>, docs: Record<string, unknown[]>) {
  const lines = [`${JSON.stringify({ format: FENCED_FORMAT, nodeId: NODE, cutoff: 0, head: 1, exportedAt: new Date().toISOString(), ...header })}\n`]
  const digests: Record<string, { count: number; sha256: string }> = {}
  for (const [coll, list] of Object.entries(docs)) {
    lines.push(`${JSON.stringify({ $coll: coll })}\n`)
    const h = createHash('sha256')
    for (const d of list) {
      const line = `${EJSON.stringify(d as any, { relaxed: false })}\n`
      h.update(line)
      lines.push(line)
    }
    digests[coll] = { count: list.length, sha256: h.digest('hex') }
  }
  const empty = { count: 0, sha256: createHash('sha256').digest('hex') }
  lines.push(`${JSON.stringify({ $end: true, digests, deleted: empty, files: empty, missingFiles: 0 })}\n`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, zlib.zstdCompressSync(Buffer.from(lines.join(''))))
}

describe('the fenced export (FR-20.84)', () => {
  it('holds everything above the cutoff, a row of another journal epoch, the deletions and the files those rows name', async () => {
    const s = await site()
    const moveId = String(oid())
    const path = fencedExportPath(s.orgId, moveId)
    const w = await writeFencedExport(db(), { orgId: s.oid, nodeId: NODE, moveId, cutoff: 10, journalEpoch: 2 }, path)
    // The File row is a document too; its bytes are the file that is gone.
    expect(w).toMatchObject({ documents: 5, deleted: 1, files: 1, missingFiles: 1 })
    expect(w.sha256).toBe(sha(readFileSync(path)))
    expect(path.split(/[\\/]/).slice(-3)).toEqual(['docs', 'fenced', `fenced-${moveId}.ndjson.zst`])
    const { items, trailer } = await itemsOf(path, { orgId: s.orgId, moveId })
    expect(trailer.header).toMatchObject({ orgId: s.orgId, nodeId: NODE, moveId, cutoff: 10, journalEpoch: 2, head: 15 })
    const docs = items.filter(i => i.kind === 'doc') as Array<Extract<FencedItem, { kind: 'doc' }>>
    const contactIds = docs.filter(d => d.coll === 'contacts').map(d => String(d.doc._id)).sort()
    // Above the cutoff, and the epoch before (whether global saw it is unknown); never what it saw.
    expect(contactIds).toEqual([String(s.ids.after), String(s.ids.oldEpoch)].sort())
    expect(docs.find(d => d.coll === 'invoices')?.doc).toMatchObject({ invoiceNumber: 'CS-2026-00043' })
    expect(items.find(i => i.kind === 'deleted')).toMatchObject({ kind: 'deleted', coll: 'contacts' })
    const file = items.find(i => i.kind === 'file') as Extract<FencedItem, { kind: 'file' }>
    expect(file.path).toBe(s.rel)
    expect(Buffer.compare(file.bytes, s.content)).toBe(0)
    expect(trailer).toMatchObject({ documents: 5, deleted: 1, files: 1, missingFiles: 1 })

    // Without an epoch, the cutoff alone: the epoch-1 row at seq 3 stays out.
    const plain = fencedExportPath(s.orgId, String(oid()))
    expect((await writeFencedExport(db(), { orgId: s.oid, nodeId: NODE, moveId: 'x', cutoff: 10 }, plain)).documents).toBe(4)
  }, 60_000)

  it('is one org\'s: a document or a file of another org, or another org\'s export, is refused (AC 38)', async () => {
    const s = await site()
    const moveId = String(oid())
    const path = fencedExportPath(s.orgId, moveId)
    await writeFencedExport(db(), { orgId: s.oid, nodeId: NODE, moveId, cutoff: 10, journalEpoch: 2 }, path)
    expect((await captureRejection(itemsOf(path, { orgId: String(oid()) })))?.message).toMatch(/another organisation/)
    expect((await captureRejection(itemsOf(path, { orgId: s.orgId, moveId: String(oid()) })))?.message).toMatch(/another promotion/)
    const foreign = join(root, 'foreign.ndjson.zst')
    craft(foreign, { orgId: s.orgId, moveId }, { contacts: [{ _id: oid(), orgId: oid(), companyName: 'Not this org' }] })
    expect((await captureRejection(itemsOf(foreign)))?.message).toMatch(/a document of another organisation in contacts/)
    const notMoved = join(root, 'not-moved.ndjson.zst')
    craft(notMoved, { orgId: s.orgId, moveId }, { node_states: [{ _id: 'x', orgId: s.oid }] })
    expect((await captureRejection(itemsOf(notMoved)))?.message).toMatch(/not a collection a move carries/)
    // A line changed after the trailer was written: the digests say so.
    const raw = zlib.zstdDecompressSync(readFileSync(path)).toString('utf8').replace('Made after the cutoff', 'Made after the cutoff, edited')
    const edited = join(root, 'edited.ndjson.zst')
    writeFileSync(edited, zlib.zstdCompressSync(Buffer.from(raw)))
    expect((await captureRejection(itemsOf(edited)))?.message).toMatch(/does not match its own digests: contacts/)
  }, 60_000)

  it('reaches global in chunks at the offset global holds, is checked, kept and never replaced', async () => {
    const s = await site()
    const move = await promotion(s.oid)
    const moveId = String(move._id)
    const local = fencedExportPath(s.orgId, moveId)
    const w = await writeFencedExport(db(), { orgId: s.oid, nodeId: NODE, moveId, cutoff: 10, journalEpoch: 2 }, local)
    const bytes = readFileSync(local)
    ;(config.upload as any).dir = join(root, 'global')
    const at = (offset: number) => ({ offset, size: w.size, sha256: w.sha256 })
    expect(await fencedExportStatus(NODE, moveId)).toEqual({ state: 'none', received: 0 })
    // Only the server that was home, and only a finished promotion.
    expect((await captureRejection(fencedExportStatus('master-someoneelse0000', moveId)))?.code).toBe('not_found')
    const third = Math.ceil(bytes.length / 3)
    expect(await receiveFencedChunk(NODE, moveId, at(0), bytes.subarray(0, third))).toMatchObject({ state: 'receiving', received: third })
    // A chunk sent again, or one ahead: told where global stands, nothing written twice.
    expect(await receiveFencedChunk(NODE, moveId, at(0), bytes.subarray(0, third))).toMatchObject({ offsetMismatch: true, received: third })
    expect(await receiveFencedChunk(NODE, moveId, at(2 * third), bytes.subarray(2 * third))).toMatchObject({ offsetMismatch: true, received: third })
    // Announced once, never replaced.
    expect((await captureRejection(receiveFencedChunk(NODE, moveId, { ...at(third), sha256: 'f'.repeat(64) }, bytes.subarray(third, 2 * third))))?.code).toBe('export_changed')
    await receiveFencedChunk(NODE, moveId, at(third), bytes.subarray(third, 2 * third))
    expect(await receiveFencedChunk(NODE, moveId, at(2 * third), bytes.subarray(2 * third))).toMatchObject({ state: 'received', received: w.size })
    const kept = fencedExportPath(s.orgId, moveId)
    expect(sha(readFileSync(kept))).toBe(w.sha256)
    const row: any = await FencedExport.findOne({ moveId: move._id }).lean()
    expect(row).toMatchObject({ state: 'received', nodeId: NODE, cutoff: 10, journalEpoch: 2, head: 15, summary: { documents: 5, deleted: 1, files: 1, missingFiles: 1, byColl: { contacts: 2, invoices: 1, docfiles: 1, files: 1 } } })
    expect(row.summary.legal).toEqual([expect.objectContaining({ coll: 'invoices', id: String(s.ids.invoice), number: 'CS-2026-00043', type: 'cash_sale', total: 24.5 })])
    // Received is final: a late chunk changes nothing.
    expect(await receiveFencedChunk(NODE, moveId, at(0), bytes.subarray(0, third))).toMatchObject({ state: 'received' })
    // Nothing of it was written into the org.
    expect(await db().collection('contacts').countDocuments({ orgId: s.oid })).toBe(3)

    const notDone = await promotion(s.oid, { state: 'verifying', fenceCutoff: 1 })
    expect((await captureRejection(receiveFencedChunk(NODE, String(notDone._id), at(0), bytes)))?.code).toBe('not_done')
  }, 60_000)

  it('refuses, and keeps, an export that is not what it says', async () => {
    const s = await site()
    const move = await promotion(s.oid)
    const moveId = String(move._id)
    // Bytes that hash to what the master says, but are no export: the reader refuses them.
    const junk = randomBytes(5000)
    ;(config.upload as any).dir = join(root, 'global')
    expect(await receiveFencedChunk(NODE, moveId, { offset: 0, size: junk.length, sha256: sha(junk) }, junk)).toMatchObject({ state: 'refused' })
    const row: any = await FencedExport.findOne({ moveId: move._id }).lean()
    expect(row.state).toBe('refused')
    expect(row.error).toMatch(/could not be read|not a fenced export/)
    expect(existsSync(fencedExportPath(s.orgId, moveId))).toBe(true)
    expect(await fencedExportStatus(NODE, moveId)).toMatchObject({ state: 'refused' })
  }, 60_000)

  it('lists each sale against what global holds now: new, already here, or its number given to another', async () => {
    const s = await site()
    const move = await promotion(s.oid)
    const moveId = String(move._id)
    const sale = (number: string) => ({ _id: oid(), orgId: s.oid, type: 'cash_sale', direction: 'outgoing', invoiceNumber: number, status: 'paid', issueDate: new Date(), total: 10, currency: 'EUR', lines: [] })
    const same = sale('CS-2026-00044')
    const clash = sale('CS-2026-00045')
    const fresh = sale('CS-2026-00046')
    await db().collection('invoices').insertMany([same, clash, fresh])
    const now = new Date()
    await db().collection('repl_journal').insertMany([same, clash, fresh].map((d, i) => ({ orgId: s.oid, coll: 'invoices', docId: d._id, seq: 20 + i, op: 'upsert', changedFields: [], clusterTime: now, journalEpoch: 2, updatedAt: now })))
    const local = fencedExportPath(s.orgId, moveId)
    const w = await writeFencedExport(db(), { orgId: s.oid, nodeId: NODE, moveId, cutoff: 10, journalEpoch: 2 }, local)
    const bytes = readFileSync(local)
    // Global: it has `same` (made before the cutoff), gave CS-…45 to another sale, has never seen …46 or …43.
    await db().collection('invoices').deleteMany({ _id: { $in: [clash._id, fresh._id, s.ids.invoice] } })
    const theirs = sale('CS-2026-00045')
    await db().collection('invoices').insertOne(theirs)
    ;(config.upload as any).dir = join(root, 'global')
    await receiveFencedChunk(NODE, moveId, { offset: 0, size: w.size, sha256: w.sha256 }, bytes)
    const [ex] = await fencedExportsOf(s.orgId)
    expect(ex).toMatchObject({ moveId, nodeId: NODE, state: 'received', collisions: 1, summary: { documents: 8 } })
    const by = Object.fromEntries(ex.legal.map(l => [l.number, l]))
    expect(by['CS-2026-00043'].onGlobal).toBe('absent')
    expect(by['CS-2026-00044'].onGlobal).toBe('same_id')
    expect(by['CS-2026-00045']).toMatchObject({ onGlobal: 'collision', collidesWith: { id: String(theirs._id), number: 'CS-2026-00045' } })
    expect(by['CS-2026-00046'].onGlobal).toBe('absent')
  }, 60_000)

  it('the fenced master exports once, keeps it, and sends it until global has it', async () => {
    const s = await site()
    const move = await promotion(s.oid)
    const moveId = String(move._id)
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = NODE
    await OrgHome.collection.insertOne({ orgId: s.oid, home: NODE, epoch: 1, state: 'active', since: new Date() } as any)
    forgetAllHomes()
    const tokenFile = join(root, 'node-token.json')
    writeFileSync(tokenFile, JSON.stringify({ server: 'https://lgrai.test', token: 'node-token', expiresAt: Math.floor(Date.now() / 1000) + 3600 }))
    ;(config.outbox as any).tokenFile = tokenFile
    const view = { id: moveId, orgId: s.orgId, kind: 'promote', state: 'done', epochFrom: 1, epochTo: 2, startedBy: String(move.startedBy), fenceCutoff: 10, fenceJournalEpoch: 2 }
    let chunks = 0
    let cut = true
    // Global, played in-process; its files in their own tree.
    const asGlobal = async <T>(f: () => Promise<T>): Promise<T> => {
      const was = config.upload.dir
      ;(config.upload as any).dir = join(root, 'global')
      try {
        return await f()
      } finally {
        ;(config.upload as any).dir = was
      }
    }
    const fetchImpl = (async (input: any, init: any = {}) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/node/v1/moves') return Response.json({ moves: [view] })
      if (url.pathname === `/api/node/v1/moves/${moveId}/fenced-export`) {
        if (cut) throw new Error('the link is down')
        if ((init.method ?? 'GET') === 'GET') return Response.json(await asGlobal(() => fencedExportStatus(NODE, moveId)))
        chunks++
        const q = url.searchParams
        const r = await asGlobal(() => receiveFencedChunk(NODE, moveId, { offset: Number(q.get('offset')), size: Number(q.get('size')), sha256: String(q.get('sha256')) }, new Uint8Array(init.body)))
        return r.offsetMismatch ? Response.json({ code: 'offset', received: r.received }, { status: 409 }) : Response.json(r)
      }
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch

    expect(await moveWorkerTick(new Date(), fetchImpl)).toBe(1) // fenced
    expect(await OrgHome.findOne({ orgId: s.oid }).lean()).toMatchObject({ state: 'fenced', epoch: 2, fenceCutoff: 10 })
    expect(await moveWorkerTick(new Date(), fetchImpl)).toBe(1) // exported, kept here
    const local = fencedExportPath(s.orgId, moveId)
    const kept: any = (await NodeState.findById(`fenced-export:${moveId}`).lean() as any)?.value
    expect(kept).toMatchObject({ documents: 5, deleted: 1, files: 1, missingFiles: 1, sha256: sha(readFileSync(local)) })
    // The link is down: nothing is lost, the next tick tries again.
    expect(await moveWorkerTick(new Date(), fetchImpl)).toBe(0)
    cut = false
    expect(await moveWorkerTick(new Date(), fetchImpl)).toBe(1)
    expect(chunks).toBe(1)
    expect(((await NodeState.findById(`move:${moveId}`).lean()) as any).value.phase).toBe('uploaded')
    expect(await FencedExport.findOne({ moveId: move._id }).lean()).toMatchObject({ state: 'received', sha256: kept.sha256 })
    // Built once: the export here is the one global holds, and stays.
    expect(sha(readFileSync(local))).toBe(kept.sha256)
    expect(sha(readFileSync(join(root, 'global', s.orgId, 'docs', 'fenced', `fenced-${moveId}.ndjson.zst`)))).toBe(kept.sha256)
    expect(await moveWorkerTick(new Date(), fetchImpl)).toBe(0)
    expect(await Invoice.countDocuments({ orgId: s.oid })).toBe(1)
  }, 60_000)
})
