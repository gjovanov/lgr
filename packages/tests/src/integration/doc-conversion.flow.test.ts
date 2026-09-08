/**
 * складова разписка → фактура conversions.
 *
 * PlusMinus can turn a разписка into an invoice keeping the same lines and prices. The goods left
 * on the разписка, so the invoice must not dispatch them again — but the PDF export drops the
 * comment that records the conversion, so it has to be recognised from the shipment itself.
 *
 * The live failure this encodes: INV-3000100974 (БеПро ЕАД, 2026-09-08) re-dispatched all 50 lines
 * of складова разписка 0000012713 and put 47 products out by exactly the note's quantity.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestWarehouse, createTestProduct, createTestStockLevel } from '../helpers/factories'
import { analyzeDocuments } from 'services/biz/doc-import/analyze'
import { commitDocuments } from 'services/biz/doc-import/commit'
import { findStockNoteConversion } from 'services/biz/doc-import/conversion'
import { reverseInvoiceStockMovement } from 'services/biz/invoicing.service'
import type { DraftResult, MappedInvoice, MappedMovement } from 'services/biz/doc-import/types'
import { Contact, Invoice, StockLevel, StockMovement } from 'db/models'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const ORG_EIK = '112500982'
const ORG_PARTY = { name: 'РЕГАЛ ООД', company_id: ORG_EIK, vat_id: 'BG' + ORG_EIK }
const PARTNER = { name: 'БеПро ЕАД', company_id: '175302437', vat_id: 'BG175302437', address: 'бул. Черни връх 51' }
const OTHER = { name: 'ЕТ МАРИЦА М', company_id: '040406418', vat_id: 'BG040406418', address: 'ул. Царица Йоана 25' }

/** A складова разписка naming a partner — what `parseStockNoteParty` yields off a real note. */
function noteDraft(number: string, lines: any[], customer: any = PARTNER): DraftResult {
  return {
    extraction: {
      document_number: number, issue_date: '2026-09-01',
      supplier: {}, customer,
      warehouse_from: 'СКЛАД - 1',
      line_items: lines,
    },
    validation: { status: 'valid', checks: [] }, model: 'test', engine: 'test',
  }
}

function invoiceDraft(number: string, lines: any[], customer: any = PARTNER): DraftResult {
  const net = lines.reduce((s: number, l: any) => s + l.total, 0)
  return {
    extraction: {
      document_number: number, issue_date: '2026-09-08', currency: 'EUR', exchange_rate: 1.95583,
      supplier: ORG_PARTY, customer,
      line_items: lines,
      net_total: net, vat_total: +(net * 0.2).toFixed(2), gross_total: +(net * 1.2).toFixed(2),
    },
    validation: { status: 'valid', checks: [] }, model: 'test', engine: 'test',
  }
}

/** Two products, stocked, plus the partner as a customer contact. */
async function scenario() {
  const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
  const user = await createTestUser(org._id)
  const wh = await createTestWarehouse(org._id)
  const bolt = await createTestProduct(org._id, { name: 'Болт М16Х75' } as any)
  const nut = await createTestProduct(org._id, { name: 'Гайка М12' } as any)
  await createTestStockLevel(org._id, bolt._id, wh._id, { quantity: 1000, avgCost: 0.5 } as any)
  await createTestStockLevel(org._id, nut._id, wh._id, { quantity: 1000, avgCost: 0.05 } as any)
  await Contact.create({ orgId: org._id, type: 'customer', companyName: PARTNER.name, taxId: PARTNER.company_id, isActive: true } as any)
  return { org, user, wh, bolt, nut }
}

const NOTE_LINES = [
  { description: 'Болт М16Х75', quantity: 300, unit: 'бр' },
  { description: 'Гайка М12', quantity: 300, unit: 'бр' },
]
const INVOICE_LINES = [
  { description: 'Болт М16Х75', quantity: 300, unit: 'бр', unit_price: 0.57, vat_rate: 20, total: 171 },
  { description: 'Гайка М12', quantity: 300, unit: 'бр', unit_price: 0.05, vat_rate: 20, total: 15.33 },
]

