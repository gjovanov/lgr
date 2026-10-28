import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestUser } from '../helpers/factories'
import { makeNodeStub, nodeEnrollBody } from '../helpers/node-stub'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { OrgHome, ReplJournal, ServerNode } from 'db/models'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { enableOrgs } from 'services/biz/replication/capture'
import { captureOn, forgetLink } from 'services/biz/replication/engine'
import { pageFor, readPageAsk, readResendAsk, replicationStatus, resendFor } from 'services/biz/replication/control'
import { BSON, buildPage, decodePage, rejournal } from 'services/biz/replication/pages'
import { startControlSocket } from '../../../portal-api/src/front/control-socket'
import { handleUplinkClose, handleUplinkMessage, handleUplinkOpen } from '../../../portal-api/src/websocket/uplink'

/**
 * The mirror's transport (FR-20.64, FR-20.67, plan step P3-2b): the API builds a page over its
 * control socket, the supervisor sends it on the bulk socket, and global applies it and says where
 * the mirror stands. The supervisor's half is Rust (`packages/server/src/replication.rs`); here are
 * the two ends it connects.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const SECRET = 'replication-transport-secret'
const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'
const saved = {
  role: config.node.role,
  id: (config.node as any).id,
  capture: config.replication.capture,
  registrationFile: config.replication.registrationFile,
}
let n = 0

beforeAll(async () => {
  await setupTestDB()
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

afterEach(async () => {
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.replication as any).capture = saved.capture
  ;(config.replication as any).registrationFile = saved.registrationFile
  forgetLink()
  forgetAllHomes()
  await clearCollections()
}, 60_000)

describe('the capture follows the link (FR-20.54)', () => {
  it('on at Full, off at Control or unregistered, and LGR_REPLICATION overrides either way', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lgr-link-'))
    try {
      const file = join(dir, 'registration.json')
      ;(config.node as any).role = 'master'
      ;(config.replication as any).capture = undefined
      ;(config.replication as any).registrationFile = file
      const now = (write?: string) => {
        if (write !== undefined) writeFileSync(file, write)
        forgetLink()
        return captureOn()
      }
      expect(now()).toBe(false) // unregistered
      expect(now(JSON.stringify({ nodeId: 'master-x', linkLevel: 'full' }))).toBe(true)
      expect(now(JSON.stringify({ nodeId: 'master-x', linkLevel: 'control' }))).toBe(false)
      expect(now('{"linkLev')).toBe(false) // half written: not Full until it reads
      ;(config.replication as any).capture = true
      expect(now()).toBe(true)
      ;(config.replication as any).capture = false
      expect(now(JSON.stringify({ linkLevel: 'full' }))).toBe(false)
      ;(config.node as any).role = 'global'
      ;(config.replication as any).capture = true
      expect(now()).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("the master's control socket (P3-2b)", () => {
  let dir = ''
  let socket = ''
  let ctl: { close: () => void } | null = null

  beforeEach(() => {
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = 'master-transporttest0000'
    ;(config.replication as any).capture = true
    // Short: an AF_UNIX path is limited to 108 bytes, on Windows as everywhere.
    dir = mkdtempSync(join(tmpdir(), 'lgr-rc-'))
    socket = join(dir, 'api.sock')
    ctl = startControlSocket(socket, SECRET, {
      status: () => ({ ok: true }),
      stop: () => {},
      replication: { status: replicationStatus, page: body => pageFor(readPageAsk(body)), resend: text => resendFor(readResendAsk(text)) },
    })
  })

  afterEach(() => {
    ctl?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** As the supervisor asks. */
  const call = (path: string, body?: string, secret: string | null = SECRET) =>
    fetch(`http://lgr-api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      unix: socket,
      headers: { ...(secret ? { 'x-lgr-front': secret } : {}), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    } as any)
  const ask = (orgId: unknown, after = 0, afterHash = '') => call('/replication/page', JSON.stringify({ orgId: String(orgId), after, afterHash }))

  async function homed() {
    const org = await createTestOrg({ slug: `transport-${++n}` } as any)
    await homeNewOrg(String(org._id))
    const contact = await createTestContact(org._id as any, { companyName: 'Paged Ltd' })
    await enableOrgs(mongoose.connection.db as any, [org._id])
    return { orgId: org._id, contact }
  }

  it('a page is its bytes and where it ends; from there, nothing; from a hash it never built, a refusal', async () => {
    const { orgId } = await homed()
    const r = await ask(orgId)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/x-lgr-page')
    const page = decodePage(new Uint8Array(await r.arrayBuffer()))
    expect(page.rows.map(x => x.coll).sort()).toEqual(['contacts', 'orgs'])
    expect(String(page.toSeq)).toBe(r.headers.get('x-lgr-page-to')!)
    expect(page.chainHash).toBe(r.headers.get('x-lgr-page-hash')!)
    expect(r.headers.get('x-lgr-page-rows')).toBe('2')

    expect((await ask(orgId, page.toSeq, page.chainHash)).status).toBe(204)
    const unknown = await ask(orgId, page.toSeq, 'a'.repeat(64))
    expect(unknown.status).toBe(409)
    expect(await unknown.json()).toMatchObject({ refused: 'chain_unknown' })
  }, 60_000)

  it('a paced supervisor asks for pieces: a page of at most maxBytes, the rest in the next (P3-2c)', async () => {
    const { orgId } = await homed()
    // Two documents (the org and a contact): a byte bound below their sum takes one a page.
    const one = await call('/replication/page', JSON.stringify({ orgId: String(orgId), after: 0, afterHash: '', maxBytes: 64 }))
    expect(one.status).toBe(200)
    const first = decodePage(new Uint8Array(await one.arrayBuffer()))
    expect(first.rows).toHaveLength(1)
    const two = decodePage(new Uint8Array(await (await call('/replication/page', JSON.stringify({ orgId: String(orgId), after: first.toSeq, afterHash: first.chainHash, maxBytes: 64 }))).arrayBuffer()))
    expect(two.rows).toHaveLength(1)
    expect([...first.rows, ...two.rows].map(x => x.coll).sort()).toEqual(['contacts', 'orgs'])
    for (const bad of [0, -1, 1.5, 5 * 1024 * 1024]) {
      expect((await call('/replication/page', JSON.stringify({ orgId: String(orgId), after: 0, afterHash: '', maxBytes: bad }))).status).toBe(400)
    }
  }, 60_000)

  it('a malformed ask is a 400, no secret a 403, and a master not linked at Full sends no page', async () => {
    const { orgId } = await homed()
    expect((await call('/replication/page', JSON.stringify({ orgId: 'nope', after: 0, afterHash: '' }))).status).toBe(400)
    expect((await call('/replication/page', JSON.stringify({ orgId: String(orgId), after: 5, afterHash: '' }))).status).toBe(400)
    expect((await call('/replication/page', JSON.stringify({ orgId: String(orgId), after: 0, afterHash: '' }), null)).status).toBe(403)
    expect((await call('/replication/resend', JSON.stringify({ orgId: String(orgId), coll: 'emaillogs', ids: [1] }))).status).toBe(400)
    ;(config.replication as any).capture = false
    const off = await ask(orgId)
    expect(off.status).toBe(409)
    expect(await off.json()).toMatchObject({ refused: 'not_full' })
  }, 60_000)

  it("global's resend journals a document again, its id keeping its type, and the next page carries it", async () => {
    const { orgId, contact } = await homed()
    const first = decodePage(new Uint8Array(await (await ask(orgId)).arrayBuffer()))
    const before: any = await ReplJournal.findOne({ orgId, coll: 'contacts', docId: contact._id }).lean()
    // As global sends it in a page-ack, passed through by the supervisor untouched.
    const resend = { orgId: String(orgId), coll: 'contacts', ids: BSON.EJSON.serialize([contact._id], { relaxed: false }) }
    const r = await call('/replication/resend', JSON.stringify(resend))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ journaled: 1 })
    const after: any = await ReplJournal.findOne({ orgId, coll: 'contacts', docId: contact._id }).lean()
    expect(after.seq).toBeGreaterThan(before.seq)
    const next = decodePage(new Uint8Array(await (await ask(orgId, first.toSeq, first.chainHash)).arrayBuffer()))
    expect(next.rows.map(x => [x.coll, String(x.id)])).toEqual([['contacts', String(contact._id)]])
  }, 60_000)

  it('the status names each captured org and whether its journal is whole', async () => {
    const { orgId } = await homed()
    const r = await call('/replication')
    expect(r.status).toBe(200)
    const st: any = await r.json()
    expect(st).toMatchObject({ capture: true, journalEpoch: 1 })
    expect(st.orgs).toEqual([expect.objectContaining({ orgId: String(orgId), ready: true })])
  }, 60_000)
})

describe("global's bulk socket (P3-2b)", () => {
  // Global is this process's own database; the master's is a second one on the same replica set.
  let master: any
  beforeAll(() => {
    master = mongoose.connection.getClient().db(`${mongoose.connection.db!.databaseName}-master`)
  })
  beforeEach(async () => {
    ;(config.node as any).role = 'global'
    await master.dropDatabase()
  })
  afterAll(async () => {
    await master.dropDatabase().catch(() => {})
  })

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

  /** A master registered for an org at `linkLevel`, home of it, with its own database journaled. */
  async function linkedMaster(linkLevel: 'full' | 'control' = 'full') {
    const stub = makeNodeStub()
    const org = await createTestOrg({ slug: `bulk-${++n}` } as any)
    const admin = await createTestUser(org._id, { role: 'admin' } as any)
    const { code } = await mintNodeEnrollmentCode(String(org._id), String(admin._id))
    await enrollNode({ ...nodeEnrollBody(stub, ENROLL, { linkLevel }), code } as any, [ENROLL])
    const token = (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN }), [TOKEN])).token
    // The org is homed on the master now: global's copy is the mirror.
    await OrgHome.collection.insertOne({ orgId: org._id, home: stub.nodeId, epoch: 1, state: 'active', since: new Date() } as any)
    forgetAllHomes()
    await master.collection('orgs').insertOne(await mongoose.connection.db!.collection('orgs').findOne({ _id: org._id }))
    const contactId = new mongoose.Types.ObjectId()
    await master.collection('contacts').insertOne({ _id: contactId, orgId: org._id, companyName: 'Mirrored Ltd', type: 'customer' })
    await master.collection('org_homes').insertOne({ orgId: org._id, home: stub.nodeId, epoch: 1, state: 'active' })
    await enableOrgs(master, [org._id])
    return { stub, orgId: org._id, token, contactId }
  }

  async function socket(token: string, ch: 'bulk' | 'interactive' = 'bulk') {
    const ws = fakeWs()
    handleUplinkOpen(ws, ch)
    await handleUplinkMessage(ws, JSON.stringify({ t: 'hello', v: 1, ch, token, bootNonce: 'boot-transport', versions: { app: '0.1.0', protocol: 1 } }))
    return ws
  }

  const pageOf = async (m: { stub: { nodeId: string }; orgId: unknown }, after = 0, afterHash = '') => {
    const built = await buildPage(mongoose.connection.getClient() as any, master, m.orgId, { after, afterHash, nodeId: m.stub.nodeId })
    if (!('bytes' in built)) throw new Error(`no page: ${JSON.stringify(built)}`)
    return built
  }

  it('the bulk welcome says where the mirror stands; a page is applied and acknowledged, and the next socket told', async () => {
    const m = await linkedMaster()
    const ws = await socket(m.token)
    const welcome = ws.last('welcome')
    expect(welcome.orgs[0]).toMatchObject({ orgId: String(m.orgId), home: m.stub.nodeId, linkLevel: 'full' })
    expect(welcome.orgs[0].mirror).toEqual({ watermark: 0, chainHash: '', journalEpoch: null, instanceEpoch: null })

    const built = await pageOf(m)
    await handleUplinkMessage(ws, built.bytes)
    expect(ws.last('page-ack')).toMatchObject({ orgId: String(m.orgId), fromSeq: 0, toSeq: built.page.toSeq, watermark: built.page.toSeq, chainHash: built.page.chainHash, applied: 2, resend: [] })
    expect(await mongoose.connection.db!.collection('contacts').findOne({ _id: m.contactId })).toMatchObject({ companyName: 'Mirrored Ltd' })

    // Sent again (the ack was lost): acknowledged, nothing written.
    await handleUplinkMessage(ws, built.bytes)
    expect(ws.last('page-ack')).toMatchObject({ duplicate: true, watermark: built.page.toSeq })

    await handleUplinkClose(ws)
    const again = await socket(m.token)
    expect(again.last('welcome').orgs[0].mirror).toMatchObject({ watermark: built.page.toSeq, chainHash: built.page.chainHash, journalEpoch: 1 })
    await handleUplinkClose(again)
  }, 60_000)

  it('a page is refused before hello, on the interactive socket, at Control, and under a clone alarm', async () => {
    const m = await linkedMaster()
    const built = await pageOf(m)

    const anon = fakeWs()
    handleUplinkOpen(anon, 'bulk')
    await handleUplinkMessage(anon, built.bytes)
    expect(anon.closed[0]?.reason).toBe('unauthenticated')

    const interactive = await socket(m.token, 'interactive')
    await handleUplinkMessage(interactive, built.bytes)
    expect(interactive.last('error')).toMatchObject({ code: 'bad_channel' })
    await handleUplinkClose(interactive)

    const control = await linkedMaster('control')
    const cws = await socket(control.token)
    await handleUplinkMessage(cws, (await pageOf(control)).bytes)
    expect(cws.last('page-refused')).toMatchObject({ orgId: String(control.orgId), reason: 'not_full' })
    await handleUplinkClose(cws)

    await ServerNode.updateOne({ _id: m.stub.nodeId }, { $set: { cloneAlarm: { at: new Date(), channel: 'bulk', bootNonces: ['a', 'b'] } } })
    const cloned = await socket(m.token)
    await handleUplinkMessage(cloned, built.bytes)
    expect(cloned.last('page-refused')).toMatchObject({ reason: 'clone_alarm' })
    await handleUplinkClose(cloned)

    // Nothing reached the mirror.
    expect(await mongoose.connection.db!.collection('contacts').countDocuments({ _id: m.contactId })).toBe(0)
  }, 60_000)

  it('a frame that is not a page is said so, and a page from behind the mirror is told where it is', async () => {
    const m = await linkedMaster()
    const ws = await socket(m.token)
    const first = await pageOf(m)
    await handleUplinkMessage(ws, first.bytes)
    // zstd magic, then garbage.
    await handleUplinkMessage(ws, new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3, 4]))
    expect(ws.last('page-refused')).toMatchObject({ reason: 'malformed' })

    await master.collection('contacts').updateOne({ _id: m.contactId }, { $set: { companyName: 'Renamed Ltd' } })
    await rejournal(mongoose.connection.getClient() as any, master, m.orgId, 'contacts', [m.contactId])
    const behind = await pageOf(m) // from 0 again: behind the mirror
    await handleUplinkMessage(ws, behind.bytes)
    expect(ws.last('page-refused')).toMatchObject({ reason: 'behind', watermark: first.page.toSeq, chainHash: first.page.chainHash })
    // From where global says: applied.
    await handleUplinkMessage(ws, (await pageOf(m, first.page.toSeq, first.page.chainHash)).bytes)
    expect(ws.last('page-ack')).toMatchObject({ applied: 1 })
    expect(await mongoose.connection.db!.collection('contacts').findOne({ _id: m.contactId })).toMatchObject({ companyName: 'Renamed Ltd' })
    await handleUplinkClose(ws)
  }, 60_000)
})
