import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { setupTestDB, teardownTestDB } from '../setup'
import { mongoose } from 'db/connection'
import { RELAY_RECEIPT_KEEP_DAYS, RelayReceipt } from 'db/models'
import { MIGRATIONS } from 'migrations/registry'
import { relayReceiptsKept60Days } from 'migrations/migrations/0021-relay-receipts-kept-60-days'

/**
 * FR-20.60, AC 27: migration 0021 keeps global's relay receipts 60 days instead of 7, in place, on a collection made
 * when the window was 7 days: a master may retry a mail for 45, and a receipt gone before then lets it go out twice.
 * A second run, a node without the collection or without the index, and one already at 60 change nothing.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)

const db = () => mongoose.connection.db!
const COLL = 'relay_receipts'
const DAY = 86_400

const exists = async () => (await db().listCollections({ name: COLL }, { nameOnly: true }).toArray()).length > 0
async function dropReceipts() {
  if (await exists()) await db().collection(COLL).drop()
}
async function ttlDays(): Promise<number | undefined> {
  const ix = (await db().collection(COLL).indexes()).find(i => JSON.stringify(i.key) === '{"at":1}')
  return typeof ix?.expireAfterSeconds === 'number' ? ix.expireAfterSeconds / DAY : undefined
}
/** Runs 0021 and answers what it said it changed. */
async function run(): Promise<string[]> {
  const said: string[] = []
  await relayReceiptsKept60Days.up({ db: db(), log: m => { said.push(m) }, orgFilter: {} })
  return said
}

describe('0021-relay-receipts-kept-60-days (FR-20.60, AC 27)', () => {
  it('is registered right after 0020, and writes the window the schema declares', () => {
    const ids = MIGRATIONS.map(m => m.id)
    expect(ids.indexOf('0021-relay-receipts-kept-60-days')).toBe(ids.indexOf('0020-legacy-access-archive-drop') + 1)
    expect(RELAY_RECEIPT_KEEP_DAYS).toBe(60)
  })

  it('a collection made at 7 days keeps its receipts 60 from now on; a second run changes nothing', async () => {
    // The model's own build first, so it cannot land on the collection made below.
    try { await RelayReceipt.init() } catch (e) { void e /* refused over an older index: what this test makes anyway */ }
    await dropReceipts()
    await db().collection(COLL).createIndex({ at: 1 }, { expireAfterSeconds: 7 * DAY })
    await db().collection(COLL).createIndex({ nodeId: 1, at: 1 })
    await db().collection(COLL).insertOne({ _id: 'node-a:outbox-1' as any, nodeId: 'node-a', kind: 'mail', state: 'sent', at: new Date() })
    expect(await ttlDays()).toBe(7)

    expect(await run()).toEqual(['relay_receipts: receipts kept 60 days (were 7)'])
    expect(await ttlDays()).toBe(60)
    expect(await db().collection(COLL).countDocuments()).toBe(1)
    expect((await db().collection(COLL).indexes()).map(i => i.name).sort()).toEqual(['_id_', 'at_1', 'nodeId_1_at_1'])

    expect(await run()).toEqual([])
    expect(await ttlDays()).toBe(60)
  })

  it('a node without the collection, or without its index, is left as it is', async () => {
    await dropReceipts()
    expect(await run()).toEqual([])
    expect(await exists()).toBe(false)

    await db().createCollection(COLL)
    expect(await run()).toEqual([])
    expect(await ttlDays()).toBeUndefined()
    await dropReceipts()
  })
})
