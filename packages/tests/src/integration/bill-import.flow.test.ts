import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestWarehouse, createTestProduct, createTestContact, createTestStockLevel } from '../helpers/factories'
import { createDraftBill, receiveBill, type DraftResult } from 'invoicing-api/src/lib/bill-import'
import { Invoice, StockLevel, Contact, StockMovement } from 'db/models'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

function draftResult(supplier: any, lines: any[]): DraftResult {
  const net = lines.reduce((s, l) => s + l.total, 0)
  return {
    extraction: {
      document_number: '2000122757',
      issue_date: '2026-03-31',
      currency: 'EUR',
      exchange_rate: 1.95583,
      supplier,
      customer: { name: 'Buyer' } as any,
      line_items: lines,
      net_total: net,
      vat_total: +(net * 0.2).toFixed(2),
      gross_total: +(net * 1.2).toFixed(2),
    },
    validation: { status: 'valid', checks: [] },
    model: 'test',
    engine: 'test',
  }
}

describe('bill OCR import flow', () => {
  it('drafts a bill: matches existing supplier + product, free-text for unmatched, EUR', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    await createTestProduct(org._id, { name: 'Специален болт М8', sku: 'SB-M8' } as any)
    const supplier = await createTestContact(org._id, { type: 'supplier', companyName: 'Доставчик АД', taxId: '112500982' } as any)

    const draft = draftResult(
      { name: 'Доставчик АД', company_id: '112500982', vat_id: 'BG112500982' },
      [
        { description: 'Специален болт М8', quantity: 100, unit: 'бр', unit_price: 0.5, vat_rate: 20, total: 50 },
        { description: 'Нещо съвсем непознато', quantity: 5, unit: 'бр', unit_price: 2, vat_rate: 20, total: 10 },
      ],
    )
    const { bill, supplier: matched, perLine } = await createDraftBill(String(org._id), String(user._id), draft, String(wh._id), 'batch1')

    expect(bill.status).toBe('draft')
    expect(bill.direction).toBe('incoming')
    expect(bill.currency).toBe('EUR')
    expect(bill.reference).toBe('2000122757')
    expect(String(bill.contactId)).toBe(String(supplier._id))
    expect(matched?.created).toBe(false)
    expect(perLine[0].matched).toBe(true)
    expect(perLine[1].matched).toBe(false)

    const doc: any = await Invoice.findById(bill.id).lean()
    expect(doc.tags).toContain('ocr:batch1')
    expect(doc.lines[0].productId).toBeTruthy()
    expect(doc.lines[0].warehouseId).toBeTruthy()
    expect(doc.lines[1].productId).toBeFalsy() // free-text — no stock impact
  })

  it('auto-creates a supplier (with lowered search mirror) when none matches', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const draft = draftResult(
      { name: 'Нов Доставчик ЕООД', company_id: '205931289', vat_id: 'BG205931289' },
      [{ description: 'Артикул', quantity: 1, unit: 'бр', unit_price: 10, vat_rate: 20, total: 10 }],
    )
    const { supplier } = await createDraftBill(String(org._id), String(user._id), draft, String(wh._id), 'b2')
    expect(supplier?.created).toBe(true)
    const c: any = await Contact.findOne({ orgId: org._id, taxId: '205931289' }).lean()
    expect(c.type).toBe('supplier')
    expect(c.companyNameLower).toBe('нов доставчик еоод')
  })

  it('converts a draft → received: allocates BILL#, moves stock for matched lines only', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { name: 'Гайка М8' } as any)
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 100 } as any)

    const draft = draftResult(
      { name: 'Доставчик', company_id: '112500982' },
      [
        { description: 'Гайка М8', quantity: 40, unit: 'бр', unit_price: 0.1, vat_rate: 20, total: 4 },
        { description: 'Свободен текст ред', quantity: 5, unit: 'бр', unit_price: 1, vat_rate: 20, total: 5 },
      ],
    )
    const { bill } = await createDraftBill(String(org._id), String(user._id), draft, String(wh._id), 'b3')

    const res = await receiveBill(String(org._id), String(bill.id), String(user._id))
    expect(res.ok).toBe(true)
    expect(res.invoiceNumber).toMatch(/^BILL-/)

    const posted: any = await Invoice.findById(bill.id).lean()
    expect(posted.status).toBe('received')

    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: wh._id }).lean()
    expect(sl.quantity).toBe(140) // 100 + 40 (matched line only)

    const movements = await StockMovement.countDocuments({ orgId: org._id, invoiceId: bill.id } as any)
    expect(movements).toBe(1)
  })
})
