import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact } from '../helpers/factories'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { Contact, EmailLog, ExchangeRate, ReplJournal, ReplOrg, ReplEngine } from 'db/models'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { captureTick, stopCapture } from 'services/biz/replication/engine'
import { capturedCollections, isHistoryLost, route, takeLease, LEASE_TTL_MS } from 'services/biz/replication/capture'
import type { Types } from 'mongoose'

/**
 * FR-20.61 (plan step P3-1b, AC 29): a master journals every write of the orgs it is home of, from a
 * change stream, so the mirror (P3-2) can be sent what changed. Against the test replica set: a real
 * change stream, real pre- and post-images, real transactions.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const saved = { role: config.node.role, id: (config.node as any).id, capture: config.replication.capture }

beforeAll(async () => {
  await setupTestDB()
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

afterEach(async () => {
  await stopCapture()
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.replication as any).capture = saved.capture
  forgetAllHomes()
  await clearCollections()
}, 60_000)

function asCapturingMaster() {
  ;(config.node as any).role = 'master'
  ;(config.node as any).id = 'master-capturetest00000'
  ;(config.replication as any).capture = true
}

/** Poll until `check` holds (the stream batches within about a second). */
async function until<T>(what: string, check: () => Promise<T | false | null | undefined>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await check()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await Bun.sleep(100)
  }
}

const row = (orgId: unknown, coll: string, docId: unknown) => ReplJournal.findOne({ orgId, coll, docId }).lean().exec()

async function homedOrg(slug: string) {
  const org = await createTestOrg({ slug } as any)
  await homeNewOrg(String(org._id))
  return org._id as Types.ObjectId
}

describe('the capture (FR-20.61)', () => {
  it('seeds what an org has, then journals every write: insert, update, delete', async () => {
    asCapturingMaster()
    const orgId = await homedOrg('cap-co')
    const existing = await createTestContact(orgId, { companyName: 'Before Ltd' })

    expect(await captureTick()).toMatchObject({ tailing: true, enabled: 1 })
    // Seeded: the org's own row, and the contact it already had.
    const seeded: any = await row(orgId, 'contacts', existing._id)
    expect(seeded).toMatchObject({ op: 'upsert', journalEpoch: 1 })
    expect(await row(orgId, 'orgs', orgId)).toBeTruthy()

    const added = await createTestContact(orgId, { companyName: 'After Ltd' })
    const inserted: any = await until('the insert', () => row(orgId, 'contacts', added._id))
    expect(inserted.seq).toBeGreaterThan(seeded.seq)

    await Contact.updateOne({ _id: added._id }, { $set: { email: 'after@example.com' } })
    const updated: any = await until('the update', async () => {
      const r: any = await row(orgId, 'contacts', added._id)
      return r && r.seq > inserted.seq && r
    })
    expect(updated.op).toBe('upsert')
    expect(updated.changedFields).toContain('email')

    await Contact.deleteOne({ _id: added._id })
    const deleted: any = await until('the delete', async () => {
      const r: any = await row(orgId, 'contacts', added._id)
      return r?.op === 'delete' && r
    })
    expect(deleted.seq).toBeGreaterThan(updated.seq)
    // The resume token was saved with the batch.
    expect((await ReplEngine.findById('engine').lean() as any).resumeToken).toBeTruthy()
  }, 60_000)

  it('journals what any writer did, a raw driver write included, and only for orgs homed here', async () => {
    asCapturingMaster()
    const mine = await homedOrg('mine-co')
    await captureTick()
    // A write past Mongoose, as a script or a mongosh fix would make.
    const raw = await mongoose.connection.db!.collection('contacts').insertOne({ orgId: mine, companyName: 'Raw Ltd', type: 'customer', isActive: true })
    await until('the raw insert', () => row(mine, 'contacts', raw.insertedId))

    // An org this master is not home of, a document with no org, and a node-local collection.
    const elsewhere = new mongoose.Types.ObjectId()
    await mongoose.connection.db!.collection('contacts').insertOne({ orgId: elsewhere, companyName: 'Not Mine', type: 'customer' })
    await ExchangeRate.collection.insertOne({ orgId: null, fromCurrency: 'EUR', toCurrency: 'BGN', rate: 1.95583, date: new Date() } as any)
    await EmailLog.collection.insertOne({ orgId: mine, to: 'x@example.com', subject: 's', status: 'sent' } as any)
    // A write after them, so the batch holding them has surely been journaled.
    const marker = await createTestContact(mine, { companyName: 'Marker Ltd' })
    await until('the marker', () => row(mine, 'contacts', marker._id))
    expect(await ReplJournal.countDocuments({ orgId: elsewhere })).toBe(0)
    expect(await ReplJournal.countDocuments({ coll: 'exchangerates' })).toBe(0)
    expect(await ReplJournal.countDocuments({ coll: 'emaillogs' })).toBe(0)
  }, 60_000)

  it('a transaction is journaled whole, in one batch', async () => {
    asCapturingMaster()
    const orgId = await homedOrg('txn-co')
    await captureTick()
    const session = await mongoose.startSession()
    const ids: unknown[] = []
    try {
      await session.withTransaction(async () => {
        for (let i = 0; i < 5; i++) {
          const [c] = await Contact.create([{ orgId, companyName: `Txn ${i}`, type: 'customer' }], { session })
          ids.push(c._id)
        }
      })
    } finally {
      await session.endSession()
    }
    const rows: any[] = await until('the transaction', async () => {
      const rs = await ReplJournal.find({ orgId, coll: 'contacts', docId: { $in: ids } }).lean().exec()
      return rs.length === 5 && rs
    })
    // One batch: contiguous seqs, and one batch time for all five.
    const seqs = rows.map(r => r.seq).sort((a, b) => a - b)
    expect(seqs[4] - seqs[0]).toBe(4)
    expect(new Set(rows.map(r => String(r.updatedAt))).size).toBe(1)
  }, 60_000)

  it('lost history raises the journal epoch and journals everything again by upsert', async () => {
    asCapturingMaster()
    const orgId = await homedOrg('lost-co')
    const c = await createTestContact(orgId, { companyName: 'Survivor Ltd' })
    await captureTick()
    const before: any = await row(orgId, 'contacts', c._id)
    expect(before.journalEpoch).toBe(1)
    await stopCapture()
    // A saved token the server cannot resume from. (A truncated oplog, code 286, needs gigabytes of
    // writes to produce; an unreadable token takes the same path, which is what is tested here.)
    await ReplEngine.updateOne({ _id: 'engine' }, { $set: { resumeToken: { _data: 'deadbeef' } } })
    await captureTick()
    const after: any = await until('the re-journal', async () => {
      const r: any = await row(orgId, 'contacts', c._id)
      return r?.journalEpoch === 2 && r
    })
    expect(after.seq).toBeGreaterThan(before.seq)
    const engine: any = await ReplEngine.findById('engine').lean()
    expect(engine.journalEpoch).toBe(2)
    expect(engine.epochReason).toBeTruthy()
    // And it captures again from there.
    const later = await createTestContact(orgId, { companyName: 'Later Ltd' })
    expect(await until('a write after the loss', () => row(orgId, 'contacts', later._id))).toMatchObject({ journalEpoch: 2 })
  }, 90_000)

  it('one tailer per master: the lease is held until it lapses', async () => {
    const db = mongoose.connection.db!
    expect(await takeLease(db as any, 'a')).toBe(true)
    expect(await takeLease(db as any, 'b')).toBe(false)
    expect(await takeLease(db as any, 'a')).toBe(true)
    expect(await takeLease(db as any, 'b', new Date(Date.now() + LEASE_TTL_MS + 1000))).toBe(true)
  })

  it('off a master, or without LGR_REPLICATION, nothing is captured', async () => {
    ;(config.node as any).role = 'master'
    ;(config.replication as any).capture = false
    expect(await captureTick()).toEqual({ tailing: false, enabled: 0 })
    ;(config.node as any).role = 'global'
    ;(config.replication as any).capture = true
    expect(await captureTick()).toEqual({ tailing: false, enabled: 0 })
    expect(await ReplOrg.countDocuments({})).toBe(0)
  })
})

