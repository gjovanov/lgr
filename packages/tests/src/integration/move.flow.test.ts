import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestContact, createTestOrg } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { makeNodeStub, nodeEnrollBody } from '../helpers/node-stub'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { AuditLog, Identity, LocalCredential, NodeState, OnpremCredential, Org, OrgHome, OrgMove, ServerNode, User } from 'db/models'
import { HOME_CACHE_MS, forgetAllHomes, homeOf } from 'db/home/home'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { generateSealKey, openSealed } from 'services/biz/crypto/node-seal'
import { credentialAad } from 'services/biz/identity/onprem-credentials.service'
import { PEOPLE_FIELDS, collectionDigests, importMoveBundle, orgHasData, writeMoveBundle } from 'services/biz/move/move-bundle'
import { MoveError, abortMove, copied, copyFor, currentMove, moveTick, movesForNode, preflightMove, startMove } from 'services/biz/move/move.service'
import { moveWorkerTick } from 'services/biz/move/move-worker.service'
import { createApiApp } from '../../../portal-api/src/api.js'
import { CLOSE, handleUplinkClose, handleUplinkMessage, handleUplinkOpen, rewelcomeNode, tickConn } from '../../../portal-api/src/websocket/uplink'

/**
 * Moving an org from lgrai.app to its master (FR-20.79, plan step P3-6a).
 *
 * Global's half runs here as global; the master's half runs as a master against the same database
 * once global's state is cleared, with a stand-in for lgrai.app's node routes that serves the copy
 * global built. The two halves therefore exchange a real copy, and each is checked against the other.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'
const LOCAL_PASSWORD = 'site-only-password-42'
const saved = { role: config.node.role, id: (config.node as any).id, tokenFile: config.outbox.tokenFile }
const scratch = mkdtempSync(join(tmpdir(), 'lgr-move-'))
const sockets: any[] = []
let n = 0

let app: any
beforeAll(async () => {
  await setupTestDB()
  app = createApiApp()
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

function fakeWs() {
  const closed: Array<{ code?: number; reason?: string }> = []
  return {
    raw: { id: Math.random() },
    send: () => {},
    close: (code?: number, reason?: string) => { closed.push({ code, reason }) },
    closed,
  }
}

async function socket(token: string, ch: 'bulk' | 'interactive') {
  const ws = fakeWs()
  handleUplinkOpen(ws, ch)
  await handleUplinkMessage(ws, JSON.stringify({ t: 'hello', v: 1, ch, token, bootNonce: 'boot-move', versions: { app: '0.1.0', protocol: 1 } }))
  sockets.push(ws)
  return ws
}

/** A person and their membership of `orgId`, with everything a master must never hold set. */
async function member(orgId: unknown, name: string, opts: { role?: string; tokenVersion?: number; credential?: boolean } = {}) {
  const k = ++n
  const person = await Identity.create({
    email: `${name.toLowerCase()}-${k}@move.test`, emailVerified: true, firstName: name, lastName: 'Shop', tokenVersion: opts.tokenVersion ?? 3,
    password: await Bun.password.hash('global-password'), passwordSetBy: 'self',
    oauthProviders: [{ provider: 'google', providerId: `g-${k}`, verified: true, linkedAt: new Date() }],
    lastOrgId: orgId, isActive: true,
  } as any)
  const user = await User.create({
    orgId, identityId: person._id, email: person.email, username: `${name.toLowerCase()}${k}`, firstName: name, lastName: 'Shop',
    role: opts.role ?? 'member', isActive: true, permissions: [], password: await Bun.password.hash('per-org-copy'),
    oauthProviders: [{ provider: 'google', providerId: `g-${k}` }], lastLoginAt: new Date(),
  } as any)
  if (opts.credential) {
    await OnpremCredential.create({ identityId: person._id, orgId, kind: 'password', verifier: await Bun.password.hash(LOCAL_PASSWORD, { algorithm: 'argon2id' }), tvAtSet: opts.tokenVersion ?? 3, setAt: new Date() })
  }
  return { person, user }
}

/**
 * A shop on lgrai.app, its master registered at Full and connected, healthy, with a seal key: a
 * move to it passes every preflight check.
 */
