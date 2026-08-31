import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestWarehouse, createTestProduct, createTestStockLevel } from '../helpers/factories'
import { analyzeDocuments } from 'services/biz/doc-import/analyze'
import { commitDocuments } from 'services/biz/doc-import/commit'
import { mapInvoiceExtraction } from 'services/biz/doc-import/map-invoice'
import { findDuplicateInvoice } from 'services/biz/doc-import/dedupe'
import { detectDocKind } from 'services/biz/doc-import/detect'
import type { DraftResult, MappedInvoice, MappedMovement } from 'services/biz/doc-import/types'
import { setDisplayPrefix, getCurrentNumber } from 'services/biz/sequence.service'
import { Invoice, Contact, StockLevel, StockMovement, Product } from 'db/models'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const ORG_EIK = '112500982'

/** A canned sidecar response — `analyze` accepts `draft` so no OCR server is needed. */
function draftResult(supplier: any, customer: any, lines: any[], overrides: any = {}): DraftResult {
  const net = lines.reduce((s, l) => s + l.total, 0)
  return {
    extraction: {
      document_number: '2000122757', issue_date: '2026-03-31', currency: 'EUR', exchange_rate: 1.95583,
      supplier, customer, line_items: lines,
      net_total: net, vat_total: +(net * 0.2).toFixed(2), gross_total: +(net * 1.2).toFixed(2),
      ...overrides,
    },
    validation: { status: 'valid', checks: [] }, model: 'test', engine: 'test',
  }
}

const ORG_PARTY = { name: 'РЕГАЛ ООД', company_id: ORG_EIK, vat_id: 'BG' + ORG_EIK }
const CUSTOMER = { name: 'ЕТ МАРИЦА М', company_id: '040406418', vat_id: 'BG040406418', address: 'ул. Царица Йоана 25' }
const SUPPLIER = { name: 'ПРОЯН ЕООД', company_id: '831643582', vat_id: 'BG831643582', address: 'бул. Цариградско шосе 7' }

