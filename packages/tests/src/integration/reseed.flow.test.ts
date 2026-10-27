import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import zlib from 'node:zlib'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { makeNodeStub, nodeEnrollBody } from '../helpers/node-stub'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import { AuditLog, Identity, NodeState, OnpremCredential, OrgHome, OrgMove, ReplOrg, ServerNode, User } from 'db/models'
import { forgetAllHomes, homeOf } from 'db/home/home'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { generateSealKey } from 'services/biz/crypto/node-seal'
import { collectionDigests, importMoveBundle } from 'services/biz/move/move-bundle'
import { abortMove, copied, copyFor, currentMove, moveTick, movesForNode } from 'services/biz/move/move.service'
import { preflightReseed, startReseed } from 'services/biz/move/reseed.service'
import { moveWorkerTick } from 'services/biz/move/move-worker.service'
import { blobDir, blobPath } from 'services/biz/replication/mirror-blobs'
import { HOME_CACHE_MS } from 'db/home/home'
import { handleUplinkClose, handleUplinkMessage, handleUplinkOpen } from '../../../portal-api/src/websocket/uplink'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { moveController } from '../../../portal-api/src/controllers/move.controller.js'

/**
 * Re-seeding a master from lgrai.app's mirror (FR-20.71, plan step P3-7, AC 36).
 *
 * Global's half runs here as global, for an org homed on a master whose mirror global holds; the
 * master's half then runs as a master against the same database, cleared and set up as the server
 * whose database went back, with a stand-in for lgrai.app's node routes serving the copy global built.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'
const saved = { role: config.node.role, id: (config.node as any).id, tokenFile: config.outbox.tokenFile }
const scratch = mkdtempSync(join(tmpdir(), 'lgr-reseed-'))
const sockets: any[] = []
const year = new Date().getFullYear()
let n = 0

beforeAll(async () => {
  await setupTestDB()
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
  rmSync(scratch, { recursive: true, force: true })
}, 60_000)

afterEach(async () => {
  for (const ws of sockets.splice(0)) await handleUplinkClose(ws)
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.outbox as any).tokenFile = saved.tokenFile
  forgetAllHomes()
  await clearCollections()
}, 60_000)

const db = () => mongoose.connection.db as any
const orgDir = (orgId: unknown) => join(config.upload.dir, String(orgId))
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const oid = () => new mongoose.Types.ObjectId()

function fakeWs() {
  return { raw: { id: Math.random() }, send: () => {}, close: () => {} }
}

async function socket(token: string, ch: 'bulk' | 'interactive') {
  const ws = fakeWs()
  handleUplinkOpen(ws, ch)
  await handleUplinkMessage(ws, JSON.stringify({ t: 'hello', v: 1, ch, token, bootNonce: 'boot-reseed', versions: { app: '0.1.0', protocol: 1 } }))
  sockets.push(ws)
  return ws
}

const FILE = Buffer.from('a document the server wrote, which lgrai.app holds by content (P3-7)')

/**
 * An org homed on its server, as lgrai.app's mirror holds it: a contact kept since the backup, one made
 * after it, and a document whose file is in the content store. The server is registered at Full,
 * connected, healthy, with a seal key, and says its database went back.
 */
