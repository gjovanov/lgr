import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import type { Types } from 'mongoose'
import { DocFile, Org, VatRegisterEntry } from 'db/models'
import { SalesRegisterError, compareSalesRegisterOf } from 'services/biz/vat-files/sales-register.service'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg, createTestProduct, createTestUser } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * FR-25 R3: a books org's sales register derived from its two branches' documents, against the one
 * filed. Fictional data only: two stores, documents of every kind the register sees, and the rows
 * only the accountant's register holds (a protocol, a till's month, a series no store issues).
 */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const PERIOD = '202609'
let books: any, pz: any, sf: any, user: any

/** A 20% invoice line, the shape every store document here carries. */
const line = (net: number, vat: number, productId?: Types.ObjectId, taxRate = 20) =>
  ({ description: 'ТЕСТ', quantity: 1, unit: 'pcs', unitPrice: net, discount: 0, taxRate, taxAmount: vat, lineTotal: net + vat, ...(productId ? { productId } : {}) })

async function issued(org: any, contactId: Types.ObjectId, over: Record<string, unknown>, imported = true) {
  const inv: any = await createTestInvoice(org._id, contactId, { status: 'sent', ...over } as any)
  if (imported) {
    await DocFile.create({
      orgId: org._id, docType: 'invoice', docNumber: String(inv.invoiceNumber).slice(-10), docDate: '2026-09-15', status: 'committed',
      committedTarget: 'invoice', committedIds: [inv._id], originalName: `invoicem_${inv._id}.pdf`, currentPath: '/dev/null',
      currentChecksum: String(inv._id), mimeType: 'application/pdf', size: 1, uploadedBy: user._id,
    })
  }
  return inv
}

const filedRow = (rowNo: number, over: Record<string, unknown>) => ({
  orgId: books._id, period: PERIOD, side: 'sales', ledger: 'books', rowNo, frozen: true,
  docTypeCode: '01', docDate: day('2026-09-10'), partnerVat: 'BG999000191', ...over,
})

