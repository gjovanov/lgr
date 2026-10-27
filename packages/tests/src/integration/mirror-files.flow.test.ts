import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import zlib from 'node:zlib'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { makeNodeStub, nodeEnrollBody } from '../helpers/node-stub'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import { MirrorBlob, OrgHome } from 'db/models'
import { forgetAllHomes } from 'db/home/home'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { forgetLink } from 'services/biz/replication/engine'
import { BLOB_CHUNK, BLOB_MAGIC, decodeBlobChunk, encodeBlobChunk } from 'services/biz/replication/blob-frame'
import { blobFor, forgetFoundBlobs, readBlobAsk } from 'services/biz/replication/blob-source'
import { blobPath, mirrorFilesStatus } from 'services/biz/replication/mirror-blobs'
import { startControlSocket } from '../../../portal-api/src/front/control-socket'
import { handleUplinkClose, handleUplinkMessage, handleUplinkOpen } from '../../../portal-api/src/websocket/uplink'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'

/**
 * FR-20.66, FR-20.69 (plan step P3-3): an org homed on a master sends its files to global's mirror,
 * which stores and reads them by content, per org (AC 52, AC 63).
 *
 * Global is this process's database; a "master" here is this process with the master's role and its
 * own upload root. The supervisor's half (the pump) is Rust (`packages/server/src/replication.rs`).
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'
const saved = { role: config.node.role, id: (config.node as any).id, capture: config.replication.capture, upload: config.upload.dir }
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: any
let root = ''
let n = 0

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const oid = () => new mongoose.Types.ObjectId()
const db = () => mongoose.connection.db!

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp())
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

beforeEach(() => {
  ;(config.node as any).role = 'global'
  root = mkdtempSync(join(tmpdir(), 'lgr-mf-'))
  ;(config.upload as any).dir = root
})

afterEach(async () => {
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.replication as any).capture = saved.capture
  ;(config.upload as any).dir = saved.upload
  forgetLink()
  forgetAllHomes()
  forgetFoundBlobs()
  rmSync(root, { recursive: true, force: true })
  await clearCollections()
}, 60_000)

function fakeWs() {
  const sent: any[] = []
  const closed: Array<{ code?: number; reason?: string }> = []
  return {
    raw: { id: Math.random() },
    send: (s: string) => { sent.push(JSON.parse(s)) },
    close: (code?: number, reason?: string) => { closed.push({ code, reason }) },
    sent,
    closed,
    last: (t: string) => [...sent].reverse().find(m => m.t === t),
  }
}

/** A master registered for a new org at Full and home of it: global's copy of the org is the mirror. */
async function linkedMaster() {
  const stub = makeNodeStub()
  const org = await createTestOrg({ slug: `mirror-files-${++n}` } as any)
  const admin = await createTestUser(org._id, { role: 'admin' } as any)
  // Made while the org is still global's: once it is homed on the master, global writes none of its users.
  const member = await createTestUser(org._id, { role: 'member' } as any)
  const { code } = await mintNodeEnrollmentCode(String(org._id), String(admin._id))
  await enrollNode({ ...nodeEnrollBody(stub, ENROLL, { linkLevel: 'full' }), code } as any, [ENROLL])
  const token = (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN }), [TOKEN])).token
  await OrgHome.collection.insertOne({ orgId: org._id, home: stub.nodeId, epoch: 1, state: 'active', since: new Date() } as any)
  forgetAllHomes()
  const bearer = await (signer as any).decorator.jwt.sign({
    id: String(admin._id), orgId: String(org._id), role: 'admin', email: admin.email, username: admin.username,
    firstName: 'Ana', lastName: 'Shop', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  const memberBearer = await (signer as any).decorator.jwt.sign({
    id: String(member._id), orgId: String(org._id), role: 'member', email: member.email, username: member.username,
    firstName: 'Mila', lastName: 'Shop', permissions: DEFAULT_ROLE_PERMISSIONS.member, ownRecordsModules: [],
  })
  return { stub, orgId: String(org._id), oid: org._id as any, token, bearer, memberBearer }
}

async function socket(token: string) {
  const ws = fakeWs()
  handleUplinkOpen(ws, 'bulk')
  await handleUplinkMessage(ws, JSON.stringify({ t: 'hello', v: 1, ch: 'bulk', token, bootNonce: `boot-files-${n}`, versions: { app: '0.1.0', protocol: 1 } }))
  return ws
}

/** The mirror's rows, as the apply writes them: raw, the org's documents as its home wrote them. */
async function docRow(orgId: any, content: Uint8Array, o: { date?: string; name?: string; archived?: { unitId: unknown } } = {}) {
  const k = ++n
  const date = o.date ?? '2026-10-01'
  const name = o.name ?? `doc-${k}.pdf`
  const _id = oid()
  await db().collection('docfiles').insertOne({
    _id, orgId, docType: 'invoice', docNumber: `n-${k}`, docDate: date, originalName: name,
    currentPath: `${String(orgId)}/docs/${date}/${name}`, currentChecksum: sha(content), version: 1,
    mimeType: 'application/pdf', size: content.length, status: 'uploaded', uploadedAt: new Date(),
    ...(o.archived ? { archived: true, archiveRef: o.archived.unitId, archivedAt: new Date() } : {}),
  })
  return { _id, path: `${String(orgId)}/docs/${date}/${name}`, name, date }
}

async function fileRow(orgId: any, content: Uint8Array, storagePath: string) {
  const _id = oid()
  await db().collection('files').insertOne({
    _id, orgId, uploadedBy: oid(), originalName: storagePath.split('/').pop(), storagePath, storageProvider: 'local',
    mimeType: 'application/pdf', size: content.length, sha256: sha(content), module: 'files', createdAt: new Date(), updatedAt: new Date(),
  })
  return _id
}

/** An archive unit as the archive service writes it: zstd around one JSON line per member. */
function unitBytes(members: Array<{ path: string; content: Uint8Array }>): Uint8Array {
  const lines = members.map(m => JSON.stringify({ path: m.path, size: m.content.length, sha256: sha(m.content), b64: Buffer.from(m.content).toString('base64') })).join('\n') + '\n'
  const z: any = zlib
  return new Uint8Array(typeof z.zstdCompressSync === 'function' ? z.zstdCompressSync(Buffer.from(lines)) : (Bun as any).zstdCompressSync(Buffer.from(lines)))
}

async function unitRow(orgId: any, bytes: Uint8Array) {
  const _id = oid()
  const filename = `lgr-archive-${n}.ndjson.zst`
  await db().collection('archiveunits').insertOne({ _id, orgId, fiscalYearId: oid(), status: 'verified', path: `${String(orgId)}/archives/${filename}`, filename, sha256: sha(bytes), bytes: bytes.length, fileCount: 1, contentBytes: 0 })
  return { _id, filename }
}

/** A file global's mirror already holds, as if it had arrived. */
async function held(orgId: string, content: Uint8Array) {
  const p = blobPath(orgId, sha(content))
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  await MirrorBlob.create({ orgId, sha256: sha(content), size: content.length, state: 'ok', offset: content.length, source: 'master' })
}

function frames(orgId: string, content: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let at = 0; at < content.length || (at === 0 && content.length === 0); at += BLOB_CHUNK) {
    out.push(encodeBlobChunk({ orgId, sha256: sha(content), offset: at, size: content.length, bytes: content.subarray(at, Math.min(content.length, at + BLOB_CHUNK)) }))
    if (content.length === 0) break
  }
  return out
}