async function mirrored(opts: { wentBack?: boolean } = {}) {
  ;(config.node as any).role = 'global'
  const org = await createTestOrg({ slug: `reseed-${++n}` } as any)
  const orgId = org._id as any
  const personId = oid()
  await db().collection('identities').insertOne({ _id: personId, email: `ana-${n}@reseed.test`, emailVerified: true, firstName: 'Ana', lastName: 'Shop', tokenVersion: 3, isActive: true })
  const anaId = oid()
  await db().collection('users').insertOne({ _id: anaId, orgId, identityId: personId, email: `ana-${n}@reseed.test`, username: `ana${n}`, firstName: 'Ana', lastName: 'Shop', role: 'admin', isActive: true, permissions: [] })
  await OnpremCredential.create({ identityId: personId, orgId, kind: 'password', verifier: await Bun.password.hash('site-only-42', { algorithm: 'argon2id' }), tvAtSet: 3, setAt: new Date() })
  const kept = oid()
  const later = oid()
  await db().collection('contacts').insertMany([
    { _id: kept, orgId, type: 'customer', companyName: 'Kept Ltd, as it is now' },
    { _id: later, orgId, type: 'customer', companyName: 'Made after the backup' },
  ])
  const rel = `${String(orgId)}/docs/2026-10-27/kept.pdf`
  const fileId = oid()
  await db().collection('files').insertOne({ _id: fileId, orgId, originalName: 'kept.pdf', storagePath: rel, storageProvider: 'local', mimeType: 'application/pdf', size: FILE.length, sha256: sha(FILE), module: 'files' })
  await db().collection('docfiles').insertOne({ _id: oid(), orgId, docType: 'invoice', docNumber: 'ft-kept', docDate: '2026-10-27', originalName: 'kept.pdf', currentPath: rel, currentChecksum: sha(FILE), version: 1, mimeType: 'application/pdf', size: FILE.length, status: 'uploaded', fileId, isActive: true })
  mkdirSync(blobDir(String(orgId)), { recursive: true })
  writeFileSync(blobPath(String(orgId), sha(FILE)), FILE)
  await db().collection('mirror_blobs').insertOne({ orgId, sha256: sha(FILE), state: 'ok', size: FILE.length })
  const sequenceId = oid()
  await db().collection('sequences').insertOne({ _id: sequenceId, orgId, prefix: 'SALES_DOC', year, lastNumber: 12 })

  const stub = makeNodeStub()
  const { code } = await mintNodeEnrollmentCode(String(orgId), String(anaId))
  await enrollNode({ ...nodeEnrollBody(stub, ENROLL, { linkLevel: 'full' }), code } as any, [ENROLL])
  const token = (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN }), [TOKEN])).token
  const seal = generateSealKey()
  await ServerNode.updateOne({ _id: stub.nodeId }, {
    $set: {
      sealKey: seal.publicKey,
      health: { at: new Date(), api: { ok: true, posOpen: 0, fiscalInFlight: 0 }, disk: { freeBytes: 50 * 1024 ** 3 } },
      ...(opts.wentBack === false ? {} : { orgState: [{ orgId, head: 40, wentBack: { at: new Date(), reason: 'mirror_ahead', detail: 'lgrai.app holds pages up to 64' }, at: new Date() }] }),
    },
  })
  await socket(token, 'interactive')
  await socket(token, 'bulk')
  // The org is written on the server; lgrai.app holds its mirror, up to page 64.
  await OrgHome.collection.insertOne({ orgId, home: stub.nodeId, epoch: 1, state: 'active', since: new Date() } as any)
  await db().collection('mirror_state').insertOne({ orgId, nodeId: stub.nodeId, epoch: 1, instanceEpoch: 'i'.repeat(32), journalEpoch: 1, watermark: 64, chainHash: 'c'.repeat(64), lastPageAt: new Date(), refused: 0, alarms: [] })
  forgetAllHomes()
  return { orgId, slug: org.slug as string, anaId, personId, kept, later, rel, sequenceId, nodeId: stub.nodeId, seal, by: { id: String(anaId) } }
}

type Mirrored = Awaited<ReturnType<typeof mirrored>>

/** Start a re-seed and run global's tick: the copy of the mirror is built. */
async function copying(s: Mirrored) {
  const move: any = await startReseed(String(s.orgId), s.by, s.slug)
  expect(await moveTick(new Date())).toBe(1)
  return (await OrgMove.findById(move._id).lean()) as any
}