beforeAll(async () => {
  await setupTestDB()
  books = await createTestOrg({ name: 'Книги', slug: 'books-test' } as any)
  pz = await createTestOrg({ name: 'Магазин А', slug: 'store-a-test' } as any)
  sf = await createTestOrg({ name: 'Магазин Б', slug: 'store-b-test' } as any)
  user = await createTestUser(pz._id)
  await Org.updateOne({ _id: books._id }, { $set: { 'settings.accounting.books': { mode: 'books', branches: [
    { orgId: pz._id, code: 'PZ', label: 'Магазин А', docSeries: ['3000'] },
    { orgId: sf._id, code: 'SF', label: 'Магазин Б', docSeries: ['2000'] },
  ] } } })

  const registered: any = await createTestContact(pz._id, { companyName: 'ТЕСТ КЛИЕНТ ООД', taxId: '999000191', vatNumber: 'BG999000191' } as any)
  const unregistered: any = await createTestContact(pz._id, { companyName: 'ТЕСТ ДРУГ ЕООД', taxId: '123456786', vatNumber: undefined } as any)
  const service: any = await createTestProduct(pz._id, { type: 'service', taxRate: 20 } as any)
  const money = (net: number, vat: number) => ({ subtotal: net, discountTotal: 0, taxTotal: vat, total: net + vat, totalBase: net + vat, amountDue: net + vat })

  // Equal: an invoice carrying its own VAT, and a credit note to a partner with no VAT number.
  await issued(pz, registered._id, { invoiceNumber: 'INV-3000700001', issueDate: day('2026-09-10'), lines: [line(0.33, 0.07), line(0.33, 0.07)], ...money(0.66, 0.13) })
  await issued(pz, unregistered._id, { type: 'credit_note', invoiceNumber: 'INV-3000700003', issueDate: day('2026-09-12'), lines: [line(10, 2, service._id)], ...money(10, 2) })
  // Equal: annulled in its own period, a row with no values.
  await issued(pz, registered._id, {
    invoiceNumber: 'INV-3000700004', issueDate: day('2026-09-13'), status: 'voided', lines: [line(5, 1)], ...money(5, 1),
    statusHistory: [{ status: 'sent', changedAt: day('2026-09-13') }, { status: 'voided', changedAt: new Date('2026-09-20T10:00:00.000Z') }],
  })
  // Differs: stored with its lines' rounded VAT, 0.14, where the document and the register say 0.13.
  await issued(pz, registered._id, { invoiceNumber: 'INV-3000700002', issueDate: day('2026-09-11'), status: 'paid', lines: [line(0.33, 0.07), line(0.33, 0.07)], ...money(0.66, 0.14) })
  // In LGR, not filed: issued in LGR, with no PlusMinus document behind it.
  await issued(pz, registered._id, { invoiceNumber: 'INV-2026-3000700005', issueDate: day('2026-09-14'), lines: [line(1, 0.2)], ...money(1, 0.2) }, false)
  // Equal: imported by the API path, which keeps no PDF but drafts through the document import.
  await issued(pz, registered._id, {
    invoiceNumber: 'INV-3000700008', issueDate: day('2026-09-17'), lines: [line(2, 0.4)], ...money(2, 0.4),
    tags: ['ocr-import'], statusHistory: [{ status: 'draft', changedAt: day('2026-09-17'), reason: 'ocr_import' }, { status: 'sent', changedAt: day('2026-09-17') }],
  }, false)
  // Annulled in October: September keeps its values, and October says its row is not derived.
  await issued(pz, registered._id, {
    invoiceNumber: 'INV-3000700009', issueDate: day('2026-09-18'), status: 'voided', lines: [line(3, 0.6)], ...money(3, 0.6),
    statusHistory: [{ status: 'sent', changedAt: day('2026-09-18') }, { status: 'voided', changedAt: new Date('2026-10-05T10:00:00.000Z') }],
  })
  // No row: a draft, a 9% document, and one of the next month.
  await issued(pz, registered._id, { invoiceNumber: 'DRF-INV-00001', status: 'draft', issueDate: day('2026-09-15'), lines: [line(1, 0.2)], ...money(1, 0.2) }, false)
  await issued(pz, registered._id, { invoiceNumber: 'INV-3000700006', issueDate: day('2026-09-16'), lines: [line(1, 0.09, undefined, 9)], ...money(1, 0.09) })
  await issued(pz, registered._id, { invoiceNumber: 'INV-3000700007', issueDate: day('2026-10-01'), lines: [line(1, 0.2)], ...money(1, 0.2) })

  await VatRegisterEntry.insertMany([
    filedRow(1, { docNumber: '3000700001', cells: { '02-10': 66, '02-11': 66, '02-20': 13, '02-21': 13 } }),
    filedRow(2, { docNumber: '3000700002', docDate: day('2026-09-11'), cells: { '02-10': 66, '02-11': 66, '02-20': 13, '02-21': 13 } }),
    filedRow(3, { docTypeCode: '03', docNumber: '3000700003', docDate: day('2026-09-12'), partnerVat: '123456786', cells: { '02-10': -1000, '02-11': -1000, '02-20': -200, '02-21': -200 } }),
    filedRow(4, { docNumber: '3000700004', docDate: day('2026-09-13'), cells: {} }),
    filedRow(5, { docNumber: '2000700001', cells: { '02-10': 100, '02-11': 100, '02-20': 20, '02-21': 20 } }),
    filedRow(6, { docNumber: '0000012345', cells: { '02-10': 100, '02-11': 100, '02-20': 20, '02-21': 20 } }),
    filedRow(7, { docTypeCode: '09', docNumber: '12', partnerVat: 'DE999999999', cells: { '02-10': 100, '02-12': 100, '02-20': 20, '02-22': 20 } }),
    filedRow(8, { docTypeCode: '81', docNumber: '', partnerVat: '999999999999', cells: { '02-10': 100, '02-11': 100, '02-20': 20, '02-21': 20 } }),
    filedRow(9, { docNumber: '3000700008', docDate: day('2026-09-17'), cells: { '02-10': 200, '02-11': 200, '02-20': 40, '02-21': 40 } }),
    filedRow(10, { docNumber: '3000700009', docDate: day('2026-09-18'), cells: { '02-10': 300, '02-11': 300, '02-20': 60, '02-21': 60 } }),
  ])
})

afterAll(async () => {
  await teardownTestDB()
})

