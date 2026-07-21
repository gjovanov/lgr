import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestWarehouse, createTestProduct, createTestStockLevel } from '../helpers/factories'
import ExcelJS from 'exceljs'
import { applyOpeningStock, parseOpeningStock } from 'warehouse-api/src/lib/opening-stock'
import { StockLevel, StockMovement } from 'db/models'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

describe('opening stock import', () => {
  it('sets levels to the file quantity, matches by name, records one adjustment, is idempotent', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const p1 = await createTestProduct(org._id, { name: 'Гайка М8' } as any)
    const p2 = await createTestProduct(org._id, { name: 'Болт М6' } as any)
    await createTestStockLevel(org._id, p1._id, wh._id, { quantity: 5 } as any) // existing → set to 100

    // Pre-seed an existing scan-numbered movement (reproduces the prod state that
    // collided with the old atomic `SM` counter). The import must skip past it.
    const year = new Date().getFullYear()
    await StockMovement.create({
      orgId: org._id, movementNumber: `SM-${year}-00001`, type: 'adjustment', status: 'completed',
      date: new Date(), toWarehouseId: wh._id, lines: [], totalAmount: 0, createdBy: user._id,
    } as any)

    const rows = [
      { name: 'Гайка М8', quantity: 100, cost: 0.1 },
      { name: 'Болт М6', quantity: 50, cost: 0.05 }, // no existing level → set to 50
      { name: 'Несъществуващ продукт', quantity: 10, cost: 1 }, // unmatched
    ]
    const res = await applyOpeningStock(String(org._id), String(wh._id), rows, String(user._id), async () => {})
    expect(res.matched).toBe(2)
    expect(res.unmatched).toBe(1)
    expect(res.adjusted).toBe(2)
    expect(res.unmatchedSamples).toContain('Несъществуващ продукт')

    const sl1: any = await StockLevel.findOne({ orgId: org._id, productId: p1._id, warehouseId: wh._id }).lean()
    expect(sl1.quantity).toBe(100) // set to target (delta +95)
    const sl2: any = await StockLevel.findOne({ orgId: org._id, productId: p2._id, warehouseId: wh._id }).lean()
    expect(sl2.quantity).toBe(50)

    const mv = await StockMovement.countDocuments({ orgId: org._id, type: 'adjustment', notes: 'Opening stock import' } as any)
    expect(mv).toBe(1)
    // scan-based numbering skips the pre-seeded SM-…-00001 → no E11000 collision
    expect(res.movementNumber).toBe(`SM-${year}-00002`)
    const osMv: any = await StockMovement.findOne({ orgId: org._id, notes: 'Opening stock import' }).lean()
    expect(osMv.movementNumber).toBe(`SM-${year}-00002`)

    // idempotent — re-run makes no changes
    const res2 = await applyOpeningStock(String(org._id), String(wh._id), rows, String(user._id), async () => {})
    expect(res2.adjusted).toBe(0)
    const sl1b: any = await StockLevel.findOne({ orgId: org._id, productId: p1._id, warehouseId: wh._id }).lean()
    expect(sl1b.quantity).toBe(100)
  })

  it('exact-matches ambiguous names 1:1 (fuzzy tokenized search would oscillate)', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    // "ВИНТ" is a token-subset of "ВИНТ ДЪЛЪГ М14": the fuzzy name/sku search matches
    // BOTH products for the row "ВИНТ", so the two rows fight over one product and the
    // import oscillates (never idempotent). Exact `nameLower` match resolves each 1:1.
    const pShort = await createTestProduct(org._id, { name: 'ВИНТ' } as any)
    const pLong = await createTestProduct(org._id, { name: 'ВИНТ ДЪЛЪГ М14' } as any)

    const rows = [
      { name: 'ВИНТ', quantity: 10, cost: 0.1 },
      { name: 'ВИНТ ДЪЛЪГ М14', quantity: 20, cost: 0.2 },
    ]
    const res = await applyOpeningStock(String(org._id), String(wh._id), rows, String(user._id), async () => {})
    expect(res.matched).toBe(2)
    expect(res.adjusted).toBe(2)

    const slShort: any = await StockLevel.findOne({ orgId: org._id, productId: pShort._id, warehouseId: wh._id }).lean()
    const slLong: any = await StockLevel.findOne({ orgId: org._id, productId: pLong._id, warehouseId: wh._id }).lean()
    expect(slShort.quantity).toBe(10) // exact → "ВИНТ" gets 10 (not 20)
    expect(slLong.quantity).toBe(20)

    // idempotent — the fuzzy path oscillates these; exact-first must settle to 0 deltas
    const res2 = await applyOpeningStock(String(org._id), String(wh._id), rows, String(user._id), async () => {})
    expect(res2.adjusted).toBe(0)
  })

  it('parseOpeningStock sums duplicate-name lines into one net-quantity row', async () => {
    // The PlusMinus export lists some products on two lines (correction pairs).
    // Those must collapse to one net row, else the import oscillates forever.
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('s')
    for (let i = 1; i < 6; i++) ws.addRow([`header-${i}`]) // rows 1..5 ignored (DATA_START=6)
    ws.addRow(['ВИНТ М4Х70 - DIN 963', '', 93, 0.2])
    ws.addRow(['ВИНТ М4Х70 - DIN 963', '', 104, 0.25]) // same product → sum to 197
    ws.addRow(['Опаковка', '', 5, 1])                   // skipped (SKIP set)
    ws.addRow(['ГАЙКА М8', '', 10, 0.1])
    const buf = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer)

    const parsed = await parseOpeningStock(buf)
    expect(parsed.length).toBe(2) // merged ВИНТ + ГАЙКА
    const vint = parsed.find(r => r.name.startsWith('ВИНТ'))!
    expect(vint.quantity).toBe(197)
    expect(vint.cost).toBe(0.25) // cost of the larger-magnitude line (qty 104)
    expect(parsed.find(r => r.name.startsWith('ГАЙКА'))!.quantity).toBe(10)
  })
})
