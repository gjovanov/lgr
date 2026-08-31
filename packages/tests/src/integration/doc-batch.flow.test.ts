import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestWarehouse, createTestUser } from '../helpers/factories'
import { DocFile, StockLevel } from 'db/models'
import { analyzeDocFilesBatch, commitDocFilesBatch, storedAnalyses } from 'services/biz/files/doc-pipeline.service'
import ExcelJS from 'exceljs'
import { tmpdir } from 'os'
import { join } from 'path'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

/** A storeOperations „Доставки" (receipt) export — analyzes with no OCR sidecar. */
async function storeOperationsBook(items: Array<[string, number, number?]>, period: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('S')
  ws.getRow(2).getCell(1).value = 'Склад: ОБЕКТИ:СКЛАД - 1'
  ws.getRow(3).getCell(1).value = `Период: ${period}`
  ws.getRow(4).getCell(1).value = 'Операция: Доставки'
  ws.getRow(9).getCell(1).value = 'Име'; ws.getRow(9).getCell(2).value = 'Мярка'
  ws.getRow(9).getCell(3).value = 'Количество'; ws.getRow(9).getCell(4).value = 'Цена'; ws.getRow(9).getCell(5).value = 'Стойност'
  let r = 10
  for (const [name, qty, value] of items) { const row = ws.getRow(r); row.getCell(1).value = name; row.getCell(2).value = 'БР'; row.getCell(3).value = qty; row.getCell(4).value = 1; row.getCell(5).value = value ?? qty; r++ }
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


  it('runs a scrambled selection in canonical order — receipts before the invoices that need their products', async () => {
    // stokrazp creates products that the day's invoicem lines then reference, and the snapshot must
    // land last, so the SERVER decides the order — the client's selection order is not a contract.
    const org = await createTestOrg()
    await createTestWarehouse(org._id, { isDefault: true } as any)
    const user = await createTestUser(org._id)
    await createTestProduct(org._id, { name: 'Гайка М8', sku: 'GM8' } as any)
    const orgId = String(org._id), uid = String(user._id)

    const so1 = await makeDoc(org, user, await storeOperationsBook([['Гайка М8', 10]], '24.07.2026 - 24.07.2026'), '20260724_1', '2026-07-24')
    const so2 = await makeDoc(org, user, await storeOperationsBook([['Гайка М8', 10]], '23.07.2026 - 23.07.2026'), '20260723_1', '2026-07-23')
    // The rest need no readable file: an unanalyzable doc still comes back as a per-doc error in
    // its ordered slot, which is exactly what is being asserted here.
    const stub = async (docType: string, docNumber: string) => DocFile.create({
      orgId: org._id, docType, docNumber, docDate: '2026-07-24', originalName: `${docType}_${docNumber}.pdf`,
      currentPath: '/nope', currentChecksum: docNumber, mimeType: 'application/pdf', size: 1, uploadedBy: user._id,
    })
    const snap = await stub('store_availability', 'A1')
    const inv = await stub('invoice', 'I1')
    const gr = await stub('goods_receipt', 'G1')
    const tr = await stub('transfer_note', 'T1')

    // deliberately worst-case input order: exactly backwards
    const scrambled = [snap, so1, so2, inv, tr, gr].map((d) => String(d._id))
    const res = await analyzeDocFilesBatch(orgId, uid, scrambled)
    expect(res.map((r) => r.docType)).toEqual([
      'goods_receipt', 'transfer_note', 'invoice', 'store_operations', 'store_operations', 'store_availability',
    ])
    // ties inside a type break by date, then number — so-2 (23rd) precedes so-1 (24th)
    expect(res.filter((r) => r.docType === 'store_operations').map((r) => r.docNumber)).toEqual(['20260723_1', '20260724_1'])

    // commit honours the same order rather than the caller's
    const ok = await commitDocFilesBatch(orgId, uid, [String(so1._id), String(so2._id)])
    expect(ok.map((r) => r.docNumber)).toEqual(['20260723_1', '20260724_1'])
  })

  /** A складова разписка laid out the way pdftotext renders it — read by the deterministic
   *  parser, so this needs no OCR sidecar and no file on disk. */
  function transferNoteText(rows: Array<[string, number, string, string]>): string {
    const at = (...cells: Array<[number, string]>) => {
      let out = ''
      for (const [i, t] of cells) out = out.padEnd(i, ' ') + t
      return out
    }
    return [
      at([52, 'СКЛАДОВА'], [90, 'Номер:']),
      at([92, 'Дата:']),
      at([100, '0000012707']),
      at([100, '28.08.2026']),
      at([52, 'РАЗПИСКА']),
      at([0, 'Склад / Магазин:'], [35, 'Main']),
      at([0, 'No'], [23, 'Име'], [47, 'Мяр.'], [55, 'Кол'], [66, 'Цена'], [78, 'Стойност']),
      ...rows.map(([name, qty, price, total], i) =>
        at([0, String(i + 1)], [5, name], [47, 'БР'], [55, String(qty)], [66, price], [78, total])),
      at([0, 'Словом: тест'], [60, 'Данъчна основа'], [78,
        rows.reduce((sv, r) => sv + Number(r[3]), 0).toFixed(2)]),
    ].join('\n')
  }

  async function pdfDoc(org: any, user: any, docType: string, docNumber: string, text: string) {
    return DocFile.create({
      orgId: org._id, docType, docNumber, docDate: '2026-08-28',
      originalName: `${docType}_${docNumber}.pdf`, currentPath: '/nope', currentChecksum: docNumber,
      mimeType: 'application/pdf', size: 1, uploadedBy: user._id, extractedText: text,
    })
  }

  it('does not flag a price the document prints rounded', async () => {
    // 600 x 0.06 = 36.00, but the document says 36.42 — because the real price is 0.0607 and the
    // Цена column is 2 dp. Reconciling against the PRINTED price turns every such line into a
    // false "verify this" and would gate a clean day behind manual review.
    const org = await createTestOrg()
    await createTestWarehouse(org._id, { isDefault: true, name: 'Main' } as any)
    const user = await createTestUser(org._id)
    await createTestProduct(org._id, { name: 'ВИНТ 6Х80 - ТХ - EVOLUTION', sku: 'V680' } as any)
    const d = await pdfDoc(org, user, 'transfer_note', '12707',
      transferNoteText([['ВИНТ 6Х80 - ТХ - EVOLUTION', 600, '0.06', '36.42']]))

    const [r] = await analyzeDocFilesBatch(String(org._id), String(user._id), [String(d._id)])
    expect(r.draftSource).toBe('parsed')       // read without the model
    expect(r.matched).toBe(1)
    expect(r.hasBlocking).toBe(false)
    expect(r.recommended).toBe(true)
    expect(r.lines[0].severity).toBe('ok')
    expect(r.lines[0].quantity).toBe(600)
  })

  it('keeps a document with an unmatched line out of the commit selection and points at the line', async () => {
    // "matched === total" was the whole pre-selection rule, so a document with a line that matches
    // NOTHING still had to be spotted by eye among 39 rows.
    const org = await createTestOrg()
    await createTestWarehouse(org._id, { isDefault: true, name: 'Main' } as any)
    const user = await createTestUser(org._id)
    await createTestProduct(org._id, { name: 'ВИНТ 8Х200 - ТХ', sku: 'V8200' } as any)
    const d = await pdfDoc(org, user, 'transfer_note', '12708', transferNoteText([
      ['ВИНТ 8Х200 - ТХ', 100, '0.50', '50.00'],
      ['НЕПОЗНАТ АРТИКУЛ', 5, '2.00', '10.00'],
    ]))

    const [r] = await analyzeDocFilesBatch(String(org._id), String(user._id), [String(d._id)])
    expect(r.matched).toBe(1)
    expect(r.total).toBe(2)
    expect(r.recommended).toBe(false)
    // the review table can point straight at the offending row
    expect(r.lines).toHaveLength(2)
    expect(r.lines[0].matched).toBe(true)
    expect(r.lines[0].severity).toBe('ok')
    expect(r.lines[1].sourceText).toBe('НЕПОЗНАТ АРТИКУЛ')
    expect(r.lines[1].matched).toBe(false)
    expect(r.lines[1].severity).toBe('warning')
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

  it('reads back the stored review for a whole date — every status, no engine call', async () => {
    const org = await createTestOrg()
    await createTestWarehouse(org._id, { isDefault: true } as any)
    const user = await createTestUser(org._id)
    await createTestProduct(org._id, { name: 'Гайка М8', sku: 'GM8' } as any)
    const orgId = String(org._id), uid = String(user._id)

    const committed = await makeDoc(org, user, await storeOperationsBook([['Гайка М8', 10]], '24.07.2026 - 24.07.2026'), '20260724_900001', '2026-07-24')
    const analyzed  = await makeDoc(org, user, await storeOperationsBook([['Гайка М8', 20]], '24.07.2026 - 24.07.2026'), '20260724_900002', '2026-07-24')
    const untouched = await makeDoc(org, user, await storeOperationsBook([['Гайка М8', 30]], '24.07.2026 - 24.07.2026'), '20260724_900003', '2026-07-24')

    await analyzeDocFilesBatch(orgId, uid, [String(committed._id), String(analyzed._id)])
    await commitDocFilesBatch(orgId, uid, [String(committed._id)])

    const rows = await storedAnalyses(orgId, { docDate: '2026-07-24' })
    expect(rows).toHaveLength(3)   // the untouched one is included, not filtered out
    const by = (n: string) => rows.find((r: any) => r.docNumber === n)!

    // still uploaded: reported as such rather than as a document with no lines
    expect((by('20260724_900003') as any).analyzed).toBe(false)
    expect(by('20260724_900003').status).toBe('uploaded')
    expect(by('20260724_900003').committable).toBe(false)

    // analyzed: the full line detail, ready to commit
    expect((by('20260724_900002') as any).analyzed).toBe(true)
    expect(by('20260724_900002').lines).toHaveLength(1)
    expect(by('20260724_900002').committable).toBe(true)

    // committed: names the movement it booked, and is not offered again
    expect(by('20260724_900001').status).toBe('committed')
    expect((by('20260724_900001') as any).booked[0]).toMatch(/^SM-/)
    expect(by('20260724_900001').committable).toBe(false)
  })
})
