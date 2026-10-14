import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestWarehouse, createTestProduct, createTestStockLevel } from '../helpers/factories'
import { analyzeDocuments } from 'services/biz/doc-import/analyze'
import { commitDocuments } from 'services/biz/doc-import/commit'
import { mapInvoiceExtraction } from 'services/biz/doc-import/map-invoice'
import { findDuplicateInvoice } from 'services/biz/doc-import/dedupe'
import { detectDocKind } from 'services/biz/doc-import/detect'
import { matchProductsExact } from 'services/biz/doc-import/matching'
import { createMissingProducts, applyDeliveredPrices } from 'services/biz/doc-import/persist-movement'
import { captureRejection } from '../helpers/capture-rejection'
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

  // INV-3000101474 on prod (2026-10-13) printed PlusMinus's own line, digit cents and all.
  it('an outgoing import writes our amount-in-words line; a bill keeps the supplier\'s', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    await createTestUser(org._id)
    const raw = 'ФАКТУРА\nСловом : деветнадесет евро и 76 цента                Данъчна основа          16.47 €\nОтстъпка: 0'
    const lines = [{ description: 'Болт М12', quantity: 1, unit: 'бр', unit_price: 16.47, vat_rate: 20, total: 16.47 }]

    const out = await mapInvoiceExtraction(String(org._id), draftResult(ORG_PARTY, CUSTOMER, lines), raw, { direction: 'outgoing' })
    expect(out.mapped.notes).toBe('Словом : деветнадесет евро и седемдесет и шест цента, Данъчна основа 16.47 €')

    const bill = await mapInvoiceExtraction(String(org._id), draftResult(SUPPLIER, ORG_PARTY, lines), raw, { direction: 'incoming' })
    expect(bill.mapped.notes).toBe('Словом : деветнадесет евро и 76 цента Данъчна основа 16.47 €')
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
        books: 'receipt' as const,
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

  it('routes the same export filtered to Продажби to the cash register, whatever target it is handed', async () => {
    // The routing is decided by the SHEET, not by the caller's target. That is what makes it safe:
    // a caller that still believes a store_operations file is a movement (the docType says so)
    // cannot book a day of sales as a delivery.
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { name: 'Гайка М8' } as any)
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 50 } as any)

    const sheet = {
      kind: 'storeOperations' as const,
      storeOperations: {
        rows: [{ name: 'Гайка М8', unit: 'БР', qty: 10, price: 0.45, value: 4.5 }],
        totalQty: 10,
        warehouse: 'ОБЕКТИ:СКЛАД - 1',
        operation: 'Продажби',
        books: 'sale' as const,
        periodStart: '2026-10-01',
      },
      text: '',
    }
    const [doc] = await analyzeDocuments(
      String(org._id), 'movement',
      [{ fileId: 'f1', filename: 'storeOperations_20261001.xlsx', parsed: sheet }],
      { warehouseId: String(wh._id) },
    )
    expect(doc.docKind).toBe('cash_register')
    const mapped = doc.mapped as MappedInvoice
    expect(mapped.type).toBe('cash_sale')
    // The business day comes from „Период" inside the sheet, and keys the day's identity.
    expect(mapped.reference).toBe('salesAnalysis:2026-10-01')
    expect(mapped.subtotal).toBeCloseTo(4.5, 2)
    expect(mapped.taxTotal).toBeCloseTo(0.9, 2)
    // The export prints a unit price, but the derived one still has to reproduce the line value.
    expect(mapped.lines[0].quantity * mapped.lines[0].unitPrice).toBeCloseTo(4.5, 4)
    expect(mapped.lines[0].warehouseId).toBe(String(wh._id))
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

  it('sells a product the SAME batch created — matched at commit, not left on the shelf', async () => {
    // The разписка that creates a product commits before the invoice that sells it, but both were
    // ANALYSED before either ran, when the product did not exist. INV-3000100879 (2026-08-31) kept
    // productId null on four ШПИЛКА lines and moved no stock: 160 units sold, none dispatched.
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)

    // 1. the receipt brings in a product the catalog has never seen
    const receipt = stockDraft({ document_number: '3000016325', warehouse_to: 'СКЛАД - 1' }, [
      { description: 'ШПИЛКА - М16Х85 - DIN 976 - 5.6 - ZN', quantity: 40, unit: 'бр', unit_price: 1, total: 40 },
    ])
    const [rDoc] = await analyzeDocuments(String(org._id), 'movement',
      [{ fileId: 'r1', text: 'СТОКОВА РАЗПИСКА', draft: receipt, kind: 'goods_receipt' }], { warehouseId: String(wh._id) })

    // 2. the invoice selling it is analysed NOW — before the product exists
    const sale = draftResult(ORG_PARTY, CUSTOMER, [
      { description: 'ШПИЛКА - М16Х85 - DIN 976 - 5.6 - ZN', quantity: 40, unit: 'бр', unit_price: 2, vat_rate: 20, total: 80 },
    ])
    const [iDoc] = await analyzeDocuments(String(org._id), 'sales_invoice',
      [{ fileId: 'i1', text: 'ФАКТУРА', draft: sale }], { warehouseId: String(wh._id) })
    expect(iDoc.diagnostics.perLine[0].matched).toBe(false)   // nothing to match yet

    // 3. commit in the canonical order: receipt first, then the invoice
    const [rRes] = await commitDocuments(String(org._id), String(user._id), 'movement', [
      { mapped: rDoc.mapped!, options: { adjustStock: true, createMissingProducts: true } }])
    expect(rRes.ok).toBe(true)
    const [iRes] = await commitDocuments(String(org._id), String(user._id), 'sales_invoice', [
      { mapped: iDoc.mapped!, options: { convert: true, adjustStock: true } }])
    expect(iRes.ok).toBe(true)

    // the invoice line found the product created moments earlier, and the stock actually moved
    const created: any = await Product.findOne({ orgId: org._id, nameLower: 'шпилка - м16х85 - din 976 - 5.6 - zn' }).lean()
    expect(created).toBeTruthy()
    const posted: any = await Invoice.findById(iRes.id).lean()
    expect(String(posted.lines[0].productId)).toBe(String(created._id))
    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: created._id, warehouseId: wh._id }).lean()
    expect(sl.quantity).toBe(0)   // 40 received, 40 sold
  })
})