describe('doc-import engine', () => {
  it('analyze maps a document without persisting anything', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    await createTestProduct(org._id, { name: 'Гайка М8' } as any)

    const draft = draftResult(ORG_PARTY, CUSTOMER, [
      { description: 'Гайка М8', quantity: 40, unit: 'бр', unit_price: 0.1, vat_rate: 20, total: 4 },
    ])

    const [doc] = await analyzeDocuments(
      String(org._id),
      'sales_invoice',
      [{ fileId: 'f1', filename: 'invoicem_2000122757.pdf', text: 'ФАКТУРА Номер: 2000122757', draft }],
      { warehouseId: String(wh._id) },
      { createMissingContact: false },
    )

    expect(doc.error).toBeUndefined()
    expect(doc.docKind).toBe('invoice')
    expect(doc.direction).toBe('outgoing')
    const mapped = doc.mapped as MappedInvoice
    expect(mapped.reference).toBe('2000122757')
    expect(mapped.lines).toHaveLength(1)
    expect(mapped.lines[0].productId).toBeTruthy()
    expect(mapped.lines[0].unit).toBe('pcs')
    expect(doc.diagnostics.perLine[0].matchedBy).toBe('exact')

    // Nothing reached the database: no invoice, and no contact was invented.
    expect(await Invoice.countDocuments({ orgId: org._id })).toBe(0)
    expect(await Contact.countDocuments({ orgId: org._id })).toBe(0)
    expect(doc.diagnostics.contactSuggestion?.name).toContain('МАРИЦА')
    expect(doc.diagnostics.contactSuggestion?.eik).toBe('040406418')
  })

  it('commit creates a draft, and convert issues it with the legacy number + stock', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { name: 'Гайка М8' } as any)
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 10 } as any)

    const draft = draftResult(ORG_PARTY, CUSTOMER, [
      { description: 'Гайка М8', quantity: 40, unit: 'бр', unit_price: 0.1, vat_rate: 20, total: 4 },
    ])
    const [doc] = await analyzeDocuments(
      String(org._id), 'sales_invoice',
      [{ fileId: 'f1', filename: 'invoicem_2000122757.pdf', text: 'ФАКТУРА Номер: 2000122757', draft }],
      { warehouseId: String(wh._id) }, { batchId: 'b1' },
    )

    const [res] = await commitDocuments(String(org._id), String(user._id), 'sales_invoice', [
      { fileId: 'f1', mapped: doc.mapped!, options: { convert: true, adjustStock: true } },
    ])
    expect(res.ok).toBe(true)
    expect(res.number).toMatch(/^DRF-INV-/)
    expect(res.issuedNumber).toBe('INV-2000122757')

    const posted: any = await Invoice.findById(res.id).lean()
    expect(posted.status).toBe('sent')
    expect(posted.tags).toContain('ocr-import')
    expect(posted.tags).toContain('ocr:b1')

    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: wh._id }).lean()
    expect(sl.quantity).toBe(-30) // 10 − 40, negatives allowed for migration

    const seq = await getCurrentNumber(String(org._id), 'SALES_DOC', new Date().getFullYear())
    expect(seq).toBeGreaterThanOrEqual(2000122757)
  })

  it('commit without convert leaves a draft and does not touch stock', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { name: 'Гайка М8' } as any)
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 10 } as any)

    const draft = draftResult(ORG_PARTY, CUSTOMER, [
      { description: 'Гайка М8', quantity: 40, unit: 'бр', unit_price: 0.1, vat_rate: 20, total: 4 },
    ])
    const [doc] = await analyzeDocuments(
      String(org._id), 'sales_invoice',
      [{ fileId: 'f1', text: 'ФАКТУРА', draft }], { warehouseId: String(wh._id) },
    )
    const [res] = await commitDocuments(String(org._id), String(user._id), 'sales_invoice', [{ mapped: doc.mapped! }])

    expect(res.ok).toBe(true)
    expect(res.issuedNumber).toBeUndefined()
    const created: any = await Invoice.findById(res.id).lean()
    expect(created.status).toBe('draft')
    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: wh._id }).lean()
    expect(sl.quantity).toBe(10)
  })

  it('flags a document pointing the wrong way for the surface instead of forcing it', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)

    // A sales invoice (org is the supplier) dropped on the Bills page.
    const draft = draftResult(ORG_PARTY, CUSTOMER, [
      { description: 'Гайка М8', quantity: 1, unit: 'бр', unit_price: 1, vat_rate: 20, total: 1 },
    ])
    const [doc] = await analyzeDocuments(
      String(org._id), 'bill',
      [{ fileId: 'f1', text: 'ФАКТУРА', draft }], { warehouseId: String(wh._id) }, { createMissingContact: false },
    )

    expect((doc.mapped as MappedInvoice).direction).toBe('outgoing')
    expect(doc.diagnostics.warnings.join(' ')).toContain('this page imports incoming')
  })

  it('detects an already-imported document by its legacy number, under the ORG-CONFIGURED prefix', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    await createTestProduct(org._id, { name: 'Болт М6' } as any)

    // The org renamed its sales prefix on /invoicing/configuration/sequences.
    await setDisplayPrefix(String(org._id), 'SALES_DOC', 'FKT')

    const draft = draftResult(ORG_PARTY, CUSTOMER, [
      { description: 'Болт М6', quantity: 2, unit: 'бр', unit_price: 1, vat_rate: 20, total: 2 },
    ])
    const [first] = await analyzeDocuments(
      String(org._id), 'sales_invoice', [{ fileId: 'f1', text: 'ФАКТУРА', draft }], { warehouseId: String(wh._id) },
    )
    expect(first.duplicate).toBeUndefined()

    const [res] = await commitDocuments(String(org._id), String(user._id), 'sales_invoice', [
      { mapped: first.mapped!, options: { convert: true, adjustStock: false } },
    ])
    // The issued number uses the configured prefix, not a hardcoded "INV".
    expect(res.issuedNumber).toBe('FKT-2000122757')

    // Re-importing the same document is recognised even though the prefix is non-default.
    const [again] = await analyzeDocuments(
      String(org._id), 'sales_invoice', [{ fileId: 'f2', text: 'ФАКТУРА', draft }], { warehouseId: String(wh._id) },
    )
    expect(again.duplicate).toBeTruthy()
    expect(again.duplicate!.number).toBe('FKT-2000122757')

    const direct = await findDuplicateInvoice(String(org._id), '2000122757', 'invoice', 'outgoing')
    expect(direct?.reason).toBe('already issued')
  })

  it('refuses to commit an already-imported document rather than orphaning a draft', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const draft = draftResult(ORG_PARTY, CUSTOMER, [
      { description: 'X', quantity: 1, unit: 'бр', unit_price: 1, vat_rate: 20, total: 1 },
    ])
    const [doc] = await analyzeDocuments(
      String(org._id), 'sales_invoice', [{ fileId: 'f1', text: 'ФАКТУРА', draft }], { warehouseId: String(wh._id) },
    )
    await commitDocuments(String(org._id), String(user._id), 'sales_invoice', [
      { mapped: doc.mapped!, options: { convert: true, adjustStock: false } },
    ])
    const afterFirst = await Invoice.countDocuments({ orgId: org._id })

    // Committing the very same mapping again must not create a second document — the old
    // behaviour created the draft and then died on the unique index while issuing it.
    const [again] = await commitDocuments(String(org._id), String(user._id), 'sales_invoice', [
      { mapped: doc.mapped!, options: { convert: true, adjustStock: false } },
    ])
    expect(again.ok).toBe(false)
    expect(again.error).toContain('already issued')
    expect(await Invoice.countDocuments({ orgId: org._id })).toBe(afterFirst)

    // …unless the user explicitly asks for it.
    const [forced] = await commitDocuments(String(org._id), String(user._id), 'sales_invoice', [
      { mapped: doc.mapped!, options: { adjustStock: false, allowDuplicate: true } },
    ])
    expect(forced.ok).toBe(true)
    expect(await Invoice.countDocuments({ orgId: org._id })).toBe(afterFirst + 1)
  })

  it('warns when two files in one batch carry the same document number', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const draft = draftResult(ORG_PARTY, CUSTOMER, [
      { description: 'X', quantity: 1, unit: 'бр', unit_price: 1, vat_rate: 20, total: 1 },
    ])

    const docs = await analyzeDocuments(
      String(org._id), 'sales_invoice',
      [
        { fileId: 'f1', filename: 'invoicem_2000122757.pdf', text: 'ФАКТУРА', draft },
        { fileId: 'f2', filename: 'invoicem_2000122757 (1).pdf', text: 'ФАКТУРА', draft },
      ],
      { warehouseId: String(wh._id) },
    )
    for (const d of docs) {
      expect(d.diagnostics.warnings.join(' ')).toContain('more than one file in this batch')
    }
  })

  it('warns when the extracted number contradicts the filename', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const draft = draftResult(ORG_PARTY, CUSTOMER, [
      { description: 'X', quantity: 1, unit: 'бр', unit_price: 1, vat_rate: 20, total: 1 },
    ])

    const [doc] = await analyzeDocuments(
      String(org._id), 'sales_invoice',
      [{ fileId: 'f1', filename: 'invoicem_2000199999.pdf', text: 'ФАКТУРА', draft }],
      { warehouseId: String(wh._id) },
    )
    expect(doc.diagnostics.warnings.join(' ')).toContain('does not appear in the filename')
  })

  it('records a per-item error instead of abandoning the rest of the batch', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const draft = draftResult(ORG_PARTY, CUSTOMER, [
      { description: 'X', quantity: 1, unit: 'бр', unit_price: 1, vat_rate: 20, total: 1 },
    ])
    const [doc] = await analyzeDocuments(
      String(org._id), 'sales_invoice', [{ fileId: 'f1', text: 'ФАКТУРА', draft }], { warehouseId: String(wh._id) },
    )

    const results = await commitDocuments(String(org._id), String(user._id), 'sales_invoice', [
      // A mapping the client corrupted — the cast fails, and only this item must suffer.
      { fileId: 'bad', mapped: { ...(doc.mapped as MappedInvoice), contactId: 'not-an-object-id' } },
      { fileId: 'good', mapped: doc.mapped! },
    ])
    expect(results).toHaveLength(2)
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toBeTruthy()
    expect(results[1].ok).toBe(true)
  })

  it('maps an incoming bill and keeps the supplier wording in sourceText', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    await createTestProduct(org._id, { name: 'Болт М6' } as any)

    const draft = draftResult(SUPPLIER, ORG_PARTY, [
      { description: 'Болт М6', quantity: 100, unit: 'бр', unit_price: 0.2, vat_rate: 20, total: 20 },
    ])
    const { mapped, contact } = await mapInvoiceExtraction(String(org._id), draft, 'ФАКТУРА', {
      warehouseId: String(wh._id), createMissingContact: true,
    })

    expect(mapped.direction).toBe('incoming')
    expect(contact?.created).toBe(true)
    const c: any = await Contact.findById(contact!.contactId).lean()
    expect(c.type).toBe('supplier')
    expect(mapped.lines[0].sourceText).toBe('Болт М6')
    expect(mapped.lines[0].warehouseId).toBe(String(wh._id))
  })

  it('imports a day of cash-register takings as one issued, paid cash sale', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { name: 'Гайка М8' } as any)
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 100 } as any)

    const sheet = {
      kind: 'salesAnalysis' as const,
      salesAnalysis: {
        rows: [
          { name: 'Гайка М8', qty: 10, value: 4.5 },
          { name: 'Артикул без съответствие', qty: 2, value: 1.5 },
        ],
        totalQty: 12,
        totalValue: 6,
      },
      text: 'salesAnalysis',
    }

    const [doc] = await analyzeDocuments(
      String(org._id), 'cash_sale',
      [{ fileId: 'f1', filename: 'salesAnalysis_20260804_101112.xlsx', parsed: sheet }],
      { warehouseId: String(wh._id) },
    )

    expect(doc.docKind).toBe('cash_register')
    const mapped = doc.mapped as MappedInvoice
    expect(mapped.type).toBe('cash_sale')
    expect(mapped.reference).toBe('salesAnalysis:2026-08-04')
    expect(mapped.currency).toBe('EUR')
    // Стойност is NET; 20% VAT is added on top.
    expect(mapped.subtotal).toBeCloseTo(6, 2)
    expect(mapped.taxTotal).toBeCloseTo(1.2, 2)
    expect(mapped.total).toBeCloseTo(7.2, 2)
    // qty × unitPrice must reproduce the line's printed value.
    expect(mapped.lines[0].quantity * mapped.lines[0].unitPrice).toBeCloseTo(4.5, 4)
    // The unmatched row still counts toward the totals but cannot move stock.
    expect(mapped.lines[1].productId).toBeUndefined()
    expect(mapped.lines[1].warehouseId).toBeUndefined()
    expect(doc.diagnostics.warnings.join(' ')).toContain('free-text')

    const [res] = await commitDocuments(String(org._id), String(user._id), 'cash_sale', [
      { fileId: 'f1', mapped, options: { adjustStock: true } },
    ])
    expect(res.ok).toBe(true)

    const created: any = await Invoice.findById(res.id).lean()
    expect(created.status).toBe('paid')
    expect(created.amountDue).toBe(0)
    expect(created.tags).toContain('cash-register-import')

    // Only the matched line dispatched.
    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: wh._id }).lean()
    expect(sl.quantity).toBe(90)
  })

  it('treats a re-imported cash-register day as a duplicate', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const sheet = {
      kind: 'salesAnalysis' as const,
      salesAnalysis: { rows: [{ name: 'X', qty: 1, value: 1 }], totalQty: 1, totalValue: 1 },
      text: '',
    }
    const item = { fileId: 'f1', filename: 'salesAnalysis_20260804.xlsx', parsed: sheet }

    const [first] = await analyzeDocuments(String(org._id), 'cash_sale', [item], { warehouseId: String(wh._id) })
    expect(first.duplicate).toBeUndefined()
    await commitDocuments(String(org._id), String(user._id), 'cash_sale', [
      { mapped: first.mapped!, options: { adjustStock: false } },
    ])

    const [again] = await analyzeDocuments(String(org._id), 'cash_sale', [item], { warehouseId: String(wh._id) })
    expect(again.duplicate).toBeTruthy()
    expect(again.duplicate!.reason).toContain('salesAnalysis:2026-08-04')
  })

  it('refuses a cash-register export whose business day cannot be determined', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    await createTestUser(org._id)
    const [doc] = await analyzeDocuments(
      String(org._id), 'cash_sale',
      [{
        fileId: 'f1',
        filename: 'export.xlsx',
        parsed: { kind: 'salesAnalysis' as const, salesAnalysis: { rows: [], totalQty: 0, totalValue: 0 }, text: '' },
      }],
      {},
    )
    expect(doc.error).toContain('business day')
  })

  it('detects the movement document kinds from their printed headers', () => {
    expect(detectDocKind('СКЛАДОВА РАЗПИСКА за приемане/предаване на МЦ')).toBe('transfer_note')
    expect(detectDocKind('СТОКОВА РАЗПИСКА №3000016107')).toBe('goods_receipt')
    expect(detectDocKind('Тип на документа: 2000 КОРЕКЦИЯ')).toBe('correction')
    expect(detectDocKind('ИСКАНЕ\nЗа отпускане на материали')).toBe('issue_note')
  })

  it('refuses a document that is not a stock note on the Movements page', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    await createTestUser(org._id)
    const [doc] = await analyzeDocuments(
      String(org._id), 'movement', [{ fileId: 'f1', text: 'ФАКТУРА Номер 123' }], {},
    )
    expect(doc.error).toContain('разписка')
  })
})

