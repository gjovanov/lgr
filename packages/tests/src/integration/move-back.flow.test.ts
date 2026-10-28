import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestContact, createTestOrg, createTestUser } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { makeNodeStub, nodeEnrollBody } from '../helpers/node-stub'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { AuditLog, MirrorBlob, NodeState, OrgHome, OrgMove, POSSession, ServerNode } from 'db/models'
import { forgetAllHomes, homeOf } from 'db/home/home'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { canonical, homeDigests } from 'services/biz/move/home-digest'
import { collectionDigests } from 'services/biz/move/move-bundle'
import { DRAIN_WAIT_MS, FREEZE_WAIT_MS, drained, moveBackTick, preflightMoveBack, startMoveBack } from 'services/biz/move/move-back.service'
import { abortMove, movesForNode } from 'services/biz/move/move.service'
import { DRAIN_AFTER_MS, moveWorkerTick } from 'services/biz/move/move-worker.service'
import { blobPath, filesMirrored } from 'services/biz/replication/mirror-blobs'
import { movedFor } from 'services/biz/desktop/repoint.service'
import { acceptedRepointKeys, verifyRepoint } from 'services/biz/desktop/repoint-token'
import { handleUplinkClose, handleUplinkMessage, handleUplinkOpen } from '../../../portal-api/src/websocket/uplink'

/**
 * Moving an org from its master back to lgrai.app (FR-20.80, plan step P3-6c).
 *
 * Global's half runs here as global, over a mirror the test lays out as pages would have. The master's
 * half runs as a master against the same database, with a stand-in for lgrai.app's node routes.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'
const saved = { role: config.node.role, id: (config.node as any).id, tokenFile: config.outbox.tokenFile, upload: config.upload.dir, baseUrl: config.oauth.baseUrl }
const sockets: any[] = []
let root = ''
let n = 0

beforeAll(async () => {
  await setupTestDB()
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

beforeEach(() => {
  ;(config.node as any).role = 'global'
  root = mkdtempSync(join(tmpdir(), 'lgr-mb-'))
  ;(config.upload as any).dir = root
})

afterEach(async () => {
  for (const ws of sockets.splice(0)) await handleUplinkClose(ws)
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.outbox as any).tokenFile = saved.tokenFile
  ;(config.upload as any).dir = saved.upload
  ;(config.oauth as any).baseUrl = saved.baseUrl
  forgetAllHomes()
  rmSync(root, { recursive: true, force: true })
  await clearCollections()
}, 60_000)

const db = () => mongoose.connection.db as any
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

function fakeWs() {
  const sent: any[] = []
  const closed: Array<{ code?: number; reason?: string }> = []
  return { raw: { id: Math.random() }, send: (s: string) => { sent.push(JSON.parse(s)) }, close: (code?: number, reason?: string) => { closed.push({ code, reason }) }, sent, closed }
}

/**
 * An org homed on its master, as global holds it: the registered master (Full, connected, healthy, no
 * till open), the org's mirror at watermark 10, a mirrored document whose file arrived as a blob (its
 * stored path holds nothing on global), and the org's own documents.
 */