async function shop() {
  ;(config.node as any).role = 'global'
  const org = await createTestOrg({ slug: `move-${++n}` } as any)
  const orgId = org._id as any
  await Org.collection.updateOne({ _id: orgId }, { $set: { 'settings.integrations': { drive: { refreshToken: 'only-on-lgrai' } } } })
  const ana = await member(orgId, 'Ana', { role: 'admin', credential: true })
  const boris = await member(orgId, 'Boris', { tokenVersion: 4 })
  // Boris has no local credential: the admin acknowledges him.
  const contact = await createTestContact(orgId, { companyName: 'Typed Ltd' })
  const B = mongoose.mongo.BSON
  await db().collection('contacts').updateOne({ _id: contact._id }, { $set: { extra: { whole: new B.Double(5), long: B.Long.fromNumber(7), money: B.Decimal128.fromString('1.10'), ref: new B.ObjectId() } } })
  mkdirSync(join(orgDir(orgId), 'docs'), { recursive: true })
  writeFileSync(join(orgDir(orgId), 'docs', 'receipt.txt'), 'касова бележка 7')

  const stub = makeNodeStub()
  const { code } = await mintNodeEnrollmentCode(String(orgId), String(ana.user._id))
  await enrollNode({ ...nodeEnrollBody(stub, ENROLL, { linkLevel: 'full' }), code } as any, [ENROLL])
  const token = (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN }), [TOKEN])).token
  const seal = generateSealKey()
  await ServerNode.updateOne({ _id: stub.nodeId }, { $set: { sealKey: seal.publicKey, health: { at: new Date(), api: { ok: true }, disk: { freeBytes: 50 * 1024 ** 3 } } } })
  const interactive = await socket(token, 'interactive')
  const bulk = await socket(token, 'bulk')
  return { orgId, ana, boris, contact, stub, nodeId: stub.nodeId, token, seal, interactive, bulk, allow: [String(boris.person._id)] }
}

type Shop = Awaited<ReturnType<typeof shop>>

/** Start a move and run the tick past the home cache's lifetime: the copy is built. */
async function copying(s: Shop) {
  const move: any = await startMove(String(s.orgId), s.nodeId, { id: String(s.ana.user._id) }, s.allow)
  expect(await moveTick(new Date(Date.now() + 2 * HOME_CACHE_MS + 1_000))).toBe(1)
  return (await OrgMove.findById(move._id).lean()) as any
}