async function want(ws: ReturnType<typeof fakeWs>, orgId: string) {
  await handleUplinkMessage(ws, JSON.stringify({ t: 'blob-sync', orgId }))
  return [...ws.sent].reverse().find(m => (m.t === 'blob-want' || m.t === 'blob-refused') && m.orgId === orgId)
}

async function http(bearer: string, method: string, path: string, body?: unknown) {
  return app.handle(new Request(`http://localhost/api${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Promise<Response>
}

describe("global's mirror takes an org's files by content (FR-20.69)", () => {
  it('asks only for what its rows of that org name, appends each chunk where it stands, and names the file by its hash only once it hashes to it', async () => {
    const m = await linkedMaster()
    const big = randomBytes(BLOB_CHUNK * 2 + 4321)
    const small = randomBytes(1000)
    await docRow(m.oid, big)
    await fileRow(m.oid, small, `${m.orgId}/doc-import/1700000000000-small.pdf`)
    const ws = await socket(m.token)
    expect(ws.last('welcome').orgs[0].files).toBe('all')

    const w = await want(ws, m.orgId)
    expect(w).toMatchObject({ t: 'blob-want', files: 'all', more: false })
    expect(w.want.map((x: any) => x.sha256).sort()).toEqual([sha(big), sha(small)].sort())
    expect(w.want.find((x: any) => x.sha256 === sha(big))).toEqual({ sha256: sha(big), offset: 0, size: big.length })

    const [f0, f1, f2] = frames(m.orgId, big)
    await handleUplinkMessage(ws, f0)
    expect(ws.last('blob-ack')).toEqual({ t: 'blob-ack', orgId: m.orgId, sha256: sha(big), offset: BLOB_CHUNK, state: 'partial' })
    // The same chunk again (an ack lost on the way): told where global stands.
    await handleUplinkMessage(ws, f0)
    expect(ws.last('blob-refused')).toMatchObject({ sha256: sha(big), reason: 'offset', offset: BLOB_CHUNK })
    await handleUplinkMessage(ws, f1)
    await handleUplinkMessage(ws, f2)
    expect(ws.last('blob-ack')).toEqual({ t: 'blob-ack', orgId: m.orgId, sha256: sha(big), offset: big.length, state: 'ok' })
    expect(Buffer.compare(readFileSync(blobPath(m.orgId, sha(big))), big)).toBe(0)
    expect(existsSync(`${blobPath(m.orgId, sha(big))}.part`)).toBe(false)
    expect(await MirrorBlob.findOne({ orgId: m.orgId, sha256: sha(big) }).lean()).toMatchObject({ state: 'ok', source: 'master', nodeId: m.stub.nodeId, size: big.length })

    // Whole, but not what it claims: dropped, and not asked for again for a while.
    await handleUplinkMessage(ws, encodeBlobChunk({ orgId: m.orgId, sha256: sha(small), offset: 0, size: 1000, bytes: randomBytes(1000) }))
    expect(ws.last('blob-refused')).toMatchObject({ sha256: sha(small), reason: 'hash_mismatch' })
    expect(existsSync(blobPath(m.orgId, sha(small)))).toBe(false)
    const bad: any = await MirrorBlob.findOne({ orgId: m.orgId, sha256: sha(small) }).lean()
    expect(bad).toMatchObject({ state: 'wanted', offset: 0, failures: 1, lastError: { reason: 'hash_mismatch' } })
    expect(+bad.retryAt).toBeGreaterThan(Date.now())
    expect((await want(ws, m.orgId)).want).toEqual([])

    // Content no row of the org names is never taken.
    const stray = randomBytes(10)
    await handleUplinkMessage(ws, frames(m.orgId, stray)[0])
    expect(ws.last('blob-refused')).toMatchObject({ sha256: sha(stray), reason: 'not_wanted' })

    expect(await mirrorFilesStatus(m.orgId)).toMatchObject({ files: true, referenced: 2, held: 1, failing: 1, waiting: 0, complete: false })
    await handleUplinkClose(ws)
  }, 60_000)

  it('isolation (AC 52): content one org holds never answers for another, and no master sends another org\'s files', async () => {
    const a = await linkedMaster()
    const b = await linkedMaster()
    const shared = randomBytes(5000)
    await docRow(a.oid, shared)
    await docRow(b.oid, shared)
    // Org B's mirror already holds those bytes.
    await held(b.orgId, shared)
    const wsA = await socket(a.token)
    const wsB = await socket(b.token)
    // A is still asked for them: what B holds says nothing about A.
    expect((await want(wsA, a.orgId)).want.map((x: any) => x.sha256)).toEqual([sha(shared)])
    expect((await want(wsB, b.orgId)).want).toEqual([])
    // B's master asking about, or sending, A's files is refused: it is not registered for A.
    expect(await want(wsB, a.orgId)).toMatchObject({ t: 'blob-refused', reason: 'not_registered' })
    await handleUplinkMessage(wsB, frames(a.orgId, shared)[0])
    expect(wsB.last('blob-refused')).toMatchObject({ orgId: a.orgId, reason: 'not_registered' })
    // A name that is not a hash never becomes a path.
    const header = new TextEncoder().encode(JSON.stringify({ orgId: a.orgId, sha256: '../../../etc/passwd', offset: 0, size: 3 }))
    const forged = new Uint8Array(9 + header.length + 3)
    forged.set(BLOB_MAGIC, 0)
    forged[4] = 1
    new DataView(forged.buffer).setUint32(5, header.length)
    forged.set(header, 9)
    await handleUplinkMessage(wsA, forged)
    expect(wsA.last('blob-refused')).toMatchObject({ reason: 'malformed' })
    // A's own master sends them: they land in A's store, B's copy untouched.
    await handleUplinkMessage(wsA, frames(a.orgId, shared)[0])
    expect(wsA.last('blob-ack')).toMatchObject({ orgId: a.orgId, state: 'ok' })
    expect(blobPath(a.orgId, sha(shared)).startsWith(join(root, a.orgId, 'blobs'))).toBe(true)
    expect(await MirrorBlob.countDocuments({ sha256: sha(shared) })).toBe(2)
    await handleUplinkClose(wsA)
    await handleUplinkClose(wsB)
  }, 60_000)

  it("metadata only is the org admin's choice: the master is welcomed again, and global then asks for nothing and takes nothing", async () => {
    const m = await linkedMaster()
    const content = randomBytes(300)
    await docRow(m.oid, content)
    const before = await socket(m.token)
    const orgBefore: any = await db().collection('orgs').findOne({ _id: m.oid })

    const off = await http(m.bearer, 'PUT', `/org/${m.orgId}/nodes/mirror`, { files: false })
    expect(off.status).toBe(200)
    expect((await off.json() as any).mirror).toMatchObject({ files: false, home: m.stub.nodeId, referenced: 1, held: 0 })
    // Global's part of the org, and nothing of the home's: `updatedAt` is the master's to write.
    const orgAfter: any = await db().collection('orgs').findOne({ _id: m.oid })
    expect(orgAfter.settings.node.mirrorFiles).toBe(false)
    expect(+orgAfter.updatedAt).toBe(+orgBefore.updatedAt)
    // The open bulk socket is told its welcome no longer holds: the pump follows on the next one.
    expect(before.closed[0]).toMatchObject({ code: 4410 })

    const ws = await socket(m.token)
    expect(ws.last('welcome').orgs[0].files).toBe('metadata')
    expect(await want(ws, m.orgId)).toMatchObject({ t: 'blob-want', files: 'metadata', want: [] })
    await handleUplinkMessage(ws, frames(m.orgId, content)[0])
    expect(ws.last('blob-refused')).toMatchObject({ reason: 'metadata_only' })

    expect((await http(m.bearer, 'PUT', `/org/${m.orgId}/nodes/mirror`, { files: true })).status).toBe(200)
    expect((await want(ws, m.orgId)).want.map((x: any) => x.sha256)).toEqual([sha(content)])
    const st = await http(m.bearer, 'GET', `/org/${m.orgId}/nodes/mirror`)
    expect((await st.json() as any).mirror).toMatchObject({ files: true, referenced: 1, waiting: 1 })

    // Not an admin: neither seen nor changed.
    expect((await http(m.memberBearer, 'PUT', `/org/${m.orgId}/nodes/mirror`, { files: false })).status).toBe(403)
    expect((await http(m.memberBearer, 'GET', `/org/${m.orgId}/nodes/mirror`)).status).toBe(403)
    await handleUplinkClose(ws)
  }, 60_000)

  it("global's own copy from before a move is taken by its hash and never asked for; one that is not what its row says is", async () => {
    const m = await linkedMaster()
    const kept = randomBytes(2000)
    const changed = randomBytes(2000)
    const keptRow = await docRow(m.oid, kept)
    const changedRow = await docRow(m.oid, changed)
    // Global wrote these while it was the org's home.
    mkdirSync(join(root, m.orgId, 'docs', '2026-10-01'), { recursive: true })
    writeFileSync(join(root, ...keptRow.path.split('/')), kept)
    writeFileSync(join(root, ...changedRow.path.split('/')), randomBytes(2000))
    const ws = await socket(m.token)
    const w = await want(ws, m.orgId)
    expect(w.want.map((x: any) => x.sha256)).toEqual([sha(changed)])
    expect(w.adopted).toBe(1)
    expect(await MirrorBlob.findOne({ orgId: m.orgId, sha256: sha(kept) }).lean()).toMatchObject({ state: 'ok', source: 'local' })
    expect(Buffer.compare(readFileSync(blobPath(m.orgId, sha(kept))), kept)).toBe(0)
    // A copy, never a move: global's own file is where it was.
    expect(existsSync(join(root, ...keptRow.path.split('/')))).toBe(true)
    await handleUplinkClose(ws)
  }, 60_000)
})

describe('a mirrored org\'s files open on global by content (AC 63)', () => {
  it('the current file, an earlier version and an archived document open from the mirror, and nothing is written where a row says', async () => {
    const m = await linkedMaster()
    const current = randomBytes(4000)
    const earlier = randomBytes(3000)
    const old = randomBytes(2500)
    const doc = await docRow(m.oid, current, { name: 'inv_1.pdf' })
    const versionName = 'inv_1_2026-09-30T10-00-00-000Z.pdf'
    await fileRow(m.oid, earlier, `${m.orgId}/docs/2026-10-01/versions/${versionName}`)
    const unit = unitBytes([{ path: '2026-01-15/old.pdf', content: old }])
    const u = await unitRow(m.oid, unit)
    const archived = await docRow(m.oid, old, { date: '2026-01-15', name: 'old.pdf', archived: { unitId: u._id } })
    const notYet = await docRow(m.oid, randomBytes(100))
    await held(m.orgId, current)
    await held(m.orgId, earlier)
    await held(m.orgId, unit)

    const get = async (path: string) => {
      const r = await http(m.bearer, 'GET', `/org/${m.orgId}/files/${path}`)
      return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) }
    }
    const a = await get(`${doc._id}/download`)
    expect(a.status).toBe(200)
    expect(Buffer.compare(Buffer.from(a.bytes), current)).toBe(0)
    const v = await get(`${doc._id}/download?version=${encodeURIComponent(versionName)}`)
    expect(v.status).toBe(200)
    expect(Buffer.compare(Buffer.from(v.bytes), earlier)).toBe(0)
    const z = await get(`${archived._id}/download`)
    expect(z.status).toBe(200)
    expect(Buffer.compare(Buffer.from(z.bytes), old)).toBe(0)
    // Read out of the unit; nothing put back on disk where the row says.
    expect(existsSync(join(root, m.orgId, 'docs'))).toBe(false)

    const versions = await http(m.bearer, 'GET', `/org/${m.orgId}/files/${doc._id}/versions`)
    expect((await versions.json() as any).versions.map((x: any) => x.name)).toEqual([versionName])

    const missing = await http(m.bearer, 'GET', `/org/${m.orgId}/files/${notYet._id}/download`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: 'file_not_mirrored' })
    await http(m.bearer, 'PUT', `/org/${m.orgId}/nodes/mirror`, { files: false })
    const metadataOnly = await http(m.bearer, 'GET', `/org/${m.orgId}/files/${notYet._id}/download`)
    expect(await metadataOnly.json()).toMatchObject({ code: 'files_not_mirrored' })
    // A file already on the mirror keeps opening.
    expect((await get(`${doc._id}/download`)).status).toBe(200)
  }, 60_000)

  it('end to end: a master reads its file by content, frames it, and global stores it and serves it', async () => {
    const m = await linkedMaster()
    const masterRoot = join(root, 'master')
    const globalRoot = join(root, 'global')
    const content = randomBytes(BLOB_CHUNK + 777)
    const row = await docRow(m.oid, content, { name: 'e2e.pdf' })
    // The master's disk: its document where its row says.
    mkdirSync(join(masterRoot, m.orgId, 'docs', '2026-10-01'), { recursive: true })
    writeFileSync(join(masterRoot, ...row.path.split('/')), content)

    const asMaster = () => {
      ;(config.node as any).role = 'master'
      ;(config.node as any).id = m.stub.nodeId
      ;(config.replication as any).capture = true
      ;(config.upload as any).dir = masterRoot
      forgetAllHomes()
    }
    const asGlobal = () => {
      ;(config.node as any).role = 'global'
      ;(config.upload as any).dir = globalRoot
      forgetAllHomes()
    }

    asGlobal()
    const ws = await socket(m.token)
    const w = await want(ws, m.orgId)
    expect(w.want).toEqual([{ sha256: sha(content), offset: 0, size: content.length }])
    for (let offset = 0, guard = 0; guard < 5; guard++) {
      asMaster()
      const c = await blobFor({ orgId: m.orgId, sha256: sha(content), offset })
      expect(c.status).toBe(200)
      asGlobal()
      await handleUplinkMessage(ws, (c as any).bytes)
      const ack = ws.last('blob-ack')
      if (ack.state === 'ok') break
      offset = ack.offset
    }
    expect(ws.last('blob-ack')).toMatchObject({ state: 'ok', offset: content.length })
    const r = await http(m.bearer, 'GET', `/org/${m.orgId}/files/${row._id}/download`)
    expect(r.status).toBe(200)
    expect(Buffer.compare(Buffer.from(await r.arrayBuffer()), content)).toBe(0)
    expect(await mirrorFilesStatus(m.orgId)).toMatchObject({ referenced: 1, held: 1, complete: true })
    await handleUplinkClose(ws)
  }, 60_000)
})

describe("the master's side: a chunk read by content, in its own org (FR-20.69)", () => {
  async function homedHere() {
    const org = await createTestOrg({ slug: `files-master-${++n}` } as any)
    const nodeId = makeNodeStub().nodeId
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = nodeId
    ;(config.replication as any).capture = true
    await OrgHome.collection.insertOne({ orgId: org._id, home: nodeId, epoch: 1, state: 'active', since: new Date() } as any)
    forgetAllHomes()
    return { orgId: String(org._id), oid: org._id as any }
  }
  const place = (rel: string, content: Uint8Array) => {
    const p = join(root, ...rel.split('/'))
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }

  it('finds a document, a version or an archive unit by its hash, chunk by chunk, and hashes the file before the first byte leaves', async () => {
    const h = await homedHere()
    const doc = randomBytes(BLOB_CHUNK + 10)
    const row = await docRow(h.oid, doc)
    place(row.path, doc)
    const version = randomBytes(50)
    const vpath = `${h.orgId}/docs/2026-10-01/versions/x_2026.pdf`
    await fileRow(h.oid, version, vpath)
    place(vpath, version)
    const unit = randomBytes(70)
    const u = await unitRow(h.oid, unit)
    place(`${h.orgId}/archives/${u.filename}`, unit)

    const first = await blobFor({ orgId: h.orgId, sha256: sha(doc), offset: 0 })
    expect(first).toMatchObject({ status: 200, size: doc.length, length: BLOB_CHUNK })
    expect(decodeBlobChunk((first as any).bytes)).toMatchObject({ orgId: h.orgId, sha256: sha(doc), offset: 0, size: doc.length })
    const rest = decodeBlobChunk(((await blobFor({ orgId: h.orgId, sha256: sha(doc), offset: BLOB_CHUNK })) as any).bytes)
    expect(Buffer.compare(Buffer.from(rest.bytes), doc.subarray(BLOB_CHUNK))).toBe(0)
    expect(await blobFor({ orgId: h.orgId, sha256: sha(version), offset: 0 })).toMatchObject({ status: 200, length: 50 })
    expect(await blobFor({ orgId: h.orgId, sha256: sha(unit), offset: 0 })).toMatchObject({ status: 200, length: 70 })
    expect(await blobFor({ orgId: h.orgId, sha256: sha(doc), offset: doc.length })).toMatchObject({ status: 409, refused: 'offset_beyond' })
  }, 60_000)

  it("says a file is missing, or not what its row says; sends nothing at Control, or for an org that is not homed here, or another org's", async () => {
    const h = await homedHere()
    const gone = randomBytes(10)
    await docRow(h.oid, gone)
    expect(await blobFor({ orgId: h.orgId, sha256: sha(gone), offset: 0 })).toMatchObject({ status: 404, code: 'missing' })

    const claimed = randomBytes(40)
    const row = await docRow(h.oid, claimed)
    place(row.path, randomBytes(40))
    expect(await blobFor({ orgId: h.orgId, sha256: sha(claimed), offset: 0 })).toMatchObject({ status: 409, refused: 'hash_mismatch' })

    // Another org's document on this disk is not this org's.
    const other = await createTestOrg({ slug: `files-other-${++n}` } as any)
    await OrgHome.collection.insertOne({ orgId: other._id, home: (config.node as any).id, epoch: 1, state: 'active', since: new Date() } as any)
    const theirs = randomBytes(30)
    const theirRow = await docRow(other._id, theirs)
    place(theirRow.path, theirs)
    expect(await blobFor({ orgId: h.orgId, sha256: sha(theirs), offset: 0 })).toMatchObject({ status: 404 })

    const away = await createTestOrg({ slug: `files-away-${++n}` } as any)
    await OrgHome.collection.insertOne({ orgId: away._id, home: 'global', epoch: 2, state: 'active', since: new Date() } as any)
    forgetAllHomes()
    expect(await blobFor({ orgId: String(away._id), sha256: sha(theirs), offset: 0 })).toMatchObject({ status: 409, refused: 'not_home' })

    ;(config.replication as any).capture = false
    forgetLink()
    expect(await blobFor({ orgId: h.orgId, sha256: sha(gone), offset: 0 })).toMatchObject({ status: 409, refused: 'not_full' })

    let threw = ''
    try { readBlobAsk({ orgId: h.orgId, sha256: 'ABC', offset: 0 }) } catch (e: any) { threw = e.message }
    expect(threw).toContain('sha256')
  }, 60_000)

  it('over the control socket: the frame and its size, as the supervisor reads them', async () => {
    const h = await homedHere()
    const content = randomBytes(1234)
    const row = await docRow(h.oid, content)
    place(row.path, content)
    const dir = mkdtempSync(join(tmpdir(), 'lgr-bc-'))
    const sock = join(dir, 'api.sock')
    const ctl = startControlSocket(sock, 'blob-secret', {
      status: () => ({ ok: true }),
      stop: () => {},
      replication: {
        status: async () => ({}),
        page: async () => ({ status: 204 }) as any,
        resend: async () => ({ journaled: 0 }),
        blob: async body => blobFor(readBlobAsk(body)),
      },
    })
    try {
      const call = (body: unknown) => fetch('http://lgr-api/replication/blob', { method: 'POST', unix: sock, headers: { 'x-lgr-front': 'blob-secret', 'content-type': 'application/json' }, body: JSON.stringify(body) } as any)
      const r = await call({ orgId: h.orgId, sha256: sha(content), offset: 0 })
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toBe('application/x-lgr-blob')
      expect([r.headers.get('x-lgr-blob-size'), r.headers.get('x-lgr-blob-length')]).toEqual(['1234', '1234'])
      expect(decodeBlobChunk(new Uint8Array(await r.arrayBuffer())).sha256).toBe(sha(content))
      const none = await call({ orgId: h.orgId, sha256: 'a'.repeat(64), offset: 0 })
      expect(none.status).toBe(404)
      expect((await call({ orgId: h.orgId, sha256: 'nope', offset: 0 })).status).toBe(400)
    } finally {
      ctl.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
