import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { createHash } from 'node:crypto'
import type { Db, MongoClient, ObjectId } from 'mongodb'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestUser, createTestAccount, createTestFiscalDevice, createTestWarehouse } from '../helpers/factories'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { Account, Contact, DocFile, FiscalDevice, MirrorState, Org, ReplJournal, User } from 'db/models'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { REPLICATION_META } from 'db/replication/meta.generated'
import { enableOrgs } from 'services/biz/replication/capture'
import { captureTick, stopCapture } from 'services/biz/replication/engine'
import { BSON, buildPage, chainHash, decodeDoc, decodePage, idKey, rejournal, type Page } from 'services/biz/replication/pages'
import { applyPage, type ApplyResult } from 'services/biz/replication/apply'
import { homePart } from 'services/biz/replication/project'
import { pageFor } from 'services/biz/replication/control'

/**
 * FR-20.64–20.66 (plan step P3-2a, AC 30–33): a master's journal leaves as pages, and global's mirror
 * applies them in one transaction each, or refuses them. Two databases on the test replica set: the
 * master's (Mongoose's own connection, where the journal is) and global's mirror.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const NODE = 'master-pagestest00000000'
const saved = { role: config.node.role, id: (config.node as any).id, capture: config.replication.capture }
let client: MongoClient
let master: Db
let mirror: Db
let n = 0
/** What only global holds of a person (a hash, in life): no page carries it and no apply changes it. */
const HELD = 'held'
/** A standalone master's own copy, FR-20.63's example of what never crosses. */
const LOCAL = 'local'

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
  await mirror.dropDatabase()
  // Global's mirror has the models' indexes: collisions are what some of these tests are about.
  for (const m of [Account, Contact, DocFile, FiscalDevice, MirrorState, Org, User]) {
    for (const [keys, opts] of m.schema.indexes()) await mirror.collection(m.collection.collectionName).createIndex(keys as any, opts as any)
  }
}, 60_000)

afterEach(async () => {
  await stopCapture()
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.replication as any).capture = saved.capture
  forgetAllHomes()
  await clearCollections()
}, 60_000)

/** Global's record of the org's home, as `homeOf` would read it there. */
const homeOnGlobal = async (orgId: ObjectId) => {
  const r = await mirror.collection<any>('org_homes').findOne({ orgId })
  return r ? { home: r.home, epoch: r.epoch, state: r.state } : { home: 'global', epoch: 0, state: 'active' as const }
}
const ctx = { nodeId: NODE, home: homeOnGlobal }

/** An org homed on this master, which global already knows: its own slug, plan and integrations. */
async function homedOrg(): Promise<ObjectId> {
  const org = await createTestOrg({ name: 'Home Co', slug: `pages-${++n}`, description: 'shop' } as any)
  const orgId = org._id as unknown as ObjectId
  await homeNewOrg(String(orgId))
  const copy: any = await master.collection('orgs').findOne({ _id: orgId })
  await mirror.collection<any>('orgs').insertOne({
    ...copy,
    slug: `global-${n}`,
    subscription: { plan: 'enterprise', maxUsers: 100, stripeSubscriptionId: 'sub_global' },
    settings: { ...copy.settings, integrations: { googleDrive: { email: 'drive@global.test' } } },
  })
  await mirror.collection<any>('org_homes').insertOne({ orgId, home: NODE, epoch: 1, state: 'active' })
  // …and the master is registered for it (P2-1).
  await mirror.collection<any>('nodes').updateOne({ _id: NODE }, { $set: { status: 'active', linkLevel: 'full' }, $addToSet: { orgIds: orgId } }, { upsert: true })
  return orgId
}

/** Journal what the org has, the way the capture's seeding does. */
const journal = async (orgId: ObjectId) => {
  await enableOrgs(master, [orgId])
}

const where = async (orgId: ObjectId) => {
  const st: any = await mirror.collection('mirror_state').findOne({ orgId })
  return { after: st?.watermark ?? 0, afterHash: st?.chainHash ?? '' }
}

/** Send pages until the mirror has everything, resending what a collision asked for. */
async function sync(orgId: ObjectId, maxDocs?: number): Promise<ApplyResult[]> {
  const out: ApplyResult[] = []
  for (let i = 0; i < 50; i++) {
    const built = await buildPage(client, master, orgId, { ...(await where(orgId)), nodeId: NODE, maxDocs })
    if ('empty' in built) return out
    if ('refused' in built) throw new Error(`the master would not build: ${built.refused}`)
    const r = await applyPage(client, mirror, built.bytes, ctx)
    out.push(r)
    if (!r.ok) return out
    for (const rs of r.resend) await rejournal(client, master, orgId, rs.coll, rs.ids)
  }
  throw new Error('the mirror never caught up')
}

