import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestContact, createTestOrg, createTestProduct, createTestStockLevel, createTestUser, createTestWarehouse } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { makeNodeStub, nodeEnrollBody } from '../helpers/node-stub'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import { AuditLog, Invoice, MirrorBlob, NodeState, OrgHome, OrgMove, Sequence, ServerNode, StockMovement } from 'db/models'
import { forgetAllHomes, homeOf } from 'db/home/home'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { SILENCE_MS, legalSeriesOf, preflightPromote, promote, recordLastNumbers } from 'services/biz/move/promote.service'
import { moveBackTick } from 'services/biz/move/move-back.service'
import { moveWorkerTick } from 'services/biz/move/move-worker.service'
import { movesForNode } from 'services/biz/move/move.service'
import { generateUNP, getNextNumber } from 'services/biz/sequence.service'
import { issuableRefusal } from 'services/biz/invoice-numbering.service'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { blobPath } from 'services/biz/replication/mirror-blobs'
import { homeStatus } from 'services/biz/home/home-status.service'
import { handleUplinkClose, handleUplinkMessage, handleUplinkOpen } from '../../../portal-api/src/websocket/uplink'

/**
 * Promoting lgrai.app's mirror when an org's master is lost for good (FR-20.81, plan step P3-6d).
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'
const saved = { role: config.node.role, id: (config.node as any).id, tokenFile: config.outbox.tokenFile, upload: config.upload.dir }
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
  root = mkdtempSync(join(tmpdir(), 'lgr-pr-'))
  ;(config.upload as any).dir = root
})
afterEach(async () => {
  for (const ws of sockets.splice(0)) await handleUplinkClose(ws)
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
const DAY = 24 * 3600_000

/** An org homed on a master that went silent `silentFor` ago, its mirror and a file held by content. */
async function lost(opts: { silentFor?: number; connected?: boolean } = {}) {
  ;(config.node as any).role = 'global'
  const org = await createTestOrg({ slug: `promote-${++n}` } as any)
  const admin = await createTestUser(org._id, { role: 'admin' } as any)
  const stub = makeNodeStub()
  const { code } = await mintNodeEnrollmentCode(String(org._id), String(admin._id))
  await enrollNode({ ...nodeEnrollBody(stub, ENROLL, { linkLevel: 'full' }), code } as any, [ENROLL])
  const lastSeen = new Date(Date.now() - (opts.silentFor ?? 2 * DAY))
  await ServerNode.updateOne({ _id: stub.nodeId }, { $set: { lastSeenAt: lastSeen } })
  if (opts.connected) {
    const token = (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN }), [TOKEN])).token
    for (const ch of ['interactive', 'bulk'] as const) {
      const ws = { raw: { id: Math.random() }, send: () => {}, close: () => {} }
      handleUplinkOpen(ws, ch)
      await handleUplinkMessage(ws, JSON.stringify({ t: 'hello', v: 1, ch, token, bootNonce: 'boot-promote', versions: { app: '0.1.0', protocol: 1 } }))
      sockets.push(ws)
    }
  }
  await OrgHome.collection.insertOne({ orgId: org._id, home: stub.nodeId, epoch: 1, state: 'active', since: new Date() } as any)
  await db().collection('orgs').updateOne({ _id: org._id }, { $set: { homeEpochHighWater: 1 } })
  await db().collection('mirror_state').insertOne({ orgId: org._id, nodeId: stub.nodeId, watermark: 41, chainHash: 'c'.repeat(64), lastPageAt: new Date(lastSeen.getTime() - 60_000), refused: 0, alarms: [] })
  // The mirror's counters, as the master's pages left them.
  await Sequence.collection.insertMany([
    { orgId: org._id, prefix: 'SALES_DOC', year: new Date().getFullYear(), lastNumber: 120 },
    { orgId: org._id, prefix: 'UNP-ED123456', year: 0, lastNumber: 900 },
    { orgId: org._id, prefix: 'DRAFT_INV', year: new Date().getFullYear(), lastNumber: 7 },
  ] as any)
  // A document the master made, its file held here by content.
  const content = randomBytes(800)
  const rel = `${String(org._id)}/docs/2026-10-27/lost.pdf`
  await db().collection('docfiles').insertOne({ orgId: org._id, docType: 'invoice', docNumber: `pr-${n}`, docDate: '2026-10-27', originalName: 'lost.pdf', currentPath: rel, currentChecksum: sha(content), version: 1, mimeType: 'application/pdf', size: content.length, status: 'uploaded', uploadedAt: new Date() })
  mkdirSync(dirname(blobPath(String(org._id), sha(content))), { recursive: true })
  writeFileSync(blobPath(String(org._id), sha(content)), content)
  await MirrorBlob.create({ orgId: org._id, sha256: sha(content), size: content.length, state: 'ok', offset: content.length, source: 'master' })
  forgetAllHomes()
  return { orgId: String(org._id), oid: org._id as any, slug: (org as any).slug, admin, nodeId: stub.nodeId, content, rel }
}