describe('matching — a name written with a look-alike letter', () => {
  it('finds the catalog product when the extraction swaps Latin K for Cyrillic К', async () => {
    const org = await createTestOrg()
    // The catalog holds the name with a LATIN k, exactly as PlusMinus exported it.
    const product = await createTestProduct(org._id, { name: 'ВИНТ - САМОПР. - 6.3Х100 - DIN 7504 K', sku: 'RG-1' })

    // The extraction spells the same name with the Cyrillic к — indistinguishable on paper.
    const hits = await matchProductsExact(String(org._id), ['ВИНТ - САМОПР. - 6.3Х100 - DIN 7504 К'])

    expect(hits[0]).not.toBeNull()
    expect(String(hits[0]!.productId)).toBe(String(product._id))
  })

  it('matches in the other direction too, and still refuses a genuinely different name', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { name: 'ГАЙКА М12 - DIN 934 - К 8 - ZN', sku: 'RG-2' })   // Cyrillic К

    const [same, different] = await matchProductsExact(String(org._id), [
      'ГАЙКА М12 - DIN 934 - K 8 - ZN',    // Latin K
      'ГАЙКА М14 - DIN 934 - K 8 - ZN',    // a different size — must not match
    ])
    expect(same).not.toBeNull()
    expect(different).toBeNull()
  })
})