/** The next page, decoded, for tests that tamper with it. */
async function nextPage(orgId: ObjectId): Promise<Page> {
  const built = await buildPage(client, master, orgId, { ...(await where(orgId)), nodeId: NODE })
  if (!('page' in built)) throw new Error(`no page: ${JSON.stringify(built)}`)
  return decodePage(built.bytes)
}

/** A page changed by `f`, its hash made right again: what a compromised master could send. */
function forge(p: Page, f: (p: Page) => void): Page {
  f(p)
  p.chainHash = chainHash(p, p.rows)
  return p
}

const docRow = (seq: number, coll: string, doc: Record<string, unknown>) => ({ seq, coll, id: doc._id, op: 'u' as const, doc: new BSON.Binary(BSON.serialize(doc)) })

/** Every replicated document of the org, by collection, as its home's parts. */
async function digest(db: Db, orgId: ObjectId) {
  const out: Record<string, Record<string, string>> = {}
  for (const e of Object.values(REPLICATION_META)) {
    if ((e.class !== 'R' && e.class !== 'S') || !e.orgPath) continue
    const docs = await db.collection<any>(e.collection).find(e.orgPath === '_id' ? { _id: orgId } : { orgId }, { promoteValues: false }).toArray()
    if (!docs.length) continue
    out[e.collection] = Object.fromEntries(docs.map(d => [idKey(d._id), createHash('sha256').update(BSON.serialize(homePart(d, e))).digest('hex')]))
  }
  return out
}

const refusedAs = (r: ApplyResult) => (r.ok ? 'applied' : r.refused)