/** Book the разписка and return the stock left after it. */
async function bookNote(ctx: any, number = '0000012713', lines = NOTE_LINES, customer = PARTNER) {
  const [doc] = await analyzeDocuments(
    String(ctx.org._id), 'movement',
    [{ fileId: 'n1', filename: `sklrazp_${number}.pdf`, text: 'СКЛАДОВА РАЗПИСКА за приемане/предаване на МЦ', draft: noteDraft(number, lines, customer) }],
    { warehouseId: String(ctx.wh._id) },
  )
  const mapped = doc.mapped as MappedMovement
  const [res] = await commitDocuments(String(ctx.org._id), String(ctx.user._id), 'movement', [{ mapped }])
  expect(res.ok).toBe(true)
  return { mapped, res }
}

async function analyzeInvoice(ctx: any, number = '3000100974', lines = INVOICE_LINES, customer = PARTNER) {
  const [doc] = await analyzeDocuments(
    String(ctx.org._id), 'sales_invoice',
    [{ fileId: 'i1', filename: `invoicem_${number}.pdf`, text: 'ФАКТУРА', draft: invoiceDraft(number, lines, customer) }],
    { warehouseId: String(ctx.wh._id) },
  )
  return doc.mapped as MappedInvoice
}

describe('складова разписка → фактура conversion', () => {
  it('carries the note\'s partner onto the movement instead of dropping it', async () => {
    const ctx = await scenario()
    const { mapped } = await bookNote(ctx)
    const contact: any = await Contact.findOne({ orgId: ctx.org._id, taxId: PARTNER.company_id }).lean()
    expect(mapped.contactId).toBe(String(contact._id))
    const mv: any = await StockMovement.findOne({ orgId: ctx.org._id, type: 'transfer' }).lean()
    expect(String(mv.contactId)).toBe(String(contact._id))
  })

  it('recognises the invoice, links both sides and moves no stock a second time', async () => {
    const ctx = await scenario()
    await bookNote(ctx)
    const afterNote: any = await StockLevel.findOne({ orgId: ctx.org._id, productId: ctx.bolt._id }).lean()
    expect(afterNote.quantity).toBe(700)

    const mapped = await analyzeInvoice(ctx)
    const hit = await findStockNoteConversion(String(ctx.org._id), mapped)
    expect(hit?.marker).toBe('sklrazp:0000012713')

    const [res] = await commitDocuments(String(ctx.org._id), String(ctx.user._id), 'sales_invoice', [
      { fileId: 'i1', mapped, options: { convert: true, adjustStock: true } },
    ])
    expect(res.ok).toBe(true)
    expect(res.issuedNumber).toBe('INV-3000100974')
    expect(res.stockSource).toBe('sklrazp:0000012713')
    expect(res.error).toContain('0000012713')

    // The whole point: the note's 300 left, the invoice's 300 did not.
    const after: any = await StockLevel.findOne({ orgId: ctx.org._id, productId: ctx.bolt._id }).lean()
    expect(after.quantity).toBe(700)
    expect(await StockMovement.countDocuments({ orgId: ctx.org._id, type: 'dispatch' })).toBe(0)

    const inv: any = await Invoice.findById(res.id).lean()
    expect(inv.stockSource.marker).toBe('sklrazp:0000012713')
    expect(inv.stockSource.detectedBy).toBe('lines')
    const mv: any = await StockMovement.findOne({ orgId: ctx.org._id, type: 'transfer' }).lean()
    expect(String(mv.invoiceId)).toBe(String(res.id))
  })

  it('books normally when the quantities differ — a subset is not a conversion', async () => {
    const ctx = await scenario()
    await bookNote(ctx)
    const mapped = await analyzeInvoice(ctx, '3000100975', [
      { ...INVOICE_LINES[0], quantity: 200, total: 114 },
      INVOICE_LINES[1],
    ])
    expect(await findStockNoteConversion(String(ctx.org._id), mapped)).toBeNull()

    const [res] = await commitDocuments(String(ctx.org._id), String(ctx.user._id), 'sales_invoice', [
      { mapped, options: { convert: true, adjustStock: true } },
    ])
    expect(res.stockSource).toBeUndefined()
    const after: any = await StockLevel.findOne({ orgId: ctx.org._id, productId: ctx.bolt._id }).lean()
    expect(after.quantity).toBe(500) // 1000 − 300 (note) − 200 (invoice)
  })

  it('books normally when the note went to a different partner', async () => {
    const ctx = await scenario()
    await Contact.create({ orgId: ctx.org._id, type: 'customer', companyName: OTHER.name, taxId: OTHER.company_id, isActive: true } as any)
    await bookNote(ctx, '0000012713', NOTE_LINES, OTHER)

    const mapped = await analyzeInvoice(ctx)
    expect(await findStockNoteConversion(String(ctx.org._id), mapped)).toBeNull()
  })

  it('will not attribute one note to a second invoice', async () => {
    const ctx = await scenario()
    await bookNote(ctx)
    const first = await analyzeInvoice(ctx)
    await commitDocuments(String(ctx.org._id), String(ctx.user._id), 'sales_invoice', [
      { mapped: first, options: { convert: true, adjustStock: true } },
    ])

    // Same shipment, same partner, a different document number — the note is already claimed.
    const second = await analyzeInvoice(ctx, '3000100999')
    expect(await findStockNoteConversion(String(ctx.org._id), second)).toBeNull()
    const [res] = await commitDocuments(String(ctx.org._id), String(ctx.user._id), 'sales_invoice', [
      { mapped: second, options: { convert: true, adjustStock: true } },
    ])
    expect(res.stockSource).toBeUndefined()
    const after: any = await StockLevel.findOne({ orgId: ctx.org._id, productId: ctx.bolt._id }).lean()
    expect(after.quantity).toBe(400) // 1000 − 300 (note) − 300 (the second, real dispatch)
  })

  it('refuses to guess when a line has no product', async () => {
    const ctx = await scenario()
    await bookNote(ctx)
    const mapped = await analyzeInvoice(ctx)
    mapped.lines[1].productId = undefined
    expect(await findStockNoteConversion(String(ctx.org._id), mapped)).toBeNull()
  })

  it('does not restock a converted invoice on void — it never dispatched', async () => {
    const ctx = await scenario()
    await bookNote(ctx)
    const mapped = await analyzeInvoice(ctx)
    const [res] = await commitDocuments(String(ctx.org._id), String(ctx.user._id), 'sales_invoice', [
      { mapped, options: { convert: true, adjustStock: true } },
    ])
    const inv: any = await Invoice.findById(res.id).lean()

    await reverseInvoiceStockMovement({ ...inv, id: String(inv._id) } as any, String(ctx.user._id))

    const after: any = await StockLevel.findOne({ orgId: ctx.org._id, productId: ctx.bolt._id }).lean()
    expect(after.quantity).toBe(700) // unchanged — a void must not put back what never left here
    expect(await StockMovement.countDocuments({ orgId: ctx.org._id, type: 'receipt' })).toBe(0)
  })

  it('books one movement per warehouse, not one per line', async () => {
    // Regression: `byWarehouse` keyed on the raw warehouseId, so a caller passing a lean invoice
    // (ObjectId ids, compared by reference) turned one 50-line invoice into 50 movements.
    const ctx = await scenario()
    const mapped = await analyzeInvoice(ctx, '3000100977')
    const [res] = await commitDocuments(String(ctx.org._id), String(ctx.user._id), 'sales_invoice', [
      { mapped, options: { convert: true, adjustStock: true } },
    ])
    const inv: any = await Invoice.findById(res.id).lean()
    expect(inv.lines.length).toBe(2)
    const dispatches: any[] = await StockMovement.find({ orgId: ctx.org._id, type: 'dispatch' }).lean()
    expect(dispatches.length).toBe(1)
    expect(dispatches[0].lines.length).toBe(2)
  })
})
