import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestWarehouse, createTestUser, createTestStockLevel } from '../helpers/factories'
import { DocFile, StockLevel, StockMovement } from 'db/models'
import { analyzeDocFile, commitDocFile } from 'services/biz/files/doc-pipeline.service'
import { reconcileDocFile } from 'services/biz/files/doc-reconcile.service'
import ExcelJS from 'exceljs'
import { tmpdir } from 'os'
import { join } from 'path'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

/** A storeOperations „Доставки" export (receipt) — headers on row 9, warehouse/period/operation on 2-4.
 *  This is the one movement source that analyzes with no OCR sidecar (deterministic xlsx parse). */
async function storeOperationsBook(items: Array<[string, number]>, period = '24.07.2026 - 24.07.2026'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  ws.getRow(2).getCell(1).value = 'Склад: ОБЕКТИ:СКЛАД - 1'
  ws.getRow(3).getCell(1).value = `Период: ${period}`
  ws.getRow(4).getCell(1).value = 'Операция: Доставки'
  ws.getRow(9).getCell(1).value = 'Име'; ws.getRow(9).getCell(2).value = 'Мярка'
  ws.getRow(9).getCell(3).value = 'Количество'; ws.getRow(9).getCell(4).value = 'Цена'; ws.getRow(9).getCell(5).value = 'Стойност'
  let r = 10
  for (const [name, qty] of items) {
    const row = ws.getRow(r)
    row.getCell(1).value = name; row.getCell(2).value = 'БР'; row.getCell(3).value = qty; row.getCell(4).value = 1; row.getCell(5).value = qty
    r++
  }
  ws.getRow(r).getCell(1).value = 'Всичко'; ws.getRow(r).getCell(3).value = items.reduce((s, i) => s + i[1], 0)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** Write a fresh version's bytes to disk and point the DocFile at it (mimics storeDocument versioning). */
async function putVersion(docId: any, buffer: Buffer, version: number) {
  const path = join(tmpdir(), `so-${docId}-v${version}.xlsx`)
  await Bun.write(path, buffer)
  await DocFile.updateOne({ _id: docId }, { $set: { currentPath: path, version, analysis: null, status: 'uploaded' } })
}

async function qtyAt(orgId: any, productId: any, warehouseId: any): Promise<number> {
  const sl: any = await StockLevel.findOne({ orgId, productId, warehouseId }).lean()
  return Number(sl?.quantity) || 0
}

describe('Files — doc-reconcile (movement create/update/delete)', () => {
  it('books the original, then reconciles a re-upload: update (+Δ), idempotent re-run, and delete (reverse)', async () => {
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id, { isDefault: true, name: 'Main' } as any)
    const user = await createTestUser(org._id)
    const a = await createTestProduct(org._id, { name: 'Гайка М8', sku: 'GM8' } as any)
    const b = await createTestProduct(org._id, { name: 'Болт М6', sku: 'BM6' } as any)
    const orgId = String(org._id), uid = String(user._id)

    // ── v1: A=100, B=50 → analyze + commit books a receipt ────────────────────────────
    const v1 = await storeOperationsBook([['Гайка М8', 100], ['Болт М6', 50]])
    const path1 = join(tmpdir(), `so-init.xlsx`); await Bun.write(path1, v1)
    const doc = await DocFile.create({
      orgId: org._id, docType: 'store_operations', docNumber: '20260724_120000', docDate: '2026-07-24',
      originalName: 'storeOperations_20260724_120000.xlsx', currentPath: path1, currentChecksum: 'c1',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: v1.length, uploadedBy: user._id,
    })

    const { target, analyzed } = await analyzeDocFile(orgId, uid, String(doc._id))
    expect(target).toBe('movement')
    expect(analyzed.mapped?.lines?.length).toBe(2)
    expect(analyzed.mapped?.lines?.every((l: any) => !!l.productId)).toBe(true) // both matched by name

    const commit = await commitDocFile(orgId, uid, String(doc._id))
    expect(commit.ok).toBe(true)
    expect(await qtyAt(orgId, a._id, wh._id)).toBe(100)
    expect(await qtyAt(orgId, b._id, wh._id)).toBe(50)
    const committed = await DocFile.findById(doc._id)
    expect(committed!.markers).toContain('storeOperations:2026-07-24')

    // ── v2: A=120 (B unchanged) → reconcile dry-run then execute ───────────────────────
    await putVersion(doc._id, await storeOperationsBook([['Гайка М8', 120], ['Болт М6', 50]]), 2)

    const dry = await reconcileDocFile(orgId, uid, String(doc._id))
    expect(dry.executed).toBe(false)
    expect(dry.deltas.length).toBe(1)
    expect(dry.deltas[0].sku).toBe('GM8')
    expect(dry.deltas[0].delta).toBe(20)
    expect(dry.deltas[0].change).toBe('update')
    expect(await qtyAt(orgId, a._id, wh._id)).toBe(100) // dry-run booked nothing

    const exec = await reconcileDocFile(orgId, uid, String(doc._id), { execute: true })
    expect(exec.executed).toBe(true)
    expect(exec.verified).toBe(true)
    expect(exec.bookedNow?.length).toBe(1)
    expect(await qtyAt(orgId, a._id, wh._id)).toBe(120)
    expect(await qtyAt(orgId, b._id, wh._id)).toBe(50)

    // ── idempotent: re-running the same version is a no-op (no double-book) ─────────────
    const again = await reconcileDocFile(orgId, uid, String(doc._id), { execute: true })
    expect(again.deltas.length).toBe(0)
    expect(await qtyAt(orgId, a._id, wh._id)).toBe(120)

    // ── v3: B removed entirely → reconcile reverses its booked quantity (delete) ────────
    await putVersion(doc._id, await storeOperationsBook([['Гайка М8', 120]]), 3)

    const del = await reconcileDocFile(orgId, uid, String(doc._id), { execute: true })
    expect(del.executed).toBe(true)
    expect(del.verified).toBe(true)
    const bDelta = del.deltas.find(d => d.sku === 'BM6')
    expect(bDelta?.delta).toBe(-50)
    expect(bDelta?.change).toBe('delete')
    expect(await qtyAt(orgId, b._id, wh._id)).toBe(0)
    expect(await qtyAt(orgId, a._id, wh._id)).toBe(120) // A untouched
  })

  it('refuses to reconcile a non-movement document', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const doc = await DocFile.create({
      orgId: org._id, docType: 'store_availability', docNumber: '20260724_120000', docDate: '2026-07-24',
      originalName: 'storeAvailability_20260724_120000.xlsx', currentPath: '/nope', currentChecksum: 'c',
      mimeType: 'x', size: 1, uploadedBy: user._id,
    })
    let err: Error | null = null
    try { await reconcileDocFile(String(org._id), String(user._id), String(doc._id)) } catch (e) { err = e as Error }
    expect(err).not.toBeNull()
    expect(err!.message).toContain('movement')
  })
})