describe('pages and the mirror apply (FR-20.64, FR-20.65)', () => {
  it('a page mirrors the org: documents equal, and each side keeps its own fields', async () => {
    const orgId = await homedOrg()
    for (let i = 0; i < 3; i++) await createTestContact(orgId as any, { companyName: `Client ${i}` })
    // An integral Double: read into JavaScript and written again, it would come out an Int32.
    const raw = await master.collection<any>('accounts').insertOne({ orgId, code: '501', name: 'Raw', type: 'asset', balance: new BSON.Double(10) })
    const wh = await createTestWarehouse(orgId as any)
    const device = await createTestFiscalDevice(orgId as any, wh._id, { status: 'online' } as any)
    // Global already has this membership, with the person's own email and password (FR-20.63).
    const user = await createTestUser(orgId as any, { password: LOCAL } as any)
    const userCopy: any = await master.collection('users').findOne({ _id: user._id })
    await mirror.collection<any>('users').insertOne({ ...userCopy, email: 'person@global.test', password: HELD })
    // …and the device, as offline: its status is true only where it was written.
    await mirror.collection<any>('fiscaldevices').insertOne({ ...(await master.collection('fiscaldevices').findOne({ _id: device._id })), status: 'offline' })

    await journal(orgId)
    const built = await buildPage(client, master, orgId, { after: 0, afterHash: '', nodeId: NODE })
    if (!('page' in built)) throw new Error('no page')
    // Node-only and global fields never cross the wire.
    const sent = decodePage(built.bytes).rows.filter(r => r.doc).map(r => ({ coll: r.coll, doc: decodeDoc(r.doc!) }))
    expect(sent.find(r => r.coll === 'users')!.doc.password).toBeUndefined()
    expect(sent.find(r => r.coll === 'users')!.doc.email).toBeUndefined()
    expect(sent.find(r => r.coll === 'fiscaldevices')!.doc.status).toBeUndefined()
    expect(sent.find(r => r.coll === 'orgs')!.doc.slug).toBeUndefined()

    const r = await applyPage(client, mirror, built.bytes, ctx)
    expect(r).toMatchObject({ ok: true, watermark: built.page.toSeq, chainHash: built.page.chainHash })
    expect(await digest(mirror, orgId)).toEqual(await digest(master, orgId))

    const org: any = await mirror.collection('orgs').findOne({ _id: orgId })
    expect(org).toMatchObject({ name: 'Home Co', slug: `global-${n}`, subscription: { plan: 'enterprise', stripeSubscriptionId: 'sub_global' } })
    expect(org.settings.integrations.googleDrive.email).toBe('drive@global.test')
    expect(org.settings.baseCurrency).toBe('EUR')
    const kept: any = await mirror.collection('users').findOne({ _id: user._id })
    expect(kept).toMatchObject({ email: 'person@global.test', username: user.username })
    expect(kept.password).toBe(HELD)
    expect(await mirror.collection('fiscaldevices').findOne({ _id: device._id })).toMatchObject({ status: 'offline', name: device.name })
    // The numbers kept their BSON types through the page.
    expect(((await mirror.collection('accounts').findOne({ _id: raw.insertedId }, { promoteValues: false })) as any).balance._bsontype).toBe('Double')
  }, 60_000)

  it('a Stripe webhook on global survives every later page, and a field the home removed is removed (AC 33)', async () => {
    const orgId = await homedOrg()
    await journal(orgId)
    await sync(orgId)
    // Global's own writes, between two pages.
    await mirror.collection('orgs').updateOne({ _id: orgId }, { $set: { 'subscription.plan': 'past_due_plan', 'settings.integrations.googleDrive.email': 'renewed@global.test' } })
    // The home's: a new name and locale, and its description removed.
    await Org.updateOne({ _id: orgId }, { $set: { name: 'Home Co 2', 'settings.locale': 'bg' }, $unset: { description: '' } })
    await rejournal(client, master, orgId, 'orgs', [orgId])
    const [r] = await sync(orgId)
    expect(r.ok).toBe(true)
    const org: any = await mirror.collection('orgs').findOne({ _id: orgId })
    expect(org).toMatchObject({ name: 'Home Co 2', subscription: { plan: 'past_due_plan' } })
    expect(org.settings.locale).toBe('bg')
    expect(org.settings.integrations.googleDrive.email).toBe('renewed@global.test')
    expect(org.description).toBeUndefined()
    expect(org.slug).toBe(`global-${n}`)
  }, 60_000)

  it('a tombstone deletes, and the last page sent again is acknowledged without writing', async () => {
    const orgId = await homedOrg()
    const gone = await createTestContact(orgId as any, { companyName: 'Gone Ltd' })
    await journal(orgId)
    await sync(orgId)
    expect(await mirror.collection('contacts').countDocuments({ _id: gone._id })).toBe(1)

    await Contact.deleteOne({ _id: gone._id })
    await rejournal(client, master, orgId, 'contacts', [gone._id])
    const built = await buildPage(client, master, orgId, { ...(await where(orgId)), nodeId: NODE })
    if (!('page' in built)) throw new Error('no page')
    expect(built.page.rows).toHaveLength(1)
    expect(built.page.rows[0].op).toBe('d')
    expect(await applyPage(client, mirror, built.bytes, ctx)).toMatchObject({ ok: true, deleted: 1 })
    expect(await mirror.collection('contacts').countDocuments({ _id: gone._id })).toBe(0)

    const before: any = await mirror.collection('mirror_state').findOne({ orgId })
    expect(await applyPage(client, mirror, built.bytes, ctx)).toMatchObject({ ok: true, duplicate: true, watermark: built.page.toSeq })
    const after: any = await mirror.collection('mirror_state').findOne({ orgId })
    expect(after.updatedAt).toEqual(before.updatedAt)
  }, 60_000)

  it('pages capped by size chain one to the next, and the master continues only from a page it built', async () => {
    const orgId = await homedOrg()
    for (let i = 0; i < 7; i++) await createTestContact(orgId as any, { companyName: `Many ${i}` })
    // Not journaled yet: nothing to page.
    expect(await buildPage(client, master, orgId, { after: 0, afterHash: '', nodeId: NODE })).toMatchObject({ refused: 'not_ready' })
    await journal(orgId)
    const results = await sync(orgId, 3)
    expect(results.length).toBeGreaterThanOrEqual(3)
    expect(results.every(r => r.ok)).toBe(true)
    expect(await digest(mirror, orgId)).toEqual(await digest(master, orgId))
    // Nothing more to send.
    expect(await buildPage(client, master, orgId, { ...(await where(orgId)), nodeId: NODE })).toEqual({ empty: true })
    // A watermark with a hash this master never made: a restored, reverted or cloned master (FR-20.51).
    const { after } = await where(orgId)
    expect(await buildPage(client, master, orgId, { after, afterHash: 'e'.repeat(64), nodeId: NODE })).toMatchObject({ refused: 'chain_unknown' })
    // And no page for an org whose home is another node.
    await mongoose.connection.db!.collection('org_homes').updateOne({ orgId }, { $set: { home: 'master-elsewhere000000000' } })
    expect(await buildPage(client, master, orgId, { after: 0, afterHash: '', nodeId: NODE })).toMatchObject({ refused: 'not_home' })
  }, 60_000)
})