describe('what counts as lost history', () => {
  it('the server codes for a point the stream cannot resume from', () => {
    for (const code of [286, 280, 260, 50811]) expect(isHistoryLost({ code }), String(code)).toBe(true)
    expect(isHistoryLost({ code: 11600 })).toBe(false)
    expect(isHistoryLost(new Error('ChangeStream is closed'))).toBe(false)
  })
})

describe('routing a change to its org', () => {
  const captured = capturedCollections()
  const id = new mongoose.Types.ObjectId()
  const org = new mongoose.Types.ObjectId()

  it('an org is the document itself; every other document carries its org', () => {
    expect(route({ operationType: 'update', ns: { coll: 'orgs' }, documentKey: { _id: org }, fullDocument: { _id: org, name: 'x' }, updateDescription: { updatedFields: { name: 'x' } } } as any, captured, new Map())).toMatchObject({ orgId: org, coll: 'orgs', op: 'upsert', changedFields: ['name'] })
    expect(route({ operationType: 'insert', ns: { coll: 'contacts' }, documentKey: { _id: id }, fullDocument: { _id: id, orgId: org } } as any, captured, new Map())).toMatchObject({ orgId: org })
  })

  it('a delete is routed by its pre-image, or by the row it already has', () => {
    expect(route({ operationType: 'delete', ns: { coll: 'contacts' }, documentKey: { _id: id }, fullDocumentBeforeChange: { _id: id, orgId: org } } as any, captured, new Map())).toMatchObject({ orgId: org, op: 'delete' })
    const known = new Map([[`contacts|${String(id)}`, org as unknown]])
    expect(route({ operationType: 'delete', ns: { coll: 'contacts' }, documentKey: { _id: id } } as any, captured, known)).toMatchObject({ orgId: org, op: 'delete' })
    expect(route({ operationType: 'delete', ns: { coll: 'contacts' }, documentKey: { _id: id } } as any, captured, new Map())).toBeNull()
  })

  it('no org, or a collection that does not replicate, is never journaled', () => {
    expect(route({ operationType: 'insert', ns: { coll: 'exchangerates' }, documentKey: { _id: id }, fullDocument: { _id: id, orgId: null } } as any, captured, new Map())).toBeNull()
    expect(route({ operationType: 'insert', ns: { coll: 'emaillogs' }, documentKey: { _id: id }, fullDocument: { _id: id, orgId: org } } as any, captured, new Map())).toBeNull()
    expect(route({ operationType: 'insert', ns: { coll: 'repl_journal' }, documentKey: { _id: id }, fullDocument: { _id: id, orgId: org } } as any, captured, new Map())).toBeNull()
  })
})