describe('promoting the mirror (FR-20.81)', () => {
  it('needs the server gone: disconnected, silent 24 h unless destroyed, the tills disconnected, the slug typed', async () => {
    const live = await lost({ connected: true })
    expect((await preflightPromote(live.orgId)).checks.find(c => c.name === 'disconnected')?.ok).toBe(false)

    const recent = await lost({ silentFor: 3 * 3600_000 })
    const pre = await preflightPromote(recent.orgId)
    expect(pre).toMatchObject({ ok: true, silentLongEnough: false, nodeId: recent.nodeId })
    expect(pre.lossFrom).toBeTruthy()
    const by = { id: String(recent.admin._id) }
    expect((await captureRejection(promote(recent.orgId, by, { hardware: 'off', tillsDisconnected: true, slug: recent.slug })))?.code).toBe('not_silent_long_enough')
    expect((await captureRejection(promote(recent.orgId, by, { hardware: 'destroyed', tillsDisconnected: true, slug: 'not-it' })))?.code).toBe('slug_mismatch')
    expect((await captureRejection(promote(recent.orgId, by, { hardware: 'destroyed', tillsDisconnected: false, slug: recent.slug })))?.code).toBe('tills_connected')
    // Destroyed: the silence need not be long.
    const move: any = await promote(recent.orgId, by, { hardware: 'destroyed', tillsDisconnected: true, slug: recent.slug })
    expect(move).toMatchObject({ kind: 'promote', state: 'verifying', from: recent.nodeId, epochFrom: 1, epochTo: 2, fenceCutoff: 41, evidence: { hardware: 'destroyed', tillsDisconnected: true } })
    expect(SILENCE_MS).toBe(DAY)
  }, 60_000)

  it('flips with the legal series frozen until the site\'s last numbers are recorded, then resumes above them', async () => {
    const s = await lost()
    const by = { id: String(s.admin._id) }
    const move: any = await promote(s.orgId, by, { hardware: 'off', tillsDisconnected: true, slug: s.slug })
    expect(await moveBackTick()).toBe(1)
    forgetAllHomes()
    expect(await homeOf(s.oid, { fresh: true })).toMatchObject({ home: 'global', epoch: 2, state: 'active' })
    expect(await OrgMove.findById(move._id).lean()).toMatchObject({ state: 'done' })
    // The file held by content is where its row says, and the content store is gone.
    expect(Buffer.compare(readFileSync(join(root, ...s.rel.split('/'))), s.content)).toBe(0)
    expect(existsSync(join(root, s.orgId, 'blobs'))).toBe(false)
    expect(await db().collection('mirror_state').countDocuments({ orgId: s.oid })).toBe(0)
    // The org's trail is here now, and it starts with who promoted it, on what evidence.
    const promoted: any = await AuditLog.findOne({ orgId: s.oid, entityType: 'org_move' }).lean()
    expect(promoted).toMatchObject({ userId: s.admin._id, entityName: "promotion of lgrai.app's copy" })
    expect(promoted.changes).toContainEqual(expect.objectContaining({ field: 'home', oldValue: s.nodeId, newValue: 'global' }))

    // Legal numbering waits; a draft does not.
    expect((await captureRejection(getNextNumber(s.orgId, 'SALES_DOC')))?.code).toBe('series_frozen')
    expect((await captureRejection(getNextNumber(s.orgId, 'CASH_SALE')))?.code).toBe('series_frozen')
    expect((await captureRejection(generateUNP(s.orgId, 'ED123456', '0001')))?.code).toBe('series_frozen')
    expect(await getNextNumber(s.orgId, 'DRAFT_INV')).toMatch(/^DRAFT_INV-\d{4}-00008$/)
    expect(await homeStatus(s.orgId)).toMatchObject({ home: 'here', seriesFrozen: { since: expect.any(String) } })

    // Every series must be given, so none opens by omission.
    const series = await legalSeriesOf(s.orgId)
    const year = new Date().getFullYear()
    expect(series).toEqual([
      { prefix: 'CASH_SALE', year, last: 0 },
      { prefix: 'SALES_DOC', year, last: 120 },
      { prefix: 'UNP-ED123456', year: 0, last: 900 },
    ])
    expect((await captureRejection(recordLastNumbers(s.orgId, by, [{ prefix: 'SALES_DOC', year, last: 131 }])))?.code).toBe('series_missing')
    expect((await captureRejection(recordLastNumbers(s.orgId, by, [{ prefix: 'DRAFT_INV', year, last: 1 }, { prefix: 'SALES_DOC', year, last: 131 }, { prefix: 'CASH_SALE', year, last: 0 }, { prefix: 'UNP-ED123456', year: 0, last: 905 }])))?.code).toBe('bad_series')
    // The site issued past the mirror (131 > 120, 905 > 900); a lower reading never lowers a counter.
    await recordLastNumbers(s.orgId, by, [{ prefix: 'SALES_DOC', year, last: 131 }, { prefix: 'CASH_SALE', year, last: 0 }, { prefix: 'UNP-ED123456', year: 0, last: 905 }])
    expect(await getNextNumber(s.orgId, 'SALES_DOC')).toBe(`SALES_DOC-${year}-00132`)
    expect(await generateUNP(s.orgId, 'ED123456', '0001')).toBe('ED123456-0001-0000906')
    expect((await homeStatus(s.orgId)).seriesFrozen).toBeUndefined()
    // Who opened the numbering again, and from what.
    const audit: any = await AuditLog.findOne({ orgId: s.oid, entityType: 'sequence' }).lean()
    expect(audit.changes).toContainEqual(expect.objectContaining({ field: `SALES_DOC ${year}`, oldValue: 120, newValue: 131 }))
    expect((await OrgMove.findById(move._id).lean() as any).steps.map((x: any) => x.name)).toContain('last_numbers')
    expect((await captureRejection(recordLastNumbers(s.orgId, by, [])))?.code).toBe('not_frozen')
  }, 60_000)

  it('the old master, back on the network, fences itself at the cutoff and writes nothing more', async () => {
    const s = await lost()
    const move: any = await promote(s.orgId, { id: String(s.admin._id) }, { hardware: 'off', tillsDisconnected: true, slug: s.slug })
    await moveBackTick()
    // However long the server stayed away, its moves still name the promotion.
    await OrgMove.updateOne({ _id: move._id }, { $set: { endedAt: new Date(Date.now() - 90 * DAY) } })
    expect((await movesForNode(s.nodeId)).find(x => x.id === String(move._id))).toMatchObject({ kind: 'promote', state: 'done', epochTo: 2, fenceCutoff: 41 })
    const done: any = await OrgMove.findById(move._id).lean()
    // This database as the old master's: it still thinks it is home, at epoch 1.
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = s.nodeId
    await OrgHome.updateOne({ orgId: s.oid }, { $set: { home: s.nodeId, epoch: 1, state: 'active' }, $unset: { seriesFrozen: '' } })
    forgetAllHomes()
    const tokenFile = join(root, 'node-token.json')
    writeFileSync(tokenFile, JSON.stringify({ server: 'https://lgrai.test', token: 'node-token', expiresAt: Math.floor(Date.now() / 1000) + 3600 }))
    ;(config.outbox as any).tokenFile = tokenFile
    const view = { id: String(done._id), orgId: s.orgId, kind: 'promote', state: 'done', epochFrom: 1, epochTo: 2, startedBy: String(s.admin._id), fenceCutoff: done.fenceCutoff }
    const fetchImpl = (async (input: any) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/node/v1/moves') return Response.json({ moves: [view] })
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    expect(await moveWorkerTick(new Date(), fetchImpl)).toBe(1)
    forgetAllHomes()
    expect(await OrgHome.findOne({ orgId: s.oid }).lean()).toMatchObject({ home: 'global', epoch: 2, state: 'fenced', fenceCutoff: 41 })
    expect(await homeOf(s.oid, { fresh: true })).toMatchObject({ home: 'global', state: 'fenced' })
    expect(((await NodeState.findById(`move:${view.id}`).lean()) as any).value.phase).toBe('fenced')
    // Never resumes on its own: the next round changes nothing.
    expect(await moveWorkerTick(new Date(), fetchImpl)).toBe(0)
    // Its banner says replaced, not moving.
    expect(await homeStatus(s.orgId)).toMatchObject({ home: 'global', state: 'fenced', moving: false })
  }, 60_000)

  it('refuses a legal issue before it moves anything; drafts, proformas and bills go on', async () => {
    const org = await createTestOrg({ slug: `promote-${++n}` } as any)
    const orgId = String(org._id)
    const user = await createTestUser(org._id, { role: 'admin' } as any)
    const customer = await createTestContact(org._id, { companyName: 'Купувач ООД', type: 'customer' } as any)
    const warehouse = await createTestWarehouse(org._id)
    const bolt = await createTestProduct(org._id, { name: 'Болт М8', sellingPrice: 10, taxRate: 20 } as any)
    await createTestStockLevel(org._id, bolt._id, warehouse._id, { quantity: 100 })
    // Promoted: written here, the legal series waiting for the site's last numbers.
    await OrgHome.collection.insertOne({ orgId: org._id, home: 'global', epoch: 2, state: 'active', since: new Date(), seriesFrozen: { since: new Date(), reason: 'promoted' } } as any)
    forgetAllHomes()

    const app = new Elysia().onError(spaErrorHandler({}) as any).use(invoiceController)
    const token = await (new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt.sign({
      id: String(user._id), orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
      firstName: 'Мария', lastName: 'Иванова', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
    })
    const call = async (path: string, body: any) => {
      const res = await app.handle(new Request(`http://localhost/org/${orgId}/invoices${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
      }))
      return { status: res.status, json: await res.json().catch(() => null) as any }
    }
    const line = { productId: String(bolt._id), warehouseId: String(warehouse._id), description: 'Болт М8', quantity: 1, unitPrice: 10, taxRate: 20 }
    const doc = { direction: 'outgoing', contactId: String(customer._id), issueDate: '2026-10-27', currency: 'EUR', lines: [line], subtotal: 10, taxTotal: 2, total: 12 }

    // A draft takes a draft number; issuing it is refused before its claim and its dispatch.
    const draft = await call('', { ...doc, type: 'invoice', paymentMethod: 'bank_transfer' })
    expect(draft.status).toBe(200)
    expect(await call(`/${draft.json.invoice.id}/send`, {})).toMatchObject({ status: 409, json: { code: 'series_frozen' } })
    const after: any = await Invoice.findById(draft.json.invoice.id).lean()
    expect(after.status).toBe('draft')
    expect(after.issue).toBeUndefined()
    expect(await StockMovement.countDocuments({ orgId: org._id, invoiceId: after._id })).toBe(0)
    // A cash sale is refused before its document exists.
    expect(await call('', { ...doc, type: 'cash_sale', paymentMethod: 'cash' })).toMatchObject({ status: 409, json: { code: 'series_frozen' } })
    expect(await Invoice.countDocuments({ orgId: org._id, type: 'cash_sale' })).toBe(0)
    // A proforma is no legal number: it issues.
    const proforma = await call('', { ...doc, type: 'proforma' })
    expect((await call(`/${proforma.json.invoice.id}/send`, {})).status).toBe(200)

    // Only the legal series wait.
    expect((await issuableRefusal(orgId, 'outgoing', 'credit_note'))?.code).toBe('series_frozen')
    expect((await issuableRefusal(orgId, 'outgoing', 'debit_note'))?.code).toBe('series_frozen')
    expect((await issuableRefusal(orgId, 'outgoing', 'cash_storno'))?.code).toBe('series_frozen')
    expect(await issuableRefusal(orgId, 'incoming', 'invoice')).toBeNull()
    expect(await issuableRefusal(orgId, 'incoming', 'credit_note')).toBeNull()
  }, 60_000)
})
