import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Glob } from 'bun'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact } from '../helpers/factories'
import { Contact, Org, OrgHome } from 'db/models'
import { forgetAllHomes, HomeElsewhereError } from 'db/home/home'
import { applyRestore } from 'services/biz/backup/backup-restore.service'
import { getNextNumber } from 'services/biz/sequence.service'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * The write guard below the routes (FR-20.4, plan step P0b-2 part 2; AC 56 in part).
 *
 * A Mongoose plugin installed by `tenantPlugin` refuses a write to an org whose home is elsewhere,
 * however it is made — `save`, an update by `_id` alone, `insertMany`, `bulkWrite`, an update that
 * moves documents INTO that org. Raw driver writes are invisible to it, so the few the application
 * makes are listed below, each guarded or exempt with its reason, and a new one fails the scan.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  await clearCollections()
  forgetAllHomes()
})

/** Make `org`'s home a master: what a move to on-prem leaves on global. */
async function awayFromHome(orgId: unknown) {
  await OrgHome.create({ orgId, home: 'node-shop-1', epoch: 1 })
  await Org.updateOne({ _id: orgId }, { $set: { homeEpochHighWater: 1 } }).exec()
  forgetAllHomes()
}

const refused = (e: unknown) => e instanceof HomeElsewhereError

describe('no home records (every org today): every kind of write works', () => {
  it('save, update by _id, insertMany, bulkWrite, delete', async () => {
    const org = await createTestOrg()
    const c = await createTestContact(org._id, { companyName: 'A' })
    await Contact.updateOne({ _id: c._id }, { $set: { companyName: 'B' } }).exec()
    await Contact.insertMany([{ orgId: org._id, type: 'customer', companyName: 'C' }])
    await Contact.bulkWrite([{ updateOne: { filter: { _id: c._id }, update: { $set: { companyName: 'D' } } } }])
    await Contact.deleteOne({ _id: c._id }).exec()
    expect(await Contact.countDocuments({ orgId: org._id })).toBe(1)
  })
})

describe('an org whose home is elsewhere: refused, whoever writes', () => {
  async function world() {
    const away = await createTestOrg()
    const home = await createTestOrg()
    const theirs = await createTestContact(away._id, { companyName: 'Away Co' })
    const ours = await createTestContact(home._id, { companyName: 'Home Co' })
    await awayFromHome(away._id)
    return { away, home, theirs, ours }
  }

  it('creating, or saving a loaded document', async () => {
    const w = await world()
    expect(refused(await captureRejection(Contact.create({ orgId: w.away._id, type: 'customer', companyName: 'X' })))).toBe(true)
    const doc = await Contact.findById(w.theirs._id).exec()
    doc!.companyName = 'changed'
    expect(refused(await captureRejection(doc!.save()))).toBe(true)
  })

  it('an update or delete naming the org', async () => {
    const w = await world()
    expect(refused(await captureRejection(Contact.updateMany({ orgId: w.away._id }, { $set: { companyName: 'x' } }).exec()))).toBe(true)
    expect(refused(await captureRejection(Contact.deleteMany({ orgId: w.away._id }).exec()))).toBe(true)
  })

  it('an update by _id alone: the org is read from the data', async () => {
    const w = await world()
    expect(refused(await captureRejection(Contact.updateOne({ _id: w.theirs._id }, { $set: { companyName: 'x' } }).exec()))).toBe(true)
    expect(refused(await captureRejection(Contact.findOneAndDelete({ _id: w.theirs._id }).exec()))).toBe(true)
  })

  it('moving a document INTO that org', async () => {
    const w = await world()
    const err = await captureRejection(Contact.updateOne({ _id: w.ours._id }, { $set: { orgId: w.away._id } }).exec())
    expect(refused(err)).toBe(true)
    expect(String((await Contact.findById(w.ours._id).lean() as any).orgId)).toBe(String(w.home._id))
  })

  it('insertMany and bulkWrite', async () => {
    const w = await world()
    expect(refused(await captureRejection(Contact.insertMany([{ orgId: w.away._id, type: 'customer', companyName: 'x' }])))).toBe(true)
    const bulk = await captureRejection(Contact.bulkWrite([{ updateOne: { filter: { _id: w.theirs._id }, update: { $set: { companyName: 'x' } } } }]))
    expect(refused(bulk)).toBe(true)
  })

  it('nothing was changed, and the org at home is written as before', async () => {
    const w = await world()
    await captureRejection(Contact.updateMany({}, { $set: { notes: 'touched' } }).exec())
    expect((await Contact.findById(w.theirs._id).lean() as any).companyName).toBe('Away Co')

    await Contact.updateOne({ _id: w.ours._id }, { $set: { companyName: 'Home Co 2' } }).exec()
    await Contact.create({ orgId: w.home._id, type: 'customer', companyName: 'New' })
    expect(await Contact.countDocuments({ orgId: w.home._id })).toBe(2)
  })

  it('a restore is refused before it reads anything', async () => {
    const w = await world()
    const err = await captureRejection(applyRestore(String(w.away._id), { type: 'run', runId: 'x' } as any, { mode: 'replace' } as any))
    expect(refused(err)).toBe(true)
  })
})

