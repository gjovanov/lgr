import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mongoose } from 'db/connection'
import type { RepositoryRegistry, DalSession } from 'dal'
import { getRepos } from 'services/context'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'

const { Types } = mongoose

/**
 * FR-32.14: the repository takes `select` and `session`.
 *
 * - `select` on every read that returns documents: only the fields named come back, and `id` always.
 * - `session` on every method: what it writes is inside the caller's transaction (gone on abort,
 *   there on commit), and what it reads sees that transaction's writes. A read made OUTSIDE the
 *   session is the witness: it must not see an uncommitted write, so a method that dropped the
 *   session on any of its operations shows up as a write that survived the abort, or a read that
 *   missed a write the transaction made.
 *
 * On the replica set of `setupTestDB()`, as transactions need one. The `dal/repos` suites, which
 * test the interface without these options, are unchanged.
 */

let repos: RepositoryRegistry
let orgId: string

const warehouse = (code: string, extra: Record<string, unknown> = {}) =>
  ({ orgId, name: `Store ${code}`, code, type: 'warehouse', isActive: true, ...extra }) as any

/** Runs `fn` in a transaction and aborts it: what `fn` wrote must leave no trace. */
async function inAbortedTransaction(fn: (session: DalSession) => Promise<void>): Promise<void> {
  const session = await mongoose.startSession()
  try {
    session.startTransaction()
    await fn(session)
    await session.abortTransaction()
  } finally {
    await session.endSession()
  }
}

beforeAll(async () => {
  await setupTestDB()
  repos = getRepos()
})

afterAll(async () => {
  await teardownTestDB()
})

beforeEach(async () => {
  await clearCollections()
  orgId = new Types.ObjectId().toString()
})

describe('select', () => {
  test('every read that returns documents returns only the fields named, and the id', async () => {
    const created = await repos.warehouses.create(warehouse('W1', { manager: 'Ana' }))
    const filter = { orgId, code: 'W1' } as any

    const reads = [
      await repos.warehouses.findById(created.id, { select: ['name'] }),
      await repos.warehouses.findOne(filter, { select: ['name'] }),
      await repos.warehouses.findByIdInOrg(created.id, orgId, { select: ['name'] }),
      (await repos.warehouses.findMany(filter, undefined, { select: ['name'] }))[0],
      (await repos.warehouses.findAll(filter, { page: 0, size: 10 }, { select: ['name'] })).items[0],
      (await repos.warehouses.findAll(filter, { page: 0, size: 0 }, { select: ['name'] })).items[0],
    ]
    for (const row of reads) {
      expect(row).toBeTruthy()
      expect(row!.id).toBe(created.id)
      expect((row as any).name).toBe('Store W1')
      expect((row as any).code).toBeUndefined()
      expect((row as any).manager).toBeUndefined()
      expect((row as any).orgId).toBeUndefined()
    }
  })

  test('a projection object excludes fields, and `id` in a list is the document id', async () => {
    const created = await repos.warehouses.create(warehouse('W2', { manager: 'Bo' }))

    const without = await repos.warehouses.findById(created.id, { select: { manager: 0 } })
    expect(without!.id).toBe(created.id)
    expect((without as any).code).toBe('W2')
    expect((without as any).manager).toBeUndefined()

    const named = await repos.warehouses.findById(created.id, { select: ['id', 'code'] })
    expect(named!.id).toBe(created.id)
    expect((named as any).code).toBe('W2')
    expect((named as any).name).toBeUndefined()
  })

  test('without select a read returns the whole document, as before', async () => {
    const created = await repos.warehouses.create(warehouse('W3', { manager: 'Cy' }))
    const row = await repos.warehouses.findById(created.id)
    expect((row as any).name).toBe('Store W3')
    expect((row as any).manager).toBe('Cy')
    expect(row!.orgId).toBe(orgId)
  })
})