async function mirrored(opts: { health?: Record<string, unknown> } = {}) {
  ;(config.node as any).role = 'global'
  const org = await createTestOrg({ slug: `move-back-${++n}` } as any)
  const orgId = org._id as any
  const admin = await createTestUser(orgId, { role: 'admin' } as any)
  const stub = makeNodeStub()
  const { code } = await mintNodeEnrollmentCode(String(orgId), String(admin._id))
  await enrollNode({ ...nodeEnrollBody(stub, ENROLL, { linkLevel: 'full' }), code } as any, [ENROLL])
  const token = (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN }), [TOKEN])).token
  await ServerNode.updateOne({ _id: stub.nodeId }, { $set: { health: { at: new Date(), api: { ok: true, posOpen: 0, fiscalInFlight: 0 }, disk: { freeBytes: 50 * 1024 ** 3 }, ...(opts.health ?? {}) } } })
  for (const ch of ['interactive', 'bulk'] as const) {
    const ws = fakeWs()
    handleUplinkOpen(ws, ch)
    await handleUplinkMessage(ws, JSON.stringify({ t: 'hello', v: 1, ch, token, bootNonce: 'boot-move-back', versions: { app: '0.1.0', protocol: 1 } }))
    sockets.push(ws)
  }
  // The flip of the move here (P3-6a), as it left things.
  await OrgHome.collection.insertOne({ orgId, home: stub.nodeId, epoch: 1, state: 'active', since: new Date() } as any)
  await db().collection('orgs').updateOne({ _id: orgId }, { $set: { homeEpochHighWater: 1 } })
  await db().collection('mirror_state').insertOne({ orgId, nodeId: stub.nodeId, epoch: 1, journalEpoch: 1, watermark: 10, chainHash: 'c'.repeat(64), refused: 0, alarms: [] })
  forgetAllHomes()
  // A document the master made: its file is here only by content.
  const content = randomBytes(3000)
  const rel = `${String(orgId)}/docs/2026-10-27/made-on-the-master.pdf`
  const docId = new mongoose.Types.ObjectId()
  await db().collection('docfiles').insertOne({ _id: docId, orgId, docType: 'invoice', docNumber: `mb-${n}`, docDate: '2026-10-27', originalName: 'made-on-the-master.pdf', currentPath: rel, currentChecksum: sha(content), version: 1, mimeType: 'application/pdf', size: content.length, status: 'uploaded', uploadedAt: new Date() })
  const blob = blobPath(String(orgId), sha(content))
  mkdirSync(dirname(blob), { recursive: true })
  writeFileSync(blob, content)
  await MirrorBlob.create({ orgId, sha256: sha(content), size: content.length, state: 'ok', offset: content.length, source: 'master', nodeId: stub.nodeId })
  await db().collection('contacts').insertMany(Array.from({ length: 5 }, (_, i) => ({ _id: new mongoose.Types.ObjectId(), orgId, type: 'customer', companyName: `Client ${i}`, isActive: true })))
  return { orgId, oid: orgId, admin, nodeId: stub.nodeId, token, content, rel, docId }
}

describe('order-insensitive digests of the home parts (FR-20.80)', () => {
  it('equal whatever the order of fields, different on any value or type', async () => {
    const m = await mirrored()
    const before = await homeDigests(db(), m.oid)
    const before2 = await collectionDigests(db(), m.oid)
    // The mirror writes split documents in its own field order.
    const org: any = await db().collection('orgs').findOne({ _id: m.oid })
    const reordered = Object.fromEntries(Object.entries(org).reverse())
    await db().collection('orgs').replaceOne({ _id: m.oid }, reordered)
    expect(await homeDigests(db(), m.oid)).toEqual(before)
    expect((await collectionDigests(db(), m.oid)).orgs.sha256).not.toBe(before2.orgs.sha256)
    // Global's own parts are not the home's: they never count.
    await db().collection('orgs').updateOne({ _id: m.oid }, { $set: { 'settings.node.mirrorFiles': false, homeEpochHighWater: 7 } })
    expect(await homeDigests(db(), m.oid)).toEqual(before)
    // A value, or only a type, of the home's.
    const B = mongoose.mongo.BSON
    await db().collection('contacts').updateOne({ orgId: m.oid, companyName: 'Client 0' }, { $set: { creditLimit: new B.Int32(5) } })
    const withInt = await homeDigests(db(), m.oid)
    expect(withInt.contacts.sha256).not.toBe(before.contacts.sha256)
    await db().collection('contacts').updateOne({ orgId: m.oid, companyName: 'Client 0' }, { $set: { creditLimit: new B.Double(5) } })
    expect((await homeDigests(db(), m.oid)).contacts.sha256).not.toBe(withInt.contacts.sha256)
    expect(canonical({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 3 } })).toEqual({ a: { c: 3, d: [{ y: 2, z: 1 }] }, b: 1 })
    expect(JSON.stringify(canonical({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 3 } }))).toBe('{"a":{"c":3,"d":[{"y":2,"z":1}]},"b":1}')
  }, 60_000)
})