describe('the chain (FR-20.64, FR-20.71)', () => {
  it('a page that continues another history is refused with an alarm; behind and ahead are told where the mirror is', async () => {
    const orgId = await homedOrg()
    const c = await createTestContact(orgId as any)
    await journal(orgId)
    await sync(orgId)
    const at = await where(orgId)

    await Contact.updateOne({ _id: c._id }, { $set: { companyName: 'Changed Ltd' } })
    await rejournal(client, master, orgId, 'contacts', [c._id])
    const diverged = await applyPage(client, mirror, forge(await nextPage(orgId), p => { p.prevHash = 'f'.repeat(64) }), ctx)
    expect(diverged).toMatchObject({ ok: false, refused: 'diverged', watermark: at.after, chainHash: at.afterHash })

    // A tampered document, the hash left as it was.
    const tampered = await nextPage(orgId)
    tampered.rows[0].doc = new BSON.Binary(BSON.serialize({ ...decodeDoc(tampered.rows[0].doc!), companyName: 'Tampered' }))
    expect(refusedAs(await applyPage(client, mirror, tampered, ctx))).toBe('forged')

    // From the start again: behind the mirror.
    const behind = await buildPage(client, master, orgId, { after: 0, afterHash: '', nodeId: NODE })
    if (!('bytes' in behind)) throw new Error('no page')
    expect(await applyPage(client, mirror, behind.bytes, ctx)).toMatchObject({ ok: false, refused: 'behind', watermark: at.after })
    // Ahead of it: pages are missing.
    const gap = forge(await nextPage(orgId), p => {
      p.fromSeq += 100
      p.rows = p.rows.map((r, i) => ({ ...r, seq: p.fromSeq + i + 1 }))
      p.toSeq = p.rows[p.rows.length - 1].seq
    })
    expect(refusedAs(await applyPage(client, mirror, gap, ctx))).toBe('gap')

    // None of it moved the mirror, and the real page still applies.
    expect(await where(orgId)).toEqual(at)
    expect((await sync(orgId))[0]).toMatchObject({ ok: true, applied: 1 })
    expect((await mirror.collection<any>('contacts').findOne({ _id: c._id }))!.companyName).toBe('Changed Ltd')
    const st: any = await mirror.collection('mirror_state').findOne({ orgId })
    expect(st.alarms.map((a: any) => a.kind)).toEqual(['diverged', 'forged'])
  }, 60_000)

  it('the page global stands on is kept through any number of rebuilds; a mirror past every page built here means the database went back', async () => {
    const orgId = await homedOrg()
    await createTestContact(orgId as any)
    await journal(orgId)
    await sync(orgId)
    const at = await where(orgId)
    // Global cannot apply for a while (it errs, it is down): the pump builds again and again from there.
    const waiting = []
    for (let i = 0; i < 40; i++) waiting.push((await createTestContact(orgId as any, { companyName: `Waiting ${i}` }))._id)
    await rejournal(client, master, orgId, 'contacts', waiting)
    for (let k = 1; k <= 40; k++) expect('page' in (await buildPage(client, master, orgId, { ...at, nodeId: NODE, maxDocs: k }))).toBe(true)
    const pagesOf = async () => ((await master.collection('repl_orgs').findOne({ orgId })) as any).pages as Array<{ toSeq: number; hash: string }>
    const kept = await pagesOf()
    expect(kept.length).toBeLessThanOrEqual(33)
    expect(kept.some(p => p.toSeq === at.after && p.hash === at.afterHash)).toBe(true)
    // The same rows make the same page: built again, it is recorded once.
    await buildPage(client, master, orgId, { ...at, nodeId: NODE, maxDocs: 40 })
    expect((await pagesOf()).length).toBe(kept.length)
    // Global takes a page at last: the chain goes on from where it stood.
    expect((await sync(orgId)).every(r => r.ok)).toBe(true)
    expect(await digest(mirror, orgId)).toEqual(await digest(master, orgId))

    // A mirror past every page this database ever built: it went back underneath it (FR-20.51).
    const top = Math.max(...(await pagesOf()).map(p => p.toSeq))
    expect(await buildPage(client, master, orgId, { after: top + 50, afterHash: 'e'.repeat(64), nodeId: NODE })).toMatchObject({ refused: 'chain_unknown', wentBack: true })
    // Below it, a chain it does not know concludes nothing here: global may be the one restored.
    const below: any = await buildPage(client, master, orgId, { after: at.after, afterHash: 'e'.repeat(64), nodeId: NODE })
    expect(below.refused).toBe('chain_unknown')
    expect(below.wentBack).toBeUndefined()
  }, 90_000)

  it('asked to continue past every page it built, the master records that its database went back and locks legal numbering, once', async () => {
    const orgId = await homedOrg()
    await createTestContact(orgId as any)
    await journal(orgId)
    await sync(orgId)
    ;(config.replication as any).capture = true
    const ask = { orgId: String(orgId), after: (await where(orgId)).after + 500, afterHash: 'e'.repeat(64) }
    expect(await pageFor(ask)).toMatchObject({ status: 409, refused: 'chain_unknown' })
    const first: any = ((await master.collection('repl_orgs').findOne({ orgId })) as any).wentBack
    expect(first).toMatchObject({ reason: 'mirror_ahead', at: expect.any(Date), detail: expect.stringContaining('went back') })
    expect(((await master.collection('org_homes').findOne({ orgId })) as any).seriesFrozen).toMatchObject({ reason: 'went_back' })
    // A person records the numbers; the pump asks again on its next session, and nothing locks again.
    await master.collection('org_homes').updateOne({ orgId }, { $unset: { seriesFrozen: '' }, $set: { seriesUnlockedAt: new Date() } })
    expect(await pageFor(ask)).toMatchObject({ status: 409, refused: 'chain_unknown' })
    expect(((await master.collection('org_homes').findOne({ orgId })) as any).seriesFrozen).toBeUndefined()
    expect(((await master.collection('repl_orgs').findOne({ orgId })) as any).wentBack.at).toEqual(first.at)
  }, 60_000)

  it('a newer journal epoch that continues the chain starts a reconcile, and another instance of the master is refused', async () => {
    const orgId = await homedOrg()
    const c = await createTestContact(orgId as any)
    await journal(orgId)
    await sync(orgId)
    await rejournal(client, master, orgId, 'contacts', [c._id])

    expect(refusedAs(await applyPage(client, mirror, forge(await nextPage(orgId), p => { p.instanceEpoch = '0'.repeat(32) }), ctx))).toBe('instance_changed')
    expect(((await mirror.collection('mirror_state').findOne({ orgId })) as any).alarms.map((a: any) => a.kind)).toEqual(['instance_changed'])

    // P3-7f (FR-20.70): the same history at a new journal epoch is applied, and the reconcile starts
    // (`mirror-reconcile.flow` follows it to the end).
    expect(refusedAs(await applyPage(client, mirror, forge(await nextPage(orgId), p => { p.journalEpoch = 2 }), ctx))).toBe('applied')
    const st: any = await mirror.collection('mirror_state').findOne({ orgId })
    expect(st).toMatchObject({ journalEpoch: 2, reconcile: { journalEpoch: 2, deleted: 0 } })
    expect(st.reconcileRequired).toBeUndefined()
  }, 60_000)
})

