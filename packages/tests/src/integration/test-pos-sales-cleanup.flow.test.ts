import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestUser, createTestWarehouse, createTestProduct, createTestStockLevel,
  createTestPOSSession, createTestPOSTransaction, createTestStockMovement,
} from '../helpers/factories'
import { AuditLog, CostLayer, POSSession, POSTransaction, StockLevel, StockMovement } from 'db/models'
import type { Types } from 'mongoose'
import {
  CleanupRefused, executeTestSaleCleanup, formatPlan, planTestSaleCleanup,
} from '../../../../scripts/remove-test-pos-sales'

/**
 * FR-21.14 (spec §5.2, D-12): the one-off that removes the `regal` org's March–April 2026 test
 * sales before R2. The dry run writes nothing. `--execute` backs up every touched document first,
 * restores stock exactly (StockLevel and cost layers), removes the rows, their movements and their
 * sessions, and keeps the AuditLog append-only. It refuses another org, rows outside the window,
 * and a count that changed since the dry run.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() })

const WINDOW = { orgSlug: 'regal', from: '2026-03-01', to: '2026-04-30' }
const at = (iso: string) => new Date(`${iso}+02:00`)

async function refusal(p: Promise<unknown>): Promise<Error | null> {
  try { await p } catch (e) { return e as Error }
  return null
}

async function world() {
  const org = await createTestOrg({ slug: 'regal', name: 'Регал' } as any)
  const orgId = org._id as Types.ObjectId
  const owner = await createTestUser(orgId, { username: 'owner' } as any)
  const uid = owner._id as Types.ObjectId
  const wh = await createTestWarehouse(orgId, { name: 'Склад 1' } as any)
  const whId = wh._id as Types.ObjectId
  const bolt = await createTestProduct(orgId, { name: 'Bolt M8' } as any)
  const nut = await createTestProduct(orgId, { name: 'Nut M8' } as any)
  await createTestStockLevel(orgId, bolt._id as Types.ObjectId, whId, { quantity: 10, availableQuantity: 10 } as any)
  await createTestStockLevel(orgId, nut._id as Types.ObjectId, whId, { quantity: 5, availableQuantity: 5 } as any)

  // A FIFO layer a test dispatch drew 2 bolts from.
  const layer = await CostLayer.create({
    orgId, productId: bolt._id, warehouseId: whId, unitCost: 3, initialQuantity: 10, remainingQuantity: 4,
    sourceMovementId: (await createTestStockMovement(orgId)).id, sourceMovementNumber: 'SM-2026-00001', receivedAt: at('2026-02-01T09:00:00'),
  } as any)

  // A closed test session with its record-only POS-OUT batch, and an open one.
  const posOut = await createTestStockMovement(orgId, {
    movementNumber: 'POS-OUT-2026-0001', type: 'dispatch', status: 'completed', recordOnly: true, fromWarehouseId: whId,
    lines: [{ productId: bolt._id, quantity: 2, unitCost: 5, totalCost: 10 }],
  } as any)
  const closed = await createTestPOSSession(orgId, whId, uid, { sessionNumber: 'POS-2026-000001', status: 'closed', batchMovementId: posOut._id } as any)
  const open = await createTestPOSSession(orgId, whId, uid, { sessionNumber: 'POS-2026-000002' } as any)

  const sale = (session: any, over: Record<string, any>) => createTestPOSTransaction(orgId, session._id as Types.ObjectId, uid, {
    type: 'sale', status: 'completed', lines: [], subtotal: 10, taxTotal: 2, total: 12, payments: [{ method: 'cash', amount: 12 }],
    isFiscal: true, fiscalDeviceNumber: 'ZK123456', ...over,
  } as any)
  const dispatch = (number: string, lines: any[]) => createTestStockMovement(orgId, {
    movementNumber: number, type: 'dispatch', status: 'completed', fromWarehouseId: whId, lines,
  } as any)

  // 1. Two bolts out of the FIFO layer, linked by `movementId`.
  const m1 = await dispatch('SM-2026-00101', [{ productId: bolt._id, quantity: 2, unitCost: 5, totalCost: 10, costAllocations: [{ costLayerId: layer._id, quantity: 2, unitCost: 3, totalCost: 6 }] }])
  const s1 = await sale(closed, { transactionNumber: 'TXN-2026-0000001', createdAt: at('2026-03-10T10:00:00'), movementId: m1._id })
  // 2. A nut, its movement named only by the sale's note (rows from before `movementId` was kept).
  await dispatch('SM-2026-00102', [{ productId: nut._id, quantity: 1, unitCost: 4, totalCost: 4 }])
  await StockMovement.updateOne({ movementNumber: 'SM-2026-00102' }, { $set: { notes: 'POS sale TXN-2026-0000002' } })
  await sale(closed, { transactionNumber: 'TXN-2026-0000002', createdAt: at('2026-03-11T10:00:00'), isFiscal: false })
  // 3. A sale whose movement never got written (the SM-counter bug of March–April).
  await sale(open, { transactionNumber: 'TXN-2026-0000003', createdAt: at('2026-04-20T10:00:00') })

  // The history the cleanup must keep.
  await AuditLog.create({ orgId, userId: uid, action: 'create', module: 'trade', entityType: 'pos_transaction', entityId: s1._id, entityName: 'TXN-2026-0000001', timestamp: at('2026-03-10T10:00:01') } as any)

  return { org, orgId, owner, wh, whId, bolt, nut, layer, posOut, closed, open }
}

const level = async (orgId: any, productId: any) => (await StockLevel.findOne({ orgId, productId }).lean().exec() as any).quantity

describe('the dry run', () => {
  it('lists every row it would touch and writes nothing', async () => {
    const w = await world()
    const before = {
      txns: await POSTransaction.countDocuments(), movements: await StockMovement.countDocuments(),
      sessions: await POSSession.countDocuments(), audits: await AuditLog.countDocuments(),
      bolt: await level(w.orgId, w.bolt._id), nut: await level(w.orgId, w.nut._id),
    }
    const plan = await planTestSaleCleanup(WINDOW)

    expect(plan.blockers).toEqual([])
    // Newest first, each with its fiscal flag and device.
    expect(plan.sales.map(s => [s.number, s.isFiscal, s.device])).toEqual([
      ['TXN-2026-0000003', true, 'ZK123456'], ['TXN-2026-0000002', false, 'ZK123456'], ['TXN-2026-0000001', true, 'ZK123456'],
    ])
    expect(plan.movements.map(m => [m.number, m.source]).sort()).toEqual([
      ['POS-OUT-2026-0001', 'pos-out'], ['SM-2026-00101', 'sale'], ['SM-2026-00102', 'sale'],
    ])
    expect(plan.stock.map(s => [String(s.productId) === String(w.bolt._id) ? 'bolt' : 'nut', s.add]).sort()).toEqual([['bolt', 2], ['nut', 1]])
    expect(plan.sessions.map(s => [s.number, s.deleted]).sort()).toEqual([['POS-2026-000001', true], ['POS-2026-000002', true]])
    expect(formatPlan(plan)).toContain('Ready: --execute --expect 3')

    expect({
      txns: await POSTransaction.countDocuments(), movements: await StockMovement.countDocuments(),
      sessions: await POSSession.countDocuments(), audits: await AuditLog.countDocuments(),
      bolt: await level(w.orgId, w.bolt._id), nut: await level(w.orgId, w.nut._id),
    }).toEqual(before)
  })
})

describe('it refuses', () => {
  it('any org but regal', async () => {
    await createTestOrg({ slug: 'regal-pz' } as any)
    const e = await refusal(planTestSaleCleanup({ ...WINDOW, orgSlug: 'regal-pz' }))
    expect(e).toBeInstanceOf(CleanupRefused)
    expect(e!.message).toContain('regal')
  })

  it('when a POS row lies outside the window, and changes nothing', async () => {
    const w = await world()
    await createTestPOSTransaction(w.orgId, w.open._id as Types.ObjectId, w.owner._id as Types.ObjectId, {
      transactionNumber: 'TXN-2026-0000099', type: 'sale', status: 'completed', createdAt: at('2026-10-02T10:00:00'),
    } as any)
    const plan = await planTestSaleCleanup(WINDOW)
    expect(plan.outside.map(s => s.number)).toEqual(['TXN-2026-0000099'])
    expect(plan.blockers.join(' ')).toContain('outside')
    expect(formatPlan(plan)).toContain('BLOCKED')

    const e = await refusal(executeTestSaleCleanup(plan, { expectSales: plan.sales.length, backupPath: join(tmpdir(), `fr21-14-${Date.now()}.ndjson`) }))
    expect(e).toBeInstanceOf(CleanupRefused)
    expect(await POSTransaction.countDocuments({ orgId: w.orgId })).toBe(4)
  })

  it('a storno in the window', async () => {
    const w = await world()
    await createTestPOSTransaction(w.orgId, w.open._id as Types.ObjectId, w.owner._id as Types.ObjectId, {
      transactionNumber: 'TXN-2026-0000004', type: 'storno', status: 'completed', createdAt: at('2026-04-21T10:00:00'),
    } as any)
    const plan = await planTestSaleCleanup(WINDOW)
    expect(plan.blockers.join(' ')).toContain('storno')
  })

  it('a count that changed since the dry run, before writing anything', async () => {
    const w = await world()
    const plan = await planTestSaleCleanup(WINDOW)
    const backupPath = join(tmpdir(), `fr21-14-${Date.now()}.ndjson`)
    const e = await refusal(executeTestSaleCleanup(plan, { expectSales: plan.sales.length - 1, backupPath }))
    expect(e).toBeInstanceOf(CleanupRefused)
    expect(existsSync(backupPath)).toBe(false)
    expect(await POSTransaction.countDocuments({ orgId: w.orgId })).toBe(3)
  })
})

describe('--execute', () => {
  it('backs up first, restores stock exactly, removes the rows, keeps the audit history and adds cleanup entries', async () => {
    const w = await world()
    const plan = await planTestSaleCleanup(WINDOW)
    const backupPath = join(tmpdir(), `fr21-14-${Date.now()}.ndjson`)
    try {
      const result = await executeTestSaleCleanup(plan, { expectSales: 3, backupPath, userId: String(w.owner._id) })

      expect(result.verify.ok).toBe(true)
      expect(result.verify.rowsLeftInWindow).toBe(0)
      expect(result.removed).toEqual({ sales: 3, movements: 3, sessions: 2, audits: 3 + 3 + 2 })

      // Stock back exactly: 10 + 2 bolts, 5 + 1 nut. The FIFO layer gets its 2 bolts back.
      expect(await level(w.orgId, w.bolt._id)).toBe(12)
      expect(await level(w.orgId, w.nut._id)).toBe(6)
      const layer: any = await CostLayer.findById(w.layer._id).lean().exec()
      expect(layer.remainingQuantity).toBe(6)

      // The rows, their movements (the POS-OUT batch too) and their sessions are gone.
      expect(await POSTransaction.countDocuments({ orgId: w.orgId })).toBe(0)
      expect(await StockMovement.countDocuments({ orgId: w.orgId, movementNumber: { $in: ['SM-2026-00101', 'SM-2026-00102', 'POS-OUT-2026-0001'] } })).toBe(0)
      expect(await POSSession.countDocuments({ orgId: w.orgId })).toBe(0)

      // The AuditLog is append-only: the old entry stays, one `cleanup` entry per removed document.
      expect(await AuditLog.countDocuments({ orgId: w.orgId, action: 'create', entityName: 'TXN-2026-0000001' })).toBe(1)
      const cleanups = await AuditLog.find({ orgId: w.orgId, action: 'cleanup' }).lean().exec()
      expect(cleanups.map((a: any) => a.entityType).sort()).toEqual([
        'pos_session', 'pos_session', 'pos_transaction', 'pos_transaction', 'pos_transaction', 'stock_movement', 'stock_movement', 'stock_movement',
      ])
      expect(cleanups.every((a: any) => String(a.userId) === String(w.owner._id))).toBe(true)

      // The backup holds every touched document, written before anything changed.
      const lines = readFileSync(backupPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      expect(lines[0]).toMatchObject({ kind: 'header', fr: 'FR-21.14', org: { slug: 'regal' } })
      const by = (c: string) => lines.filter(l => l.collection === c)
      expect(by('postransactions').map(l => l.doc.transactionNumber).sort()).toEqual(['TXN-2026-0000001', 'TXN-2026-0000002', 'TXN-2026-0000003'])
      expect(by('stockmovements')).toHaveLength(3)
      expect(by('possessions')).toHaveLength(2)
      expect(by('stocklevels').map(l => l.doc.quantity).sort()).toEqual([10, 5].sort())
      expect(by('costlayers')[0].doc.remainingQuantity).toBe(4)
    } finally {
      rmSync(backupPath, { force: true })
    }
  })
})
