import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestProduct,
  createTestWarehouse,
  createTestStockLevel,
} from '../helpers/factories'
import {
  REPORT_REGISTRY,
  listReportsFor,
  reportById,
  canAccessReport,
  validateParams,
} from 'services/biz/report-registry'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import type { Types } from 'mongoose'

/**
 * FR-06 (#14) — the LIVE registry: the real entries, the real handlers, real data.
 * (The pure gate/validator contract is unit-tested in unit/report-registry.test.ts.)
 */

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

/** A caller shaped like the JWT payload the controller passes to the gate. */
function caller(role: keyof typeof DEFAULT_ROLE_PERMISSIONS) {
  return { role, permissions: DEFAULT_ROLE_PERMISSIONS[role] }
}

describe('Report registry — shape', () => {
  it('has unique ids', () => {
    const ids = REPORT_REGISTRY.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every entry a permission — no report is ungated', () => {
    for (const e of REPORT_REGISTRY) {
      expect(e.permission, `${e.id} has no permission`).toBeTruthy()
    }
  })

  it('pairs `runner` entries with a handler and `custom` entries without one', () => {
    for (const e of REPORT_REGISTRY) {
      if (e.view === 'runner') expect(typeof e.handler, `${e.id}`).toBe('function')
      else expect(e.handler, `${e.id}`).toBeUndefined()
    }
  })

  it('declares at least one output per entry, and app-relative routes', () => {
    for (const e of REPORT_REGISTRY) {
      expect(e.outputs.length, `${e.id}`).toBeGreaterThan(0)
      expect(e.route.startsWith('/'), `${e.id} route is not app-relative`).toBe(true)
    }
  })
})

describe('Report catalog gate (FR-6.7)', () => {
  it('shows an admin everything', () => {
    expect(listReportsFor(caller('admin')).length).toBe(REPORT_REGISTRY.length)
  })

  it('shows an accountant the invoicing + inventory reports', () => {
    const ids = listReportsFor(caller('accountant')).map(r => r.id)
    expect(ids).toContain('export')
    expect(ids).toContain('aging')
    // accountant holds inventory.read
    expect(ids).toContain('inventory-valuation')
  })

  it('shows a warehouse_manager the inventory report and nothing invoicing', () => {
    const ids = listReportsFor(caller('warehouse_manager')).map(r => r.id)
    expect(ids).toContain('inventory-valuation')
    expect(ids).not.toContain('export')
    expect(ids).not.toContain('aging')
  })

  it('shows the read-only nra_auditor the invoicing reports', () => {
    // An NRA inspector's whole job is reading and exporting sales data — being told
    // "Forbidden" is the one outcome that must never happen.
    const ids = listReportsFor(caller('nra_auditor')).map(r => r.id)
    expect(ids).toContain('export')
    expect(ids).toContain('aging')
  })

  it('shows an anonymous caller nothing', () => {
    expect(listReportsFor(null)).toEqual([])
  })

  it('never leaks the gate fields over the wire', () => {
    for (const meta of listReportsFor(caller('admin'))) {
      expect(meta).not.toHaveProperty('permission')
      expect(meta).not.toHaveProperty('roles')
      expect(meta).not.toHaveProperty('handler')
    }
  })

  it('contains no accounting or payroll report (scope decision 2026-08-24)', () => {
    const ids = REPORT_REGISTRY.map(e => e.id)
    for (const excluded of ['general-ledger', 'financial-statements', 'journal-analysis', 'tax-returns', 'payroll-summary', 'payslips']) {
      expect(ids).not.toContain(excluded)
    }
  })
})