// ── stock movements ──────────────────────────────────────────────────────────

/** A canned sidecar response for a стокова/складова разписка or искане. */
function stockDraft(overrides: any, lines: any[]): DraftResult {
  return {
    extraction: {
      document_number: '3000016107',
      issue_date: '2026-07-27',
      supplier: {}, customer: {},
      line_items: lines,
      ...overrides,
    },
    validation: { status: 'valid', checks: [] }, model: 'test', engine: 'test',
  }
}

describe('doc-import — stock movements', () => {
  it('books a стокова разписка as a completed receipt and leaves avgCost untouched', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { name: 'Гайка М8' } as any)
    // An existing product opens at avgCost 5; the разписка quotes 8.24.
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 10, avgCost: 5 } as any)

    const draft = stockDraft({ warehouse_to: 'СКЛАД - 1' }, [
      { description: 'Гайка М8', quantity: 4, unit: 'бр', unit_price: 8.24, total: 32.96, prices: { 'Цена': 8.24, 'Цена 1': 9.5 } },
    ])

    const [doc] = await analyzeDocuments(
      String(org._id), 'movement',
      [{ fileId: 'f1', filename: 'stokrazp_3000016107.pdf', text: 'СТОКОВА РАЗПИСКА №3000016107', draft }],
      { warehouseId: String(wh._id) },
    )
    expect(doc.docKind).toBe('goods_receipt')
    const mapped = doc.mapped as MappedMovement
    expect(mapped.type).toBe('receipt')
    expect(mapped.toWarehouseId).toBe(String(wh._id))
    expect(mapped.marker).toBe('stokrazp:3000016107')
    // THE costing rule: an existing product keeps its avgCost, so confirming is cost-neutral.
    expect(mapped.lines[0].unitCost).toBe(5)

    const [res] = await commitDocuments(String(org._id), String(user._id), 'movement', [
      { fileId: 'f1', mapped, options: { adjustStock: true } },
    ])
    expect(res.ok).toBe(true)

    const mv: any = await StockMovement.findById(res.id).lean()
    expect(mv.status).toBe('completed')
    expect(mv.notes).toContain('stokrazp:3000016107')

    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: wh._id }).lean()
    expect(sl.quantity).toBe(14)
    expect(sl.avgCost).toBeCloseTo(5, 4) // unchanged — the whole point of the rule
  })

  it('rescues a stokrazp whose landscape title is fragmented (СТОКОВА … РАЗПИСКА) via the filename kind hint', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { name: 'Гайка М8' } as any)
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 10, avgCost: 5 } as any)

    // Real OCR of a landscape stokrazp: the title splits across columns with the number/date
    // interposed, so `detectDocKind` (adjacent-phrase regex) returns unknown.
    const fragmented = 'СТОКОВА                  Номер:\n                        Дата:\n                        3000016291\n                        25.08.2026\n\n              РАЗПИСКА\n       за получаване на стоки'
    const draft = stockDraft({ document_number: '3000016291', warehouse_to: 'СКЛАД - 1' }, [
      { description: 'Гайка М8', quantity: 4, unit: 'бр', unit_price: 8.24 },
    ])

    // Without the hint → a movement target errors ("does not look like a разписка").
    const [noHint] = await analyzeDocuments(String(org._id), 'movement',
      [{ fileId: 'f1', text: fragmented, draft }], { warehouseId: String(wh._id) })
    expect(noHint.docKind).toBe('unknown')
    expect(noHint.error).toContain('does not look like')

    // With the filename-derived kind hint → it proceeds as a goods_receipt.
    const [withHint] = await analyzeDocuments(String(org._id), 'movement',
      [{ fileId: 'f1', text: fragmented, draft, kind: 'goods_receipt' }], { warehouseId: String(wh._id) })
    expect(withHint.docKind).toBe('goods_receipt')
    expect((withHint.mapped as MappedMovement)?.type).toBe('receipt')
    expect(withHint.error).toBeUndefined()
  })

  it('lets content win over the kind hint: a 2000 КОРЕКЦИЯ stays a correction', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { name: 'Гайка М8' } as any)
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 10, avgCost: 5 } as any)
    const draft = stockDraft({ document_number: '3000016300', warehouse_to: 'СКЛАД - 1' }, [
      { description: 'Гайка М8', quantity: 4, unit: 'бр' },
    ])
    // Filename says stokrazp (goods_receipt), but the content is a 2000 КОРЕКЦИЯ → content wins.
    const [doc] = await analyzeDocuments(String(org._id), 'movement',
      [{ fileId: 'f1', text: 'Тип на документа: 2000 КОРЕКЦИЯ\nСТОКОВА РАЗПИСКА', draft, kind: 'goods_receipt' }],
      { warehouseId: String(wh._id) })
    expect(doc.docKind).toBe('correction')
  })

  it('books a складова разписка as a transfer OUT with no destination', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { name: 'Болт М6' } as any)
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 50, avgCost: 2 } as any)

    const draft = stockDraft({ document_number: '778', warehouse_from: 'СКЛАД - 1' }, [
      { description: 'Болт М6', quantity: 20, unit: 'бр' },
    ])
    const [doc] = await analyzeDocuments(
      String(org._id), 'movement',
      [{ fileId: 'f1', text: 'СКЛАДОВА РАЗПИСКА за приемане/предаване на МЦ', draft }],
      { warehouseId: String(wh._id) },
    )
    const mapped = doc.mapped as MappedMovement
    expect(mapped.type).toBe('transfer')
    expect(mapped.fromWarehouseId).toBe(String(wh._id))
    expect(mapped.toWarehouseId).toBeUndefined() // destination store is not tracked here
    expect(mapped.marker).toBe('sklrazp:778')

    const [res] = await commitDocuments(String(org._id), String(user._id), 'movement', [{ mapped }])
    expect(res.ok).toBe(true)
    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: wh._id }).lean()
    expect(sl.quantity).toBe(30)
    expect(sl.avgCost).toBeCloseTo(2, 4) // reductions never disturb cost
  })

  it('books an искане as an adjustment write-off', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { name: 'Ръкавици' } as any)
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 12, avgCost: 1 } as any)

    const draft = stockDraft({ document_number: '42', warehouse_from: 'СКЛАД - 1' }, [
      { description: 'Ръкавици', quantity: 5, unit: 'чф' },
    ])
    const [doc] = await analyzeDocuments(
      String(org._id), 'movement',
      [{ fileId: 'f1', text: 'ИСКАНЕ\nЗа отпускане на материали', draft }],
      { warehouseId: String(wh._id) },
    )
    const mapped = doc.mapped as MappedMovement
    expect(mapped.type).toBe('adjustment')
    expect(mapped.marker).toBe('sklisk:42')

    const [res] = await commitDocuments(String(org._id), String(user._id), 'movement', [{ mapped }])
    expect(res.ok).toBe(true)
    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: wh._id }).lean()
    expect(sl.quantity).toBe(7)
  })

  it('splits a 2000 КОРЕКЦИЯ into a receipt and an adjustment so the sign is carried by the type', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const up = await createTestProduct(org._id, { name: 'Плюс' } as any)
    const down = await createTestProduct(org._id, { name: 'Минус' } as any)
    await createTestStockLevel(org._id, up._id, wh._id, { quantity: 10, avgCost: 1 } as any)
    await createTestStockLevel(org._id, down._id, wh._id, { quantity: 10, avgCost: 1 } as any)

    const draft = stockDraft({ document_number: '55', correction: true, warehouse_to: 'СКЛАД - 1' }, [
      { description: 'Плюс', quantity: 3, unit: 'бр' },
      { description: 'Минус', quantity: -4, unit: 'бр' },
    ])
    const [doc] = await analyzeDocuments(
      String(org._id), 'movement',
      [{ fileId: 'f1', text: 'Тип на документа: 2000 КОРЕКЦИЯ', draft }],
      { warehouseId: String(wh._id) },
    )
    expect(doc.docKind).toBe('correction')
    const mapped = doc.mapped as MappedMovement
    expect(mapped.type).toBe('receipt')
    expect(doc.extraMovements).toHaveLength(1)
    expect(doc.extraMovements![0].type).toBe('adjustment')
    // Quantities are booked positive — the movement type says which way stock goes.
    expect(doc.extraMovements![0].lines[0].quantity).toBe(4)

    const [res] = await commitDocuments(String(org._id), String(user._id), 'movement', [
      { mapped, extraMovements: doc.extraMovements },
    ])
    expect(res.ok).toBe(true)
    expect(res.number!.split(', ')).toHaveLength(2)

    const slUp: any = await StockLevel.findOne({ orgId: org._id, productId: up._id }).lean()
    const slDown: any = await StockLevel.findOne({ orgId: org._id, productId: down._id }).lean()
    expect(slUp.quantity).toBe(13)
    expect(slDown.quantity).toBe(6)
  })

  it('creates catalog-new products with cost + tier prices, then books their quantity', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    await createTestProduct(org._id, { name: 'Съществуващ', sku: 'REGAL-00007' } as any)

    const draft = stockDraft({ warehouse_to: 'СКЛАД - 1' }, [
      {
        description: '49160 СВРЕДЛО - Ф16 - с намалена опашка',
        quantity: 2, unit: 'бр', unit_price: 8.24, total: 16.48,
        prices: { 'Цена': 8.24, 'Цена 1': 7.49, 'Цена 2': 6.24 },
      },
    ])
    const [doc] = await analyzeDocuments(
      String(org._id), 'movement',
      [{ fileId: 'f1', text: 'СТОКОВА РАЗПИСКА', draft }],
      { warehouseId: String(wh._id) },
    )
    expect(doc.diagnostics.perLine[0].matched).toBe(false)
    expect(doc.diagnostics.perLine[0].candidateNew).toMatchObject({ cost: 8.24, unit: 'pcs' })
    expect(doc.diagnostics.warnings.join(' ')).toContain('not in the catalog')

    const [res] = await commitDocuments(String(org._id), String(user._id), 'movement', [
      { mapped: doc.mapped!, options: { createMissingProducts: true, adjustStock: true } },
    ])
    expect(res.ok).toBe(true)

    const created: any = await Product.findOne({ orgId: org._id, name: '49160 СВРЕДЛО - Ф16 - с намалена опашка' }).lean()
    expect(created).toBeTruthy()
    expect(created.sku).toBe('REGAL-00008') // continues the org's SKU sequence
    expect(created.purchasePrice).toBe(8.24)
    const cost = created.priceTiers.find((t: any) => t.name === 'Доставна цена')
    const tier1 = created.priceTiers.find((t: any) => t.name === 'Цена 1')
    expect(cost.finalPrice).toBe(8.24)
    expect(tier1.finalPrice).toBe(7.49)
    // The tier-name tag is what makes tag-based price resolution select this slot.
    expect(tier1.tags).toContain('Цена 1')

    // A brand-new product opens at the разписка's cost — there is no avgCost to protect.
    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: created._id }).lean()
    expect(sl.quantity).toBe(2)
    expect(sl.avgCost).toBeCloseTo(8.24, 4)
  })

  it('prices an EXISTING product from a разписка without touching what it costs us', async () => {
    // „Цена" is the DELIVERY price — the Excel's „Дост. цена", equal to the product's purchasePrice
    // and avgCost. Writing it into purchasePrice (which this used to do) overwrote the buying price;
    // writing it into sellingPrice priced the goods at what we paid. The narrow layout carries NO
    // selling price, so sellingPrice must simply be left alone. The cost slots go untouched too.
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const product: any = await createTestProduct(org._id, {
      name: 'ШАЙБА - М20 - DIN 125 - ZN', sku: 'REGAL-00007',
      purchasePrice: 0.041, sellingPrice: 0.0818,
      priceTiers: [
        { name: 'Доставна цена', percent: 0, finalPrice: 0.041, manualOverride: true, contactIds: [], tags: [] },
        { name: 'Цена на едро', percent: 0, finalPrice: 0.05, manualOverride: true, contactIds: [], tags: [] },
        { name: 'Цена 0', percent: 0, finalPrice: 0.075, manualOverride: true, contactIds: [], tags: [] },
        { name: 'Цена 1', percent: 0, finalPrice: 0, manualOverride: false, contactIds: [], tags: [] },
        { name: 'Цена 2', percent: 0, finalPrice: 0, manualOverride: false, contactIds: [], tags: [] },
        { name: 'Цена 3', percent: 0, finalPrice: 0.9, manualOverride: true, contactIds: [], tags: [] },
      ],
    } as any)

    const draft = stockDraft({ warehouse_to: 'СКЛАД - 1' }, [
      {
        description: 'ШАЙБА - М20 - DIN 125 - ZN',
        quantity: 8000, unit: 'бр', unit_price: 0.0614, total: 491.2,
        prices: { 'Цена': 0.0614, 'Цена 1': 0.038, 'Цена 2': 0.0346 },
      },
    ])
    const [doc] = await analyzeDocuments(
      String(org._id), 'movement',
      [{ fileId: 'f1', text: 'СТОКОВА РАЗПИСКА', draft }],
      { warehouseId: String(wh._id) },
    )
    expect(doc.diagnostics.perLine[0].matched).toBe(true)
    // No „Прод. цена" column on this layout → nothing to say about the selling price.
    expect(doc.mapped!.lines[0].productUpdate).toEqual({})
    expect(doc.mapped!.lines[0].productUpdate).not.toHaveProperty('purchasePrice')

    const [res] = await commitDocuments(String(org._id), String(user._id), 'movement', [
      { mapped: doc.mapped!, options: { adjustStock: true } },
    ])
    expect(res.ok).toBe(true)

    const after: any = await Product.findOne({ orgId: org._id, _id: product._id }).lean()
    const tier = (n: string) => after.priceTiers.find((t: any) => t.name === n)
    expect(after.purchasePrice).toBe(0.041)          // untouched
    expect(after.sellingPrice).toBe(0.0818)          // untouched — Цена is the cost, not a sale price
    expect(tier('Доставна цена').finalPrice).toBe(0.041)   // untouched
    expect(tier('Цена на едро').finalPrice).toBe(0.05)     // untouched
    expect(tier('Цена 0').finalPrice).toBe(0.075)          // untouched
    expect(tier('Цена 1').finalPrice).toBe(0.038)          // Цена 1
    expect(tier('Цена 2').finalPrice).toBe(0.0346)         // Цена 2
    expect(tier('Цена 3').finalPrice).toBe(0.9)            // the разписка is silent → preserved
    expect(tier('Цена 1').tags).toContain('Цена 1')

    // a staged analysis from BEFORE this rule must not be able to reintroduce the old write
    const stale = JSON.parse(JSON.stringify(doc.mapped!))
    stale.lines[0].productUpdate = { purchasePrice: 0.0614 }
    stale.lines[0].priceTiers = [{ name: 'Доставна цена', percent: 0, finalPrice: 0.0614, manualOverride: true, contactIds: [], tags: [] }]
    stale.marker = 'stokrazp:stale-1'
    await commitDocuments(String(org._id), String(user._id), 'movement', [{ mapped: stale, options: { adjustStock: true } }])
    const guarded: any = await Product.findOne({ orgId: org._id, _id: product._id }).lean()
    expect(guarded.purchasePrice).toBe(0.041)
    expect(guarded.priceTiers.find((t: any) => t.name === 'Доставна цена').finalPrice).toBe(0.041)
  })

  it('takes the selling price from Прод. цена when the разписка carries that column', async () => {
    // The 2026-08-31 export added „Прод. цена" (what we sell for) and „Цена на едро" beside the
    // delivery price. Verified against the live catalog: Цена ↔ purchasePrice, Прод. цена ↔
    // sellingPrice, Цена на едро ↔ the wholesale slot.
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const product: any = await createTestProduct(org._id, {
      name: 'ГАЙКА М8 - DIN 557 - КВАДР. - A2', sku: 'REGAL-00008',
      purchasePrice: 0.044, sellingPrice: 0.0639,
    } as any)

    const draft = stockDraft({ warehouse_to: 'СКЛАД - 1' }, [
      {
        description: 'ГАЙКА М8 - DIN 557 - КВАДР. - A2',
        quantity: 50, unit: 'бр', unit_price: 0.044, total: 2.2,
        // as the wrapped header folds them: unspaced, which must still resolve
        prices: { 'Цена': 0.044, 'Прод.цена': 0.06, 'Ценанаедро': 0.08, 'Цена 1': 0.0347 },
      },
    ])
    const [doc] = await analyzeDocuments(
      String(org._id), 'movement',
      [{ fileId: 'f1', text: 'СТОКОВА РАЗПИСКА', draft }],
      { warehouseId: String(wh._id) },
    )
    expect(doc.mapped!.lines[0].productUpdate).toEqual({ sellingPrice: 0.06 })

    const [res] = await commitDocuments(String(org._id), String(user._id), 'movement', [
      { mapped: doc.mapped!, options: { adjustStock: true } },
    ])
    expect(res.ok).toBe(true)

    const after: any = await Product.findOne({ orgId: org._id, _id: product._id }).lean()
    expect(after.sellingPrice).toBe(0.06)     // Прод. цена
    expect(after.purchasePrice).toBe(0.044)   // never written from a разписка
    const tier = (n: string) => after.priceTiers.find((t: any) => t.name === n)
    expect(tier('Цена 1').finalPrice).toBe(0.0347)
    // „Цена на едро" is a cost-side slot — the разписка does not get to move it.
    expect(tier('Цена на едро').finalPrice).toBe(0)
  })

  it('records the source document on the movement, not just inside its notes', async () => {
    // The document a movement came from lived only as a marker in free text, so nothing could
    // filter or join on it and the product ledger had no column to show it in.
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    await createTestProduct(org._id, { name: 'ВИНТ 8Х200 - ТХ', sku: 'REGAL-00007' } as any)

    const draft = stockDraft({ warehouse_from: 'СКЛАД - 1', document_number: '0000012698' }, [
      { description: 'ВИНТ 8Х200 - ТХ', quantity: 600, unit: 'бр', unit_price: 0.5, total: 300, prices: { 'Цена': 0.5 } },
    ])
    const [doc] = await analyzeDocuments(
      String(org._id), 'movement',
      [{ fileId: 'f1', filename: 'sklrazp_0000012698.pdf', text: 'СКЛАДОВА РАЗПИСКА', draft, kind: 'transfer_note' }],
      { warehouseId: String(wh._id) },
    )
    expect(doc.mapped!.reference).toBe('sklrazp_0000012698')

    const [res] = await commitDocuments(String(org._id), String(user._id), 'movement', [
      { mapped: doc.mapped!, options: { adjustStock: true } },
    ])
    expect(res.ok).toBe(true)
    const mv: any = await StockMovement.findById(res.id).lean()
    expect(mv.reference).toBe('sklrazp_0000012698')
    expect(mv.notes).toContain('sklrazp:0000012698')   // the marker still drives idempotency
  })

  it('refuses to book when nothing matched and product creation was declined', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)

    const draft = stockDraft({ warehouse_to: 'СКЛАД - 1' }, [
      { description: 'Непознат артикул', quantity: 1, unit: 'бр', unit_price: 1, total: 1 },
    ])
    const [doc] = await analyzeDocuments(
      String(org._id), 'movement', [{ fileId: 'f1', text: 'СТОКОВА РАЗПИСКА', draft }], { warehouseId: String(wh._id) },
    )
    const [res] = await commitDocuments(String(org._id), String(user._id), 'movement', [
      { mapped: doc.mapped!, options: { createMissingProducts: false } },
    ])
    expect(res.ok).toBe(false)
    expect(res.error).toContain('create them first')
  })

  it('treats a re-imported разписка as a duplicate via its notes marker', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { name: 'Гайка М8' } as any)
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 0, avgCost: 1 } as any)

    const draft = stockDraft({ warehouse_to: 'СКЛАД - 1' }, [
      { description: 'Гайка М8', quantity: 1, unit: 'бр', unit_price: 1, total: 1 },
    ])
    const item = { fileId: 'f1', text: 'СТОКОВА РАЗПИСКА', draft }

    const [first] = await analyzeDocuments(String(org._id), 'movement', [item], { warehouseId: String(wh._id) })
    expect(first.duplicate).toBeUndefined()
    await commitDocuments(String(org._id), String(user._id), 'movement', [{ mapped: first.mapped! }])

    const [again] = await analyzeDocuments(String(org._id), 'movement', [item], { warehouseId: String(wh._id) })
    expect(again.duplicate).toBeTruthy()
    expect(again.duplicate!.reason).toContain('stokrazp:3000016107')
  })

  it('imports a storeOperations export as a receipt keyed on its business day', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { name: 'Гайка М8' } as any)
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 5, avgCost: 3 } as any)

    const sheet = {
      kind: 'storeOperations' as const,
      storeOperations: {
        rows: [{ name: 'Гайка М8', unit: 'БР', qty: 100, price: 0.2, value: 20 }],
        totalQty: 100,
        warehouse: 'Всички складове',
        operation: 'Доставки',
        periodStart: '2026-07-24',
      },
      text: '',
    }
    const [doc] = await analyzeDocuments(
      String(org._id), 'movement',
      [{ fileId: 'f1', filename: 'storeOperations_20260724.xlsx', parsed: sheet }],
      { warehouseId: String(wh._id) },
    )
    const mapped = doc.mapped as MappedMovement
    expect(mapped.marker).toBe('storeOperations:2026-07-24')
    // Quantities only — this export's price is not authoritative, so avgCost is preserved.
    expect(mapped.lines[0].unitCost).toBe(3)

    const [res] = await commitDocuments(String(org._id), String(user._id), 'movement', [{ mapped }])
    expect(res.ok).toBe(true)
    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: wh._id }).lean()
    expect(sl.quantity).toBe(105)
    expect(sl.avgCost).toBeCloseTo(3, 4)
  })

  it('invoices a SERVICE line without moving stock, and still books the goods beside it', async () => {
    // regal bills „Комисионна по диларски договор" every month. It is a catalog item so the line
    // matches, but it holds no stock: it must neither create a dispatch nor trip the guard that
    // refuses a product line carrying no warehouseId.
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const service = await createTestProduct(org._id, { name: 'Комисионна по диларски договор', sku: 'SVC-1', type: 'service', trackInventory: false } as any)
    const goods = await createTestProduct(org._id, { name: 'Гайка М8', sku: 'G-1' } as any)
    await createTestStockLevel(org._id, goods._id, wh._id, { quantity: 100 } as any)

    const draft = draftResult(ORG_PARTY, CUSTOMER, [
      { description: 'Комисионна по диларски договор', quantity: 1, unit: 'бр', unit_price: 1, vat_rate: 20, total: 1 },
      { description: 'Гайка М8', quantity: 4, unit: 'бр', unit_price: 0.5, vat_rate: 20, total: 2 },
    ])
    const [doc] = await analyzeDocuments(
      String(org._id), 'sales_invoice',
      [{ fileId: 'f1', text: 'ФАКТУРА', draft }], { warehouseId: String(wh._id) },
    )
    // both lines match — the service is no longer an unmatched line
    expect(doc.diagnostics.perLine.every((l: any) => l.matched)).toBe(true)

    const [res] = await commitDocuments(String(org._id), String(user._id), 'sales_invoice', [
      { mapped: doc.mapped!, options: { convert: true, adjustStock: true } },
    ])
    expect(res.ok).toBe(true)

    // the goods moved; the service did not appear in any movement
    const goodsLevel: any = await StockLevel.findOne({ orgId: org._id, productId: goods._id, warehouseId: wh._id }).lean()
    expect(goodsLevel.quantity).toBe(96)
    expect(await StockLevel.countDocuments({ orgId: org._id, productId: service._id })).toBe(0)
    const movements = await StockMovement.find({ orgId: org._id }).lean()
    expect(movements.flatMap((m: any) => m.lines).some((l: any) => String(l.productId) === String(service._id))).toBe(false)
  })

  it('a negative line on a разписка takes stock OUT, it does not add it', async () => {
    // Стокова разписка 3000016326: 40 БОЛТ М20Х100 handed back, 40 М20Х95 taken in, the document
    // printing a negative total to say so. Folding |−40| into the receipt ADDED what had just left
    // the warehouse — the error is twice the line.
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const back = await createTestProduct(org._id, { name: 'БОЛТ М20Х100', sku: 'B100' } as any)
    const taken = await createTestProduct(org._id, { name: 'БОЛТ М20Х95', sku: 'B95' } as any)
    await createTestStockLevel(org._id, back._id, wh._id, { quantity: 100, avgCost: 2.06 } as any)
    await createTestStockLevel(org._id, taken._id, wh._id, { quantity: 0, avgCost: 1.738 } as any)

    const draft = stockDraft({ document_number: '3000016326', warehouse_to: 'СКЛАД - 1' }, [
      { description: 'БОЛТ М20Х100', quantity: -40, unit: 'бр', unit_price: 2.06, total: -82.4 },
      { description: 'БОЛТ М20Х95', quantity: 40, unit: 'бр', unit_price: 1.738, total: 69.54 },
    ])
    const [doc] = await analyzeDocuments(
      String(org._id), 'movement',
      [{ fileId: 'f1', text: 'СТОКОВА РАЗПИСКА', draft, kind: 'goods_receipt' }],
      { warehouseId: String(wh._id) },
    )
    // two movements: what came in, and what went back out
    const all = [doc.mapped as MappedMovement, ...((doc as any).extraMovements || [])] as MappedMovement[]
    expect(all).toHaveLength(2)
    const inMv = all.find(m => m.toWarehouseId)!
    const outMv = all.find(m => m.fromWarehouseId)!
    expect(inMv.type).toBe('receipt')
    expect(outMv.type).toBe('adjustment')
    expect(inMv.lines[0].quantity).toBe(40)
    expect(outMv.lines[0].quantity).toBe(40)   // magnitude; the SIDE carries the sign

    const [res] = await commitDocuments(String(org._id), String(user._id), 'movement', [
      { mapped: doc.mapped!, extraMovements: (doc as any).extraMovements, options: { adjustStock: true } },
    ])
    expect(res.ok).toBe(true)

    const handedBack: any = await StockLevel.findOne({ orgId: org._id, productId: back._id, warehouseId: wh._id }).lean()
    const cameIn: any = await StockLevel.findOne({ orgId: org._id, productId: taken._id, warehouseId: wh._id }).lean()
    expect(handedBack.quantity).toBe(60)   // 100 − 40, NOT 140
    expect(cameIn.quantity).toBe(40)
  })
})