describe('matching — a dropped " - " field separator', () => {
  /**
   * INV-3000101340 (regal-pz, 2026-10-05) could not be booked: PlusMinus printed
   * „ШАЙБА - КОНУСНА 22ММ - DIN 435 - 14% - HDG" while the catalog holds the same name with
   * the separator after КОНУСНА. A hyphen is a real character, so neither the exact rung nor
   * either whitespace rung could see past it, and the line stayed free-text.
   */
  it('finds the product when the document drops one separator', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { name: 'ШАЙБА - КОНУСНА - 22ММ - DIN 435 - 14% - HDG', sku: 'RG-20747' })

    const hits = await matchProductsExact(String(org._id), ['ШАЙБА - КОНУСНА 22ММ - DIN 435 - 14% - HDG'])

    expect(hits[0]).not.toBeNull()
    expect(String(hits[0]!.productId)).toBe(String(product._id))
    expect(hits[0]!.matchedBy).toBe('token')
  })

  it('matches a name joined up entirely, and in the other direction', async () => {
    const org = await createTestOrg()
    const joined = await createTestProduct(org._id, { name: 'НОРД - ЛОК - М16', sku: 'RG-1' })

    const [a, b] = await matchProductsExact(String(org._id), ['НОРДЛОКМ16', 'НОРД ЛОК М16'])

    expect(String(a!.productId)).toBe(String(joined._id))
    expect(String(b!.productId)).toBe(String(joined._id))
  })

  /**
   * A dot is content, not a separator: this catalog carries both 13.5ММ and 135ММ-style sizes,
   * and collapsing them would move stock between two real, different articles.
   */
  it('does not treat a dot as a separator', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { name: 'ШАЙБА - КОНУСНА - 13.5ММ - DIN 435 - 14%', sku: 'RG-2' })

    const hits = await matchProductsExact(String(org._id), ['ШАЙБА - КОНУСНА - 135ММ - DIN 435 - 14%'])

    expect(hits[0]).toBeNull()
  })

  /**
   * ⚠ The refusal is the feature. regal-sf holds 342 groups of rows differing only by
   * separators; picking the first would book a sale against an arbitrary twin.
   */
  it('refuses when more than one catalog row differs only by separators', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { name: 'БОЛТ - М12Х50 - DIN 933 - ZN', sku: 'RG-3' })
    await createTestProduct(org._id, { name: 'БОЛТ - М12Х50 - DIN933 - ZN', sku: 'RG-4' })

    const hits = await matchProductsExact(String(org._id), ['БОЛТ М12Х50 DIN 933 ZN'])

    expect(hits[0]).toBeNull()
  })

  it('still refuses a genuinely different name', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { name: 'ШАЙБА - КОНУСНА - 22ММ - DIN 435 - 14% - HDG', sku: 'RG-5' })

    // ZN is a different coating, i.e. a different article — not a separator difference.
    const hits = await matchProductsExact(String(org._id), ['ШАЙБА - КОНУСНА - 22ММ - DIN 435 - 14% - ZN'])

    expect(hits[0]).toBeNull()
  })
})

describe('createMissingProducts — a name that differs only in separators', () => {
  /**
   * A name reaches product creation because every matching rung missed, and since rung 3d shipped
   * one of the ways to miss is AMBIGUITY. Creating on an exact-nameLower check alone would then add
   * a third row to a group that already has two — growing the duplication the refusal protects.
   */
  it('reuses the single separator twin instead of creating a duplicate', async () => {
    const org = await createTestOrg()
    const twin = await createTestProduct(org._id, { name: 'БОЛТ М16Х120 - DIN 7991 - K 8.8 - ZN', sku: 'RG-1' } as any)

    const created = await createMissingProducts(String(org._id), [
      { name: 'БОЛТ М16Х120 - DIN7991 - K 8.8 - ZN', cost: 1.5, selling: 2, unit: 'pcs', tiers: {} } as any,
    ])

    expect(created).toHaveLength(1)
    expect(created[0].created).toBe(false)
    expect(String(created[0].productId)).toBe(String(twin._id))
    // The line asked by one spelling and got a product with another — the caller needs both.
    expect(created[0].requestedName).toBe('БОЛТ М16Х120 - DIN7991 - K 8.8 - ZN')
    expect(created[0].name).toBe('БОЛТ М16Х120 - DIN 7991 - K 8.8 - ZN')
    expect(await Product.countDocuments({ orgId: org._id } as any)).toBe(1)
  })

  it('refuses when several catalog rows differ from it only in separators', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { name: 'БОЛТ М16Х120 - DIN 7991 - K 8.8 - ZN', sku: 'RG-1' } as any)
    await createTestProduct(org._id, { name: 'БОЛТ М16Х120 - DIN7991 - K 8.8 - ZN', sku: 'RG-2' } as any)

    const err = await captureRejection(createMissingProducts(String(org._id), [
      { name: 'БОЛТ М16Х120-DIN 7991-K 8.8-ZN', cost: 1.5, selling: 2, unit: 'pcs', tiers: {} } as any,
    ]))

    expect(err).not.toBeNull()
    expect(String(err!.message)).toContain('differ from it only in separators')
    expect(String(err!.message)).toContain('RG-1')
    expect(String(err!.message)).toContain('RG-2')
    // Nothing was added: refusing is the point.
    expect(await Product.countDocuments({ orgId: org._id } as any)).toBe(2)
  })

  it('still creates a genuinely new article', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { name: 'БОЛТ М16Х120 - DIN 7991 - K 8.8 - ZN', sku: 'RG-1' } as any)

    const created = await createMissingProducts(String(org._id), [
      { name: 'U - БОЛТ - М8 - ПО ЧЕРТЕЖ', cost: 1.092, selling: 1.092, unit: 'pcs', tiers: {} } as any,
    ])

    expect(created[0].created).toBe(true)
    expect(created[0].requestedName).toBe('U - БОЛТ - М8 - ПО ЧЕРТЕЖ')
    expect(await Product.countDocuments({ orgId: org._id } as any)).toBe(2)
  })
})

