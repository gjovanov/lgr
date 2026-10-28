import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import type { Db, MongoClient, ObjectId } from 'mongodb'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact } from '../helpers/factories'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { Contact, MirrorDeadLetter, MirrorState, Org } from 'db/models'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { enableOrgs } from 'services/biz/replication/capture'
import { stopCapture } from 'services/biz/replication/engine'
import { buildPage, idKey, rejournal } from 'services/biz/replication/pages'
import { applyPage, type ApplyResult } from 'services/biz/replication/apply'
import { DEAD_MAX, mirrorDeadLetterStatus, retryAfterMs } from 'services/biz/replication/dead-letters'

/**
 * FR-20.65 (plan step P3-2c): a document of a master's page that global cannot write into its mirror
 * is SET ASIDE (`mirror_dead_letters`), and the rest of the page applies: one document never stops an
 * org's mirror. Asked for again ever less often, resolved by the page that writes it. Two databases
 * on the test replica set, as in `replication-pages.flow`.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const NODE = 'master-deadletters000000'
const saved = { role: config.node.role, id: (config.node as any).id }
let client: MongoClient
let master: Db
let mirror: Db
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
  await mirror.dropDatabase()
  for (const m of [Contact, MirrorDeadLetter, MirrorState, Org]) {
    for (const [keys, opts] of m.schema.indexes()) await mirror.collection(m.collection.collectionName).createIndex(keys as any, opts as any)
  }
}, 60_000)

afterEach(async () => {
  await stopCapture()
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  forgetAllHomes()
  await clearCollections()
}, 60_000)

const homeOnGlobal = async (orgId: ObjectId) => {
  const r = await mirror.collection<any>('org_homes').findOne({ orgId })
  return r ? { home: r.home, epoch: r.epoch, state: r.state } : { home: 'global', epoch: 0, state: 'active' as const }
}
const ctxAt = (now?: Date) => ({ nodeId: NODE, home: homeOnGlobal, ...(now ? { now } : {}) })

async function homedOrg(): Promise<ObjectId> {
  const org = await createTestOrg({ name: 'Home Co', slug: `dead-${++n}`, description: 'shop' } as any)
  const orgId = org._id as unknown as ObjectId
  await homeNewOrg(String(orgId))
  const copy: any = await master.collection('orgs').findOne({ _id: orgId })
  await mirror.collection<any>('orgs').insertOne({ ...copy })
  await mirror.collection<any>('org_homes').insertOne({ orgId, home: NODE, epoch: 1, state: 'active' })
  await mirror.collection<any>('nodes').updateOne({ _id: NODE }, { $set: { status: 'active', linkLevel: 'full' }, $addToSet: { orgIds: orgId } }, { upsert: true })
  return orgId
}

const where = async (orgId: ObjectId) => {
  const st: any = await mirror.collection('mirror_state').findOne({ orgId })
  return { after: st?.watermark ?? 0, afterHash: st?.chainHash ?? '' }
}

/** Send pages until the mirror has everything, resending what an acknowledgement asks for. */
async function sync(orgId: ObjectId, now?: Date): Promise<ApplyResult[]> {
  const out: ApplyResult[] = []
  for (let i = 0; i < 50; i++) {
    const built = await buildPage(client, master, orgId, { ...(await where(orgId)), nodeId: NODE })
    if ('empty' in built) return out
    if ('refused' in built) throw new Error(`the master would not build: ${built.refused} ${built.detail}`)
    const r = await applyPage(client, mirror, built.bytes, ctxAt(now))
    out.push(r)
    if (!r.ok) return out
    for (const rs of r.resend) await rejournal(client, master, orgId, rs.coll, rs.ids)
  }
  throw new Error('the mirror never caught up')
}

const letters = (orgId: ObjectId) => mirror.collection<any>('mirror_dead_letters').find({ orgId }).toArray()

