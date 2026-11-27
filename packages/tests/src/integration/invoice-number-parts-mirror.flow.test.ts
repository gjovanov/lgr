import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import type { Db, MongoClient, ObjectId } from 'mongodb'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestContact, createTestOrg } from '../helpers/factories'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { Contact, Invoice, MirrorDeadLetter, MirrorState, Org } from 'db/models'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { enableOrgs } from 'services/biz/replication/capture'
import { stopCapture } from 'services/biz/replication/engine'
import { buildPage, rejournal } from 'services/biz/replication/pages'
import { applyPage, type ApplyResult } from 'services/biz/replication/apply'
import { homeDigests } from 'services/biz/move/home-digest'

/**
 * #929, section 6 of the issue: a master older than the running number sends its invoices without it, and a master
 * that was given one by a copy may hold it stale. Global derives it where it applies the page, always from the
 * number, and the move back's digests leave it out, so the two still compare equal. Two databases on the test
 * replica set, as in `mirror-dead-letters.flow`.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const NODE = 'master-runningnumber0000'
const saved = { role: config.node.role, id: (config.node as any).id }
const year = new Date().getFullYear()
let client: MongoClient
let master: Db
let mirror: Db
let n = 0

beforeAll(async () => {
  await setupTestDB()
  client = mongoose.connection.getClient() as unknown as MongoClient
  master = mongoose.connection.db as unknown as Db
  mirror = client.db(`${master.databaseName}-mirror929`)
}, 60_000)

afterAll(async () => {
  await mirror.dropDatabase().catch(() => {})
  await teardownTestDB()
}, 60_000)

beforeEach(async () => {
  ;(config.node as any).role = 'master'
  ;(config.node as any).id = NODE
  await mirror.dropDatabase()
  for (const m of [Contact, Invoice, MirrorDeadLetter, MirrorState, Org]) {
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

async function homedOrg(): Promise<ObjectId> {
  const org = await createTestOrg({ name: 'Home Co', slug: `parts-mirror-${++n}`, description: 'shop' } as any)
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

async function sync(orgId: ObjectId): Promise<ApplyResult[]> {
  const out: ApplyResult[] = []
  for (let i = 0; i < 50; i++) {
    const built = await buildPage(client, master, orgId, { ...(await where(orgId)), nodeId: NODE })
    if ('empty' in built) return out
    if ('refused' in built) throw new Error(`the master would not build: ${built.refused} ${built.detail}`)
    const r = await applyPage(client, mirror, built.bytes, { nodeId: NODE, home: homeOnGlobal })
    out.push(r)
    if (!r.ok) return out
    for (const rs of r.resend) await rejournal(client, master, orgId, rs.coll, rs.ids)
  }
  throw new Error('the mirror never caught up')
}

describe('the mirror derives the running number (#929 §6)', () => {
  it('from an older master\'s invoice without it, and over a stale one, and the move back still compares equal', async () => {
    const orgId = await homedOrg()
    const contact = await createTestContact(orgId as any, { companyName: 'Buyer Ltd' })
    await enableOrgs(master as any, [orgId])
    await sync(orgId)

    const base = { orgId, type: 'invoice', direction: 'outgoing', status: 'sent', contactId: contact._id, currency: 'EUR', lines: [] }
    const older = new mongoose.Types.ObjectId()
    const stale = new mongoose.Types.ObjectId()
    // Written raw on the master, as a server of the previous release stores them: no running number at all...
    await master.collection<any>('invoices').insertOne({ _id: older, ...base, invoiceNumber: `INV-${year}-00041` })
    // ...and one issued by such a server after a copy gave it its draft's running number.
    await master.collection<any>('invoices').insertOne({ _id: stale, ...base, invoiceNumber: `INV-${year}-00042`, numberHead: `DRF-INV-${year}`, numberSeq: 9 })
    await rejournal(client, master, orgId, 'invoices', [older, stale])

    const results = await sync(orgId)
    expect(results.every(r => r.ok)).toBe(true)
    expect(await mirror.collection('invoices').findOne({ _id: older })).toMatchObject({ invoiceNumber: `INV-${year}-00041`, numberHead: `INV-${year}`, numberSeq: 41 })
    expect(await mirror.collection('invoices').findOne({ _id: stale })).toMatchObject({ invoiceNumber: `INV-${year}-00042`, numberHead: `INV-${year}`, numberSeq: 42 })
    // The master's copy is left as it was: global never writes the home's data.
    expect(await master.collection('invoices').findOne({ _id: older })).not.toHaveProperty('numberHead')

    // What a move back compares: equal, the derived fields left out on both sides.
    const home = await homeDigests(master as any, orgId as any)
    const copy = await homeDigests(mirror as any, orgId as any)
    expect(copy.invoices).toEqual(home.invoices)
  })
})