describe("global's side (FR-20.80)", () => {
  it('preflight: every check at once; a till open there, a file the server cannot send, an org already here', async () => {
    const m = await mirrored()
    const ok = await preflightMoveBack(String(m.orgId))
    expect(ok).toMatchObject({ ok: true, nodeId: m.nodeId })
    expect(ok.checks.every(c => c.ok)).toBe(true)

    await ServerNode.updateOne({ _id: m.nodeId }, { $set: { 'health.api.posOpen': 1 } })
    expect((await preflightMoveBack(String(m.orgId))).checks.find(c => c.name === 'no_till_open')?.ok).toBe(false)
    await ServerNode.updateOne({ _id: m.nodeId }, { $set: { 'health.api.posOpen': 0 } })

    // A file of the org the server cannot send: blocking, unless left behind.
    const lost = 'f'.repeat(64)
    await db().collection('files').insertOne({ orgId: m.oid, uploadedBy: new mongoose.Types.ObjectId(), originalName: 'lost.pdf', storagePath: `${String(m.orgId)}/docs/lost.pdf`, storageProvider: 'local', mimeType: 'application/pdf', size: 5, sha256: lost, module: 'files' })
    await MirrorBlob.create({ orgId: m.oid, sha256: lost, state: 'wanted', offset: 0, failures: 1, retryAt: new Date(Date.now() + 3600_000), lastError: { reason: 'missing_on_master', at: new Date() } })
    const blocked = await preflightMoveBack(String(m.orgId))
    expect(blocked.checks.find(c => c.name === 'files')).toMatchObject({ ok: false })
    expect(blocked.files).toMatchObject({ missingOnMaster: 1 })
    expect((await preflightMoveBack(String(m.orgId), true)).ok).toBe(true)

    // Not homed on a master at all.
    await OrgHome.updateOne({ orgId: m.oid }, { $set: { home: 'global' } })
    forgetAllHomes()
    expect((await preflightMoveBack(String(m.orgId))).checks.find(c => c.name === 'home_master')?.ok).toBe(false)
  }, 60_000)

  it('drains: pages up to the frozen head, every file, then equal digests; then puts the files back and flips', async () => {
    const m = await mirrored()
    const move: any = await startMoveBack(String(m.orgId), { id: String(m.admin._id) })
    expect(move).toMatchObject({ kind: 'to_global', state: 'freezing', from: m.nodeId, to: 'global', epochFrom: 1, epochTo: 2 })
    expect((await captureRejection(startMoveBack(String(m.orgId), { id: String(m.admin._id) })))?.code).toBe('preflight_failed')
    // The master sees it, among its moves.
    expect((await movesForNode(m.nodeId)).find(x => x.id === String(move._id))).toMatchObject({ kind: 'to_global', state: 'freezing', epochFrom: 1, epochTo: 2 })
    // Records only or not, the files travel during a move back.
    await db().collection('orgs').updateOne({ _id: m.oid }, { $set: { 'settings.node.mirrorFiles': false } })
    expect(await filesMirrored(String(m.orgId))).toBe(true)

    const id = String(move._id)
    // The master froze; its journal ends at 14. The mirror is at 10.
    expect(await drained(m.nodeId, id, { head: 14, journalEpoch: 1 })).toEqual({ wait: 'pages', watermark: 10, head: 14 })
    expect(await OrgMove.findById(id).lean()).toMatchObject({ state: 'copying', head: 14, waiting: { on: 'pages' } })
    await db().collection('mirror_state').updateOne({ orgId: m.oid }, { $set: { watermark: 14 } })
    // A file a row names that has not arrived.
    const late = randomBytes(100)
    await db().collection('files').insertOne({ orgId: m.oid, uploadedBy: new mongoose.Types.ObjectId(), originalName: 'late.pdf', storagePath: `${String(m.orgId)}/docs/late.pdf`, storageProvider: 'local', mimeType: 'application/pdf', size: 100, sha256: sha(late), module: 'files' })
    expect(await drained(m.nodeId, id, { head: 14, journalEpoch: 1 })).toMatchObject({ wait: 'files', files: { referenced: 2, held: 1 } })
    const latePath = blobPath(String(m.orgId), sha(late))
    writeFileSync(latePath, late)
    await MirrorBlob.create({ orgId: m.oid, sha256: sha(late), size: 100, state: 'ok', offset: 100, source: 'master' })
    expect(await drained(m.nodeId, id, { head: 14, journalEpoch: 1 })).toEqual({ need: 'digests' })
    // The master's digests: one contact differs (a page still on its way): wait.
    const ours = await homeDigests(db(), m.oid)
    expect(await drained(m.nodeId, id, { head: 14, journalEpoch: 1, digests: { ...ours, contacts: { count: 5, sha256: 'a'.repeat(64) } } })).toEqual({ wait: 'digests', mismatch: ['contacts'] })
    expect(await drained(m.nodeId, id, { head: 14, journalEpoch: 1, digests: ours })).toEqual({ wait: 'placing' })
    expect(await OrgMove.findById(id).lean()).toMatchObject({ state: 'verifying' })

    // The tick: every file back where its row says, then the flip.
    expect(existsSync(join(root, ...m.rel.split('/')))).toBe(false)
    const flipped: string[] = []
    expect(await moveBackTick(new Date(), { flippedBack: nodeId => flipped.push(nodeId) })).toBe(1)
    expect(flipped).toEqual([m.nodeId])
    expect(Buffer.compare(readFileSync(join(root, ...m.rel.split('/'))), m.content)).toBe(0)
    expect(Buffer.compare(readFileSync(join(root, String(m.orgId), 'docs', 'late.pdf')), late)).toBe(0)
    forgetAllHomes()
    expect(await homeOf(m.oid, { fresh: true })).toMatchObject({ home: 'global', epoch: 2, state: 'active' })
    expect(((await db().collection('orgs').findOne({ _id: m.oid })) as any).homeEpochHighWater).toBe(2)
    expect(await db().collection('mirror_state').countDocuments({ orgId: m.oid })).toBe(0)
    // The content store has done its work.
    expect(await MirrorBlob.countDocuments({ orgId: m.oid })).toBe(0)
    expect(existsSync(join(root, String(m.orgId), 'blobs'))).toBe(false)
    const done: any = await OrgMove.findById(id).lean()
    expect(done).toMatchObject({ state: 'done', placed: { placed: 2, present: 0, missing: 0 } })
    // The master is told so, as often as it asks.
    expect(await drained(m.nodeId, id, { head: 14 })).toEqual({ ok: true, epoch: 2, orgId: String(m.orgId), repoints: [] })
    expect(await moveBackTick()).toBe(0)
  }, 60_000)

  it("with the flip's answer comes one signed cloud re-point per desktop of the org (FR-20.82)", async () => {
    const m = await mirrored()
    ;(config.oauth as any).baseUrl = 'https://lgrai.test/'
    const till = new mongoose.Types.ObjectId()
    const gone = new mongoose.Types.ObjectId()
    await db().collection('desktops').insertMany([
      { _id: till, orgId: m.oid, name: 'Till 1', status: 'active' },
      { _id: gone, orgId: m.oid, name: 'Old till', status: 'revoked' },
    ])
    const move: any = await startMoveBack(String(m.orgId), { id: String(m.admin._id) })
    await db().collection('mirror_state').updateOne({ orgId: m.oid }, { $set: { watermark: 20 } })
    await drained(m.nodeId, String(move._id), { head: 20, digests: await homeDigests(db(), m.oid) })
    await moveBackTick()
    const done: any = await drained(m.nodeId, String(move._id), { head: 20 })
    expect(done).toMatchObject({ ok: true, epoch: 2 })
    expect(done.repoints.map((r: any) => r.desktopId)).toEqual([String(till)])
    const v = verifyRepoint(done.repoints[0].instruction, acceptedRepointKeys())
    expect(v).toMatchObject({ ok: true, claims: { sub: String(till), org: String(m.orgId), node: 'global', epoch: 2, server: 'https://lgrai.test' } })
    expect((v as any).claims.fp).toBeUndefined()
  }, 60_000)

  it("a file already where its row says stays; one with other bytes there is replaced", async () => {
    const m = await mirrored()
    const abs = join(root, ...m.rel.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, randomBytes(10)) // not what the row names
    const move: any = await startMoveBack(String(m.orgId), { id: String(m.admin._id) })
    await db().collection('mirror_state').updateOne({ orgId: m.oid }, { $set: { watermark: 20 } })
    expect(await drained(m.nodeId, String(move._id), { head: 20, digests: await homeDigests(db(), m.oid) })).toEqual({ wait: 'placing' })
    await moveBackTick()
    expect(Buffer.compare(readFileSync(abs), m.content)).toBe(0)
    expect(await OrgMove.findById(move._id).lean()).toMatchObject({ state: 'done', placed: { placed: 1 } })
  }, 60_000)

  it('an abort leaves the home where it is; a server that never froze, or a mirror that never drained, is given up', async () => {
    const m = await mirrored()
    const move: any = await startMoveBack(String(m.orgId), { id: String(m.admin._id) })
    await abortMove(String(move._id), 'not today')
    expect(await drained(m.nodeId, String(move._id), { head: 3 })).toMatchObject({ ok: false, state: 'aborted', error: 'not today' })
    forgetAllHomes()
    expect(await homeOf(m.oid, { fresh: true })).toMatchObject({ home: m.nodeId, epoch: 1, state: 'active' })
    // No audit entry written on global for an org homed on its master.
    expect(await AuditLog.countDocuments({ orgId: m.oid, entityType: 'org_move' })).toBe(0)

    const again: any = await startMoveBack(String(m.orgId), { id: String(m.admin._id) })
    expect(await moveBackTick(new Date(Date.now() + FREEZE_WAIT_MS + 60_000))).toBe(1)
    expect(await OrgMove.findById(again._id).lean()).toMatchObject({ state: 'aborted', error: 'the server never froze the organisation' })

    const third: any = await startMoveBack(String(m.orgId), { id: String(m.admin._id) })
    await drained(m.nodeId, String(third._id), { head: 99 })
    expect(await moveBackTick(new Date(Date.now() + DRAIN_WAIT_MS + 60_000))).toBe(1)
    expect((await OrgMove.findById(third._id).lean() as any).error).toContain('never caught up (pages')
    // Another server's report is not this move's.
    const fourth: any = await startMoveBack(String(m.orgId), { id: String(m.admin._id) })
    expect((await captureRejection(drained(makeNodeStub().nodeId, String(fourth._id), { head: 1 })))?.code).toBe('not_found')
  }, 60_000)
})

