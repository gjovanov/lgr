import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestWarehouse, createTestUser } from '../helpers/factories'
import { DocFile, StockLevel, StockMovement, Product } from 'db/models'
import { analyzeDocFilesBatch, commitDocFilesBatch } from 'services/biz/files/doc-pipeline.service'
import { deleteDocFiles } from 'services/biz/files/doc-delete.service'
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
  const path = join(tmpdir(), `so-del-${docNumber}.xlsx`)
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
/** analyze + commit a doc, returning it fresh. */
async function commitOne(orgId: string, uid: string, doc: any) {
  await analyzeDocFilesBatch(orgId, uid, [String(doc._id)])
  await commitDocFilesBatch(orgId, uid, [String(doc._id)])
  return DocFile.findById(doc._id)
}

describe('Files — batch delete + rollback', () => {
  it('dry-run changes nothing, then execute reverses the movement and removes the document', async () => {
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id, { isDefault: true, name: 'Main' } as any)
    const user = await createTestUser(org._id)
    const p = await createTestProduct(org._id, { name: 'Гайка М8', sku: 'GM8' } as any)
    const orgId = String(org._id), uid = String(user._id)

    const doc = await makeDoc(org, user, await storeOperationsBook([['Гайка М8', 100]], '24.07.2026 - 24.07.2026'), '20260724_120000', '2026-07-24')
    const committed = await commitOne(orgId, uid, doc)
    expect(committed!.status).toBe('committed')
    expect(await qtyAt(orgId, p._id, wh._id)).toBe(100)

    // ── dry run ──
    const dry = await deleteDocFiles(orgId, uid, [String(doc._id)], { rollback: true })
    expect(dry.executed).toBe(false)
    expect(dry.totals.movements).toBe(1)
    expect(dry.plans[0].movements[0].action).toBe('reverse')
    const impact = dry.stockImpact.find((s) => s.sku === 'GM8')
    expect(impact?.delta).toBe(-100)   // reversing a receipt takes the stock back out
    expect(impact?.after).toBe(0)
    expect(await qtyAt(orgId, p._id, wh._id)).toBe(100)          // untouched
    expect(await DocFile.countDocuments({ orgId, _id: doc._id })).toBe(1)

    // ── execute ──
    const res = await deleteDocFiles(orgId, uid, [String(doc._id)], { rollback: true, execute: true })
    expect(res.executed).toBe(true)
    expect(res.reversals?.length).toBe(1)
    expect(res.deleted).toEqual(['20260724_120000'])
    expect(await qtyAt(orgId, p._id, wh._id)).toBe(0)            // stock rolled back
    expect(await DocFile.countDocuments({ orgId, _id: doc._id })).toBe(0)  // hard-deleted
    const movs = await StockMovement.find({ orgId }).lean()
    expect(movs.length).toBe(2)                                   // original + its reversal
    expect(movs.some((m: any) => String(m.notes).includes('docdelete:20260724_120000'))).toBe(true)
  })

  it('hard-deletes so the same document number can be re-uploaded afterwards', async () => {
    const org = await createTestOrg()
    await createTestWarehouse(org._id, { isDefault: true } as any)
    const user = await createTestUser(org._id)
    await createTestProduct(org._id, { name: 'Гайка М8', sku: 'GM8' } as any)
    const orgId = String(org._id), uid = String(user._id)
    const buf = await storeOperationsBook([['Гайка М8', 10]], '24.07.2026 - 24.07.2026')
    const doc = await makeDoc(org, user, buf, '20260724_140000', '2026-07-24')
    await commitOne(orgId, uid, doc)
    await deleteDocFiles(orgId, uid, [String(doc._id)], { rollback: true, execute: true })
    // the unique {orgId,docType,docNumber} index must be free again
    const again = await makeDoc(org, user, buf, '20260724_140000', '2026-07-28')
    expect(String(again.docNumber)).toBe('20260724_140000')
  })

  it('PROVENANCE GUARD: a booking made before the current file version is not rolled back without force', async () => {
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id, { isDefault: true } as any)
    const user = await createTestUser(org._id)
    const p = await createTestProduct(org._id, { name: 'Гайка М8', sku: 'GM8' } as any)
    const orgId = String(org._id), uid = String(user._id)

    const doc = await makeDoc(org, user, await storeOperationsBook([['Гайка М8', 40]], '24.07.2026 - 24.07.2026'), '20260724_150000', '2026-07-24')
    await commitOne(orgId, uid, doc)
    expect(await qtyAt(orgId, p._id, wh._id)).toBe(40)

    // Simulate the 2026-08-31 incident: the file is re-uploaded AFTER its booking already existed.
    await DocFile.updateOne({ _id: doc._id }, { $set: { uploadedAt: new Date(Date.now() + 60_000), version: 2, status: 'uploaded' } })

    const guarded = await deleteDocFiles(orgId, uid, [String(doc._id)], { rollback: true, execute: true })
    expect(guarded.plans[0].provenanceMismatch).toBe(true)
    expect(guarded.plans[0].movements[0].action).toBe('skip')     // refused
    expect(guarded.reversals?.length).toBe(0)
    expect(await qtyAt(orgId, p._id, wh._id)).toBe(40)            // the booking survives

    // The document row still goes; only the rollback was withheld.
    expect(await DocFile.countDocuments({ orgId, _id: doc._id })).toBe(0)
  })

  it('force overrides the provenance guard', async () => {
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id, { isDefault: true } as any)
    const user = await createTestUser(org._id)
    const p = await createTestProduct(org._id, { name: 'Гайка М8', sku: 'GM8' } as any)
    const orgId = String(org._id), uid = String(user._id)
    const doc = await makeDoc(org, user, await storeOperationsBook([['Гайка М8', 40]], '24.07.2026 - 24.07.2026'), '20260724_160000', '2026-07-24')
    await commitOne(orgId, uid, doc)
    await DocFile.updateOne({ _id: doc._id }, { $set: { uploadedAt: new Date(Date.now() + 60_000) } })

    const forced = await deleteDocFiles(orgId, uid, [String(doc._id)], { rollback: true, force: true, execute: true })
    expect(forced.plans[0].movements[0].action).toBe('reverse')
    expect(forced.reversals?.length).toBe(1)
    expect(await qtyAt(orgId, p._id, wh._id)).toBe(0)
  })

  it('deactivates a product the import created, but keeps one another document uses', async () => {
    const org = await createTestOrg()
    await createTestWarehouse(org._id, { isDefault: true } as any)
    const user = await createTestUser(org._id)
    const orgId = String(org._id), uid = String(user._id)

    // "НОВА ГАЙКА" is not in the catalog — the commit creates it.
    const doc = await makeDoc(org, user, await storeOperationsBook([['НОВА ГАЙКА', 25]], '24.07.2026 - 24.07.2026'), '20260724_170000', '2026-07-24')
    const committed = await commitOne(orgId, uid, doc)
    const created = await Product.findOne({ orgId, nameLower: 'нова гайка' }).lean()
    expect(created).toBeTruthy()
    expect((committed!.createdProductIds || []).map(String)).toContain(String((created as any)._id))

    const res = await deleteDocFiles(orgId, uid, [String(doc._id)], { rollback: true, removeProducts: true, execute: true })
    expect(res.plans[0].products[0].action).toBe('deactivate')
    const after: any = await Product.findById((created as any)._id).lean()
    expect(after.isActive).toBe(false)

    // A product referenced by a second document is never removed.
    const p2 = await createTestProduct(org._id, { name: 'ОБЩА ГАЙКА', sku: 'SHARED' } as any)
    const d1 = await makeDoc(org, user, await storeOperationsBook([['ОБЩА ГАЙКА', 5]], '25.07.2026 - 25.07.2026'), '20260725_100000', '2026-07-25')
    const d2 = await makeDoc(org, user, await storeOperationsBook([['ОБЩА ГАЙКА', 7]], '26.07.2026 - 26.07.2026'), '20260726_100000', '2026-07-26')
    await commitOne(orgId, uid, d1); await commitOne(orgId, uid, d2)
    await DocFile.updateOne({ _id: d1._id }, { $set: { createdProductIds: [p2._id] } })  // pretend d1 created it
    const shared = await deleteDocFiles(orgId, uid, [String(d1._id)], { rollback: true, removeProducts: true })
    expect(shared.plans[0].products[0].action).toBe('in_use')
  })
})