describe('the copy (FR-20.79 step 3)', () => {
  it('is type-exact, carries the people as who they are, and nothing a master must never hold', async () => {
    const s = await shop()
    const path = join(scratch, `bundle-${n}.ndjson.zst`)
    const items = [{ iid: String(s.ana.person._id), org: String(s.orgId), kind: 'password', tv: 3, setAt: new Date().toISOString(), sealed: 'sealed-to-the-master' }]
    const b = await writeMoveBundle(db(), s.orgId, path, { credentials: items })
    expect(b.people).toBe(2)
    expect(b.credentials).toBe(1)
    expect(b.digests).toEqual(await collectionDigests(db(), s.orgId))

    const target = mongoose.connection.getClient().db(`${db().databaseName}-move-${n}`)
    try {
      const kept: unknown[] = []
      const got = await importMoveBundle(target as any, s.orgId, path, { applyCredentials: async xs => { kept.push(...xs); return { live: xs.map(String), unopened: 0 } } })
      expect(got.digests).toEqual(b.digests)
      expect(got.people).toBe(2)
      expect(got.credentials).toBe(1)
      expect(kept).toEqual(items)

      // Every BSON type as global stored it.
      const raw = (d: any, id: unknown) => d.collection('contacts').findOne({ _id: id }, { promoteValues: false })
      const B = mongoose.mongo.BSON
      expect(Buffer.from(B.serialize(await raw(target, s.contact._id))).equals(Buffer.from(B.serialize(await raw(db(), s.contact._id))))).toBe(true)

      const users = await target.collection('users').find({ orgId: s.orgId }).toArray()
      expect(users).toHaveLength(2)
      for (const u of users) {
        expect(u.password).toBeUndefined()
        expect(u.oauthProviders).toBeUndefined()
        expect(u.lastLoginAt).toBeUndefined() // the node observes it itself
        expect(u.identityId).toBeTruthy()
      }
      const org: any = await target.collection('orgs').findOne({ _id: s.orgId })
      expect(org.settings.integrations).toBeUndefined()
      expect(org.settings.baseCurrency).toBe('EUR')
      const people = await target.collection('identities').find({}).toArray()
      expect(people.map(p => String(p._id)).sort()).toEqual([String(s.ana.person._id), String(s.boris.person._id)].sort())
      for (const p of people) {
        expect(Object.keys(p).every(k => (PEOPLE_FIELDS as readonly string[]).includes(k))).toBe(true)
        expect(p.password).toBeUndefined()
        expect(p.oauthProviders).toBeUndefined()
        expect(p.lastOrgId).toBeUndefined()
      }

      // Only into an empty org.
      const again = await captureRejection(importMoveBundle(target as any, s.orgId, path))
      expect(String(again?.message)).toContain('only into an empty org')
    } finally {
      await target.dropDatabase()
    }
  }, 60_000)

  it('a copy changed on the way, or carrying a password, is refused', async () => {
    const s = await shop()
    const path = join(scratch, `bundle-${n}.ndjson.zst`)
    await writeMoveBundle(db(), s.orgId, path)
    const lines = zlib.zstdDecompressSync(readFileSync(path)).toString('utf8').split('\n')
    const rewrite = (to: string, f: (l: string) => string) => writeFileSync(to, zlib.zstdCompressSync(Buffer.from(lines.map(f).join('\n'))))

    const tampered = join(scratch, `tampered-${n}.ndjson.zst`)
    rewrite(tampered, l => l.replace('Typed Ltd', 'Typed Ltb'))
    const forged = join(scratch, `forged-${n}.ndjson.zst`)
    rewrite(forged, l => (l.includes('"tokenVersion"') && l.includes('@move.test') ? l.replace('{"_id"', '{"password":"$argon2id$x","_id"') : l))

    for (const [file, why] of [[tampered, 'does not match its own digests: contacts'], [forged, 'carries password']]) {
      const target = mongoose.connection.getClient().db(`${db().databaseName}-bad-${++n}`)
      try {
        const err = await captureRejection(importMoveBundle(target as any, s.orgId, file))
        expect(String(err?.message)).toContain(why)
      } finally {
        await target.dropDatabase()
      }
    }
  }, 60_000)
})

describe('preflight (FR-20.79 step 1)', () => {
  it('names everything that stands in the way, at once', async () => {
    const s = await shop()
    const check = async (allow: string[] = s.allow, busy = 0) => {
      const r = await preflightMove(String(s.orgId), s.nodeId, allow, busy)
      return { ok: r.ok, failed: r.checks.filter(c => !c.ok).map(c => c.name), missing: r.missingCredentials.map(m => m.identityId) }
    }
    expect(await check()).toEqual({ ok: true, failed: [], missing: [String(s.boris.person._id)] })
    // Boris has no local credential, and nobody said that is all right.
    expect((await check([])).failed).toEqual(['credentials'])
    expect((await check(s.allow, 1)).failed).toEqual(['no_fiscal_command'])

    await db().collection('possessions').insertOne({ orgId: s.orgId, status: 'open' })
    await db().collection('backgroundtasks').insertOne({ orgId: s.orgId, status: 'processing' })
    await ServerNode.updateOne({ _id: s.nodeId }, { $set: { linkLevel: 'control', 'health.at': new Date(Date.now() - 10 * 60_000) }, $unset: { sealKey: 1 } })
    await db().collection('node_presence').updateMany({ nodeId: s.nodeId }, { $set: { heartbeatAt: new Date(Date.now() - 5 * 60_000) } })
    expect((await check()).failed.sort()).toEqual(['connected', 'full', 'healthy', 'no_job_running', 'no_till_open', 'seal_key'].sort())
  }, 60_000)
})

