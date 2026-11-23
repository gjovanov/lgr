import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestWarehouse, createTestProduct, createTestInvoice, createTestAccount } from '../helpers/factories'
import { mapInvoiceExtraction } from 'services/biz/doc-import/map-invoice'
import { analyzeDocuments } from 'services/biz/doc-import/analyze'
import { commitDocuments } from 'services/biz/doc-import/commit'
import { plusminusInvoiceToExtraction, buildSyntheticRawText, type PlusMinusDocument } from 'services/biz/doc-import/map-plusminus-invoice'
import { documentAmounts } from 'services/biz/document-amounts'
import { getContactLedger } from 'services/biz/contact-ledger.service'
import { getProductLedger } from 'services/biz/product-ledger.service'
import { createInvoiceJournalEntry } from 'services/biz/auto-journal.service'
import { Invoice, Journal } from 'db/models'
import type { DraftResult, MappedInvoice } from 'services/biz/doc-import/types'
import type { Types } from 'mongoose'

/**
 * #598 — one meaning for a line's `lineTotal`: gross, imported documents included.
 *
 * The import mapper (the PDF/OCR path and the PlusMinus API path both go through it) stores the paper's net
 * line value plus its VAT, with the VAT unchanged and the header still the paper's. The readers that took
 * `lineTotal` as gross are then right for an imported invoice too: the contact ledger beside an LGR-made
 * invoice of the same customer, the product ledger's sales, and the journal's revenue.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const ORG_EIK = '123456786'
const ORG_PARTY = { name: 'ПРОБА ООД', company_id: ORG_EIK, vat_id: 'BG' + ORG_EIK }
const CUSTOMER = { name: 'ЕТ ПРИМЕРОВ П', company_id: '999000214', vat_id: 'BG999000214', address: 'ул. Примерна 25' }

/** A canned sidecar response, as `doc-import.flow.test.ts` builds it. */
function draftResult(lines: any[], overrides: any = {}): DraftResult {
  const net = lines.reduce((s, l) => s + l.total, 0)
  return {
    extraction: {
      document_number: '2000725757', issue_date: '2026-03-31', currency: 'EUR', exchange_rate: 1,
      supplier: ORG_PARTY, customer: CUSTOMER, line_items: lines,
      net_total: net, vat_total: +(net * 0.2).toFixed(2), gross_total: +(net * 1.2).toFixed(2),
      ...overrides,
    },
    validation: { status: 'valid', checks: [] }, model: 'test', engine: 'test',
  }
}

const NUT = { description: 'Гайка М8', quantity: 40, unit: 'бр', unit_price: 0.1, vat_rate: 20, total: 4 }
// The PDF prints 0.0213, which does not make 64.00: the price is derived from the line value.
const WASHER = { description: 'Шайба М8', quantity: 3000, unit: 'бр', unit_price: 0.0213, vat_rate: 20, total: 64 }

const amounts = (m: MappedInvoice) => m.lines.map(l => [l.lineTotal, l.taxAmount])

describe('the import mapper stores lineTotal gross (#598)', () => {
  it('from a PDF\'s extraction: the line value plus its VAT; the VAT and the header are the paper\'s', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const { mapped } = await mapInvoiceExtraction(String(org._id), draftResult([NUT, WASHER]), 'ФАКТУРА', { direction: 'outgoing' })
    expect(amounts(mapped)).toEqual([[4.8, 0.8], [76.8, 12.8]])
    expect(mapped.lines.map(l => +(l.quantity * l.unitPrice).toFixed(2))).toEqual([4, 64])
    expect([mapped.subtotal, mapped.taxTotal, mapped.total]).toEqual([68, 13.6, 81.6])
  })

  it('with no net total on the document, the subtotal is the lines\' nets, never their gross', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const { mapped } = await mapInvoiceExtraction(String(org._id), draftResult([NUT, WASHER], { net_total: undefined }), '', { direction: 'outgoing' })
    expect(mapped.subtotal).toBe(68)
  })

  it('a credit note: positive magnitudes, gross', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const draft = draftResult([{ ...NUT, quantity: -40, total: -4 }], { net_total: -4, vat_total: -0.8, gross_total: -4.8 })
    const { mapped } = await mapInvoiceExtraction(String(org._id), draft, 'КРЕДИТНО ИЗВЕСТИЕ', { direction: 'outgoing', type: 'credit_note' })
    expect(amounts(mapped)).toEqual([[4.8, 0.8]])
    expect([mapped.subtotal, mapped.taxTotal, mapped.total]).toEqual([4, 0.8, 4.8])
  })

  it('from the PlusMinus API: the same, and the subtotal from the lines (the API gives none)', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const doc: PlusMinusDocument = {
      header: {
        docNumber: '3000704649', docDate: '20261026', partner: 'ПАРТНЬОРИ:ТЕСТ КЛИЕНТ АД', vatRate: '20',
        sum: '35.88', vat: '5.98', paymentMethod: '2', placeOfIssue: 'гр.Тестоград',
      },
      lines: [
        { name: 'БОЛТ М12Х60 - DIN 933 - A4', quantity: '100', measure: 'БР', price: '0.25', sum: '25' },
        { name: 'ГАЙКА М16 - DIN 934 - A4-80', quantity: '20', measure: 'БР', price: '0.245', sum: '4.9' },
      ],
    } as any
    const extraction = plusminusInvoiceToExtraction(doc, { name: 'ПРОБА ООД', eik: ORG_EIK, vatNumber: 'BG' + ORG_EIK, address: 'ул.Тестова 101', city: 'Тестоград' })
    const draft: DraftResult = { extraction, validation: { status: 'valid', checks: [] }, model: 'direct', engine: 'plusminus-api' } as any
    const { mapped } = await mapInvoiceExtraction(String(org._id), draft, buildSyntheticRawText(doc.header!))
    expect(mapped.direction).toBe('outgoing')
    expect(amounts(mapped)).toEqual([[30, 5], [5.88, 0.98]])
    expect([mapped.subtotal, mapped.taxTotal, mapped.total]).toEqual([29.9, 5.98, 35.88])
  })
})