describe("global's re-seed (FR-20.71)", () => {
  it('names everything that stands in the way, and above all a server whose database did not go back', async () => {
    const s = await mirrored()
    const failed = async () => (await preflightReseed(String(s.orgId))).checks.filter(c => !c.ok).map(c => c.name).sort()
    expect(await failed()).toEqual([])
    const pre = await preflightReseed(String(s.orgId))
    expect(pre).toMatchObject({ ok: true, nodeId: s.nodeId, wentBack: { reason: 'mirror_ahead' } })
    expect(pre.files).toMatchObject({ referenced: 1, held: 1 })

    // Nothing says it went back: a re-seed would replace what it holds with an older copy.
    await ServerNode.updateOne({ _id: s.nodeId }, { $unset: { orgState: 1 } })
    expect(await failed()).toEqual(['went_back'])
    // …unless the mirror refused its history since its last page.
    await db().collection('mirror_state').updateOne({ orgId: s.orgId }, { $set: { lastRefusal: { reason: 'instance_changed', at: new Date(Date.now() + 1000) } } })
    expect(await failed()).toEqual([])
    expect((await preflightReseed(String(s.orgId))).wentBack).toMatchObject({ reason: 'instance_changed' })

    // A clone is decided first; a till open or a print running, and no copy to re-seed from.
    await ServerNode.updateOne({ _id: s.nodeId }, { $set: { cloneAlarm: { at: new Date(), channel: 'bulk', bootNonces: ['a', 'b'] }, 'health.api.posOpen': 1, 'health.api.fiscalInFlight': 2 } })
    await db().collection('mirror_state').updateOne({ orgId: s.orgId }, { $set: { chainHash: '' } })
    expect(await failed()).toEqual(['mirror', 'no_clone_alarm', 'no_fiscal_command', 'no_till_open'])

    // And nothing to re-seed for an org written on lgrai.app.
    await OrgHome.updateOne({ orgId: s.orgId }, { $set: { home: 'global' } })
    forgetAllHomes()
    expect((await preflightReseed(String(s.orgId))).checks.find(c => c.name === 'home_master')?.ok).toBe(false)
  }, 60_000)

  it('builds its copy of the mirror, files from the content store, and flips on equal digests: the chain starts again, nothing deleted', async () => {
    const s = await mirrored()
    expect((await captureRejection(startReseed(String(s.orgId), s.by, `${s.slug}-x`)))?.code).toBe('slug_mismatch')
    const built = await copying(s)
    expect(built).toMatchObject({ kind: 'reseed', state: 'copying', from: 'global', to: s.nodeId, epochFrom: 1, epochTo: 1 })
    expect(built.bundle).toMatchObject({ people: 1, credentials: 1 })
    expect(built.files.count).toBe(1)
    expect(built.steps.map((x: any) => x.name)).toEqual(['preflight', 'asked', 'copy'])
    // One live move per org.
    expect((await captureRejection(startReseed(String(s.orgId), s.by, s.slug)))?.code).toBe('preflight_failed')
    const [view] = await movesForNode(s.nodeId)
    expect(view).toMatchObject({ id: String(built._id), kind: 'reseed', state: 'copying', bundle: { sha256: built.bundle.sha256 }, files: { sha256: built.files.sha256 } })

    // The files of the copy are the mirror's, at the paths their rows name.
    const paths = await copyFor(s.nodeId, String(built._id))
    const lines = zlib.zstdDecompressSync(readFileSync(paths.files)).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    expect(lines.slice(1)).toEqual([{ path: 'docs/2026-10-27/kept.pdf', size: FILE.length, sha256: sha(FILE), b64: FILE.toString('base64') }])

    // What a master that took it would answer.
    const target = mongoose.connection.getClient().db(`${db().databaseName}-reseed-${n}`)
    let report: any
    try {
      const imported = await importMoveBundle(target as any, s.orgId, paths.bundle, { applyCredentials: async xs => ({ live: xs.map(String), unopened: 0 }) })
      report = { digests: imported.digests, people: imported.people, credentials: imported.credentials }
    } finally {
      await target.dropDatabase()
    }
    // Global's own fields changing meanwhile do not stand in the way: the copy is what the server was given.
    await db().collection('orgs').updateOne({ _id: s.orgId }, { $set: { 'subscription.plan': 'enterprise' } })
    const replaced = { file: `docs/reseed/${built._id}.ndjson.zst`, documents: 9, onlyThere: 2, sales: 1, salesNumbers: [`INV-${year}-00009`] }
    expect(await copied(s.nodeId, String(built._id), { ...report, replaced } as any)).toEqual({ ok: true, epoch: 1, orgId: String(s.orgId), kind: 'reseed' })
    const done: any = await currentMove(String(s.orgId))
    expect(done.state).toBe('done')
    expect(done.replaced).toEqual({ ...replaced, salesNumbers: replaced.salesNumbers })
    expect(done.steps.map((x: any) => x.name)).toEqual(['preflight', 'asked', 'copy', 'imported', 'replaced', 'flip', 'done'])
    // The chain starts again; the mirror's documents and files stay, and the home never moved.
    expect(await db().collection('mirror_state').countDocuments({ orgId: s.orgId })).toBe(0)
    expect(await db().collection('contacts').countDocuments({ orgId: s.orgId })).toBe(2)
    expect(existsSync(blobPath(String(s.orgId), sha(FILE)))).toBe(true)
    forgetAllHomes()
    expect(await homeOf(s.orgId, { fresh: true })).toMatchObject({ home: s.nodeId, epoch: 1, state: 'active' })
    expect(existsSync(paths.bundle) || existsSync(paths.files)).toBe(false)
    // The org's trail is the server's to write: nothing here.
    expect(await AuditLog.countDocuments({ orgId: s.orgId })).toBe(0)
    // Said again (the answer lost), the same.
    expect(await copied(s.nodeId, String(built._id), report)).toEqual({ ok: true, epoch: 1, orgId: String(s.orgId), kind: 'reseed' })
  }, 60_000)

  it('its routes answer for an org written on its server: the home gate lets them through', async () => {
    const s = await mirrored()
    const app = new Elysia().onError(spaErrorHandler({}) as any).use(moveController)
    const token = await (new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt.sign({
      id: String(s.anaId), orgId: String(s.orgId), role: 'admin', email: 'ana@reseed.test', username: 'ana', firstName: 'Ana', lastName: 'Shop', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
    })
    const call = async (path: string, body: unknown = {}) => {
      const res = await app.handle(new Request(`http://localhost/org/${String(s.orgId)}/moves${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }))
      return { status: res.status, json: await res.json().catch(() => null) as any }
    }
    // ⚠ Global writes none of this org's data: without the home gate's leave, both would be 409.
    expect(await call('/reseed/preflight')).toMatchObject({ status: 200, json: { ok: true, wentBack: { reason: 'mirror_ahead' } } })
    expect(await call('/reseed', { slug: `${s.slug}-x` })).toMatchObject({ status: 422, json: { code: 'slug_mismatch' } })
    expect(await call('/reseed', { slug: s.slug })).toMatchObject({ status: 200, json: { move: { kind: 'reseed', state: 'copying', to: s.nodeId } } })
    // Nobody without a session.
    const anonymous = await app.handle(new Request(`http://localhost/org/${String(s.orgId)}/moves/reseed/preflight`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
    expect(anonymous.status).toBe(401)
  }, 60_000)

  it('a server copy that differs is aborted: the mirror keeps its chain, and the copy goes', async () => {
    const s = await mirrored()
    const built = await copying(s)
    const paths = await copyFor(s.nodeId, String(built._id))
    const bad = { digests: { ...built.digests, contacts: { count: 1, sha256: 'f'.repeat(64) } }, people: 1, credentials: 1 }
    expect(await copied(s.nodeId, String(built._id), bad)).toEqual({ ok: false, mismatch: ['contacts'] })
    expect((await currentMove(String(s.orgId)))?.state).toBe('aborted')
    expect(await db().collection('mirror_state').countDocuments({ orgId: s.orgId, chainHash: 'c'.repeat(64) })).toBe(1)
    expect(existsSync(paths.bundle) || existsSync(paths.files)).toBe(false)
    expect(await AuditLog.countDocuments({ orgId: s.orgId })).toBe(0)
    // An admin's abort before the copy is taken: the same, and a new re-seed may start.
    const again = await copying(s)
    await abortMove(String(again._id), 'not today', s.by)
    expect((await preflightReseed(String(s.orgId))).ok).toBe(true)
  }, 60_000)
})

describe("the server's side (FR-20.71)", () => {
  /**
   * Global builds a re-seed's copy; then this database becomes the server's, whose database went back:
   * it holds the org as a backup had it (the contact older, one since deleted on the mirror, an
   * invoice issued after the mirror's last page, and none of what was made since), its legal
   * numbering locked, and the went-back record.
   */
  async function onTheServer(opts: { record?: boolean } = {}) {
    const s = await mirrored()
    const built = await copying(s)
    const [view] = await movesForNode(s.nodeId)
    const paths = await copyFor(s.nodeId, String(built._id))
    const bundle = join(scratch, `copy-${n}.ndjson.zst`)
    const files = join(scratch, `copy-${n}.files.ndjson.zst`)
    copyFileSync(paths.bundle, bundle)
    copyFileSync(paths.files, files)
    const digests = built.digests

    for (const ws of sockets.splice(0)) await handleUplinkClose(ws)
    await clearCollections()
    rmSync(orgDir(s.orgId), { recursive: true, force: true })
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = s.nodeId
    forgetAllHomes()
    const tokenFile = join(scratch, `node-token-${n}.json`)
    writeFileSync(tokenFile, JSON.stringify({ server: 'https://lgrai.test', token: 'node-token', expiresAt: Math.floor(Date.now() / 1000) + 3600 }))
    ;(config.outbox as any).tokenFile = tokenFile
    await NodeState.create({ _id: 'seal-key', value: { ...s.seal, createdAt: new Date() } } as any)

    // The server's own copy, as its backup had it.
    await OrgHome.collection.insertOne({ orgId: s.orgId, home: s.nodeId, epoch: 1, state: 'active', since: new Date(), seriesFrozen: { since: new Date(), reason: 'went_back', detail: 'lgrai.app holds pages up to 64' } } as any)
    forgetAllHomes()
    await db().collection('orgs').insertOne({ _id: s.orgId, name: 'Reseed Co', slug: s.slug, settings: { baseCurrency: 'EUR' }, subscription: { plan: 'professional', maxUsers: 5 } })
    await db().collection('identities').insertOne({ _id: s.personId, email: `ana-${n}@reseed.test`, emailVerified: true, firstName: 'Ana', lastName: 'Shop', tokenVersion: 3, isActive: true })
    await db().collection('users').insertOne({ _id: s.anaId, orgId: s.orgId, identityId: s.personId, email: `ana-${n}@reseed.test`, username: `ana${n}`, firstName: 'Ana', lastName: 'Shop', role: 'admin', isActive: true, permissions: [] })
    const gone = oid()
    const issued = oid()
    await db().collection('contacts').insertMany([
      { _id: s.kept, orgId: s.orgId, type: 'customer', companyName: 'Kept Ltd, as the backup had it' },
      { _id: gone, orgId: s.orgId, type: 'customer', companyName: 'Deleted since the backup' },
    ])
    await db().collection('invoices').insertOne({ _id: issued, orgId: s.orgId, type: 'invoice', direction: 'outgoing', status: 'sent', invoiceNumber: `INV-${year}-00009`, total: 12 })
    await db().collection('invoices').insertOne({ _id: oid(), orgId: s.orgId, type: 'invoice', direction: 'outgoing', status: 'draft', invoiceNumber: `DRF-INV-${year}-00003`, total: 5 })
    // The same counter row, as the backup had it.
    await db().collection('sequences').insertOne({ _id: s.sequenceId, orgId: s.orgId, prefix: 'SALES_DOC', year, lastNumber: 9 })
    await ReplOrg.collection.insertOne({
      orgId: s.orgId, enabled: true, seq: 40, seededAt: new Date(), seededEpoch: 1,
      pages: [{ toSeq: 38, hash: 'd'.repeat(64), at: new Date() }],
      ...(opts.record === false ? {} : { wentBack: { at: new Date(), reason: 'mirror_ahead', detail: 'lgrai.app holds pages up to 64' } }),
    } as any)

    const lgrai = { moves: [{ ...view }] as any[], answer: { ok: true, epoch: 1, kind: 'reseed' } as any, calls: [] as any[] }
    const fetchImpl = (async (input: any, init: any = {}) => {
      const url = new URL(String(input))
      lgrai.calls.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined })
      if (url.pathname === '/api/node/v1/moves') return Response.json({ moves: lgrai.moves })
      const part = url.pathname.match(/^\/api\/node\/v1\/moves\/[0-9a-f]{24}\/(bundle|files|copied|failed)$/)?.[1]
      if (part === 'bundle') return new Response(Bun.file(bundle))
      if (part === 'files') return new Response(Bun.file(files))
      if (part === 'copied') return Response.json(lgrai.answer)
      if (part === 'failed') return Response.json({ ok: true })
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    let clock = Date.now()
    const tick = (ms = 0) => moveWorkerTick(new Date((clock += ms)), fetchImpl)
    const reported = (path: string) => lgrai.calls.filter(c => c.path.endsWith(path))
    const phase = async () => ((await NodeState.findById(`move:${String(built._id)}`).lean()) as any)?.value
    return { ...s, moveId: String(built._id), digests, lgrai, tick, reported, phase, gone, issued }
  }

  it('freezes the org, keeps what it holds, takes lgrai.app\'s copy, and is unfrozen with a new chain when lgrai.app flips', async () => {
    const m = await onTheServer()
    // Asked: the org freezes, and no page continues the old chain.
    expect(await m.tick()).toBe(1)
    forgetAllHomes()
    expect(await OrgHome.findOne({ orgId: m.orgId }).lean()).toMatchObject({ home: m.nodeId, epoch: 1, state: 'frozen' })
    expect(((await ReplOrg.findOne({ orgId: m.orgId }).lean()) as any).pages).toEqual([])
    // A write made on a cached "home is here" lands first: nothing is read before the home cache ran out.
    expect(await m.tick()).toBe(0)
    expect(m.reported('/bundle')).toHaveLength(0)
    expect(await m.tick(2 * HOME_CACHE_MS + 1_000)).toBe(1)

    // What it held is kept for good, with what the copy lacks: the deleted contact, and the issued sale.
    const kept = join(orgDir(m.orgId), 'docs', 'reseed', `${m.moveId}.ndjson.zst`)
    expect(existsSync(kept)).toBe(true)
    const keptText = zlib.zstdDecompressSync(readFileSync(kept)).toString('utf8')
    expect(keptText).toContain(`INV-${year}-00009`)
    expect(keptText).toContain('Deleted since the backup')
    const [report] = m.reported('/copied')
    expect(report.body).toEqual({
      digests: m.digests, people: 1, credentials: 1,
      replaced: { file: `docs/reseed/${m.moveId}.ndjson.zst`, documents: expect.any(Number), onlyThere: 3, sales: 1, salesNumbers: [`INV-${year}-00009`] },
    })
    // The org here is lgrai.app's copy now, document for document, with the file where its row says.
    expect(await collectionDigests(db(), m.orgId)).toEqual(m.digests)
    const names = (await db().collection('contacts').find({ orgId: m.orgId }).toArray()).map((c: any) => c.companyName).sort()
    expect(names).toEqual(['Kept Ltd, as it is now', 'Made after the backup'])
    expect(await db().collection('invoices').countDocuments({ orgId: m.orgId })).toBe(0)
    expect(readFileSync(join(config.upload.dir, m.rel)).equals(FILE)).toBe(true)
    expect(((await db().collection('sequences').findOne({ orgId: m.orgId, prefix: 'SALES_DOC' })) as any).lastNumber).toBe(12)
    expect((await m.phase()).phase).toBe('reported')

    // Until lgrai.app flips, nothing more; then unfrozen, the record gone, the re-seed in the trail.
    m.lgrai.moves[0].state = 'verifying'
    expect(await m.tick()).toBe(0)
    m.lgrai.moves[0].state = 'done'
    expect(await m.tick()).toBe(1)
    forgetAllHomes()
    const home: any = await OrgHome.findOne({ orgId: m.orgId }).lean()
    expect(home).toMatchObject({ home: m.nodeId, epoch: 1, state: 'active' })
    // ⚠ Legal numbering stays locked: what the server issued after its last page is on paper only.
    expect(home.seriesFrozen).toMatchObject({ reason: 'went_back' })
    expect(((await ReplOrg.findOne({ orgId: m.orgId }).lean()) as any).wentBack).toBeUndefined()
    expect(await AuditLog.findOne({ orgId: m.orgId, entityType: 'org_move', entityName: 're-seeded from lgrai.app\'s copy' }).lean()).toBeTruthy()
    expect(await m.tick()).toBe(0)
    expect(m.reported('/copied')).toHaveLength(1)
    expect(m.reported('/failed')).toHaveLength(0)
  }, 60_000)

  it('refuses when its database did not go back, whatever lgrai.app asked, and changes nothing', async () => {
    const m = await onTheServer({ record: false })
    expect(await m.tick()).toBe(1)
    expect(m.reported('/failed')[0]?.body.reason).toContain('did not go back')
    expect(m.reported('/bundle')).toHaveLength(0)
    forgetAllHomes()
    expect(await OrgHome.findOne({ orgId: m.orgId }).lean()).toMatchObject({ state: 'active' })
    expect(await db().collection('contacts').countDocuments({ orgId: m.orgId })).toBe(2)
    expect(await m.tick()).toBe(0)
  }, 60_000)

  it('an abort after the copy was taken puts back what the server held, then unfreezes', async () => {
    const m = await onTheServer()
    // lgrai.app finds the server's copy differs, and aborts.
    m.lgrai.answer = { ok: false, mismatch: ['contacts'] }
    await m.tick()
    await m.tick(2 * HOME_CACHE_MS + 1_000)
    expect(await db().collection('invoices').countDocuments({ orgId: m.orgId })).toBe(0)
    expect((await m.phase()).phase).toBe('mismatch')
    m.lgrai.moves[0].state = 'aborted'
    expect(await m.tick()).toBe(1)
    forgetAllHomes()
    expect(await OrgHome.findOne({ orgId: m.orgId }).lean()).toMatchObject({ state: 'active' })
    const names = (await db().collection('contacts').find({ orgId: m.orgId }).toArray()).map((c: any) => c.companyName).sort()
    expect(names).toEqual(['Deleted since the backup', 'Kept Ltd, as the backup had it'])
    expect(((await db().collection('invoices').findOne({ _id: m.issued })) as any)?.invoiceNumber).toBe(`INV-${year}-00009`)
    // Still went back: a new re-seed may be asked for.
    expect(((await ReplOrg.findOne({ orgId: m.orgId }).lean()) as any).wentBack).toBeTruthy()
    expect((await m.phase()).phase).toBe('unfrozen')
    expect(await m.tick()).toBe(0)
  }, 60_000)
})
