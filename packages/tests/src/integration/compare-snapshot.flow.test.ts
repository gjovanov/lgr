import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestWarehouse } from '../helpers/factories'
import { StockLevel } from 'db/models'
import { compareSnapshot } from 'services/biz/files/compare-snapshot.service'
import ExcelJS from 'exceljs'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

/** The price tiers the service compares, in export order — mirrors `TIER_NAMES`. */
const TIER_HEADINGS = [
  'Цена на едро', 'Цена 0', 'Цена 1', 'Цена 2', 'Цена 3', 'Цена 4',
  'Цена 5', 'Цена 6', 'Цена 7', 'Цена 8', 'Цена 9',
]

/**
 * Build a storeAvailability-shaped xlsx (headers on row 5, data from row 6).
 *
 * ⚠ Every heading must be written, not just `Име` and `Количество`.
 * `compare-snapshot.service` resolves price columns BY NAME (since 2026-09-01, after a shifted
 * column read as 98 372 price mismatches across 97 % of the catalog), and treats a heading the
 * export does not carry as UNKNOWN rather than zero — deliberately, because reading absent
 * columns as 0 once reported 634 price changes that never happened.
 *
 * So a fixture with only two headings describes an export carrying no price columns at all, and
 * the service correctly compares none of them. That is what made the price-mismatch case below
 * fail: the assertion was right, the sheet it was handed was not a storeAvailability export.
 */
async function buildSnapshot(rows: Array<{ name: string; qty: number; purchase?: number; selling?: number; slots?: number[] }>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('S')
  const header = ws.getRow(5)
  header.getCell(1).value = 'Име'
  header.getCell(2).value = 'Мярка'
  header.getCell(3).value = 'Количество'
  header.getCell(4).value = 'Дост. цена'
  header.getCell(5).value = 'Прод. цена'
  TIER_HEADINGS.forEach((t, i) => { header.getCell(6 + i).value = t })
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
    // The export's „Дост. цена" is the product's „Доставна цена" SLOT. The purchase price is another figure
    // („Цена 2" / 1.2 since 2026-11-15): PROD A's differs from the file's column and is no mismatch.
    const delivery = [{ name: 'Доставна цена', percent: 0, finalPrice: 1.0, manualOverride: true }]
    const a = await createTestProduct(org._id, { name: 'PROD A', sku: 'A', purchasePrice: 0.75, sellingPrice: 2.0, priceTiers: delivery } as any)
    const b = await createTestProduct(org._id, { name: 'PROD B', sku: 'B', purchasePrice: 1.0, sellingPrice: 2.0, priceTiers: delivery } as any)
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

  it('holds the export\'s „Дост. цена" to the „Доставна цена" slot, never to the purchase price', async () => {
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id, { isDefault: true } as any)
    const slot = (finalPrice: number) => [{ name: 'Доставна цена', percent: 0, finalPrice, manualOverride: true }]
    // SAME: the slot agrees with the file, and the purchase price (2 = a „Цена 2" of 2.4 / 1.2) does not have to.
    const same = await createTestProduct(org._id, { name: 'SAME', sku: 'S', purchasePrice: 2, sellingPrice: 3, priceTiers: slot(1.5) } as any)
    // MOVED: the purchase price equals the file's column, as it did on every product until 2026-11-15. The slot is off.
    const moved = await createTestProduct(org._id, { name: 'MOVED', sku: 'M', purchasePrice: 1.5, sellingPrice: 3, priceTiers: slot(1.4) } as any)
    for (const p of [same, moved]) await StockLevel.create({ orgId: org._id, productId: p._id, warehouseId: wh._id, quantity: 1, availableQuantity: 1, avgCost: 1 })

    const res = await compareSnapshot(String(org._id), await buildSnapshot([
      { name: 'SAME', qty: 1, purchase: 1.5, selling: 3 },
      { name: 'MOVED', qty: 1, purchase: 1.5, selling: 3 },
    ]))
    expect(res.rows.filter(r => r.kind === 'price_mismatch').map(r => [r.name, r.field, r.file, r.lgr])).toEqual([['MOVED', 'Дост.цена', 1.5, 1.4]])
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