/** An imported invoice issued through the Files commit, and an LGR-made one, for the same customer. */
async function bothKinds() {
  const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
  const orgId = org._id as Types.ObjectId
  const user = await createTestUser(orgId)
  const wh = await createTestWarehouse(orgId)
  const product = await createTestProduct(orgId, { name: 'Гайка М8' } as any)

  const [doc] = await analyzeDocuments(
    String(orgId), 'sales_invoice',
    [{ fileId: 'f1', filename: 'invoicem_2000725757.pdf', text: 'ФАКТУРА Номер: 2000725757', draft: draftResult([NUT]) }],
    { warehouseId: String(wh._id) }, {},
  )
  const [res] = await commitDocuments(String(orgId), String(user._id), 'sales_invoice', [
    { fileId: 'f1', mapped: doc.mapped!, options: { convert: true, adjustStock: false } },
  ])
  expect(res.ok).toBe(true)
  const imported: any = await Invoice.findById(res.id).lean()
  expect(imported.tags).toContain('ocr-import')
  expect(imported.status).toBe('sent')
  const contactId = imported.contactId as Types.ObjectId
  expect(contactId).toBeTruthy()

  // What `POST /invoices` stores for 10 × 0.40 at 20 %: the same money, made in LGR.
  const { lines } = documentAmounts({ lines: [{ productId: product._id, description: 'Гайка М8', quantity: 10, unitPrice: 0.4, taxRate: 20, warehouseId: wh._id } as any] })
  const made = await createTestInvoice(orgId, contactId, {
    status: 'sent', lines, subtotal: 4, taxTotal: 0.8, total: 4.8, totalBase: 4.8, amountDue: 4.8,
  } as any)
  return { org, orgId, user, wh, product, imported, made, contactId }
}

describe('the readers, with an imported and an LGR-made invoice side by side (#598)', () => {
  it('the contact ledger shows both lines gross, as their documents\' totals', async () => {
    const s = await bothKinds()
    const ledger = await getContactLedger(String(s.orgId), String(s.contactId))
    const rows = ledger.entries.filter(e => e.documentType === 'invoice')
    expect(rows.map(r => r.lineTotal).sort()).toEqual([4.8, 4.8])
    expect(rows.find(r => r.documentId === String(s.imported._id))!.lineTotal).toBe(s.imported.total)
    expect(rows.find(r => r.documentId === String(s.made._id))!.lineTotal).toBe((s.made as any).total)
    expect(ledger.summary.totalSales).toBe(9.6)
  })

  it('the product ledger\'s invoice sales add up gross, as its cash sales do', async () => {
    const s = await bothKinds()
    await createTestInvoice(s.orgId, s.contactId, {
      type: 'cash_sale', status: 'paid', invoiceNumber: 'CS-2026-00001',
      lines: [{ productId: s.product._id, description: 'Гайка М8', quantity: 5, unit: 'pcs', unitPrice: 0.1, discount: 0, taxRate: 20, taxAmount: 0.1, lineTotal: 0.6, warehouseId: s.wh._id }],
      subtotal: 0.5, taxTotal: 0.1, total: 0.6, totalBase: 0.6, amountPaid: 0.6, amountDue: 0,
    } as any)
    const { summary } = await getProductLedger(String(s.orgId), String(s.product._id))
    expect(summary.totalInvoiceSales).toBeCloseTo(9.6, 2)
    expect(summary.totalCashRegisterSales).toBeCloseTo(0.6, 2)
  })

  it('the journal posts an imported invoice\'s net as revenue and its VAT as VAT', async () => {
    const s = await bothKinds()
    const receivable = await createTestAccount(s.orgId, { name: 'Receivable', type: 'asset' })
    const revenue = await createTestAccount(s.orgId, { name: 'Revenue', type: 'revenue', subType: 'operating_revenue' } as any)
    const output = await createTestAccount(s.orgId, { name: 'Output VAT', type: 'liability' } as any)
    const journal = await Journal.create({ orgId: s.orgId, name: 'Sales', code: `S${Date.now() % 100000}`, type: 'sale' })
    const je = await createInvoiceJournalEntry(
      String(s.orgId), { ...s.imported, id: String(s.imported._id), createdBy: String(s.user._id) },
      { receivableAccountId: String(receivable._id), revenueAccountId: String(revenue._id), outputVatAccountId: String(output._id) },
      { journalId: String(journal._id) }, false,
    )
    const side = (id: unknown) => (je.lines as any[]).filter(l => String(l.accountId) === String(id))
      .reduce((a, l) => [+(a[0] + l.debit).toFixed(2), +(a[1] + l.credit).toFixed(2)], [0, 0])
    expect(side(revenue._id)).toEqual([0, 4])
    expect(side(output._id)).toEqual([0, 0.8])
    expect(side(receivable._id)).toEqual([4.8, 0])
  })
})