describe('session', () => {
  test('the writes of every write method are inside the transaction: none survives an abort', async () => {
    const kept = await repos.warehouses.create(warehouse('K1'))
    const doomed = await repos.warehouses.create(warehouse('K2'))
    const alsoDoomed = await repos.warehouses.create(warehouse('K3'))

    await inAbortedTransaction(async session => {
      await repos.warehouses.create(warehouse('T1'), { session })
      await repos.warehouses.createMany([warehouse('T2'), warehouse('T3')], { session })
      await repos.warehouses.update(kept.id, { name: 'renamed by update' } as any, { session })
      await repos.warehouses.updateInOrg(kept.id, orgId, { manager: 'set by updateInOrg' } as any, {}, { session, unset: ['managerId'] })
      await repos.warehouses.findOneAndUpdate({ orgId, code: 'K1' } as any, { isDefault: true } as any, { session })
      await repos.warehouses.updateMany({ orgId } as any, { type: 'store' } as any, { session })
      await repos.warehouses.delete(doomed.id, { session })
      await repos.warehouses.deleteInOrg(alsoDoomed.id, orgId, {}, { session })
      await repos.warehouses.deleteMany({ orgId, code: 'K1' } as any, { session })
    })

    const after = await repos.warehouses.findMany({ orgId } as any, { code: 1 })
    expect(after.map(w => (w as any).code)).toEqual(['K1', 'K2', 'K3'])
    const k1 = after[0] as any
    expect(k1.name).toBe('Store K1')
    expect(k1.manager).toBeUndefined()
    expect(k1.isDefault).toBe(false)
    expect(after.every(w => (w as any).type === 'warehouse')).toBe(true)
  })

  test('every read method sees the transaction\'s own writes, and a read outside it does not', async () => {
    await inAbortedTransaction(async session => {
      const created = await repos.warehouses.create(warehouse('S1'), { session })
      const filter = { orgId, code: 'S1' } as any

      expect(await repos.warehouses.findById(created.id, { session })).toBeTruthy()
      expect(await repos.warehouses.findOne(filter, { session })).toBeTruthy()
      expect(await repos.warehouses.findByIdInOrg(created.id, orgId, { session })).toBeTruthy()
      expect(await repos.warehouses.findMany(filter, undefined, { session })).toHaveLength(1)
      const page = await repos.warehouses.findAll(filter, { page: 0, size: 10 }, { session })
      expect(page.items).toHaveLength(1)
      expect(page.total).toBe(1) // the page's count carries the session too
      expect(await repos.warehouses.count(filter, { session })).toBe(1)
      const grouped = await repos.warehouses.aggregate<{ n: number }>([
        { $match: { orgId: new Types.ObjectId(orgId) } as any },
        { $group: { _id: null, n: { $sum: 1 } } },
      ], { session })
      expect(grouped[0]?.n).toBe(1)

      // The witness: outside the session the write is not there yet.
      expect(await repos.warehouses.findById(created.id)).toBeNull()
      expect(await repos.warehouses.count(filter)).toBe(0)
    })
  })

  test('a committed transaction keeps what the repository wrote in it', async () => {
    const session = await mongoose.startSession()
    try {
      await session.withTransaction(async () => {
        await repos.warehouses.create(warehouse('C1'), { session })
        await repos.warehouses.createMany([warehouse('C2')], { session })
      })
    } finally {
      await session.endSession()
    }
    expect(await repos.warehouses.count({ orgId } as any)).toBe(2)
  })

  test('select and session together', async () => {
    await inAbortedTransaction(async session => {
      const created = await repos.warehouses.create(warehouse('B1'), { session })
      const row = await repos.warehouses.findById(created.id, { session, select: ['code'] })
      expect((row as any).code).toBe('B1')
      expect((row as any).name).toBeUndefined()
    })
  })

  test('the account balances move inside the transaction only', async () => {
    const account = await repos.accounts.create({
      orgId, code: '501', name: 'Cash', type: 'asset', subType: 'current', balance: 10,
    } as any)

    await inAbortedTransaction(async session => {
      await repos.accounts.adjustBalances(orgId, { [account.id]: 5 }, { session })
      expect((await repos.accounts.findById(account.id, { session }))!.balance).toBe(15)
      expect((await repos.accounts.findById(account.id))!.balance).toBe(10)
    })

    expect((await repos.accounts.findById(account.id))!.balance).toBe(10)
  })
})