describe('a legal number is never drawn on a cached "active"', () => {
  it('frozen after the home was cached: an ordinary write still passes on the cache, a number draw is refused', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    expect(await getNextNumber(orgId, 'INV', 5)).toMatch(/-00001$/) // the home is now cached as active

    // A move freezes the org — and nothing tells this process's cache.
    await OrgHome.create({ orgId, home: 'global', epoch: 0, state: 'frozen' })

    await Contact.create({ orgId, type: 'customer', companyName: 'within the cache window' })
    const err = await captureRejection(getNextNumber(orgId, 'INV', 5))
    expect(refused(err)).toBe(true)
  })
})

/**
 * Raw driver writes in server code, which the plugin cannot see. Each is guarded by an explicit
 * `assertHomeIsHere`, or is not org data. A new one fails the scan until it is listed here.
 */
const RAW_WRITE_SITES: Record<string, { count: number; why: string }> = {
  'services/src/biz/backup/backup-restore.service.ts': {
    count: 5,
    why: 'applyRestore() calls assertHomeIsHere(orgId) first; 1 of the 5 deletes Identity rows (people, not org data)',
  },
  'services/src/biz/login-throttle.service.ts': { count: 1, why: 'login throttles: not org data' },
  'invoicing-api/src/controllers/invoice.controller.ts': {
    count: 1,
    why: 'the payment record (P0a-4): one atomic pipeline update; calls assertHomeIsHere(orgId) first',
  },
}

describe('raw write sites are listed', () => {
  it('every raw driver write in server code is on the list, and the list is current', async () => {
    const root = join(import.meta.dir, '..', '..', '..')
    const dirs = ['services/src', 'fiscal/src', 'reporting/src']
    for await (const p of new Glob('*-api/src').scan({ cwd: root, onlyFiles: false })) dirs.push(p)
    const raw = /\.collection(?:\([^)]*\))?\.(?:insert\w*|update\w*|delete\w*|replace\w*|findOneAnd\w*|bulkWrite)\(/g
    const found: Record<string, number> = {}
    for (const dir of dirs) {
      if (!existsSync(join(root, dir))) continue
      for await (const f of new Glob('**/*.ts').scan({ cwd: join(root, dir) })) {
        const n = ((await Bun.file(join(root, dir, f)).text()).match(raw) ?? []).length
        if (n) found[`${dir}/${f}`.replace(/\\/g, '/')] = n
      }
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(RAW_WRITE_SITES).map(([k, v]) => [k, v.count])))
  })

  it('the restore guard is really there', async () => {
    const src = await Bun.file(join(import.meta.dir, '..', '..', '..', 'services/src/biz/backup/backup-restore.service.ts')).text()
    expect(src).toContain('await assertHomeIsHere(orgId)')
  })
})