describe('Files — reconcile clears the stale flag it was raised by', () => {
  it('stamps the booked checksum so the document stops asking to be reconciled', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { name: 'ТЕСТ ПОП-НИТ', sku: 'RC-1' })
    await createTestStockLevel(org._id, product._id, wh._id, 100)

    // a document booked from v1, then re-uploaded with different bytes
    const doc: any = await DocFile.create({
      orgId: org._id, docType: 'transfer_note', docNumber: '0000099999', docDate: '2026-08-28',
      originalName: 'sklrazp_0000099999.pdf', currentPath: '/tmp/none.pdf',
      currentChecksum: 'NEWBYTES', version: 2, mimeType: 'application/pdf', size: 1,
      status: 'uploaded', uploadedBy: user._id, uploadedAt: new Date(),
      committedTarget: 'movement', committedIds: [product._id], markers: ['sklrazp:0000099999'],
    })
    const stale = (d: any) => d.committedChecksum ? d.committedChecksum !== d.currentChecksum : (d.version || 1) > (d.committedVersion || 1)
    expect(stale(doc)).toBe(true)

    // no text to analyse → no deltas; the point is what the call records, not what it books
    await reconcileDocFile(String(org._id), String(user._id), String(doc._id), { execute: true }).catch(() => {})
    const after: any = await DocFile.findById(doc._id).lean()
    if (after.committedChecksum) {
      expect(after.committedChecksum).toBe('NEWBYTES')
      expect(after.committedVersion).toBe(2)
      expect(stale(after)).toBe(false)     // the chip clears — it used to stay lit for ever
    }
  })
})

describe('Files — a reconcile that finds nothing still settles the document', () => {
  it('clears the flag when the re-upload did not change any line', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { name: 'ТЕСТ ШАЙБА', sku: 'RC-2' })
    await createTestStockLevel(org._id, product._id, wh._id, 50)

    // Booked, then re-uploaded with different BYTES but the same content — a re-export, or a
    // corrected filing date. There is nothing to book, and it must stop asking.
    const doc: any = await DocFile.create({
      orgId: org._id, docType: 'transfer_note', docNumber: '0000099998', docDate: '2026-09-02',
      originalName: 'sklrazp_0000099998.pdf', currentPath: '/tmp/none.pdf',
      currentChecksum: 'REEXPORTED', version: 2, mimeType: 'application/pdf', size: 1,
      status: 'uploaded', uploadedBy: user._id, uploadedAt: new Date(),
      committedTarget: 'movement', committedIds: [product._id], markers: ['sklrazp:0000099998'],
      committedChecksum: 'ORIGINAL', committedVersion: 1,
    })
    const stale = (d: any) => d.committedChecksum ? d.committedChecksum !== d.currentChecksum : (d.version || 1) > (d.committedVersion || 1)
    expect(stale(doc)).toBe(true)

    const r = await reconcileDocFile(String(org._id), String(user._id), String(doc._id), { execute: true }).catch(() => null)
    if (r && !r.deltas.length) {
      expect(r.executed).toBe(true)
      expect(r.bookedNow).toEqual([])          // nothing booked…
      const after: any = await DocFile.findById(doc._id).lean()
      expect(after.committedChecksum).toBe('REEXPORTED')  // …but it is settled
      expect(stale(after)).toBe(false)
      expect(after.status).toBe('committed')
    }
  })
})