/** A built move, and the report a master that imported it would send. */
async function shopWithCopy() {
  const s = await shop()
  const built = await copying(s)
  const target = mongoose.connection.getClient().db(`${db().databaseName}-copy-${n}`)
  try {
    const paths = await copyFor(s.nodeId, String(built._id))
    const imported = await importMoveBundle(target as any, s.orgId, paths.bundle, { applyCredentials: async xs => ({ live: xs.map(String), unopened: 0 }) })
    return { ...s, built, report: { digests: imported.digests, people: imported.people, credentials: imported.credentials } }
  } finally {
    await target.dropDatabase()
  }
}

describe("global's move (FR-20.79 steps 2–5)", () => {
  it('freezes the org, builds the copy once the home cache has run out, and flips on equal digests', async () => {
    const s = await shop()
    const now = new Date()
    await db().collection('desktopenrollmentcodes').insertOne({ orgId: s.orgId, usedAt: null, expiresAt: new Date(now.getTime() + 3600_000) })
    await db().collection('desktopenrollmentkeys').insertOne({ orgId: s.orgId, revokedAt: null })
    await db().collection('mirror_state').insertOne({ orgId: s.orgId, nodeId: 'an-old-chain', watermark: 9, chainHash: 'f'.repeat(64) })

    const move: any = await startMove(String(s.orgId), s.nodeId, { id: String(s.ana.user._id) }, s.allow)
    expect(move).toMatchObject({ state: 'freezing', from: 'global', to: s.nodeId, epochFrom: 0, epochTo: 1 })
    expect(await homeOf(s.orgId, { fresh: true })).toMatchObject({ home: 'global', state: 'freezing' })
    // Written before the freeze, so it travels in the copy.
    expect(await AuditLog.countDocuments({ orgId: s.orgId, entityType: 'org_move' })).toBe(1)
    // Frozen: the org's data is not written here any more.
    const refused = await captureRejection(createTestContact(s.orgId, { companyName: 'Written while frozen' }))
    expect(refused?.name).toBe('HomeElsewhereError')
    // One live move per org.
    const second = await captureRejection(startMove(String(s.orgId), s.nodeId, { id: String(s.ana.user._id) }, s.allow))
    expect(second).toBeInstanceOf(MoveError)
    expect(second.statusCode).toBe(409)

    // No pod may still act on a cached "home is here": the copy waits.
    expect(await moveTick(new Date())).toBe(0)
    const t = new Date(Date.now() + 2 * HOME_CACHE_MS + 1_000)
    expect(await moveTick(t)).toBe(1)
    const built: any = await OrgMove.findById(move._id).lean()
    expect(built.state).toBe('copying')
    expect(built.bundle).toMatchObject({ people: 2, credentials: 1 })
    expect(built.steps.map((x: any) => x.name)).toEqual(['preflight', 'freeze', 'revoke_enrollment', 'copy'])
    expect(await db().collection('desktopenrollmentcodes').countDocuments({ orgId: s.orgId, expiresAt: { $gt: t } })).toBe(0)
    expect(await db().collection('desktopenrollmentkeys').countDocuments({ orgId: s.orgId, revokedAt: null })).toBe(0)

    const [view] = await movesForNode(s.nodeId)
    expect(view).toMatchObject({ id: String(move._id), state: 'copying', epochTo: 1, bundle: { sha256: built.bundle.sha256 }, files: { sha256: built.files.sha256 } })
    expect(await movesForNode('master-someoneelse0000000')).toEqual([])
    const paths = await copyFor(s.nodeId, String(move._id))
    expect(existsSync(paths.bundle) && existsSync(paths.files)).toBe(true)

    // The master's import, into a database of its own: the credential opens only with its key.
    const target = mongoose.connection.getClient().db(`${db().databaseName}-master-${n}`)
    try {
      const imported = await importMoveBundle(target as any, s.orgId, paths.bundle, {
        applyCredentials: async xs => {
          const live = xs.filter((it: any) => JSON.parse(openSealed(s.seal.privateKey, it.sealed, credentialAad(s.nodeId, it)) ?? '{}').verifier?.startsWith('$argon2'))
          return { live: live.map((it: any) => `${it.iid}|${it.kind}`), unopened: xs.length - live.length }
        },
      })
      expect(imported.credentials).toBe(1)

      // A socket welcomed before the move pages nothing of the org: the flip welcomes it again.
      expect(await copied(s.nodeId, String(move._id), imported)).toEqual({ ok: true, epoch: 1, orgId: String(s.orgId) })
    } finally {
      await target.dropDatabase()
    }
    forgetAllHomes()
    expect(await OrgHome.findOne({ orgId: s.orgId }).lean()).toMatchObject({ home: s.nodeId, epoch: 1, state: 'active' })
    expect((await Org.findById(s.orgId).lean() as any).homeEpochHighWater).toBe(1)
    expect(await homeOf(s.orgId, { fresh: true })).toMatchObject({ home: s.nodeId, state: 'active', epoch: 1 })
    expect(await db().collection('mirror_state').countDocuments({ orgId: s.orgId })).toBe(0)
    expect((await currentMove(String(s.orgId)))?.state).toBe('done')
    expect(existsSync(paths.bundle) || existsSync(paths.files)).toBe(false)

    await tickConn(s.bulk)
    expect(s.bulk.closed).toEqual([{ code: CLOSE.homeChanged, reason: 'home_changed' }])
    expect(s.interactive.closed).toEqual([])
    const fresh = await socket(s.token, 'bulk')
    await tickConn(fresh)
    expect(fresh.closed).toEqual([])
    expect(rewelcomeNode(s.nodeId)).toBe(2) // both bulk sockets this process holds
    expect(s.interactive.closed).toEqual([])

    // Past the flip there is nothing to abort, and nothing to start: the org is homed on its master.
    expect((await captureRejection(abortMove(String(move._id), 'too late')))?.code).toBe('not_abortable')
    const again = await captureRejection(startMove(String(s.orgId), s.nodeId, { id: String(s.ana.user._id) }, s.allow))
    expect(again?.code).toBe('preflight_failed')
  }, 60_000)

  it('a copy that differs, or a master missing a person, is aborted and the org unfrozen', async () => {
    const s = await shop()
    const built = await copying(s)
    const r = await copied(s.nodeId, String(built._id), { digests: { ...built.digests, contacts: { count: 1, sha256: '0'.repeat(64) } }, people: 1, credentials: 1 })
    expect(r).toEqual({ ok: false, mismatch: ['contacts', 'people'] })
    const after: any = await OrgMove.findById(built._id).lean()
    expect(after.state).toBe('aborted')
    expect(after.error).toContain('contacts, people')
    forgetAllHomes()
    expect(await homeOf(s.orgId, { fresh: true })).toMatchObject({ home: 'global', state: 'active', epoch: 0 })
    expect(existsSync(join(orgDir(s.orgId), 'backups', 'moves', built.bundle.file))).toBe(false)
    expect((await createTestContact(s.orgId, { companyName: 'Written again' })).companyName).toBe('Written again')
  }, 60_000)

  it('a flip cut short is finished by the next report, and a report after the flip is answered, not refused', async () => {
    const s = await shopWithCopy()
    // This process died after marking the move verifying, before the flip.
    await OrgMove.updateOne({ _id: s.built._id }, { $set: { state: 'verifying' } })
    expect(await copied(s.nodeId, String(s.built._id), s.report)).toEqual({ ok: true, epoch: 1, orgId: String(s.orgId) })
    forgetAllHomes()
    expect(await homeOf(s.orgId, { fresh: true })).toMatchObject({ home: s.nodeId, epoch: 1, state: 'active' })
    // The answer was lost on the way: the master asks again, and is told it is done.
    await db().collection('mirror_state').insertOne({ orgId: s.orgId, nodeId: s.nodeId, watermark: 3, chainHash: 'a'.repeat(64) })
    expect(await copied(s.nodeId, String(s.built._id), s.report)).toEqual({ ok: true, epoch: 1, orgId: String(s.orgId) })
    // …and nothing ran twice: the chain the master's pages started is still there.
    expect(await db().collection('mirror_state').countDocuments({ orgId: s.orgId })).toBe(1)
    expect((await OrgMove.findById(s.built._id).lean() as any).steps.filter((x: any) => x.name === 'flip')).toHaveLength(1)
  }, 60_000)

  it('an abort before the flip unfreezes the org and leaves nothing else changed', async () => {
    const s = await shop()
    const move: any = await startMove(String(s.orgId), s.nodeId, { id: String(s.ana.user._id) }, s.allow)
    await abortMove(String(move._id), 'not today', { id: String(s.ana.user._id) })
    forgetAllHomes()
    expect(await homeOf(s.orgId, { fresh: true })).toMatchObject({ home: 'global', state: 'active', epoch: 0 })
    expect((await captureRejection(abortMove(String(move._id), 'twice')))?.code).toBe('not_abortable')
    // A new move can start again.
    expect((await preflightMove(String(s.orgId), s.nodeId, s.allow)).ok).toBe(true)
  }, 60_000)
})

