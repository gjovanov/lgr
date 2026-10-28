import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Db, MongoClient, ObjectId } from 'mongodb'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestInvoice } from '../helpers/factories'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { Contact, Invoice, MirrorState, Org } from 'db/models'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { REPLICATION_META } from 'db/replication/meta.generated'
import { ENGINE_ID, enableOrgs, historyLost, seedOrg } from 'services/biz/replication/capture'
import { stopCapture } from 'services/biz/replication/engine'
import { BSON, buildPage, chainHash, decodePage, idKey, rejournal, type Page } from 'services/biz/replication/pages'
import { applyPage, type ApplyResult } from 'services/biz/replication/apply'
import { homePart } from 'services/biz/replication/project'
import { ReconcileRefused, mirrorIdsFor, mirrorReconcileStatus, mirrorReconcileTick, reconcileReported } from 'services/biz/replication/reconcile'

/**
 * FR-20.70 (plan step P3-7f): after a master lost the record of its changes (a new journal epoch),
 * lgrai.app's copy of the org is made equal to it again, one way, the home winning, and an issued
 * sale is never deleted from it (FR-20.51). Two databases on the test replica set, as in
 * `replication-pages.flow`: the master's (Mongoose's own connection) and global's mirror.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const NODE = 'master-reconciletest0000'
const saved = { role: config.node.role, id: (config.node as any).id, capture: config.replication.capture, tokenFile: config.outbox.tokenFile }
let client: MongoClient
let master: Db
let mirror: Db
let root: string
let n = 0

beforeAll(async () => {
  await setupTestDB()
  client = mongoose.connection.getClient() as unknown as MongoClient
  master = mongoose.connection.db as unknown as Db
  mirror = client.db(`${master.databaseName}-mirror`)
}, 60_000)

afterAll(async () => {
  await mirror.dropDatabase().catch(() => {})
  await teardownTestDB()
}, 60_000)

beforeEach(async () => {
  ;(config.node as any).role = 'master'
  ;(config.node as any).id = NODE
  ;(config.replication as any).capture = true
  root = mkdtempSync(join(tmpdir(), 'lgr-reconcile-'))
  mkdirSync(join(root, 'state'), { recursive: true })
  ;(config.outbox as any).tokenFile = join(root, 'state', 'node-token.json')
  writeFileSync(config.outbox.tokenFile, JSON.stringify({ server: 'https://lgrai.test', token: 'node-token', expiresAt: Math.floor(Date.now() / 1000) + 3600 }))
  await mirror.dropDatabase()
  for (const m of [Contact, Invoice, MirrorState, Org]) {
    for (const [keys, opts] of m.schema.indexes()) await mirror.collection(m.collection.collectionName).createIndex(keys as any, opts as any)
  }
}, 60_000)

afterEach(async () => {
  await stopCapture()
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.replication as any).capture = saved.capture
  ;(config.outbox as any).tokenFile = saved.tokenFile
  rmSync(root, { recursive: true, force: true })
  forgetAllHomes()
  await clearCollections()
}, 60_000)

const homeOnGlobal = async (orgId: unknown) => {
  const r = await mirror.collection<any>('org_homes').findOne({ orgId: new mongoose.Types.ObjectId(String(orgId)) })
  return r ? { home: r.home, epoch: r.epoch, state: r.state } : { home: 'global', epoch: 0, state: 'active' as const }
}
const ctx = { nodeId: NODE, home: homeOnGlobal }
const sideNow = () => ({ db: mirror as any, home: homeOnGlobal })

/** An org homed on this master, which global knows and holds no copy of yet. */
async function homedOrg(): Promise<ObjectId> {
  const org = await createTestOrg({ name: 'Home Co', slug: `reconcile-${++n}`, description: 'shop' } as any)
  const orgId = org._id as unknown as ObjectId
  await homeNewOrg(String(orgId))
  const copy: any = await master.collection('orgs').findOne({ _id: orgId })
  await mirror.collection<any>('orgs').insertOne({ ...copy })
  await mirror.collection<any>('org_homes').insertOne({ orgId, home: NODE, epoch: 1, state: 'active' })
  await mirror.collection<any>('nodes').updateOne({ _id: NODE }, { $set: { status: 'active', linkLevel: 'full' }, $addToSet: { orgIds: orgId } }, { upsert: true })
  return orgId
}