describe('doc-import — a price-only разписка books nothing', () => {
  /**
   * PlusMinus issues стокови разписки with an EMPTY „Кол" column and „Крайна сума 0.00" purely to
   * restate prices. 3000016390 was one; refused by the parser and handed to the model, it came back
   * with 1500 of each ИЗОЛИРБАНД against a real stock of ~13. The parser reads it now, and a line
   * that delivers nothing must not enter a movement.
   */
  it('maps to zero movements and says why', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { name: 'ИЗОЛИРБАНД - 20Х19 - СИН' } as any)
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 13, avgCost: 1 } as any)

    const draft = stockDraft({ document_number: '3000016390', warehouse_from: 'СКЛАД - 1' }, [
      { description: 'ИЗОЛИРБАНД - 20Х19 - СИН', quantity: 0, unit: 'бр', prices: { 'Цена': 1.5, 'Прод. цена': 1.58 } },
    ])
    const [doc] = await analyzeDocuments(
      String(org._id), 'movement',
      [{ fileId: 'f1', filename: 'stokrazp_3000016390.pdf', text: 'СТОКОВА РАЗПИСКА за получаване на стоки', draft }],
      { warehouseId: String(wh._id) },
    )
    expect(doc.error).toBeUndefined()          // a complete read, not a failure
    expect(doc.mapped).toBeFalsy()             // …with nothing to book
    expect(doc.nothingToMove).toBe(true)
    expect((doc.diagnostics?.warnings || []).join(' ')).toContain('delivers nothing')

    // and nothing moved
    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: wh._id }).lean()
    expect(sl.quantity).toBe(13)
  })

  /**
   * …but it is NOT a no-op. Restating prices is the document's entire purpose, and until
   * 2026-10-08 the commit wrote nothing at all: the mapper computed every `productUpdate` and
   * tier, then dropped the lines because they could not enter a movement. Four regal-pz documents
   * and two regal-sf ones committed that way — 43 priced lines that never reached the catalog.
   */
  it('carries its prices on the analysis and applies them on commit', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, {
      name: 'ГАЙКА М6 - I 7042 - BN 205107 T1 - МЕТ.ПР.', purchasePrice: 0.3, sellingPrice: 0.4,
    } as any)
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 13, avgCost: 0.3 } as any)

    const draft = stockDraft({ document_number: '3000016504', warehouse_from: 'СКЛАД - 1' }, [
      {
        description: 'ГАЙКА М6 - I 7042 - BN 205107 T1 - МЕТ.ПР.', quantity: 0, unit: 'бр',
        // The real 3000016504's first line.
        prices: { 'Цена': 0.4090, 'Прод. цена': 0.4600, 'Цена на едро': 0.5500, 'Цена 1': 0.5215, 'Цена 2': 0.3360 },
      },
    ])
    const [doc] = await analyzeDocuments(
      String(org._id), 'movement',
      [{ fileId: 'f1', filename: 'stokrazp_3000016504.pdf', text: 'СТОКОВА РАЗПИСКА за получаване на стоки', draft }],
      { warehouseId: String(wh._id) },
    )
    expect(doc.nothingToMove).toBe(true)
    expect(doc.priceOnly).toHaveLength(1)
    expect((doc.diagnostics?.warnings || []).join(' ')).toContain('prices are applied to 1 product')

    const repriced = await applyDeliveredPrices(String(org._id), doc.priceOnly as any)
    expect(repriced).toBe(1)

    const after: any = await Product.findOne({ _id: product._id }).lean()
    expect(after.sellingPrice).toBe(0.46)                       // Прод. цена
    expect(after.purchasePrice).toBe(0.3)                       // ⚠ never written by an import
    const tier = (n: string) => (after.priceTiers || []).find((t: any) => t.name === n)
    expect(tier('Цена 1')?.finalPrice).toBe(0.5215)
    expect(tier('Цена 2')?.finalPrice).toBe(0.336)
    // PROTECTED_TIERS: a разписка prices what we SELL, never the cost slots.
    expect(tier('Цена на едро')?.finalPrice ?? 0).not.toBe(0.55)
    expect(tier('Доставна цена')?.finalPrice ?? 0).not.toBe(0.409)

    // and still nothing moved
    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: wh._id }).lean()
    expect(sl.quantity).toBe(13)
    expect(await StockMovement.countDocuments({ orgId: org._id } as any)).toBe(0)
    expect(String(user._id)).toBeTruthy()
  })

  /** A transfer or write-off OUT of the warehouse must never reprice, price column or not. */
  it('does not reprice from a price-only transfer note', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { name: 'ГАЙКА М8 - DIN 934', sellingPrice: 0.4 } as any)
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 10, avgCost: 1 } as any)

    const draft = stockDraft({ document_number: '0000012770', warehouse_from: 'СКЛАД - 1' }, [
      { description: 'ГАЙКА М8 - DIN 934', quantity: 0, unit: 'бр', prices: { 'Цена': 1.5, 'Прод. цена': 9.99 } },
    ])
    const [doc] = await analyzeDocuments(
      String(org._id), 'movement',
      [{ fileId: 'f1', filename: 'sklrazp_0000012770.pdf', text: 'СКЛАДОВА РАЗПИСКА за прехвърляне на стоки', draft }],
      { warehouseId: String(wh._id) },
    )
    expect(doc.nothingToMove).toBe(true)
    expect(doc.priceOnly).toBeUndefined()
    expect((doc.diagnostics?.warnings || []).join(' ')).toContain('restates no price we can apply')

    const after: any = await Product.findOne({ _id: product._id }).lean()
    expect(after.sellingPrice).toBe(0.4)
  })
})

