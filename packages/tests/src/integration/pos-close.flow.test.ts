import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestWarehouse, createTestUser, createTestPOSSession } from '../helpers/factories'
import { expectedTotals, buildClosingBreakdown } from 'invoicing-api/src/controllers/pos.controller'
import { POSSession } from 'db/models'
import type { Types } from 'mongoose'

/**
 * FR-09 (#18) — „Каса и приключване".
 *
 * The endpoint itself needs a live fiscal device to exercise end to end, so these tests pin
 * the pure arithmetic the close screen and the persisted breakdown are built from, plus the
 * concurrency guard that stops two tills from each firing their own Z-report.
 *
 * NOTE: no `.rejects` / `.resolves` anywhere — they deadlock under Bun on Windows after
 * MongoDB I/O (see CLAUDE.md Known Issues). try/catch capture instead.
 */

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

describe('expectedTotals (FR-9.3)', () => {
  it('adds the opening float to cash but not to card', () => {
    expect(expectedTotals({ openingBalance: 500, totalCash: 120.5, totalCard: 80, totalOther: 0 }))
      .toEqual({ cash: 620.5, card: 80, other: 0 })
  })

  it('treats a session predating totalOther as zero', () => {
    // Sessions created before FR-9.2 have no `totalOther` at all.
    expect(expectedTotals({ openingBalance: 100, totalCash: 0, totalCard: 0 }))
      .toEqual({ cash: 100, card: 0, other: 0 })
  })

  it('rounds to cents rather than carrying float noise', () => {
    expect(expectedTotals({ openingBalance: 0.1, totalCash: 0.2, totalCard: 0, totalOther: 0 }).cash).toBe(0.3)
  })
})

describe('buildClosingBreakdown (FR-9.1)', () => {
  it('produces one line per method with the signed difference', () => {
    const out = buildClosingBreakdown({ cash: 620.5, card: 80, other: 0 }, { cash: 615, card: 80 })
    expect(out).toEqual([
      { method: 'cash', expected: 620.5, counted: 615, difference: -5.5 },
      { method: 'card', expected: 80, counted: 80, difference: 0 },
      { method: 'other', expected: 0, counted: 0, difference: 0 },
    ])
  })

  it('treats an omitted method as counted zero, not as "matches expected"', () => {
    // A blank card field means "I counted nothing", which is a real shortage.
    const out = buildClosingBreakdown({ cash: 100, card: 50, other: 0 }, { cash: 100 })
    expect(out.find(l => l.method === 'card')).toEqual({ method: 'card', expected: 50, counted: 0, difference: -50 })
  })

  it('keeps the cash line first so the legacy fields map from it', () => {
    // closingBalance/expectedBalance/difference stay cash-only for the JE handler.
    expect(buildClosingBreakdown({ cash: 1, card: 2, other: 3 }, {})[0].method).toBe('cash')
  })
})

describe('close concurrency guard (FR-9.4)', () => {
  async function openSession() {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const wh = await createTestWarehouse(orgId)
    const user = await createTestUser(orgId)
    const session = await createTestPOSSession(orgId, wh._id as Types.ObjectId, user._id as Types.ObjectId, {
      openingBalance: 500, totalCash: 120, totalCard: 80,
    })
    return { orgId, session }
  }

  it('lets exactly one of two concurrent claims through', async () => {
    const { orgId, session } = await openSession()
    const claim = () =>
      POSSession.findOneAndUpdate(
        { _id: session._id, orgId, status: 'open' },
        { $set: { status: 'closing_control' } },
        { new: true },
      ).exec()

    const [a, b] = await Promise.all([claim(), claim()])
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it('leaves the session claimable again after a release', async () => {
    const { orgId, session } = await openSession()
    await POSSession.findOneAndUpdate({ _id: session._id, orgId, status: 'open' }, { $set: { status: 'closing_control' } }).exec()
    // A fiscal failure puts it back to `open` so the operator can retry.
    await POSSession.updateOne({ _id: session._id, orgId }, { $set: { status: 'open', fiscalStatus: 'failed', fiscalError: 'not connected' } }).exec()

    const again = await POSSession.findOneAndUpdate(
      { _id: session._id, orgId, status: 'open' },
      { $set: { status: 'closing_control' } },
      { new: true },
    ).exec()
    expect(again).toBeTruthy()
    expect((again as any).fiscalStatus).toBe('failed')
  })

  it('will not claim an already-closed session', async () => {
    const { orgId, session } = await openSession()
    await POSSession.updateOne({ _id: session._id, orgId }, { $set: { status: 'closed' } }).exec()
    const claimed = await POSSession.findOneAndUpdate(
      { _id: session._id, orgId, status: 'open' },
      { $set: { status: 'closing_control' } },
    ).exec()
    expect(claimed).toBeNull()
  })
})

describe('session model (FR-9.1/9.2)', () => {
  it('persists the breakdown and the fiscal outcome', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const wh = await createTestWarehouse(orgId)
    const user = await createTestUser(orgId)
    const session = await createTestPOSSession(orgId, wh._id as Types.ObjectId, user._id as Types.ObjectId)

    const breakdown = buildClosingBreakdown({ cash: 100, card: 20, other: 5 }, { cash: 98, card: 20, other: 5 })
    await POSSession.updateOne({ _id: session._id }, {
      $set: {
        status: 'closed', closingBreakdown: breakdown,
        fiscalStatus: 'closed', zReportNumber: '0042', fiscalClosedAt: new Date(),
      },
    }).exec()

    const reloaded = await POSSession.findById(session._id).lean() as any
    expect(reloaded.closingBreakdown).toHaveLength(3)
    expect(reloaded.closingBreakdown[0]).toMatchObject({ method: 'cash', expected: 100, counted: 98, difference: -2 })
    expect(reloaded.fiscalStatus).toBe('closed')
    expect(reloaded.zReportNumber).toBe('0042')
  })

  it('defaults totalOther to 0 on a new session', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const wh = await createTestWarehouse(orgId)
    const user = await createTestUser(orgId)
    const session = await createTestPOSSession(orgId, wh._id as Types.ObjectId, user._id as Types.ObjectId)
    const reloaded = await POSSession.findById(session._id).lean() as any
    expect(reloaded.totalOther).toBe(0)
  })

  it('accumulates non-cash/card tenders into totalOther', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const wh = await createTestWarehouse(orgId)
    const user = await createTestUser(orgId)
    const session = await createTestPOSSession(orgId, wh._id as Types.ObjectId, user._id as Types.ObjectId)

    // What the transaction route now does for a voucher payment.
    await POSSession.findByIdAndUpdate(session._id, { $inc: { totalOther: 25 } }).exec()
    const reloaded = await POSSession.findById(session._id).lean() as any
    expect(reloaded.totalOther).toBe(25)
    expect(expectedTotals(reloaded).other).toBe(25)
  })
})