describe('isolation (FR-20.66)', () => {
  it('another org\'s row, a sender that is not home, a collection that does not replicate, a file outside the org, an org tombstone', async () => {
    const orgId = await homedOrg()
    const other = new mongoose.Types.ObjectId() as unknown as ObjectId
    const c = await createTestContact(orgId as any)
    await journal(orgId)
    await sync(orgId)
    await rejournal(client, master, orgId, 'contacts', [c._id])
    const contacts = await mirror.collection('contacts').countDocuments({})

    const refusal = async (p: Page, context = ctx) => refusedAs(await applyPage(client, mirror, p, context))
    expect(await refusal(forge(await nextPage(orgId), p => {
      p.rows = [docRow(p.fromSeq + 1, 'contacts', { _id: new mongoose.Types.ObjectId(), orgId: other, companyName: 'Not Mine', type: 'customer' })]
      p.toSeq = p.fromSeq + 1
    }))).toBe('foreign')
    expect(await refusal(await nextPage(orgId), { ...ctx, nodeId: 'master-impostor000000000' })).toBe('not_home')
    await mirror.collection('org_homes').updateOne({ orgId }, { $set: { epoch: 2 } })
    expect(await refusal(await nextPage(orgId))).toBe('not_home')
    await mirror.collection('org_homes').updateOne({ orgId }, { $set: { epoch: 1 } })
    expect(await refusal(forge(await nextPage(orgId), p => {
      p.rows = [docRow(p.fromSeq + 1, 'emaillogs', { _id: new mongoose.Types.ObjectId(), orgId, to: 'x@example.com' })]
      p.toSeq = p.fromSeq + 1
    }))).toBe('foreign')
    expect(await refusal(forge(await nextPage(orgId), p => {
      p.rows = [docRow(p.fromSeq + 1, 'docfiles', { _id: new mongoose.Types.ObjectId(), orgId, docType: 'invoice', docNumber: '1', currentPath: `${String(other)}/docs/stolen.pdf` })]
      p.toSeq = p.fromSeq + 1
    }))).toBe('foreign')
    expect(await refusal(forge(await nextPage(orgId), p => {
      p.rows = [docRow(p.fromSeq + 1, 'docfiles', { _id: new mongoose.Types.ObjectId(), orgId, docType: 'invoice', docNumber: '1', currentPath: '/etc/passwd' })]
      p.toSeq = p.fromSeq + 1
    }))).toBe('foreign')
    expect(await refusal(forge(await nextPage(orgId), p => {
      p.rows = [{ seq: p.fromSeq + 1, coll: 'orgs', id: orgId, op: 'd' }]
      p.toSeq = p.fromSeq + 1
    }))).toBe('foreign')

    expect(await mirror.collection('contacts').countDocuments({})).toBe(contacts)
    expect(await mirror.collection('orgs').countDocuments({ _id: orgId })).toBe(1)
    const st: any = await mirror.collection('mirror_state').findOne({ orgId })
    expect(st.alarms.map((a: any) => a.kind)).toEqual(['foreign', 'not_home', 'not_home', 'foreign', 'foreign', 'foreign', 'foreign'])
  }, 60_000)

  it('a master revoked for the org, under a clone alarm, or linked at Control writes nothing, whatever the home record says', async () => {
    const orgId = await homedOrg()
    const c = await createTestContact(orgId as any)
    await journal(orgId)
    await sync(orgId)
    await Contact.updateOne({ _id: c._id }, { $set: { companyName: 'After Revocation' } })
    await rejournal(client, master, orgId, 'contacts', [c._id])

    await mirror.collection<any>('nodes').updateOne({ _id: NODE }, { $pull: { orgIds: orgId } })
    expect(refusedAs(await applyPage(client, mirror, await nextPage(orgId), ctx))).toBe('not_registered')
    await mirror.collection<any>('nodes').updateOne({ _id: NODE }, { $addToSet: { orgIds: orgId }, $set: { cloneAlarm: { at: new Date(), channel: 'bulk', bootNonces: ['a', 'b'] } } })
    expect(refusedAs(await applyPage(client, mirror, await nextPage(orgId), ctx))).toBe('clone_alarm')
    // FR-20.54: at Control no business data leaves the building, so the mirror takes none.
    await mirror.collection<any>('nodes').updateOne({ _id: NODE }, { $set: { linkLevel: 'control' }, $unset: { cloneAlarm: '' } })
    expect(refusedAs(await applyPage(client, mirror, await nextPage(orgId), ctx))).toBe('not_full')
    await mirror.collection<any>('nodes').updateOne({ _id: NODE }, { $set: { status: 'revoked', linkLevel: 'full' } })
    expect(refusedAs(await applyPage(client, mirror, await nextPage(orgId), ctx))).toBe('not_registered')

    expect((await mirror.collection<any>('contacts').findOne({ _id: c._id }))!.companyName).not.toBe('After Revocation')
    const st: any = await mirror.collection('mirror_state').findOne({ orgId })
    expect(st.alarms.map((a: any) => a.kind)).toEqual(['not_registered', 'clone_alarm', 'not_registered'])
  }, 60_000)

  it('a document id another org holds is refused, never deleted', async () => {
    const orgId = await homedOrg()
    await journal(orgId)
    await sync(orgId)
    const theirs = new mongoose.Types.ObjectId()
    const other = new mongoose.Types.ObjectId()
    await mirror.collection<any>('contacts').insertOne({ _id: theirs, orgId: other, companyName: 'Theirs Ltd', type: 'customer' })
    await master.collection<any>('contacts').insertOne({ _id: theirs, orgId, companyName: 'Mine Ltd', type: 'customer' })
    await rejournal(client, master, orgId, 'contacts', [theirs])
    const [r] = await sync(orgId)
    expect(refusedAs(r)).toBe('foreign_collision')
    expect(await mirror.collection('contacts').findOne({ _id: theirs })).toMatchObject({ orgId: other, companyName: 'Theirs Ltd' })
  }, 60_000)
})