describe('doc-import — a till export that is a history dump, not a day', () => {
  const sheet = (periodStart: string, rows = 2) => ({
    kind: 'storeOperations' as const,
    storeOperations: {
      rows: Array.from({ length: rows }, (_, i) => ({ name: `Гайка М${i}`, unit: 'БР', qty: 10, price: 1, value: 10 })),
      totalQty: 10 * rows,
      warehouse: 'ОБЕКТИ:СКЛАД',
      operation: 'Продажби',
      books: 'sale' as const,
      periodStart,
    },
    text: '',
  })

  it('refuses a two-year span and says why, instead of booking it as one day', async () => {
    // The real file: exported 2026-10-05, „Период: 01.01.2025 - 31.12.2026", 5,287 articles,
    // 1,145,236 units. Its rows summed to its own footer to the cent, so every arithmetic gate
    // passed — only the span gives it away.
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const wh = await createTestWarehouse(org._id)
    const [doc] = await analyzeDocuments(
      String(org._id), 'cash_sale',
      [{ fileId: 'f1', filename: 'storeOperations_20261005_193203.xlsx', parsed: sheet('2025-01-01') }],
      { warehouseId: String(wh._id) },
    )
    expect(doc.docKind).toBe('cash_register')
    expect(doc.mapped).toBeUndefined()
    expect(doc.error).toContain('history dump')
    expect(doc.error).toContain('2025-01-01')
  })

  it('still accepts a day exported LATE, which is routine', async () => {
    // salesAnalysis_20260907_ legitimately covering 2026-09-03: the filename records when the
    // export was taken, not the business day.
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const wh = await createTestWarehouse(org._id)
    const [doc] = await analyzeDocuments(
      String(org._id), 'cash_sale',
      [{ fileId: 'f1', filename: 'storeOperations_20260907_120000.xlsx', parsed: sheet('2026-09-03') }],
      { warehouseId: String(wh._id) },
    )
    expect(doc.error).toBeUndefined()
    expect((doc.mapped as MappedInvoice).reference).toBe('salesAnalysis:2026-09-03')
  })

  it('books a history dump under the day the operator names, since then it is not inferred', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const wh = await createTestWarehouse(org._id)
    const [doc] = await analyzeDocuments(
      String(org._id), 'cash_sale',
      [{ fileId: 'f1', filename: 'storeOperations_20261005_193203.xlsx', parsed: sheet('2025-01-01') }],
      { warehouseId: String(wh._id), date: '2026-10-05' },
    )
    expect(doc.error).toBeUndefined()
    expect((doc.mapped as MappedInvoice).reference).toBe('salesAnalysis:2026-10-05')
  })
})