describe('FR-25 R3 — the sales register, derived from the branches and compared with the one filed', () => {
  it('counts every row: equal, differing and in what, and which side alone holds it', async () => {
    const gate = await compareSalesRegisterOf(books._id, PERIOD)
    expect(gate.filedRows).toBe(10)
    expect(gate.derivedRows).toBe(7)
    expect(gate.branches).toEqual(['PZ', 'SF'])
    expect(gate.outside).toEqual([])
    expect(gate.counts).toEqual({
      'PZ imported: equal': 5,
      'PZ imported: differs in vat': 1,
      'PZ native: in LGR, not filed': 1,
      "filed 01, SF's series: not in LGR": 1,
      "filed 01, no branch's series": 1,
      "filed 09, no branch's series (a 2-character number)": 1,
      "filed 81, no branch's series (a 0-character number)": 1,
      'PZ: no row derived (not_issued: draft)': 1,
      'PZ: no row derived (rate_not_derived: 9)': 1,
    })
    expect(gate.gap).toBe(true)
    // The operator's view names the row and the cents, and nothing in `counts` does.
    expect(gate.details.find(d => d.outcome.includes('differs'))).toEqual({ key: '01:3000700002', outcome: 'PZ imported: differs in vat', deltas: { base: 0, vat: 1 } })
    expect(JSON.stringify(gate.counts)).not.toContain('3000700')
  })

  it('shows what a month not filed yet would declare, and calls nothing a gap', async () => {
    const gate = await compareSalesRegisterOf(books._id, '202610')
    expect(gate.filedRows).toBe(0)
    expect(gate.counts).toEqual({ 'PZ imported: in LGR, not filed': 1, 'PZ: annulled this period, issued before it: no row derived': 1 })
    expect(gate.gap).toBe(false)
  })

  it('refuses an org that keeps its own books, and a period that is not one', async () => {
    const own = await captureRejection(compareSalesRegisterOf(pz._id, PERIOD))
    expect(own).toBeInstanceOf(SalesRegisterError)
    expect((own as SalesRegisterError).code).toBe('not_a_books_org')
    const bad = await captureRejection(compareSalesRegisterOf(books._id, '202613'))
    expect((bad as SalesRegisterError).code).toBe('bad_period')
  })

  it('names the rows of a store that sells outside LGR by its series, and derives nothing for it', async () => {
    await Org.updateOne({ _id: books._id }, { $set: { 'settings.accounting.books.externalBranches': [{ code: 'PZW', docSeries: ['00000'] }] } })
    const gate = await compareSalesRegisterOf(books._id, PERIOD)
    expect(gate.branches).toEqual(['PZ', 'SF'])
    expect(gate.outside).toEqual(['PZW'])
    expect(gate.derivedRows).toBe(7)
    expect(gate.counts["filed 01, PZW's series: a store outside LGR"]).toBe(1)
    expect(gate.counts["filed 01, no branch's series"]).toBeUndefined()
  })

  it('reads the same from the home of a split, whose branches are both stores and itself (FR-25 R7)', async () => {
    const split = {
      mode: 'books',
      branches: [{ orgId: pz._id, code: 'PZ', label: 'Магазин А', docSeries: ['3000'] }, { orgId: sf._id, code: 'SF', label: 'Магазин Б', docSeries: ['2000'] }],
      externalBranches: [{ code: 'PZW', docSeries: ['00000'] }],
      split: { homeOrgId: pz._id },
    }
    await Org.updateMany({ _id: { $in: [pz._id, sf._id] } }, { $set: { 'settings.accounting.books': split } })
    // The VAT files are the home's: the same filed rows, held by the home.
    const filed: any[] = await VatRegisterEntry.find({ orgId: books._id }).lean()
    await VatRegisterEntry.insertMany(filed.map(({ _id, ...row }) => ({ ...row, orgId: pz._id })))
    try {
      const fromBooks = await compareSalesRegisterOf(books._id, PERIOD)
      const fromHome = await compareSalesRegisterOf(pz._id, PERIOD)
      expect(fromHome).toMatchObject({ filedRows: 10, derivedRows: 7, branches: ['PZ', 'SF'], outside: ['PZW'], gap: true })
      expect(fromHome.counts).toEqual(fromBooks.counts)
      expect(fromHome.details).toEqual(fromBooks.details)
    } finally {
      await VatRegisterEntry.deleteMany({ orgId: pz._id })
      await Org.updateMany({ _id: { $in: [pz._id, sf._id] } }, { $unset: { 'settings.accounting.books': 1 } })
    }
  })
})