describe("the master's side (FR-20.80)", () => {
  /** This database as the master's, home of an org; a stand-in for lgrai.app's node routes. */
  async function onTheMaster(opts: { answers?: any[] } = {}) {
    // Made as global would have: on a master, an org not homed there takes no writes.
    ;(config.node as any).role = 'global'
    forgetAllHomes()
    const org = await createTestOrg({ slug: `move-back-master-${++n}` } as any)
    const orgId = org._id as any
    const admin = await createTestUser(orgId, { role: 'admin' } as any)
    const nodeId = makeNodeStub().nodeId
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = nodeId
    await OrgHome.collection.insertOne({ orgId, home: nodeId, epoch: 1, state: 'active', since: new Date() } as any)
    await db().collection('repl_orgs').insertOne({ orgId, enabled: true, seq: 17 })
    await db().collection('repl_engine').insertOne({ _id: 'engine', journalEpoch: 1 })
    forgetAllHomes()
    const tokenFile = join(root, 'node-token.json')
    writeFileSync(tokenFile, JSON.stringify({ server: 'https://lgrai.test', token: 'node-token', expiresAt: Math.floor(Date.now() / 1000) + 3600 }))
    ;(config.outbox as any).tokenFile = tokenFile
    const moveId = String(new mongoose.Types.ObjectId())
    const lgrai = {
      move: { id: moveId, orgId: String(orgId), kind: 'to_global', state: 'freezing', epochFrom: 1, epochTo: 2, startedBy: String(admin._id) } as any,
      answers: [...(opts.answers ?? [])] as any[],
      calls: [] as any[],
    }
    const fetchImpl = (async (input: any, init: any = {}) => {
      const url = new URL(String(input))
      lgrai.calls.push({ path: url.pathname, body: init.body ? JSON.parse(init.body) : undefined })
      if (url.pathname === '/api/node/v1/moves') return Response.json({ moves: [lgrai.move] })
      if (url.pathname.endsWith('/drained')) return Response.json(lgrai.answers.shift() ?? { wait: 'pages', watermark: 0, head: 17 })
      if (url.pathname.endsWith('/failed')) return Response.json({ ok: true })
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    const phase = async () => ((await NodeState.findById(`move:${moveId}`).lean()) as any)?.value
    return { orgId, admin, nodeId, moveId, lgrai, fetchImpl, phase }
  }

  it('freezes the org, reports its journal head once the last writes are captured, its digests when asked, and leaves on done', async () => {
    const till = String(new mongoose.Types.ObjectId())
    const m = await onTheMaster({ answers: [{ need: 'digests' }, { wait: 'placing' }, { ok: true, epoch: 2, repoints: [{ desktopId: till, instruction: 'signed.by.global' }, { desktopId: 'nope', instruction: 'x' }] }] })
    const t0 = Date.now()
    expect(await moveWorkerTick(new Date(t0), m.fetchImpl)).toBe(1)
    forgetAllHomes()
    expect(await OrgHome.findOne({ orgId: m.orgId }).lean()).toMatchObject({ home: m.nodeId, epoch: 1, state: 'freezing' })
    expect(await AuditLog.findOne({ orgId: m.orgId, entityType: 'org_move', entityName: 'to lgrai.app' }).lean()).toBeTruthy()
    // The org's writes are refused here from now.
    expect((await captureRejection(createTestContact(m.orgId, { companyName: 'Written while frozen' })))?.code).toBe('org_home_elsewhere')

    // Not before every write is captured.
    expect(await moveWorkerTick(new Date(t0 + 1_000), m.fetchImpl)).toBe(0)
    expect(m.lgrai.calls.filter(c => c.path.endsWith('/drained'))).toHaveLength(0)
    expect(await moveWorkerTick(new Date(t0 + DRAIN_AFTER_MS + 1), m.fetchImpl)).toBe(1)
    const reports = m.lgrai.calls.filter(c => c.path.endsWith('/drained'))
    expect(reports.map(r => Object.keys(r.body).sort())).toEqual([['head', 'journalEpoch'], ['digests', 'head', 'journalEpoch']])
    expect(reports[0].body).toEqual({ head: 17, journalEpoch: 1 })
    expect(reports[1].body.digests).toEqual(await homeDigests(db(), m.orgId))
    expect(await m.phase()).toMatchObject({ phase: 'draining', waiting: 'placing' })

    // Done on lgrai.app, with the desktops' re-points: the org lives there, this server keeps a read-only copy.
    m.lgrai.move.state = 'done'
    expect(await moveWorkerTick(new Date(t0 + DRAIN_AFTER_MS + 20_000), m.fetchImpl)).toBe(1)
    forgetAllHomes()
    expect(await homeOf(m.orgId, { fresh: true })).toMatchObject({ home: 'global', epoch: 2, state: 'active' })
    expect(await m.phase()).toMatchObject({ phase: 'left' })
    // Each desktop is handed its own; one global signed nothing for is told the org moved.
    expect(await movedFor(till, String(m.orgId))).toEqual({ kind: 'repoint', instruction: 'signed.by.global', node: 'global', name: 'lgrai.app' })
    expect(await movedFor(String(new mongoose.Types.ObjectId()), String(m.orgId))).toEqual({ kind: 'moved', node: 'global', name: 'lgrai.app' })
    expect(await moveWorkerTick(new Date(t0 + DRAIN_AFTER_MS + 40_000), m.fetchImpl)).toBe(0)
  }, 60_000)

  it('refuses while a till session is open, and unfreezes when the move is aborted', async () => {
    const busy = await onTheMaster()
    await POSSession.collection.insertOne({ orgId: busy.orgId, status: 'open', openedAt: new Date() } as any)
    expect(await moveWorkerTick(new Date(), busy.fetchImpl)).toBe(1)
    expect(busy.lgrai.calls.find(c => c.path.endsWith('/failed'))?.body).toEqual({ reason: 'a till session is open: close it first' })
    forgetAllHomes()
    expect(await OrgHome.findOne({ orgId: busy.orgId }).lean()).toMatchObject({ state: 'active' })
    expect(await busy.phase()).toMatchObject({ phase: 'refused' })
    expect(await moveWorkerTick(new Date(), busy.fetchImpl)).toBe(0)
    await clearCollections()

    const m = await onTheMaster()
    expect(await moveWorkerTick(new Date(), m.fetchImpl)).toBe(1)
    m.lgrai.move.state = 'aborted'
    expect(await moveWorkerTick(new Date(), m.fetchImpl)).toBe(1)
    forgetAllHomes()
    expect(await homeOf(m.orgId, { fresh: true })).toMatchObject({ home: m.nodeId, epoch: 1, state: 'active' })
    expect(await m.phase()).toMatchObject({ phase: 'unfrozen' })
    // A fiscal print in flight refuses too.
    await clearCollections()
    const printing = await onTheMaster()
    expect(await moveWorkerTick(new Date(), printing.fetchImpl, () => 1)).toBe(1)
    expect(printing.lgrai.calls.find(c => c.path.endsWith('/failed'))?.body).toEqual({ reason: 'a fiscal device is printing' })
  }, 60_000)
})
