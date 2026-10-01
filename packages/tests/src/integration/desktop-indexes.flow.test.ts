import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { Desktop } from 'db/models'

/**
 * FR-14.36 — C06's indexes exist and do what they claim.
 *
 * ⚠ **An index that silently failed to build is a slow surprise in production**, and a UNIQUE
 * index that silently failed to build is a correctness one: the thing it was enforcing simply
 * stops being enforced, with no error anywhere. Mongoose builds indexes in the background and
 * swallows the failure by default, so "the schema declares it" is not evidence.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

async function indexes(): Promise<Record<string, any>> {
  // ⚠ `syncIndexes` first: `mongodb-memory-server` starts empty, and a test that reads indexes
  // without building them asserts nothing about the schema.
  await Desktop.syncIndexes()
  const raw = await Desktop.collection.indexes()
  const byKey: Record<string, any> = {}
  for (const ix of raw) byKey[JSON.stringify(ix.key)] = ix
  return byKey
}

function makeRow(orgId: any, over: Record<string, unknown> = {}) {
  return {
    orgId,
    name: 'TILL-1',
    installationId: 'inst-1',
    machineId: 'machine-1',
    publicKey: 'x'.repeat(60),
    status: 'active',
    ...over,
  }
}

describe('the Desktop indexes (C06)', () => {
  it('declares the three the fleet queries by', async () => {
    const ix = await indexes()
    const keys = Object.keys(ix)

    // `{orgId, installationId}` — the re-enrollment lookup, and the uniqueness guarantee.
    expect(keys).toContain(JSON.stringify({ orgId: 1, installationId: 1 }))
    // `{orgId, status}` — the Desktops page, which hides revoked rows by default.
    expect(keys).toContain(JSON.stringify({ orgId: 1, status: 1 }))
    // `{orgId, lastSeenAt}` — presence and the ephemeral reaper.
    expect(keys).toContain(JSON.stringify({ orgId: 1, lastSeenAt: 1 }))
  })

  it('makes the installationId index UNIQUE and PARTIAL', async () => {
    const ix = await indexes()
    const inst = ix[JSON.stringify({ orgId: 1, installationId: 1 })]
    expect(inst.unique).toBe(true)
    // ⚠ `$in: ['active']`, not `$ne: 'revoked'`. C06 records that `createIndexes` refuses `$ne`
    // in a partial filter with a message about unsupported operators — so if this ever changes
    // shape, the index stops building and the test above is what notices.
    expect(inst.partialFilterExpression).toEqual({ status: { $in: ['active'] } })
  })
})

describe('what the partial unique index actually enforces', () => {
  it('REFUSES a second ACTIVE row with the same installationId', async () => {
    // ⚠ The positive half of C14's trap. Without this the index could be partial over the wrong
    // predicate and nobody would know until two tills shared an identity.
    const org = await createTestOrg({ name: 'Idx A', slug: 'idx-a' })
    await Desktop.create(makeRow(org._id))

    const err = await captureRejection(Desktop.create(makeRow(org._id, { name: 'TILL-2' })))
    expect(err).toBeTruthy()
    expect(String((err as any)?.code ?? err?.message)).toContain('11000')
  })

  it('ALLOWS an active row beside a revoked one with the same installationId', async () => {
    // ⚠ The negative half, and the reason the index is partial at all: re-enrollment revives a
    // machine, and the revoked row stays for the audit trail. A plain unique index would make
    // re-enrolling a revoked desktop impossible — which is exactly the lifecycle C06 ships.
    const org = await createTestOrg({ name: 'Idx B', slug: 'idx-b' })
    await Desktop.create(makeRow(org._id, { status: 'revoked' }))
    const revived = await Desktop.create(makeRow(org._id, { status: 'active' }))

    expect(revived.status).toBe('active')
    expect(await Desktop.countDocuments({ orgId: org._id, installationId: 'inst-1' })).toBe(2)
  })

  it('ALLOWS the same installationId in a DIFFERENT org', async () => {
    // The index is per-org, as every tenant-scoped index here is. Two shops can clone the same
    // machine image without colliding.
    const a = await createTestOrg({ name: 'Idx C', slug: 'idx-c' })
    const b = await createTestOrg({ name: 'Idx D', slug: 'idx-d' })
    await Desktop.create(makeRow(a._id))
    const other = await Desktop.create(makeRow(b._id))
    expect(String(other.orgId)).toBe(String(b._id))
  })

  it('allows TWO revoked rows with the same installationId', async () => {
    // Outside the partial filter entirely: a machine enrolled and revoked repeatedly accumulates
    // audit rows, and the index must not stand in the way of that history.
    const org = await createTestOrg({ name: 'Idx E', slug: 'idx-e' })
    await Desktop.create(makeRow(org._id, { status: 'revoked' }))
    await Desktop.create(makeRow(org._id, { status: 'revoked', name: 'TILL-2' }))
    expect(await Desktop.countDocuments({ orgId: org._id, status: 'revoked' })).toBe(2)
  })
})