/** The node as global's routes see it: its registry row. */
const nodeRow = async () => mirror.collection<any>('nodes').findOne({ _id: NODE })

const where = async (orgId: ObjectId) => {
  const st: any = await mirror.collection('mirror_state').findOne({ orgId })
  return { after: st?.watermark ?? 0, afterHash: st?.chainHash ?? '' }
}

/** Send pages until the mirror has everything, resending what a collision asked for. */
async function sync(orgId: ObjectId): Promise<ApplyResult[]> {
  const out: ApplyResult[] = []
  for (let i = 0; i < 50; i++) {
    const built = await buildPage(client, master, orgId, { ...(await where(orgId)), nodeId: NODE })
    if ('empty' in built) return out
    if ('refused' in built) throw new Error(`the master would not build: ${built.refused} ${built.detail}`)
    const r = await applyPage(client, mirror, built.bytes, ctx)
    out.push(r)
    if (!r.ok) return out
    for (const rs of r.resend) await rejournal(client, master, orgId, rs.coll, rs.ids)
  }
  throw new Error('the mirror never caught up')
}

function forge(p: Page, f: (p: Page) => void): Page {
  f(p)
  p.chainHash = chainHash(p, p.rows)
  return p
}

/** The master loses the record of its changes, as the tailer finds it: a new epoch, every document journaled again. */
async function loseHistory(orgId: ObjectId): Promise<number> {
  await master.collection<any>('repl_engine').updateOne({ _id: ENGINE_ID }, { $set: { holder: 'test' }, $setOnInsert: { journalEpoch: 1 } }, { upsert: true })
  const epoch = await historyLost(master as any, 'test', 'the test lost it')
  await seedOrg(master as any, orgId, 'upsert')
  return epoch
}