describe('inventory-valuation handler', () => {
  const entry = () => reportById('inventory-valuation')!

  async function seed() {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const wh1 = await createTestWarehouse(orgId)
    const wh2 = await createTestWarehouse(orgId)
    const bolt = await createTestProduct(orgId, { sku: 'BOLT-1', name: 'Bolt', unit: 'pcs' })
    const nut = await createTestProduct(orgId, { sku: 'NUT-1', name: 'Nut', unit: 'pcs' })
    const gone = await createTestProduct(orgId, { sku: 'GONE-1', name: 'Sold out' })

    // Bolt: 10 @ 5 in wh1 + 20 @ 2 in wh2 → 30 units, value 50 + 40 = 90, avg 3.
    await createTestStockLevel(orgId, bolt._id as Types.ObjectId, wh1._id as Types.ObjectId, { quantity: 10, avgCost: 5, availableQuantity: 10 })
    await createTestStockLevel(orgId, bolt._id as Types.ObjectId, wh2._id as Types.ObjectId, { quantity: 20, avgCost: 2, availableQuantity: 20 })
    // Nut: 4 @ 25 in wh1 → value 100.
    await createTestStockLevel(orgId, nut._id as Types.ObjectId, wh1._id as Types.ObjectId, { quantity: 4, avgCost: 25, availableQuantity: 4, reservedQuantity: 1 })
    // Sold out: a zero row, excluded unless includeZero.
    await createTestStockLevel(orgId, gone._id as Types.ObjectId, wh1._id as Types.ObjectId, { quantity: 0, avgCost: 7, availableQuantity: 0 })

    return { orgId: String(orgId), wh1: String(wh1._id), wh2: String(wh2._id) }
  }

  it('rolls quantity and value up across warehouses', async () => {
    const { orgId } = await seed()
    const res = await entry().handler!({ orgId, params: {}, output: 'table' })

    const bolt = res.rows.find(r => r.sku === 'BOLT-1')!
    expect(bolt.quantity).toBe(30)
    expect(bolt.totalValue).toBe(90)
    // avgCost is derived from the rolled-up value, not averaged over rows.
    expect(bolt.avgCost).toBe(3)

    const nut = res.rows.find(r => r.sku === 'NUT-1')!
    expect(nut.totalValue).toBe(100)
    expect(nut.reserved).toBe(1)
  })

  it('excludes zero-quantity products by default and includes them on request', async () => {
    const { orgId } = await seed()

    const without = await entry().handler!({ orgId, params: { includeZero: false }, output: 'table' })
    expect(without.rows.map(r => r.sku)).not.toContain('GONE-1')

    const with_ = await entry().handler!({ orgId, params: { includeZero: true }, output: 'table' })
    expect(with_.rows.map(r => r.sku)).toContain('GONE-1')
  })

  it('scopes to one warehouse when asked', async () => {
    const { orgId, wh2 } = await seed()
    const res = await entry().handler!({ orgId, params: { warehouseId: wh2 }, output: 'table' })

    // wh2 holds only the Bolt's 20 @ 2.
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0].sku).toBe('BOLT-1')
    expect(res.rows[0].quantity).toBe(20)
    expect(res.totals!.totalValue).toBe(40)
  })

  it('totals match the sum of the returned rows', async () => {
    const { orgId } = await seed()
    const res = await entry().handler!({ orgId, params: {}, output: 'table' })
    const summed = res.rows.reduce((s, r) => s + r.totalValue, 0)
    expect(res.totals!.totalValue).toBeCloseTo(summed, 2)
    expect(res.meta!.rowCount).toBe(res.rows.length)
    expect(res.meta!.truncated).toBe(false)
  })

  it('is org-scoped — another org\'s stock never appears', async () => {
    const { orgId } = await seed()
    const other = await createTestOrg({ slug: `other-${Date.now()}` } as any)
    const otherId = other._id as Types.ObjectId
    const wh = await createTestWarehouse(otherId)
    const p = await createTestProduct(otherId, { sku: 'FOREIGN-1', name: 'Foreign' })
    await createTestStockLevel(otherId, p._id as Types.ObjectId, wh._id as Types.ObjectId, { quantity: 999, avgCost: 1 })

    const res = await entry().handler!({ orgId, params: {}, output: 'table' })
    expect(res.rows.map(r => r.sku)).not.toContain('FOREIGN-1')
  })

  it('declares columns for every key its rows carry', async () => {
    const { orgId } = await seed()
    const res = await entry().handler!({ orgId, params: {}, output: 'table' })
    const declared = new Set(res.columns.map(c => c.key))
    for (const row of res.rows) {
      for (const key of Object.keys(row)) {
        // productId is the drill-down handle, deliberately not a displayed column.
        if (key === 'productId') continue
        expect(declared.has(key), `undeclared column: ${key}`).toBe(true)
      }
    }
  })

  it('runs behind the same gate the catalog applies', () => {
    const e = entry()
    expect(canAccessReport(e, caller('warehouse_manager'))).toBe(true)
    // A payroll-only user holds no inventory.read and must not reach the handler.
    expect(canAccessReport(e, { role: 'member', permissions: ['payroll.read'] })).toBe(false)
  })

  it('accepts its declared params and drops anything else', () => {
    const out = validateParams(entry(), { warehouseId: 'abc', includeZero: 'true', evil: 1 })
    expect(out).toEqual({ warehouseId: 'abc', includeZero: true })
  })
})