describe('collisions (FR-20.65)', () => {
  it('a unique key a stale document still holds is freed in the same transaction, and the stale one resent', async () => {
    const orgId = await homedOrg()
    const a = await createTestAccount(orgId as any, { code: '411' })
    await journal(orgId)
    await sync(orgId)
    // On the master, A gives up its code and B takes it, and only B is journaled so far: the mirror
    // still holds A with the code.
    await Account.updateOne({ _id: a._id }, { $set: { code: '412' } })
    const b = await createTestAccount(orgId as any, { code: '411' })
    await rejournal(client, master, orgId, 'accounts', [b._id])

    const built = await buildPage(client, master, orgId, { ...(await where(orgId)), nodeId: NODE })
    if (!('bytes' in built)) throw new Error('no page')
    const r = await applyPage(client, mirror, built.bytes, ctx)
    expect(r).toMatchObject({ ok: true, applied: 1, resend: [{ coll: 'accounts' }] })
    if (!r.ok) throw new Error('refused')
    expect(r.resend[0].ids.map(String)).toEqual([String(a._id)])
    expect((await mirror.collection<any>('accounts').findOne({ orgId, code: '411' }))!._id).toEqual(b._id)

    // The resend brings A back as it is now.
    await rejournal(client, master, orgId, r.resend[0].coll, r.resend[0].ids)
    await sync(orgId)
    expect((await mirror.collection<any>('accounts').findOne({ _id: a._id }))!.code).toBe('412')
    expect(await digest(mirror, orgId)).toEqual(await digest(master, orgId))
  }, 60_000)
})

