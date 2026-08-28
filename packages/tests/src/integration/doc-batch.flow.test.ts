import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestWarehouse, createTestUser } from '../helpers/factories'
import { DocFile, StockLevel } from 'db/models'
import { analyzeDocFilesBatch, commitDocFilesBatch } from 'services/biz/files/doc-pipeline.service'
import ExcelJS from 'exceljs'
import { tmpdir } from 'os'
import { join } from 'path'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

/** A storeOperations „Доставки" (receipt) export — analyzes with no OCR sidecar. */
async function storeOperationsBook(items: Array<[string, number]>, period: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('S')
  ws.getRow(2).getCell(1).value = 'Склад: ОБЕКТИ:СКЛАД - 1'
  ws.getRow(3).getCell(1).value = `Период: ${period}`
  ws.getRow(4).getCell(1).value = 'Операция: Доставки'
  ws.getRow(9).getCell(1).value = 'Име'; ws.getRow(9).getCell(2).value = 'Мярка'
  ws.getRow(9).getCell(3).value = 'Количество'; ws.getRow(9).getCell(4).value = 'Цена'; ws.getRow(9).getCell(5).value = 'Стойност'
  let r = 10
  for (const [name, qty] of items) { const row = ws.getRow(r); row.getCell(1).value = name; row.getCell(2).value = 'БР'; row.getCell(3).value = qty; row.getCell(4).value = 1; row.getCell(5).value = qty; r++ }
  ws.getRow(r).getCell(1).value = 'Всичко'; ws.getRow(r).getCell(3).value = items.reduce((s, i) => s + i[1], 0)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

async function makeDoc(org: any, user: any, buf: Buffer, docNumber: string, docDate: string): Promise<any> {
  const path = join(tmpdir(), `so-batch-${docNumber}.xlsx`)
  await Bun.write(path, buf)
  return DocFile.create({
    orgId: org._id, docType: 'store_operations', docNumber, docDate,
    originalName: `storeOperations_${docNumber}.xlsx`, currentPath: path, currentChecksum: docNumber,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: buf.length, uploadedBy: user._id,
  })
}
async function qtyAt(orgId: any, productId: any, warehouseId: any): Promise<number> {
  const sl: any = await StockLevel.findOne({ orgId, productId, warehouseId }).lean()
  return Number(sl?.quantity) || 0
}

describe('Files — batch analyze + commit', () => {
  it('analyzes and commits a selection in one job each (batched, no N+1)', async () => {
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id, { isDefault: true, name: 'Main' } as any)
    const user = await createTestUser(org._id)
    const a = await createTestProduct(org._id, { name: 'Гайка М8', sku: 'GM8' } as any)
    const b = await createTestProduct(org._id, { name: 'Болт М6', sku: 'BM6' } as any)
    const orgId = String(org._id), uid = String(user._id)

    const d1 = await makeDoc(org, user, await storeOperationsBook([['Гайка М8', 100]], '24.07.2026 - 24.07.2026'), '20260724_120000', '2026-07-24')
    const d2 = await makeDoc(org, user, await storeOperationsBook([['Болт М6', 50]], '25.07.2026 - 25.07.2026'), '20260725_120000', '2026-07-25')

    // ── batch analyze ──
    const analyzed = await analyzeDocFilesBatch(orgId, uid, [String(d1._id), String(d2._id)])
    expect(analyzed.length).toBe(2)
    for (const r of analyzed) { expect(r.target).toBe('movement'); expect(r.matched).toBe(1); expect(r.total).toBe(1); expect(r.committable).toBe(true); expect(r.recommended).toBe(true) }
    // persisted via bulkWrite
    expect((await DocFile.findById(d1._id))!.status).toBe('analyzed')
    expect((await DocFile.findById(d2._id))!.status).toBe('analyzed')

    // ── batch commit ──
    const committed = await commitDocFilesBatch(orgId, uid, [String(d1._id), String(d2._id)])
    expect(committed.length).toBe(2)
    expect(committed.every((r) => r.ok)).toBe(true)
    expect(await qtyAt(orgId, a._id, wh._id)).toBe(100)
    expect(await qtyAt(orgId, b._id, wh._id)).toBe(50)
    const doc1 = await DocFile.findById(d1._id)
    expect(doc1!.status).toBe('committed')
    expect(doc1!.committedTarget).toBe('movement')
    expect(doc1!.markers).toContain('storeOperations:2026-07-24')

    // ── re-analyzing a committed doc reuses its analysis but is NOT offered for commit again ──
    const reanalyzed = await analyzeDocFilesBatch(orgId, uid, [String(d1._id)])
    expect(reanalyzed[0].committed).toBe(true)
    expect(reanalyzed[0].committable).toBe(false)
    expect(reanalyzed[0].recommended).toBe(false)
  })

  it('reuses a prior analysis unless forced, and reports progress', async () => {
    const org = await createTestOrg()
    await createTestWarehouse(org._id, { isDefault: true } as any)
    const user = await createTestUser(org._id)
    await createTestProduct(org._id, { name: 'Гайка М8', sku: 'GM8' } as any)
    const orgId = String(org._id), uid = String(user._id)
    const d1 = await makeDoc(org, user, await storeOperationsBook([['Гайка М8', 10]], '24.07.2026 - 24.07.2026'), '20260724_130000', '2026-07-24')

    let ticks = 0
    await analyzeDocFilesBatch(orgId, uid, [String(d1._id)], {}, () => { ticks++ })
    expect(ticks).toBe(1) // progress fired once (1 doc)

    const again = await analyzeDocFilesBatch(orgId, uid, [String(d1._id)])
    expect(again[0].reused).toBe(true) // second pass reused the stored analysis

    const forced = await analyzeDocFilesBatch(orgId, uid, [String(d1._id)], { force: true })
    expect(forced[0].reused).toBeUndefined() // forced → re-analyzed
  })

  it('surfaces a non-analyzable doc as a per-doc error, not a batch failure', async () => {
    const org = await createTestOrg()
    await createTestWarehouse(org._id, { isDefault: true } as any)
    const user = await createTestUser(org._id)
    const orgId = String(org._id), uid = String(user._id)
    const bad = await DocFile.create({
      orgId: org._id, docType: 'store_availability', docNumber: '20260724_1', docDate: '2026-07-24',
      originalName: 'storeAvailability_20260724_1.xlsx', currentPath: '/nope', currentChecksum: 'x', mimeType: 'x', size: 1, uploadedBy: user._id,
    })
    const res = await analyzeDocFilesBatch(orgId, uid, [String(bad._id)])
    expect(res.length).toBe(1)
    expect(res[0].error).toContain('not analyzable')
    expect(res[0].committable).toBe(false)
  })
})
