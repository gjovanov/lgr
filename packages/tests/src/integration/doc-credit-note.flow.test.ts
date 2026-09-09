/**
 * Кредитно известие — a credit note, not an invoice with negative numbers.
 *
 * PlusMinus exports these as `invoicem_*.pdf` and numbers them in the SAME series as the sales
 * invoices, so nothing but the printed title distinguishes them. Four of regal-pz's documents had
 * landed as `type: 'invoice'` with every amount negative. The stock came out right by accident (a
 * dispatch of −N adds N back), but the document was the wrong type — invisible among the credit
 * notes, and `auto-journal`, which applies `sign = -1` for a credit note, would have double-negated
 * it once accounting is wired.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestWarehouse, createTestProduct, createTestStockLevel } from '../helpers/factories'
import { analyzeDocuments } from 'services/biz/doc-import/analyze'
import { commitDocuments } from 'services/biz/doc-import/commit'
import { detectNoteType, parseNoteReference } from 'services/biz/doc-import/detect'
import type { DraftResult, MappedInvoice } from 'services/biz/doc-import/types'
import { Invoice, StockLevel, StockMovement } from 'db/models'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const ORG_EIK = '112500982'
const ORG_PARTY = { name: 'РЕГАЛ ООД', company_id: ORG_EIK, vat_id: 'BG' + ORG_EIK }
const CUSTOMER = { name: 'КОЛОВАГ АД', company_id: '112131492', vat_id: 'BG112131492', address: 'ул.Любен Каравелов 2' }

/** The letterhead of a real кредитно известие: the credited document sits BELOW its label. */
const NOTE_TEXT = [
  ' Кредитно известие                                          Номер:',
  '                                                              Дата:',
  '                                                         3000100983',
  '                                                         09.09.2026',
  '                                              ОРИГИНАЛ',
  '                                              Известие към: -ФЕ',
  '                                            3000100972/08.09.2026',
].join('\n')

/** PlusMinus prints a note's quantity and every value NEGATIVE. */
function noteDraft(): DraftResult {
  return {
    extraction: {
      document_number: '3000100983', issue_date: '2026-09-09', currency: 'EUR', exchange_rate: 1.95583,
      supplier: ORG_PARTY, customer: CUSTOMER,
      line_items: [{ description: 'БОЛТ М16Х70', quantity: -1000, unit: 'бр', unit_price: 0.82, vat_rate: 20, total: -818.10 }],
      net_total: -818.10, vat_total: -163.62, gross_total: -981.72,
    },
    validation: { status: 'valid', checks: [] }, model: 'test', engine: 'test',
  }
}

describe('кредитно известие', () => {
  it('reads the title and the document it corrects', () => {
    expect(detectNoteType(NOTE_TEXT)).toBe('credit_note')
    expect(parseNoteReference(NOTE_TEXT)).toBe('3000100972')
    expect(detectNoteType('ФАКТУРА ОРИГИНАЛ')).toBeNull()
    expect(parseNoteReference('ФАКТУРА ОРИГИНАЛ')).toBeUndefined()
  })

  it('maps as a credit note with POSITIVE amounts — the sign rides on the type', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    await createTestProduct(org._id, { name: 'БОЛТ М16Х70' } as any)

    const [doc] = await analyzeDocuments(
      String(org._id), 'sales_invoice',
      [{ fileId: 'f1', filename: 'invoicem_3000100983.pdf', text: NOTE_TEXT, draft: noteDraft() }],
      { warehouseId: String(wh._id) },
    )
    const mapped = doc.mapped as MappedInvoice
    expect(mapped.type).toBe('credit_note')
    expect(mapped.direction).toBe('outgoing')
    expect(mapped.lines[0].quantity).toBe(1000)
    expect(mapped.total).toBeCloseTo(981.72, 2)
    expect(mapped.relatedReference).toBe('3000100972')
  })

  it('books it as a RETURN into the warehouse and links the invoice it corrects', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { name: 'БОЛТ М16Х70' } as any)
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 152, avgCost: 0.5 } as any)

    // the invoice this note corrects has to exist for the link to resolve
    const orig = await Invoice.create({
      orgId: org._id, type: 'invoice', direction: 'outgoing', invoiceNumber: 'INV-3000100972',
      reference: '3000100972', issueDate: new Date('2026-09-08'), dueDate: new Date('2026-10-08'),
      currency: 'EUR', exchangeRate: 1.95583, lines: [], subtotal: 0, taxTotal: 0, total: 0,
      totalBase: 0, amountDue: 0, amountPaid: 0, status: 'sent',
      billingAddress: { street: 'x', city: 'y', postalCode: '1', country: 'BG' }, createdBy: user._id,
    } as any)

    const [doc] = await analyzeDocuments(
      String(org._id), 'sales_invoice',
      [{ fileId: 'f1', filename: 'invoicem_3000100983.pdf', text: NOTE_TEXT, draft: noteDraft() }],
      { warehouseId: String(wh._id) },
    )
    const [res] = await commitDocuments(String(org._id), String(user._id), 'sales_invoice', [
      { mapped: doc.mapped!, options: { convert: true, adjustStock: true } },
    ])
    expect(res.ok).toBe(true)

    const saved: any = await Invoice.findById(res.id).lean()
    expect(saved.type).toBe('credit_note')
    expect(saved.total).toBeCloseTo(981.72, 2)
    expect(String(saved.relatedInvoiceId)).toBe(String(orig._id))
    // Numbered in the sales series, exactly as PlusMinus does.
    expect(res.issuedNumber).toBe('INV-3000100983')

    const mv: any = await StockMovement.findOne({ orgId: org._id, invoiceId: res.id }).lean()
    expect(mv.type).toBe('return')
    expect(mv.toWarehouseId).toBeTruthy()          // the goods come BACK IN
    expect(mv.lines[0].quantity).toBe(1000)
    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: product._id }).lean()
    expect(sl.quantity).toBe(1152)                 // 152 + 1000 returned
  })

  it('leaves a plain ФАКТУРА alone', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    await createTestProduct(org._id, { name: 'БОЛТ М16Х70' } as any)
    const draft = noteDraft()
    draft.extraction.line_items![0].quantity = 1000
    draft.extraction.line_items![0].total = 818.10
    draft.extraction.net_total = 818.10
    draft.extraction.gross_total = 981.72

    const [doc] = await analyzeDocuments(
      String(org._id), 'sales_invoice',
      [{ fileId: 'f1', filename: 'invoicem_3000100984.pdf', text: 'ФАКТУРА ОРИГИНАЛ Номер: 3000100984', draft }],
      { warehouseId: String(wh._id) },
    )
    const mapped = doc.mapped as MappedInvoice
    expect(mapped.type).toBe('invoice')
    expect(mapped.relatedReference).toBeUndefined()
  })
})