describe('collisions of split documents', () => {
  it('a membership that held a username is parked, not deleted, so its person and link survive the resend', async () => {
    const orgId = await homedOrg()
    const person = new mongoose.Types.ObjectId()
    const ana = await createTestUser(orgId as any, { username: 'ana', identityId: person } as any)
    await mirror.collection<any>('users').insertOne({ ...(await master.collection('users').findOne({ _id: ana._id })), email: 'ana@global.test', password: HELD })
    await journal(orgId)
    await sync(orgId)
    // On the master, Ana becomes ana2 and a newcomer takes "ana"; only the newcomer is journaled yet.
    await User.updateOne({ _id: ana._id }, { $set: { username: 'ana2' } })
    const newcomer = await createTestUser(orgId as any, { username: 'ana' } as any)
    await rejournal(client, master, orgId, 'users', [newcomer._id])

    const built = await buildPage(client, master, orgId, { ...(await where(orgId)), nodeId: NODE })
    if (!('bytes' in built)) throw new Error('no page')
    const r = await applyPage(client, mirror, built.bytes, ctx)
    expect(r).toMatchObject({ ok: true, resend: [{ coll: 'users' }] })
    if (!r.ok) throw new Error('refused')
    expect(await mirror.collection('users').findOne({ _id: newcomer._id })).toMatchObject({ username: 'ana' })
    const parked: any = await mirror.collection('users').findOne({ _id: ana._id })
    expect(parked).toMatchObject({ username: `~stale~${String(ana._id)}`, identityId: person, email: 'ana@global.test' })
    expect(parked.password).toBe(HELD)

    // The resend brings her back as she is, still linked, her person intact.
    await rejournal(client, master, orgId, r.resend[0].coll, r.resend[0].ids)
    await sync(orgId)
    const back: any = await mirror.collection('users').findOne({ _id: ana._id })
    expect(back).toMatchObject({ username: 'ana2', identityId: person, email: 'ana@global.test' })
    expect(back.password).toBe(HELD)
    expect(await digest(mirror, orgId)).toEqual(await digest(master, orgId))
  }, 60_000)
})