describe('dead letters (FR-20.65)', () => {
  it('a document whose id another org holds is set aside, never written over, and the rest of the page applies', async () => {
    const orgId = await homedOrg()
    await enableOrgs(master as any, [orgId])
    await sync(orgId)
    const theirs = new mongoose.Types.ObjectId()
    const other = new mongoose.Types.ObjectId()
    await mirror.collection<any>('contacts').insertOne({ _id: theirs, orgId: other, companyName: 'Theirs Ltd', type: 'customer' })
    await master.collection<any>('contacts').insertOne({ _id: theirs, orgId, companyName: 'Mine Ltd', type: 'customer' })
    const next = await createTestContact(orgId as any, { companyName: 'Next Ltd' })
    await rejournal(client, master, orgId, 'contacts', [theirs, next._id])

    const [r] = await sync(orgId)
    expect(r.ok).toBe(true)
    expect((r as any).setAside).toBe(1)
    // That org's document is untouched; this one's next document is written.
    expect(await mirror.collection('contacts').findOne({ _id: theirs })).toMatchObject({ orgId: other, companyName: 'Theirs Ltd' })
    expect(await mirror.collection('contacts').findOne({ _id: next._id })).toMatchObject({ orgId, companyName: 'Next Ltd' })
    const [d] = await letters(orgId)
    expect(d).toMatchObject({ coll: 'contacts', reason: 'foreign_collision', status: 'open', attempts: 1, nodeId: NODE })
    expect(idKey(d.docId)).toBe(idKey(theirs))
    expect(d.detail).toContain("another org's")
    const st: any = await mirror.collection('mirror_state').findOne({ orgId })
    expect(st.alarms.filter((a: any) => a.kind === 'dead_letter')).toHaveLength(1)
    expect(await mirrorDeadLetterStatus(String(orgId), mirror as any)).toMatchObject({ open: 1, items: [{ coll: 'contacts', id: String(theirs), reason: 'foreign_collision', attempts: 1 }] })
  }, 60_000)

  it('the database refusing a document sets it aside too', async () => {
    const orgId = await homedOrg()
    await enableOrgs(master as any, [orgId])
    await sync(orgId)
    // The mirror's database refuses this one, whatever the page says.
    await mirror.command({ collMod: 'contacts', validator: { companyName: { $ne: 'Refused Ltd' } }, validationLevel: 'strict', validationAction: 'error' })
    const refused = await createTestContact(orgId as any, { companyName: 'Refused Ltd' })
    const fine = await createTestContact(orgId as any, { companyName: 'Fine Ltd' })
    await rejournal(client, master, orgId, 'contacts', [refused._id, fine._id])
    const [r] = await sync(orgId)
    expect(r.ok).toBe(true)
    expect(await mirror.collection('contacts').countDocuments({ _id: refused._id })).toBe(0)
    expect(await mirror.collection('contacts').countDocuments({ _id: fine._id })).toBe(1)
    const [d] = await letters(orgId)
    expect(d).toMatchObject({ coll: 'contacts', reason: 'write_error', status: 'open' })
    expect(d.detail).toContain('121: Document failed validation')
  }, 60_000)

  it('a set-aside document is asked for again when its time comes, waits longer when set aside again, and is resolved once written', async () => {
    const orgId = await homedOrg()
    await enableOrgs(master as any, [orgId])
    await sync(orgId)
    const theirs = new mongoose.Types.ObjectId()
    const other = new mongoose.Types.ObjectId()
    await mirror.collection<any>('contacts').insertOne({ _id: theirs, orgId: other, companyName: 'Theirs Ltd', type: 'customer' })
    await master.collection<any>('contacts').insertOne({ _id: theirs, orgId, companyName: 'Mine Ltd', type: 'customer' })
    await rejournal(client, master, orgId, 'contacts', [theirs])
    const t0 = new Date()
    await sync(orgId, t0)
    let [d] = await letters(orgId)
    expect(new Date(d.retryAt).getTime()).toBe(t0.getTime() + retryAfterMs(1))

    // Before its time a page brings no resend of it.
    const early = await createTestContact(orgId as any)
    await rejournal(client, master, orgId, 'contacts', [early._id])
    const [r1] = await sync(orgId, new Date(t0.getTime() + 60_000))
    expect(r1.ok && r1.resend).toEqual([])

    // Its time come, the next acknowledgement asks for it; the conflict is still there, so it is set
    // aside again, waits twice as long, and raises no second alarm.
    const t1 = new Date(t0.getTime() + retryAfterMs(1) + 1000)
    const later = await createTestContact(orgId as any)
    await rejournal(client, master, orgId, 'contacts', [later._id])
    const again = await sync(orgId, t1)
    expect(again[0].ok && again[0].resend.flatMap(x => x.ids.map(id => idKey(id)))).toEqual([idKey(theirs)])
    ;[d] = await letters(orgId)
    expect(d).toMatchObject({ status: 'open', attempts: 2 })
    expect(new Date(d.retryAt).getTime()).toBe(t1.getTime() + retryAfterMs(2))
    expect(((await mirror.collection('mirror_state').findOne({ orgId })) as any).alarms.filter((a: any) => a.kind === 'dead_letter')).toHaveLength(1)

    // Someone resolves the conflict: the next time it is asked for, it is written, and resolved.
    await mirror.collection('contacts').deleteOne({ _id: theirs, orgId: other })
    const t2 = new Date(t1.getTime() + retryAfterMs(2) + 1000)
    const last = await createTestContact(orgId as any)
    await rejournal(client, master, orgId, 'contacts', [last._id])
    await sync(orgId, t2)
    expect(await mirror.collection('contacts').findOne({ _id: theirs })).toMatchObject({ orgId, companyName: 'Mine Ltd' })
    ;[d] = await letters(orgId)
    expect(d).toMatchObject({ status: 'resolved', resolvedAt: expect.any(Date) })
    expect((await mirrorDeadLetterStatus(String(orgId), mirror as any)).open).toBe(0)
  }, 60_000)

  it(`more than ${DEAD_MAX} documents set aside fail the page, which is sent again`, async () => {
    const orgId = await homedOrg()
    await enableOrgs(master as any, [orgId])
    await sync(orgId)
    const other = new mongoose.Types.ObjectId()
    const ids = Array.from({ length: DEAD_MAX + 1 }, () => new mongoose.Types.ObjectId())
    await mirror.collection<any>('contacts').insertMany(ids.map(_id => ({ _id, orgId: other, companyName: 'Theirs', type: 'customer' })))
    await master.collection<any>('contacts').insertMany(ids.map(_id => ({ _id, orgId, companyName: 'Mine', type: 'customer' })))
    await rejournal(client, master, orgId, 'contacts', ids)
    const before = await where(orgId)
    const built = await buildPage(client, master, orgId, { ...before, nodeId: NODE })
    if (!('bytes' in built)) throw new Error('no page')
    let error = ''
    try {
      await applyPage(client, mirror, built.bytes, ctxAt())
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    expect(error).toContain(`more than ${DEAD_MAX} documents`)
    // Nothing of it was written, and the mirror stands where it stood.
    expect(await where(orgId)).toEqual(before)
    expect(await letters(orgId)).toHaveLength(0)
  }, 120_000)
})