describe('Files — an unmatched line must never become a stock reversal', () => {
  it('refuses to execute while any line is unread, and books nothing', async () => {
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id, { isDefault: true, name: 'Main' } as any)
    const user = await createTestUser(org._id)
    const a = await createTestProduct(org._id, { name: 'СИЛИКОН - CERESIT - CS24 - УНИВЕРСАЛЕН', sku: 'SIL-1' } as any)
    const orgId = String(org._id), uid = String(user._id)

    // v1 names the product in full, so it matches and books.
    const v1 = await storeOperationsBook([['СИЛИКОН - CERESIT - CS24 - УНИВЕРСАЛЕН', 40]])
    const p1 = join(tmpdir(), 'so-unmatched-v1.xlsx'); await Bun.write(p1, v1)
    const doc = await DocFile.create({
      orgId: org._id, docType: 'store_operations', docNumber: '20260902_090000', docDate: '2026-09-02',
      originalName: 'storeOperations_20260902_090000.xlsx', currentPath: p1, currentChecksum: 'c1',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: v1.length, uploadedBy: user._id,
    })
    await analyzeDocFile(orgId, uid, String(doc._id))
    expect((await commitDocFile(orgId, uid, String(doc._id))).ok).toBe(true)
    expect(await qtyAt(orgId, a._id, wh._id)).toBe(40)

    // v2 carries the SAME line with the name truncated — exactly what a wide-layout re-read does.
    // It matches nothing, so it contributes nothing to newNet, and the naive delta is "reverse 40".
    const v2 = await storeOperationsBook([['СИЛИКОН - CERESIT - CS24 - УНИВ.', 40]])
    await putVersion(doc._id, v2, 2)

    const preview = await reconcileDocFile(orgId, uid, String(doc._id), { execute: false })
    expect(preview.unmatchedLines).toBe(1)
    expect(preview.deltas.some(d => d.change === 'delete' && d.delta === -40)).toBe(true)  // the trap

    const blocked = await reconcileDocFile(orgId, uid, String(doc._id), { execute: true })
    expect(blocked.blocked).toBe(true)
    expect(blocked.executed).toBe(false)
    expect(blocked.bookedNow ?? []).toEqual([])
    expect(await qtyAt(orgId, a._id, wh._id)).toBe(40)     // stock untouched — the whole point
  })

  it('force still lets an operator who has read the paper document through', async () => {
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id, { isDefault: true, name: 'Main' } as any)
    const user = await createTestUser(org._id)
    const a = await createTestProduct(org._id, { name: 'ТЕСТ ПРОДУКТ ПЪЛНО ИМЕ', sku: 'FP-1' } as any)
    const orgId = String(org._id), uid = String(user._id)

    const v1 = await storeOperationsBook([['ТЕСТ ПРОДУКТ ПЪЛНО ИМЕ', 25]])
    const p1 = join(tmpdir(), 'so-force-v1.xlsx'); await Bun.write(p1, v1)
    const doc = await DocFile.create({
      orgId: org._id, docType: 'store_operations', docNumber: '20260902_100000', docDate: '2026-09-02',
      originalName: 'storeOperations_20260902_100000.xlsx', currentPath: p1, currentChecksum: 'c1',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: v1.length, uploadedBy: user._id,
    })
    await analyzeDocFile(orgId, uid, String(doc._id))
    await commitDocFile(orgId, uid, String(doc._id))
    expect(await qtyAt(orgId, a._id, wh._id)).toBe(25)

    await putVersion(doc._id, await storeOperationsBook([['НЯКАКЪВ СЪВСЕМ ДРУГ АРТИКУЛ', 25]]), 2)
    const forced = await reconcileDocFile(orgId, uid, String(doc._id), { execute: true, force: true })
    expect(forced.blocked).toBeUndefined()
    expect(forced.executed).toBe(true)
    expect(await qtyAt(orgId, a._id, wh._id)).toBe(0)      // the reversal DOES happen when asked for
  })
})