describe('memberships (FR-20.63)', () => {
  it('a link to a person global never made is applied without it, inert, with an alarm', async () => {
    const orgId = await homedOrg()
    const person = new mongoose.Types.ObjectId()
    const linked = await createTestUser(orgId as any, { identityId: person } as any)
    const copy: any = await master.collection('users').findOne({ _id: linked._id })
    await mirror.collection<any>('users').insertOne(copy)
    // New on the master, naming somebody: global never sanctioned it.
    const stranger = new mongoose.Types.ObjectId()
    const fresh = await createTestUser(orgId as any, { identityId: stranger } as any)
    await journal(orgId)

    const [r] = await sync(orgId)
    expect(r).toMatchObject({ ok: true })
    if (!r.ok) throw new Error('refused')
    expect(r.alarms).toHaveLength(1)
    expect((await mirror.collection<any>('users').findOne({ _id: linked._id }))!.identityId).toEqual(person)
    const inert: any = await mirror.collection('users').findOne({ _id: fresh._id })
    expect(inert.identityId).toBeUndefined()
    expect(inert).toMatchObject({ email: `${String(fresh._id)}@inert.invalid`, username: fresh.username, role: fresh.role })

    // The home re-points a sanctioned membership at somebody else: unlinked, not re-pointed.
    await User.updateOne({ _id: linked._id }, { $set: { identityId: new mongoose.Types.ObjectId() } })
    await rejournal(client, master, orgId, 'users', [linked._id])
    const [again] = await sync(orgId)
    expect(again).toMatchObject({ ok: true })
    expect((await mirror.collection<any>('users').findOne({ _id: linked._id }))!.identityId).toBeUndefined()
    const st: any = await mirror.collection('mirror_state').findOne({ orgId })
    expect(st.alarms.map((a: any) => a.kind)).toEqual(['membership_unsanctioned', 'membership_unsanctioned'])
  }, 60_000)
})

describe('end to end through the capture', () => {
  it('what the master writes, by any path, reaches the mirror as it is', async () => {
    ;(config.replication as any).capture = true
    const orgId = await homedOrg()
    const keep = await createTestContact(orgId as any, { companyName: 'Keep Ltd' })
    const drop = await createTestContact(orgId as any, { companyName: 'Drop Ltd' })
    await captureTick()
    await sync(orgId)

    await Contact.updateOne({ _id: keep._id }, { $set: { email: 'keep@example.com' } })
    await Contact.deleteOne({ _id: drop._id })
    const session = await mongoose.startSession()
    try {
      await session.withTransaction(async () => {
        for (let i = 0; i < 3; i++) await Contact.create([{ orgId, companyName: `Txn ${i}`, type: 'customer' }], { session })
      })
    } finally {
      await session.endSession()
    }
    await master.collection('contacts').updateOne({ _id: keep._id }, { $set: { phone: '+359 2 000' } })
    await Org.updateOne({ _id: orgId }, { $set: { name: 'Captured Co' } })

    // The capture batches within about a second, in order: once the last two writes are journaled,
    // every write before them is too.
    const end = Date.now() + 15_000
    for (;;) {
      const phone = await ReplJournal.countDocuments({ orgId, coll: 'contacts', docId: keep._id, changedFields: 'phone' })
      const name = await ReplJournal.countDocuments({ orgId, coll: 'orgs', changedFields: 'name' })
      if (phone && name) break
      if (Date.now() > end) throw new Error('the capture did not journal the writes')
      await Bun.sleep(100)
    }
    // ⚠ A page is read at the snapshot (majority-committed) point, which can trail what the poll above
    // read at "local" by the batch that just committed: "nothing to send" until it catches up. So
    // until the mirror holds the journal's head, not merely until one page comes back empty.
    const head = ((await ReplJournal.findOne({ orgId }).sort({ seq: -1 }).lean()) as any).seq
    while ((await where(orgId)).after < head) {
      if (Date.now() > end) throw new Error('the mirror did not catch up with the journal')
      await sync(orgId)
      await Bun.sleep(50)
    }
    expect(await digest(mirror, orgId)).toEqual(await digest(master, orgId))
    expect((await mirror.collection<any>('orgs').findOne({ _id: orgId }))!.name).toBe('Captured Co')
    expect(await mirror.collection('contacts').countDocuments({ _id: drop._id })).toBe(0)
  }, 90_000)
})
