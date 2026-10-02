import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestWarehouse, createTestUser } from '../helpers/factories'
import { DocFile, Invoice, StockLevel } from 'db/models'
import { analyzeDocFilesBatch, commitDocFilesBatch, storedAnalyses } from 'services/biz/files/doc-pipeline.service'
import ExcelJS from 'exceljs'
import { tmpdir } from 'os'
import { join } from 'path'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

/** A storeOperations export — analyzes with no OCR sidecar. „Доставки" is a receipt, „Продажби" the
 *  day's till takings; the operation is the only thing that says which. */
async function storeOperationsBook(items: Array<[string, number, number?]>, period: string, operation = 'Доставки'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('S')
  ws.getRow(2).getCell(1).value = 'Склад: ОБЕКТИ:СКЛАД - 1'
  ws.getRow(3).getCell(1).value = `Период: ${period}`
  ws.getRow(4).getCell(1).value = `Операция: ${operation}`
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
/**
 * A фактура DocFile the deterministic parser can read, so the test drives the real analyze path
 * rather than a hand-written analysis. The layout mirrors the PlusMinus export: party block, a
 * No/Име/Мяр/Кол/Цена/Стойност table, then the Данъчна основа footer the arithmetic gate checks.
 */
async function makeInvoiceDoc(org: any, user: any, number: string, docDate: string, items: Array<[string, number]>): Promise<any> {
  const d = docDate.split('-')
  const bg = d[2] + '.' + d[1] + '.' + d[0]
  const rows = items.map(([name, qty], i) =>
    String(i + 1).padEnd(3) + '        ' + name.padEnd(34) + '        БР      ' + String(qty).padStart(7) + '          1.0000  ' + String(qty.toFixed(2)).padStart(11))
  const net = items.reduce((s2, [, q]) => s2 + q, 0)
  const text = [
    '                                            ФАКТУРА                                   Номер:      ' + number,
    '                                                                                       Дата:      ' + bg,
    '                                            ОРИГИНАЛ',
    '',
    'ПОЛУЧАТЕЛ   Тест Клиент ЕООД                                      ДОСТАВЧИК РЕГАЛ ООД',
    'ЕИК         999999999                                             ЕИК      112500982',
    '',
    '   No                      Име                        Мяр      Кол            Цена     Стойност',
    ...rows,
    '',
    '                                                      Данъчна основа                  ' + net.toFixed(2) + ' €',
    '                                                      ДДС ( 20 % )                    ' + (net * 0.2).toFixed(2) + ' €',
  ].join('\n')
  const path = join(tmpdir(), 'inv-batch-' + number + '.pdf')
  await Bun.write(path, 'pdf-placeholder')
  return DocFile.create({
    orgId: org._id, docType: 'invoice', docNumber: number, docDate,
    originalName: 'invoicem_' + number + '.pdf', currentPath: path, currentChecksum: number,
    mimeType: 'application/pdf', size: 10, uploadedBy: user._id, extractedText: text,
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

  it('books a „Продажби" storeOperations export as the day of till takings, not as a delivery', async () => {
    // Same report, same filename prefix, same docType — and the opposite direction. regal-sf
    // exports its cash register this way every day, while regal-pz's three July files are
    // „Доставки" deliveries. The docType cannot tell them apart; only the parsed „Операция:" can,
    // so the target is settled AFTER the sheet is read. Booking this one as a receipt would have
    // added the day's sales to stock instead of taking them out — a double-sized error.
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id, { isDefault: true, name: 'Sofia' } as any)
    const user = await createTestUser(org._id)
    const p = await createTestProduct(org._id, { name: 'Гайка М8', sku: 'GM8' } as any)
    await StockLevel.create({ orgId: org._id, productId: p._id, warehouseId: wh._id, quantity: 100, avgCost: 1 } as any)
    const orgId = String(org._id), uid = String(user._id)

    const buf = await storeOperationsBook([['Гайка М8', 10, 4.5]], '01.10.2026 - 01.10.2026', 'Продажби')
    const d = await makeDoc(org, user, buf, '20261001_120000', '2026-10-01')

    const [row] = await analyzeDocFilesBatch(orgId, uid, [String(d._id)])
    expect(row.target).toBe('cash_sale')
    expect(row.matched).toBe(1)
    expect(row.committable).toBe(true)
    // Re-reading the stored review must give the same answer: the target is remembered, not
    // re-derived from the docType (which would say 'movement' for ever).
    const [back] = await storedAnalyses(orgId, { docFileIds: [String(d._id)] })
    expect(back.target).toBe('cash_sale')

    const [res] = await commitDocFilesBatch(orgId, uid, [String(d._id)])
    expect(res.ok).toBe(true)
    // Stock went DOWN by the quantity sold.
    expect(await qtyAt(orgId, p._id, wh._id)).toBe(90)
    const doc = await DocFile.findById(d._id)
    expect(doc!.committedTarget).toBe('invoice')
    const inv: any = await Invoice.findOne({ orgId: org._id, _id: { $in: doc!.committedIds } }).lean()
    expect(inv.type).toBe('cash_sale')
    // The day is the identity whichever export carried it — so the same takings arriving as a
    // salesAnalysis file collide with this instead of booking twice.
    expect(inv.reference).toBe('salesAnalysis:2026-10-01')
    expect(inv.subtotal).toBeCloseTo(4.5, 2)
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

  it('shows the outgoing half of a split document in the review, not a blank row', async () => {
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id, { isDefault: true } as any)
    const user = await createTestUser(org._id)
    await createTestProduct(org._id, { name: 'Гайка М8', sku: 'GM8' } as any)
    await createTestProduct(org._id, { name: 'Болт М6', sku: 'BM6' } as any)
    const orgId = String(org._id), uid = String(user._id)

    // storeOperations cannot carry negatives, so stage the split shape directly on the DocFile:
    // one line received, one handed back — exactly what a разписка with a negative line produces.
    const doc = await makeDoc(org, user, await storeOperationsBook([['Гайка М8', 10]], '24.07.2026 - 24.07.2026'), '20260724_950001', '2026-07-24')
    await analyzeDocFilesBatch(orgId, uid, [String(doc._id)])
    const fresh: any = await DocFile.findById(doc._id)
    const a: any = fresh.analysis
    a.extraMovements = [{ type: 'adjustment', fromWarehouseId: String(wh._id), notes: 'x (−)', marker: 'x', totalAmount: 0, newProducts: [],
      lines: [{ productName: 'Болт М6', quantity: 7, unitCost: 1, sourceText: 'Болт М6' }] }]
    a.diagnostics.perLine.push({ sourceText: 'Болт М6', matched: true, productId: null, matchedBy: 'exact' })
    await DocFile.updateOne({ _id: doc._id }, { $set: { analysis: a } })

    const [row] = await storedAnalyses(orgId, { docFileIds: [String(doc._id)] })
    const outgoing = (row as any).lines.find((l: any) => l.sourceText === 'Болт М6')
    expect(outgoing.productName).toBe('Болт М6')   // paired from extraMovements, not blank
    expect(outgoing.quantity).toBe(7)
  })

  it('settles a re-export as superseded instead of leaving it pending for ever', async () => {
    // regal exports the cash register twice a day; the second file is the same day again. The
    // duplicate guard refuses it -- correctly -- but the document must not sit there analyzed,
    // inviting a retry that can only fail again.
    const org = await createTestOrg()
    await createTestWarehouse(org._id, { isDefault: true } as any)
    const user = await createTestUser(org._id)
    await createTestProduct(org._id, { name: 'Гайка М8', sku: 'GM8' } as any)
    const orgId = String(org._id), uid = String(user._id)

    const body = await storeOperationsBook([['Гайка М8', 12]], '24.07.2026 - 24.07.2026')
    const first  = await makeDoc(org, user, body, '20260724_960001', '2026-07-24')
    const second = await makeDoc(org, user, body, '20260724_960002', '2026-07-24')  // same day, re-exported

    await analyzeDocFilesBatch(orgId, uid, [String(first._id), String(second._id)])
    const [a] = await commitDocFilesBatch(orgId, uid, [String(first._id)])
    expect(a.ok).toBe(true)
    const [b] = await commitDocFilesBatch(orgId, uid, [String(second._id)])
    expect(b.ok).toBe(false)
    expect((b as any).duplicate).toBe(true)

    const settled: any = await DocFile.findById(second._id)
    expect(settled.status).toBe('superseded')
    expect(settled.supersededBy).toBeTruthy()          // names the movement that already carried it

    // and the review no longer offers it
    const [row] = await storedAnalyses(orgId, { docFileIds: [String(second._id)] })
    expect(row.committable).toBe(false)
    expect(row.recommended).toBe(false)
  })

  it('flags an invoice the same batch’s till export already sold, without suppressing it', async () => {
    // regal-sf 2026-10-01: three invoices whose every line the day’s till export already carried,
    // 17 lines dispatched twice, two products driven negative. The check runs AFTER the main
    // analyze loop on purpose — the till export is analyzed in the same batch, so its mapping does
    // not exist until every document has been through, and a check inside the loop races it.
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id, { isDefault: true, name: 'Sofia' } as any)
    const user = await createTestUser(org._id)
    const p = await createTestProduct(org._id, { name: 'Гайка М8', sku: 'GM8' } as any)
    const q = await createTestProduct(org._id, { name: 'Болт М6', sku: 'BM6' } as any)
    await StockLevel.create({ orgId: org._id, productId: p._id, warehouseId: wh._id, quantity: 500, avgCost: 1 } as any)
    await StockLevel.create({ orgId: org._id, productId: q._id, warehouseId: wh._id, quantity: 500, avgCost: 1 } as any)
    const orgId = String(org._id), uid = String(user._id)

    // the day's till: 10 Гайка and 10 Болт
    const tillBuf = await storeOperationsBook([['Гайка М8', 10, 5], ['Болт М6', 10, 5]], '01.10.2026 - 01.10.2026', 'Продажби')
    const tillDoc = await makeDoc(org, user, tillBuf, '20261001_120000', '2026-10-01')

    // one invoice INSIDE the till (6 of each) and one that asks for more than it sold
    const inside = await makeInvoiceDoc(org, user, 'INSIDE-1', '2026-10-01', [['Гайка М8', 6], ['Болт М6', 6]])
    const outside = await makeInvoiceDoc(org, user, 'OUTSIDE-1', '2026-10-01', [['Гайка М8', 99]])

    const rows = await analyzeDocFilesBatch(orgId, uid, [String(tillDoc._id), String(inside._id), String(outside._id)])
    const row = (n: string) => rows.find((r: any) => r.docNumber === n)!

    const flagged: any = row('INSIDE-1')
    expect(flagged.warnings.join(' ')).toContain('VERIFY before committing')
    expect(flagged.hasBlocking).toBe(true)
    // Dropped out of the recommended set, but still committable — a person decides, and nothing
    // was suppressed on their behalf.
    expect(flagged.recommended).toBe(false)
    expect(flagged.committable).toBe(true)

    // The invoice asking for more than the till sold is a different sale and must stay clean.
    const clean: any = row('OUTSIDE-1')
    expect(clean.warnings.join(' ')).not.toContain('VERIFY before committing')

    // The warning survives a plain read-back of the stored review, not just this return value.
    const [back] = await storedAnalyses(orgId, { docFileIds: [String(inside._id)] })
    expect((back as any).warnings.join(' ')).toContain('VERIFY before committing')
  })
})
