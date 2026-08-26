import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestWarehouse } from '../helpers/factories'
import { StockLevel } from 'db/models'
import { compareSnapshot } from 'services/biz/files/compare-snapshot.service'
import ExcelJS from 'exceljs'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

/** Build a storeAvailability-shaped xlsx (headers on row 5, data from row 6). */
async function buildSnapshot(rows: Array<{ name: string; qty: number; purchase?: number; selling?: number; slots?: number[] }>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('S')
  ws.getRow(5).getCell(1).value = 'Име'
  ws.getRow(5).getCell(3).value = 'Количество'
  rows.forEach((r, i) => {
    const row = ws.getRow(6 + i)
    row.getCell(1).value = r.name
    row.getCell(2).value = 'бр'
    row.getCell(3).value = r.qty
    row.getCell(4).value = r.purchase ?? 0
    row.getCell(5).value = r.selling ?? 0
    ;(r.slots ?? []).forEach((v, j) => { row.getCell(6 + j).value = v })
  })
  return Buffer.from(await wb.xlsx.writeBuffer())
}

describe('Files — compare-snapshot', () => {
  it('finds qty diffs, price diffs and missing products vs the live catalog', async () => {
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id, { isDefault: true } as any)
    const a = await createTestProduct(org._id, { name: 'PROD A', sku: 'A', purchasePrice: 1.0, sellingPrice: 2.0 } as any)
    const b = await createTestProduct(org._id, { name: 'PROD B', sku: 'B', purchasePrice: 1.0, sellingPrice: 2.0 } as any)
    await StockLevel.create({ orgId: org._id, productId: a._id, warehouseId: wh._id, quantity: 100, availableQuantity: 100, avgCost: 1 })
    await StockLevel.create({ orgId: org._id, productId: b._id, warehouseId: wh._id, quantity: 50, availableQuantity: 50, avgCost: 1 })

    const buffer = await buildSnapshot([
      { name: 'PROD A', qty: 90, purchase: 1.0, selling: 2.0 }, // qty diff -10, no price diff
      { name: 'PROD B', qty: 50, purchase: 1.0, selling: 3.0 }, // qty match, selling diff (2.0 → 3.0)
      { name: 'PROD C', qty: 5, purchase: 0, selling: 0 },      // not in LGR → missing
    ])

    const res = await compareSnapshot(String(org._id), buffer)

    expect(res.summary.snapshotRows).toBe(3)
    expect(res.summary.matched).toBe(2)
    expect(res.summary.missingFromLgr).toBe(1)
    expect(res.summary.qtyMismatches).toBe(1)
    expect(res.summary.priceMismatches).toBe(1)

    const qty = res.rows.find(r => r.kind === 'qty_mismatch')
    expect(qty?.name).toBe('PROD A'); expect(qty?.file).toBe(90); expect(qty?.lgr).toBe(100); expect(qty?.diff).toBe(-10)
    const price = res.rows.find(r => r.kind === 'price_mismatch')
    expect(price?.name).toBe('PROD B'); expect(price?.field).toBe('Прод.цена'); expect(price?.file).toBe(3); expect(price?.lgr).toBe(2)
    const miss = res.rows.find(r => r.kind === 'missing_in_lgr')
    expect(miss?.name).toBe('PROD C')

    // CSV is byte-shaped like the CLI (kind,sku,name,field,file,lgr,diff)
    expect(res.csv.split('\n')[0]).toBe('kind,sku,name,field,file,lgr,diff')
    expect(res.csv).toContain('qty_mismatch,A,"PROD A",quantity,90,100,-10')
  })

  it('sums duplicate names (correction/split rows) before comparing', async () => {
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id, { isDefault: true } as any)
    const p = await createTestProduct(org._id, { name: 'DUP', sku: 'D', purchasePrice: 1, sellingPrice: 1 } as any)
    await StockLevel.create({ orgId: org._id, productId: p._id, warehouseId: wh._id, quantity: 30, availableQuantity: 30, avgCost: 1 })
    // two rows for DUP: 20 + 10 = 30 net → matches LGR, no qty diff
    const buffer = await buildSnapshot([{ name: 'DUP', qty: 20 }, { name: 'DUP', qty: 10 }])
    const res = await compareSnapshot(String(org._id), buffer)
    expect(res.summary.qtyMismatches).toBe(0)
    expect(res.summary.matched).toBe(1)
  })
})