describe("the master's side (FR-20.79 steps 3–6)", () => {
  /**
   * Global builds a move's copy; its files are kept outside the upload tree, and then this database
   * becomes the master's: empty, with the node's id and seal key and a node token for lgrai.app.
   */
  async function onTheMaster(prepare?: (s: Shop) => Promise<void>) {
    const s = await shop()
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
    // Both feeds had moved past these people while this server did not hold them.
    await NodeState.create({ _id: 'identity-feed', value: { cursor: `${new Date().toISOString()}|${'a'.repeat(24)}`, fullAt: new Date() } } as any)
    await NodeState.create({ _id: 'credential-feed', value: { cursor: `${new Date().toISOString()}|${'a'.repeat(24)}`, sealKey: s.seal.publicKey, fullAt: new Date() } } as any)
    await prepare?.(s)

    const lgrai = { moves: [{ ...view }] as any[], answer: { ok: true, epoch: 1 } as any, calls: [] as any[], failCopied: 0 }
    const fetchImpl = (async (input: any, init: any = {}) => {
      const url = new URL(String(input))
      lgrai.calls.push({ path: url.pathname, method: init.method ?? 'GET', auth: new Headers(init.headers).get('authorization'), body: init.body ? JSON.parse(init.body) : undefined })
      if (url.pathname === '/api/node/v1/moves') return Response.json({ moves: lgrai.moves })
      const part = url.pathname.match(/^\/api\/node\/v1\/moves\/[0-9a-f]{24}\/(bundle|files|copied|failed)$/)?.[1]
      if (part === 'bundle') return new Response(Bun.file(bundle))
      if (part === 'files') return new Response(Bun.file(files))
      if (part === 'copied') {
        if (lgrai.failCopied > 0) {
          lgrai.failCopied--
          return new Response('{}', { status: 502 })
        }
        return Response.json(lgrai.answer)
      }
      if (part === 'failed') return Response.json({ ok: true })
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    const tick = () => moveWorkerTick(new Date(), fetchImpl)
    const reported = (path: string) => lgrai.calls.filter(c => c.path.endsWith(path))
    return { ...s, moveId: String(built._id), digests, lgrai, tick, reported }
  }

  it('takes the copy with its people and their credentials, and makes the org home when lgrai.app says so', async () => {
    const m = await onTheMaster()
    expect(await m.tick()).toBe(1)
    expect(m.lgrai.calls.every(c => c.auth === 'Bearer node-token')).toBe(true)
    const [report] = m.reported('/copied')
    expect(report.body).toEqual({ digests: m.digests, people: 2, credentials: 1 })
    expect(await collectionDigests(db(), m.orgId)).toEqual(m.digests)
    forgetAllHomes()
    expect(await OrgHome.findOne({ orgId: m.orgId }).lean()).toMatchObject({ home: m.nodeId, epoch: 1, state: 'frozen' })

    // The people, as who they are; a local credential that works here, and only for this org.
    const ana: any = await Identity.findById(m.ana.person._id).select('+password').lean()
    expect(ana).toMatchObject({ email: m.ana.person.email, tokenVersion: 3, isActive: true })
    expect(ana.password).toBeUndefined()
    const cred: any = await LocalCredential.findOne({ identityId: m.ana.person._id }).select('+verifier').lean()
    expect(cred).toMatchObject({ source: 'lgrai', kind: 'password', tvAtSet: 3 })
    expect(String(cred.forOrgId)).toBe(String(m.orgId))
    expect(await Bun.password.verify(LOCAL_PASSWORD, cred.verifier)).toBe(true)
    expect(readFileSync(join(orgDir(m.orgId), 'docs', 'receipt.txt'), 'utf8')).toBe('касова бележка 7')
    // The feeds run from the start: what changed while the copy travelled reaches these people.
    expect(((await NodeState.findById('identity-feed').lean()) as any).value.fullAt).toBeNull()
    expect(((await NodeState.findById('credential-feed').lean()) as any).value.fullAt).toBeNull()
    expect(existsSync(join(orgDir(m.orgId), 'backups', 'moves', `move-${m.moveId}.ndjson.zst`))).toBe(false)

    // Until lgrai.app flips, nothing more happens; then the org is home here.
    m.lgrai.moves[0].state = 'verifying'
    expect(await m.tick()).toBe(0)
    m.lgrai.moves[0].state = 'done'
    expect(await m.tick()).toBe(1)
    forgetAllHomes()
    expect(await homeOf(m.orgId, { fresh: true })).toMatchObject({ home: m.nodeId, epoch: 1, state: 'active' })
    expect(await AuditLog.findOne({ orgId: m.orgId, entityType: 'org_move', entityName: 'from lgrai.app' }).lean()).toBeTruthy()
    expect(await m.tick()).toBe(0)
    expect(m.reported('/copied')).toHaveLength(1)
  }, 60_000)

  it('a report lost on the way is sent again, without importing again', async () => {
    const m = await onTheMaster()
    const phase = async () => ((await NodeState.findById(`move:${m.moveId}`).lean()) as any).value.phase
    m.lgrai.failCopied = 1
    expect(await m.tick()).toBe(1)
    expect(await phase()).toBe('imported')
    expect(await m.tick()).toBe(1)
    expect(await phase()).toBe('reported')
    expect(m.reported('/bundle')).toHaveLength(1)
    expect(m.reported('/copied')).toHaveLength(2)
    expect(m.reported('/failed')).toHaveLength(0)
  }, 60_000)

  it('an abort removes what the master imported, and of the people only those it added', async () => {
    let otherOrg: unknown
    const m = await onTheMaster(async s => {
      // Boris is already here: a member of another org this server holds.
      otherOrg = new mongoose.Types.ObjectId()
      await db().collection('identities').insertOne({ _id: s.boris.person._id, email: s.boris.person.email, firstName: 'Boris', lastName: 'Shop', tokenVersion: 1, isActive: true, emailVerified: true })
      await db().collection('users').insertOne({ orgId: otherOrg, identityId: s.boris.person._id, username: 'boris-elsewhere', isActive: true })
    })
    expect(await m.tick()).toBe(1)
    // A person already held keeps their record; their tokenVersion only goes up.
    expect(((await Identity.findById(m.boris.person._id).lean()) as any).tokenVersion).toBe(4)

    m.lgrai.moves[0].state = 'aborted'
    expect(await m.tick()).toBe(1)
    expect(await orgHasData(db(), m.orgId)).toBeNull()
    expect(await Identity.exists({ _id: m.ana.person._id })).toBeNull()
    expect(await Identity.exists({ _id: m.boris.person._id })).toBeTruthy()
    expect(await db().collection('users').countDocuments({ orgId: otherOrg })).toBe(1)
    expect(await LocalCredential.countDocuments({ forOrgId: m.orgId })).toBe(0)
    expect(await OrgHome.exists({ orgId: m.orgId })).toBeNull()
    expect(await m.tick()).toBe(0)
  }, 60_000)

  it('refuses an org this server already holds, and a person whose email another holds here', async () => {
    const held = await onTheMaster(async s => {
      await db().collection('contacts').insertOne({ orgId: s.orgId, companyName: 'Already here' })
    })
    expect(await held.tick()).toBe(1)
    expect(held.reported('/failed')[0]?.body.reason).toContain('already holds data of the org')
    expect(held.reported('/bundle')).toHaveLength(0)
    expect(await OrgHome.exists({ orgId: held.orgId })).toBeNull()

    for (const ws of sockets.splice(0)) await handleUplinkClose(ws)
    ;(config.node as any).role = saved.role
    forgetAllHomes()
    await clearCollections()
    const clash = await onTheMaster(async s => {
      await db().collection('identities').insertOne({ email: s.ana.person.email, firstName: 'Someone', lastName: 'Else', tokenVersion: 0, isActive: true, emailVerified: true })
    })
    expect(await clash.tick()).toBe(1)
    expect(clash.reported('/failed')[0]?.body.reason).toContain('the email of another person')
    expect(await orgHasData(db(), clash.orgId)).toBeNull()
    expect(await Identity.exists({ _id: clash.boris.person._id })).toBeNull() // added, then removed again
    expect(await OrgHome.exists({ orgId: clash.orgId })).toBeNull()
  }, 60_000)
})

describe('the routes (FR-20.79)', () => {
  const signer = (new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt
  const userToken = (u: any, orgId: string) => signer.sign({
    id: String(u._id), email: u.email, username: u.username, firstName: u.firstName, lastName: u.lastName,
    role: u.role, orgId, permissions: [...(u.permissions ?? [])],
  })
  const call = (path: string, init: RequestInit = {}) => app.handle(new Request(`http://localhost${path}`, init))
  const post = (body: unknown, token?: string): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })

  it("an org admin's on lgrai.app only; a server sees only its own moves, and its copy only while it is wanted", async () => {
    const s = await shop()
    const admin = await userToken(s.ana.user, String(s.orgId))
    const memberToken = await userToken(s.boris.user, String(s.orgId))
    const base = `/api/org/${s.orgId}/moves`

    expect((await call(`${base}/preflight`, post({ nodeId: s.nodeId }, memberToken))).status).toBe(403)
    const pre = await call(`${base}/preflight`, post({ nodeId: s.nodeId, allowMissing: s.allow }, admin))
    expect(pre.status).toBe(200)
    expect((await pre.json()).ok).toBe(true)
    expect((await call(`${base}/preflight`, post({ nodeId: 'not-a-node' }, admin))).status).toBe(422)

    const started = await call(`${base}/`, post({ nodeId: s.nodeId, allowMissing: s.allow }, admin))
    expect(started.status).toBe(200)
    const { move } = await started.json()
    expect(move).toMatchObject({ state: 'freezing', to: s.nodeId })
    expect(JSON.stringify(move)).not.toContain('ndjson')
    expect((await (await call(`${base}/current`, { headers: { authorization: `Bearer ${admin}` } })).json()).move.id).toBe(move.id)

    // The server's own routes: its moves, and the copy only once it is built.
    const node = { authorization: `Bearer ${s.token}` }
    expect((await (await call('/api/node/v1/moves', { headers: node })).json()).moves).toHaveLength(1)
    expect((await call(`/api/node/v1/moves/${move.id}/bundle`, { headers: node })).status).toBe(404)
    await moveTick(new Date(Date.now() + 2 * HOME_CACHE_MS + 1_000))
    const bundle = await call(`/api/node/v1/moves/${move.id}/bundle`, { headers: node })
    expect(bundle.status).toBe(200)
    expect((await bundle.arrayBuffer()).byteLength).toBeGreaterThan(0)
    expect((await call(`/api/node/v1/moves/${move.id}/bundle`)).status).toBe(401)
    const bad = await call(`/api/node/v1/moves/${move.id}/copied`, post({ digests: {}, people: 0, credentials: 0 }))
    expect(bad.status).toBe(401)

    // The abort works while the org is frozen: the home gate lets global's own record through.
    const aborted = await call(`${base}/${move.id}/abort`, post({}, admin))
    expect(aborted.status).toBe(200)
    expect((await aborted.json()).move.state).toBe('aborted')

    ;(config.node as any).role = 'master'
    expect((await call(`${base}/preflight`, post({ nodeId: s.nodeId }, admin))).status).toBe(404)
  }, 60_000)
})
