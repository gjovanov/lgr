import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { mongoose } from 'db/connection'
import { Sequence } from 'db/models'
import { generateUNP } from 'services/biz/sequence.service'
import { runMigrations } from 'migrations/runner'
import { unpPerDevice } from 'migrations/migrations/0001-unp-per-device'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * One УНП counter per fiscal device (Н-18 Прил. 29 т. 9; FR-20.45, #156; AC 12).
 *
 * The counter used to be per device AND operator, so two operators on one device issued the same
 * numbers. These assert the rule, the migration that carries existing counters over, and the
 * rollback rule that keeps a downgraded binary from re-issuing a number.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() })

const DEVICE = 'ED123456'
const suffix = (unp: string) => Number(unp.slice(-7))
const db = () => mongoose.connection.db!
const migrate = () => runMigrations({ db: db(), migrations: [unpPerDevice] })

/** The state a database had before #156: per-operator counters and the УНП they issued. */
async function legacyHistory(orgId: unknown) {
  await Sequence.create({ orgId, prefix: `UNP-${DEVICE}-0001`, year: 0, lastNumber: 12 })
  await Sequence.create({ orgId, prefix: `UNP-${DEVICE}-0002`, year: 0, lastNumber: 7 })
  await Sequence.create({ orgId, prefix: 'UNP-OTHER123-0001', year: 0, lastNumber: 3 })
  // A sale whose number is above its counter (a counter reset by hand, say): the scan still sees it.
  await db().collection('postransactions').insertOne({ orgId, unpNumber: `${DEVICE}-0003-0000020` })
}

describe('one УНП counter per fiscal device', () => {
  it('two operators on one device receive consecutive numbers, never the same one (AC 12)', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    const a = await generateUNP(orgId, DEVICE, '0001')
    const b = await generateUNP(orgId, DEVICE, '0002')
    const c = await generateUNP(orgId, DEVICE, '0001')

    expect([a, b, c]).toEqual([`${DEVICE}-0001-0000001`, `${DEVICE}-0002-0000002`, `${DEVICE}-0001-0000003`])
  })

  it('devices count separately, and so do orgs', async () => {
    const org = await createTestOrg()
    const other = await createTestOrg()
    await generateUNP(String(org._id), DEVICE, '0001')
    expect(suffix(await generateUNP(String(org._id), 'ED999999', '0001'))).toBe(1)
    expect(suffix(await generateUNP(String(other._id), DEVICE, '0001'))).toBe(1)
  })

  it('concurrent sales on one device never share a number', async () => {
    const org = await createTestOrg()
    const unps = await Promise.all(Array.from({ length: 20 }, (_, i) => generateUNP(String(org._id), DEVICE, i % 2 ? '0001' : '0002')))
    expect(new Set(unps.map(suffix)).size).toBe(20)
  })
})

describe('migration 0001-unp-per-device', () => {
  it('before it runs, a device with history refuses to allocate rather than restart at 1', async () => {
    const org = await createTestOrg()
    await legacyHistory(org._id)
    const err = await captureRejection(generateUNP(String(org._id), DEVICE, '0001'))
    expect((err as Error).message).toMatch(/bun run migrate/)
  })

  it('the first number after it is above every number issued before it', async () => {
    const org = await createTestOrg()
    await legacyHistory(org._id)

    await migrate()

    // 20 is the highest issued on this device (a sale above its own counter); the other device
    // keeps its own floor.
    expect(suffix(await generateUNP(String(org._id), DEVICE, '0002'))).toBe(21)
    expect(suffix(await generateUNP(String(org._id), 'OTHER123', '0001'))).toBe(4)
  })

  it('is idempotent, and safe after new numbers were already allocated', async () => {
    const org = await createTestOrg()
    await legacyHistory(org._id)
    await migrate()
    await generateUNP(String(org._id), DEVICE, '0001') // 21
    await generateUNP(String(org._id), DEVICE, '0001') // 22

    await unpPerDevice.up({ db: db(), log: () => {}, orgFilter: {} })

    expect(suffix(await generateUNP(String(org._id), DEVICE, '0001'))).toBe(23)
  })

  it('a rolled-back binary, counting per operator, continues above the new numbers; re-upgrading continues above its', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    await legacyHistory(org._id)
    await migrate()
    expect(suffix(await generateUNP(orgId, DEVICE, '0001'))).toBe(21)

    // The previous binary: $inc on its own per-operator counter.
    const old = async (op: string) =>
      (await Sequence.findOneAndUpdate({ orgId, prefix: `UNP-${DEVICE}-${op}`, year: 0 }, { $inc: { lastNumber: 1 } }, { new: true, upsert: true }))!.lastNumber
    const fromOld = [await old('0001'), await old('0002')]
    expect(Math.min(...fromOld)).toBeGreaterThan(21)

    // Upgraded again: above everything the old binary issued.
    expect(suffix(await generateUNP(orgId, DEVICE, '0001'))).toBeGreaterThan(Math.max(...fromOld))
  })

  it('touches only the orgs its scope names', async () => {
    const mine = await createTestOrg()
    const theirs = await createTestOrg()
    await legacyHistory(mine._id)
    await legacyHistory(theirs._id)

    await unpPerDevice.up({ db: db(), log: () => {}, orgFilter: { orgId: mine._id } })

    expect(await Sequence.exists({ orgId: mine._id, prefix: `UNP-${DEVICE}`, year: 0 })).toBeTruthy()
    expect(await Sequence.exists({ orgId: theirs._id, prefix: `UNP-${DEVICE}`, year: 0 })).toBeNull()
  })
})
