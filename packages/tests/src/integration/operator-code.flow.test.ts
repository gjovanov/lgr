import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { allocateOperatorCode } from 'services/biz/sequence.service'
import { Sequence, User } from 'db/models'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

describe('SUPTO operator code allocation', () => {
  it('starts at 0001 in a fresh org', async () => {
    const org = await createTestOrg({ name: 'Fresh', slug: 'op-fresh' })
    expect(await allocateOperatorCode(String(org._id))).toBe('0001')
    expect(await allocateOperatorCode(String(org._id))).toBe('0002')
  })

  // Regression: users imported or seeded before the counter existed hold codes it never
  // issued. A bare $inc re-issued 0001 and the insert died on {operatorCode, orgId}.
  it('skips codes already held when the counter lags behind (no duplicate)', async () => {
    const org = await createTestOrg({ name: 'Legacy', slug: 'op-legacy' })
    await createTestUser(org._id, { username: 'legacy1', email: 'l1@t.com', operatorCode: '0001' } as any)
    await createTestUser(org._id, { username: 'legacy2', email: 'l2@t.com', operatorCode: '0002' } as any)
    expect(await Sequence.findOne({ orgId: org._id, prefix: 'OPERATOR', year: 0 })).toBeNull()

    const code = await allocateOperatorCode(String(org._id))

    expect(code).toBe('0003')
    const created = await createTestUser(org._id, { username: 'new', email: 'n@t.com', operatorCode: code } as any)
    expect(created.operatorCode).toBe('0003')
    const codes = (await User.find({ orgId: org._id }).lean()).map((u: any) => u.operatorCode)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('does not rewind the counter when the highest code is below it', async () => {
    const org = await createTestOrg({ name: 'Ahead', slug: 'op-ahead' })
    await Sequence.create({ orgId: org._id, prefix: 'OPERATOR', year: 0, lastNumber: 7 })
    await createTestUser(org._id, { username: 'low', email: 'low@t.com', operatorCode: '0002' } as any)

    expect(await allocateOperatorCode(String(org._id))).toBe('0008')
  })

  it('hands concurrent callers distinct codes', async () => {
    const org = await createTestOrg({ name: 'Concurrent', slug: 'op-conc' })
    const codes = await Promise.all(
      Array.from({ length: 5 }, () => allocateOperatorCode(String(org._id))),
    )
    expect(new Set(codes).size).toBe(5)
  })

  it('scopes the counter per org', async () => {
    const a = await createTestOrg({ name: 'A', slug: 'op-a' })
    const b = await createTestOrg({ name: 'B', slug: 'op-b' })
    await createTestUser(a._id, { username: 'a1', email: 'a1@t.com', operatorCode: '0009' } as any)

    expect(await allocateOperatorCode(String(a._id))).toBe('0010')
    expect(await allocateOperatorCode(String(b._id))).toBe('0001')
  })
})
