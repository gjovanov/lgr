import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestWarehouse, createTestProduct, createTestPOSSession } from '../helpers/factories'
import { mongoose } from 'db/connection'
import { StockMovement } from 'db/models'
import { runMigrations } from 'migrations/runner'
import { posOutRecordOnly } from 'migrations/migrations/0006-pos-out-record-only'
import { reportById, validateParams } from 'services/biz/report-registry'
import { exportStockMovementSummary } from 'services/biz/supto-export.service'
import { buildDailyDigest } from 'services/biz/digest/daily-digest.service'
import type { Types } from 'mongoose'

/**
 * FR-21.4 (B-4) — the POS-OUT session batch dispatch counted every POS sale twice.
 *
 * The old session-close handler wrote one per session: a `completed` dispatch that never went
 * through `confirmMovement`, so it moved nothing, while each sale had already moved its goods with
 * its own `SM-` dispatch. `0006` marks the existing ones record-only, and the three readers that
 * sum movements skip them. (The handler no longer writes one: pos-session-journal.flow.)
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() })

const db = () => mongoose.connection.db!
const migrate = () => runMigrations({ db: db(), migrations: [posOutRecordOnly] })
const DAY = '2026-05-10'
const AT = new Date(`${DAY}T12:00:00`)

/** A POS sale's own dispatch, and the batch the old handler wrote for its session. */
async function seed() {
  const org = await createTestOrg()
  const orgId = org._id as Types.ObjectId
  const user = await createTestUser(orgId)
  const wh = await createTestWarehouse(orgId)
  const bolt = await createTestProduct(orgId, { sku: 'BOLT-1', name: 'Bolt', unit: 'pcs', avgCost: 2 })
  const line = { productId: bolt._id, quantity: 3, unitCost: 5, totalCost: 15 }

  const sale = await StockMovement.create({
    orgId, movementNumber: 'SM-2026-00001', type: 'dispatch', status: 'completed', date: AT,
    fromWarehouseId: wh._id, lines: [line], totalAmount: 15, notes: 'POS sale TXN-2026-0000001', createdBy: user._id,
  })
  const batch = await StockMovement.create({
    orgId, movementNumber: 'POS-OUT-2026-000001', type: 'dispatch', status: 'completed', date: AT,
    fromWarehouseId: wh._id, lines: [line], totalAmount: 15, notes: 'POS session POS-2026-000001 batch dispatch', createdBy: user._id,
  })
  await createTestPOSSession(orgId, wh._id as Types.ObjectId, user._id as Types.ObjectId, {
    status: 'closed', batchMovementId: batch._id as Types.ObjectId,
  })
  return { orgId, user, wh, bolt, sale, batch }
}

describe('0006-pos-out-record-only', () => {
  it('marks the batch record-only and nothing else, and changes nothing the second time', async () => {
    const s = await seed()
    // A batch no session points at any more, found by its number.
    const orphan = await StockMovement.create({
      orgId: s.orgId, movementNumber: 'POS-OUT-2026-000002', type: 'dispatch', status: 'completed', date: AT,
      fromWarehouseId: s.wh._id, lines: [], totalAmount: 0, createdBy: s.user._id,
    })

    await migrate()
    const flags = async () => Object.fromEntries(
      (await StockMovement.find({ orgId: s.orgId }).lean()).map((m: any) => [m.movementNumber, m.recordOnly ?? false]),
    )
    expect(await flags()).toEqual({
      'SM-2026-00001': false,
      'POS-OUT-2026-000001': true,
      'POS-OUT-2026-000002': true,
    })
    expect(String(orphan._id)).toBeTruthy()

    const before = await StockMovement.find({ orgId: s.orgId }).sort({ movementNumber: 1 }).lean()
    // Recorded once by the runner; run the body again to hold it to its idempotence.
    await posOutRecordOnly.up({ db: db(), log: () => {}, orgFilter: {} })
    const after = await StockMovement.find({ orgId: s.orgId }).sort({ movementNumber: 1 }).lean()
    expect(after.map((m: any) => [m.movementNumber, m.recordOnly, String(m.updatedAt)]))
      .toEqual(before.map((m: any) => [m.movementNumber, m.recordOnly, String(m.updatedAt)]))
  })

  it('touches only the orgs in its filter', async () => {
    const a = await seed()
    const b = await seed()
    await posOutRecordOnly.up({ db: db(), log: () => {}, orgFilter: { orgId: a.orgId } })
    expect((await StockMovement.findById(a.batch._id).lean())!.recordOnly).toBe(true)
    expect((await StockMovement.findById(b.batch._id).lean())!.recordOnly).toBeUndefined()
  })
})

describe('the movement readers skip a record-only movement', () => {
  it('FR-07 warehouse operations counts the sale once', async () => {
    const s = await seed()
    const entry = reportById('warehouse-operations')!
    const run = () => entry.handler!({
      orgId: String(s.orgId),
      params: validateParams(entry, { operation: 'sales', period: { preset: 'custom', from: DAY, to: DAY } }),
      output: 'table',
    })
    expect((await run()).rows.find(r => r.sku === 'BOLT-1')!.quantity).toBe(6)
    await migrate()
    expect((await run()).rows.find(r => r.sku === 'BOLT-1')!.quantity).toBe(3)
  })

  it('SUPTO 18.8 lists the sale\'s movement, not the batch', async () => {
    const s = await seed()
    await migrate()
    const { movements } = await exportStockMovementSummary({
      orgId: String(s.orgId), dateFrom: new Date(`${DAY}T00:00:00`), dateTo: new Date(`${DAY}T23:59:59`),
    })
    expect(movements.map((m: any) => m.movementNumber)).toEqual(['SM-2026-00001'])
  })

  it('the digest\'s materials sold (FR-11.7c) count the sale once', async () => {
    const s = await seed()
    await migrate()
    const digest = await buildDailyDigest(String(s.orgId), DAY, { sections: { materials: true } })
    const sold = (digest as any).materials.sold
    expect(sold.rows.map((r: any) => r.quantity)).toEqual([3])
    expect(sold.totalValue).toBe(15)
  })
})