/** lgrai.app, for the master's tick: its two reconcile routes, as the controller answers them (EJSON). */
function globalFetch(calls: string[] = []): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = new URL(String(input))
    calls.push(url.pathname + url.search)
    const node = await nodeRow()
    try {
      if (url.pathname === '/api/node/v1/reconcile/ids') {
        const q = url.searchParams
        const after = q.has('after') ? BSON.EJSON.parse(q.get('after')!, { relaxed: false }) : undefined
        const page = await mirrorIdsFor(node, q.get('orgId') ?? '', { ...(q.has('coll') ? { coll: q.get('coll')! } : {}), ...(after !== undefined ? { after } : {}) }, { ...sideNow(), limit: 3 })
        return new Response(BSON.EJSON.stringify(page as any, { relaxed: false }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.pathname === '/api/node/v1/reconcile/done') {
        const body = JSON.parse(String(init?.body))
        return Response.json(await reconcileReported(node, body.orgId, body, sideNow()))
      }
    } catch (e) {
      if (e instanceof ReconcileRefused) return Response.json({ code: e.code }, { status: e.status })
      throw e
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
}

/** Every replicated document of the org, by collection, as its home's parts. */
async function digest(db: Db, orgId: ObjectId, skip: (coll: string, id: string) => boolean = () => false) {
  const out: Record<string, Record<string, string>> = {}
  for (const e of Object.values(REPLICATION_META)) {
    if ((e.class !== 'R' && e.class !== 'S') || !e.orgPath) continue
    const docs = await db.collection<any>(e.collection).find(e.orgPath === '_id' ? { _id: orgId } : { orgId }, { promoteValues: false }).toArray()
    const kept = docs.filter(d => !skip(e.collection, idKey(d._id)))
    if (!kept.length) continue
    out[e.collection] = Object.fromEntries(kept.map(d => [idKey(d._id), createHash('sha256').update(BSON.serialize(homePart(d, e))).digest('hex')]))
  }
  return out
}

const refusedAs = (r: ApplyResult) => (r.ok ? 'applied' : r.refused)

describe('the reconcile after lost history (FR-20.70)', () => {
  it('the copy is made equal to its home: what the gap deleted goes, what it changed comes, an issued sale stays', async () => {
    const orgId = await homedOrg()
    const gone = await createTestContact(orgId as any, { companyName: 'Deleted in the gap' })
    const changed = await createTestContact(orgId as any, { companyName: 'Before the gap' })
    const kept = await createTestContact(orgId as any, { companyName: 'Untouched' })
    const sale = await createTestInvoice(orgId as any, kept._id as any, { status: 'sent', invoiceNumber: 'INV-2026-00007' } as any)
    const draft = await createTestInvoice(orgId as any, kept._id as any, { status: 'draft', invoiceNumber: 'DRF-INV-2026-00001' } as any)
    await enableOrgs(master as any, [orgId])
    expect(((await master.collection('repl_orgs').findOne({ orgId })) as any).reconciledEpoch).toBe(1)
    await sync(orgId)
    expect(await mirror.collection('contacts').countDocuments({ orgId })).toBe(3)

    // The gap: writes the capture never saw (its stream was down past the oplog's reach).
    await master.collection('contacts').deleteOne({ _id: gone._id })
    await master.collection('contacts').updateOne({ _id: changed._id }, { $set: { companyName: 'Changed in the gap' } })
    const added = await master.collection<any>('contacts').insertOne({ orgId, type: 'customer', companyName: 'Added in the gap', isActive: true })
    await master.collection('invoices').deleteOne({ _id: draft._id })
    // ⚠ And an issued sale the home no longer has: nothing on the home deletes one, so it lost it.
    await master.collection('invoices').deleteOne({ _id: sale._id })

    expect(await loseHistory(orgId)).toBe(2)
    // The first page of the new epoch continues the chain: applied, and the reconcile starts.
    const first = await sync(orgId)
    expect(first.length).toBeGreaterThan(0)
    expect(first.every(r => r.ok)).toBe(true)
    let st: any = await mirror.collection('mirror_state').findOne({ orgId })
    expect(st.journalEpoch).toBe(2)
    expect(st.reconcile).toMatchObject({ journalEpoch: 2, since: expect.any(Date) })
    expect(st.reconcile.doneAt).toBeUndefined()
    // What the master has came again; what it deleted in the gap is in no row, so the copy still has it.
    expect(((await mirror.collection('contacts').findOne({ _id: changed._id })) as any).companyName).toBe('Changed in the gap')
    expect(await mirror.collection('contacts').countDocuments({ _id: added.insertedId })).toBe(1)
    expect(await mirror.collection('contacts').countDocuments({ _id: gone._id })).toBe(1)
    expect((await mirrorReconcileStatus(String(orgId), sideNow()))?.doneAt).toBeNull()

    // The master's tick asks for every id the copy holds (3 a page here) and journals each again.
    const calls: string[] = []
    const journaled = await mirrorReconcileTick(globalFetch(calls))
    expect(journaled).toBeGreaterThan(5)
    expect(calls.filter(c => c.startsWith('/api/node/v1/reconcile/ids')).length).toBeGreaterThan(2)
    expect(calls.at(-1)).toBe('/api/node/v1/reconcile/done')
    const repl: any = await master.collection('repl_orgs').findOne({ orgId })
    expect(repl.reconciledEpoch).toBe(2)
    expect(repl.reconcile).toBeUndefined()
    st = await mirror.collection('mirror_state').findOne({ orgId })
    expect(st.reconcile.head).toBe(repl.seq)
    expect(st.reconcile.doneAt).toBeUndefined()

    // Its pages bring each as it is here, or as gone.
    await sync(orgId)
    expect(await mirror.collection('contacts').countDocuments({ _id: gone._id })).toBe(0)
    expect(await mirror.collection('invoices').countDocuments({ _id: draft._id })).toBe(0)
    expect(await mirror.collection('invoices').countDocuments({ _id: sale._id })).toBe(1)
    st = await mirror.collection('mirror_state').findOne({ orgId })
    expect(st.reconcile.doneAt).toEqual(expect.any(Date))
    expect(st.reconcile.deleted).toBe(2)
    expect(st.reconcile.kept).toEqual([expect.objectContaining({ coll: 'invoices', id: String(sale._id), number: 'INV-2026-00007' })])
    expect(st.alarms.filter((a: any) => a.kind === 'sale_kept')).toHaveLength(1)
    const status = await mirrorReconcileStatus(String(orgId), sideNow())
    expect(status).toMatchObject({ deleted: 2, kept: [{ number: 'INV-2026-00007' }], doneAt: expect.any(Date) })
    // The copy is the home's, but for the sale it keeps.
    expect(await digest(mirror, orgId, (coll, id) => coll === 'invoices' && id === idKey(sale._id))).toEqual(await digest(master, orgId))

    // Done once: the next tick asks nothing.
    const again: string[] = []
    expect(await mirrorReconcileTick(globalFetch(again))).toBe(0)
    expect(again).toEqual([])
  }, 120_000)

  it('the epoch is raised only by a page that continues the chain; an older one stays refused', async () => {
    const orgId = await homedOrg()
    const c = await createTestContact(orgId as any)
    await enableOrgs(master as any, [orgId])
    await sync(orgId)
    await rejournal(client, master, orgId, 'contacts', [c._id])
    // One page, as the master built it, taken three ways: global applies the forged one, whose hash
    // this master never built, so it could not build another from there.
    const built = await buildPage(client, master, orgId, { ...(await where(orgId)), nodeId: NODE })
    if (!('page' in built)) throw new Error(`no page: ${JSON.stringify(built)}`)
    const copy = () => decodePage(built.bytes)
    // Another history at a new epoch: still another history.
    expect(refusedAs(await applyPage(client, mirror, forge(copy(), p => { p.journalEpoch = 2; p.prevHash = 'f'.repeat(64) }), ctx))).toBe('diverged')
    let st: any = await mirror.collection('mirror_state').findOne({ orgId })
    expect(st.journalEpoch).toBe(1)
    expect(st.reconcile).toBeUndefined()
    // The same history at a new epoch: applied, and the reconcile starts.
    expect(refusedAs(await applyPage(client, mirror, forge(copy(), p => { p.journalEpoch = 2 }), ctx))).toBe('applied')
    st = await mirror.collection('mirror_state').findOne({ orgId })
    expect(st).toMatchObject({ journalEpoch: 2, reconcile: { journalEpoch: 2 } })
    expect(st.reconcileRequired).toBeUndefined()
    // A page of the epoch before is the past.
    expect(refusedAs(await applyPage(client, mirror, forge(copy(), p => { p.journalEpoch = 1 }), ctx))).toBe('stale_journal')
  }, 60_000)

  it('the master\'s word may come before the first page of the epoch; the copy is done when its watermark gets there', async () => {
    const orgId = await homedOrg()
    const gone = await createTestContact(orgId as any, { companyName: 'Gone' })
    await createTestContact(orgId as any, { companyName: 'Stays' })
    await enableOrgs(master as any, [orgId])
    await sync(orgId)
    await master.collection('contacts').deleteOne({ _id: gone._id })
    await loseHistory(orgId)
    // The tick runs first: no page of the epoch has been applied yet.
    await mirrorReconcileTick(globalFetch())
    let st: any = await mirror.collection('mirror_state').findOne({ orgId })
    expect(st.journalEpoch).toBe(1)
    expect(st.reconcile).toMatchObject({ journalEpoch: 2, head: expect.any(Number) })
    expect(st.reconcile.doneAt).toBeUndefined()
    // The pages go on with that record, and finish it.
    await sync(orgId)
    st = await mirror.collection('mirror_state').findOne({ orgId })
    expect(st.journalEpoch).toBe(2)
    expect(st.reconcile).toMatchObject({ journalEpoch: 2, deleted: 1, doneAt: expect.any(Date) })
    expect(await mirror.collection('contacts').countDocuments({ _id: gone._id })).toBe(0)
  }, 60_000)

  it('no page deletes an issued sale, a draft goes as before', async () => {
    const orgId = await homedOrg()
    const c = await createTestContact(orgId as any)
    const sale = await createTestInvoice(orgId as any, c._id as any, { status: 'paid', invoiceNumber: 'INV-2026-00011' } as any)
    const draft = await createTestInvoice(orgId as any, c._id as any, { status: 'draft', invoiceNumber: 'DRF-INV-2026-00002' } as any)
    const till = await master.collection<any>('postransactions').insertOne({ orgId, sessionId: new mongoose.Types.ObjectId(), transactionNumber: 'POS-2026-000003', type: 'sale', status: 'completed', total: 1, subtotal: 1, lines: [], payments: [], isFiscal: false })
    await enableOrgs(master as any, [orgId])
    await sync(orgId)
    for (const [coll, id] of [['invoices', sale._id], ['invoices', draft._id], ['postransactions', till.insertedId]] as const) {
      await master.collection(coll).deleteOne({ _id: id as any })
      await rejournal(client, master, orgId, coll, [id])
    }
    const r = await sync(orgId)
    expect(r.every(x => x.ok)).toBe(true)
    expect(await mirror.collection('invoices').countDocuments({ _id: sale._id })).toBe(1)
    expect(await mirror.collection('postransactions').countDocuments({ _id: till.insertedId })).toBe(1)
    expect(await mirror.collection('invoices').countDocuments({ _id: draft._id })).toBe(0)
    const st: any = await mirror.collection('mirror_state').findOne({ orgId })
    expect(st.alarms.filter((a: any) => a.kind === 'sale_kept')).toHaveLength(2)
    expect(st.alarms.map((a: any) => a.detail).join(' ')).toContain('INV-2026-00011')
    expect(st.reconcile).toBeUndefined()
  }, 60_000)

  it('lgrai.app gives the ids of its copy to the org\'s home only, page by page, and says when it holds none', async () => {
    const orgId = await homedOrg()
    for (let i = 0; i < 5; i++) await createTestContact(orgId as any, { companyName: `C${i}` })
    let node: any = await nodeRow()
    // No copy yet: nothing to reconcile.
    expect(await mirrorIdsFor(node, String(orgId), {}, sideNow())).toMatchObject({ none: true, ids: [] })
    await enableOrgs(master as any, [orgId])
    await sync(orgId)
    // Every id, once, in pages of 2: the org's own document is never asked.
    const seen = new Map<string, number>()
    let from: { coll?: string; after?: unknown } = {}
    for (let i = 0; i < 100; i++) {
      const page = await mirrorIdsFor(node, String(orgId), from, { ...sideNow(), limit: 2 })
      expect(page.ids.length).toBeLessThanOrEqual(2)
      for (const id of page.ids) seen.set(`${page.coll}|${idKey(id)}`, (seen.get(`${page.coll}|${idKey(id)}`) ?? 0) + 1)
      if (!page.next) break
      from = page.next
    }
    const contacts = await mirror.collection('contacts').find({ orgId }, { projection: { _id: 1 } }).toArray()
    expect(contacts).toHaveLength(5)
    for (const c of contacts) expect(seen.get(`contacts|${idKey(c._id)}`)).toBe(1)
    expect([...seen.keys()].some(k => k.startsWith('orgs|'))).toBe(false)
    expect([...seen.values()].every(v => v === 1)).toBe(true)

    // Only the org's home, registered for it at Full, with no clone alarm.
    const refused = async (n: any, id = String(orgId)) => {
      try {
        await mirrorIdsFor(n, id, {}, sideNow())
        return 'answered'
      } catch (e) {
        return e instanceof ReconcileRefused ? `${e.status} ${e.code}` : String(e)
      }
    }
    expect(await refused(node, String(new mongoose.Types.ObjectId()))).toBe('404 not_found')
    expect(await refused({ ...node, linkLevel: 'control' })).toBe('409 not_full')
    expect(await refused({ ...node, cloneAlarm: { at: new Date() } })).toBe('409 clone_alarm')
    await mirror.collection('org_homes').updateOne({ orgId }, { $set: { home: 'global' } })
    expect(await refused(node)).toBe('409 not_home')
    node = { ...node, orgIds: [] }
    expect(await refused(node)).toBe('404 not_found')
    // A collection that does not replicate is no place to start.
    await mirror.collection('org_homes').updateOne({ orgId }, { $set: { home: NODE } })
    let bad = ''
    try {
      await mirrorIdsFor(await nodeRow(), String(orgId), { coll: 'repl_journal' }, sideNow())
    } catch (e) {
      bad = e instanceof ReconcileRefused ? e.code : String(e)
    }
    expect(bad).toBe('bad_request')
  }, 60_000)

  it('a first seeding needs no reconcile, and a master that never lost its history asks nothing', async () => {
    const orgId = await homedOrg()
    await createTestContact(orgId as any)
    await enableOrgs(master as any, [orgId])
    await sync(orgId)
    const calls: string[] = []
    expect(await mirrorReconcileTick(globalFetch(calls))).toBe(0)
    // Lost history, then a second org arriving at the new epoch: only the first is reconciled.
    await loseHistory(orgId)
    const later = await homedOrg()
    await createTestContact(later as any)
    await enableOrgs(master as any, [later])
    expect(((await master.collection('repl_orgs').findOne({ orgId: later })) as any).reconciledEpoch).toBe(2)
    await mirrorReconcileTick(globalFetch(calls))
    const asked = calls.filter(c => c.startsWith('/api/node/v1/reconcile/ids'))
    expect(asked.length).toBeGreaterThan(0)
    expect(((await master.collection('repl_orgs').findOne({ orgId })) as any).reconciledEpoch).toBe(2)
    // At Control the capture is off, and so is the reconcile.
    ;(config.replication as any).capture = false
    await master.collection('repl_orgs').updateOne({ orgId }, { $set: { reconciledEpoch: 1 } })
    const none: string[] = []
    expect(await mirrorReconcileTick(globalFetch(none))).toBe(0)
    expect(none).toEqual([])
  }, 60_000)

  it('a tick cut short goes on from where it stood', async () => {
    const orgId = await homedOrg()
    for (let i = 0; i < 4; i++) await createTestContact(orgId as any, { companyName: `C${i}` })
    await enableOrgs(master as any, [orgId])
    await sync(orgId)
    await loseHistory(orgId)
    // lgrai.app answers two pages, then goes away.
    let answered = 0
    const flaky = (async (input: any, init?: any) => {
      if (++answered > 2) return new Response('{}', { status: 502 })
      return globalFetch()(input, init)
    }) as unknown as typeof fetch
    expect(await mirrorReconcileTick(flaky)).toBeGreaterThan(0)
    const cut: any = await master.collection('repl_orgs').findOne({ orgId })
    expect(cut.reconcile).toMatchObject({ journalEpoch: 2, asked: expect.any(Number) })
    expect(cut.reconciledEpoch).toBe(1)
    const calls: string[] = []
    await mirrorReconcileTick(globalFetch(calls))
    const done: any = await master.collection('repl_orgs').findOne({ orgId })
    expect(done.reconciledEpoch).toBe(2)
    expect(done.reconcile).toBeUndefined()
    // It went on from where it stood, not from the beginning.
    expect(calls[0]).toStartWith('/api/node/v1/reconcile/ids?')
    expect(new URL(calls[0], 'https://lgrai.test').searchParams.has('coll')).toBe(true)
    expect(calls.at(-1)).toBe('/api/node/v1/reconcile/done')
  }, 60_000)
})
