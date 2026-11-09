import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestInvoice, createTestProduct, createTestWarehouse } from '../helpers/factories'
import { getContactLedger } from 'services/biz/contact-ledger.service'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

describe('Contact Ledger', () => {
  it('should return empty ledger for contact with no invoices', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)

    const result = await getContactLedger(String(org._id), String(contact._id))

    expect(result.entries).toHaveLength(0)
    expect(result.total).toBe(0)
    expect(result.summary.totalSales).toBe(0)
    expect(result.summary.totalPurchases).toBe(0)
    expect(result.summary.balance).toBe(0)
  })

  it('should show sales invoice entries with product details', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id, { name: 'Widget' })
    const warehouse = await createTestWarehouse(org._id)

    await createTestInvoice(org._id, contact._id, {
      type: 'invoice',
      direction: 'outgoing',
      status: 'sent',
      lines: [{
        productId: product._id,
        description: 'Widget',
        quantity: 10,
        unit: 'pcs',
        unitPrice: 25,
        discount: 0,
        taxRate: 18,
        taxAmount: 45,
        lineTotal: 295,
        warehouseId: warehouse._id,
      }],
    })

    const result = await getContactLedger(String(org._id), String(contact._id))

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].documentType).toBe('invoice')
    expect(result.entries[0].productName).toBe('Widget')
    expect(result.entries[0].quantity).toBe(10)
    expect(result.entries[0].unitPrice).toBe(25)
    expect(result.entries[0].lineTotal).toBe(295)
    expect(result.entries[0].warehouseName).toBe(warehouse.name)
  })

  it('should compute summary totals for outgoing and incoming invoices', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)

    // Outgoing (sale)
    await createTestInvoice(org._id, contact._id, {
      type: 'invoice', direction: 'outgoing', status: 'sent', total: 500,
    })

    // Incoming (purchase)
    await createTestInvoice(org._id, contact._id, {
      type: 'invoice', direction: 'incoming', status: 'sent', total: 200,
      invoiceNumber: `BILL-${Date.now()}`,
    })

    const result = await getContactLedger(String(org._id), String(contact._id))

    expect(result.summary.totalSales).toBe(500)
    expect(result.summary.totalPurchases).toBe(200)
    expect(result.summary.balance).toBe(300)
  })

  it('should filter by date range', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)

    await createTestInvoice(org._id, contact._id, {
      type: 'invoice', direction: 'outgoing', status: 'sent',
      issueDate: new Date('2025-01-15'), total: 100,
      invoiceNumber: `INV-JAN-${Date.now()}`,
    })
    await createTestInvoice(org._id, contact._id, {
      type: 'invoice', direction: 'outgoing', status: 'sent',
      issueDate: new Date('2025-06-15'), total: 200,
      invoiceNumber: `INV-JUN-${Date.now()}`,
    })

    const result = await getContactLedger(String(org._id), String(contact._id), {
      dateFrom: '2025-05-01',
      dateTo: '2025-12-31',
    })

    // Only the June invoice should match
    expect(result.summary.totalSales).toBe(200)
  })

  it('should filter by document type', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)

    await createTestInvoice(org._id, contact._id, {
      type: 'invoice', direction: 'outgoing', status: 'sent', total: 100,
    })
    await createTestInvoice(org._id, contact._id, {
      type: 'credit_note', direction: 'outgoing', status: 'sent', total: 50,
      invoiceNumber: `CRN-${Date.now()}`,
    })

    const result = await getContactLedger(String(org._id), String(contact._id), {
      documentTypes: ['credit_note'],
    })

    expect(result.entries.length).toBeGreaterThanOrEqual(0)
    expect(result.summary.totalCreditNotes).toBe(50) // only credit note
  })

  it('should paginate results', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)

    // Create 5 invoices
    for (let i = 0; i < 5; i++) {
      await createTestInvoice(org._id, contact._id, {
        type: 'invoice', direction: 'outgoing', status: 'sent', total: 100,
        invoiceNumber: `INV-PAG-${Date.now()}-${i}`,
      })
    }

    const page0 = await getContactLedger(String(org._id), String(contact._id), { page: 0, size: 2 })
    expect(page0.entries.length).toBeLessThanOrEqual(2)
    expect(page0.total).toBeGreaterThanOrEqual(5)
    expect(page0.totalPages).toBeGreaterThanOrEqual(3)
  })
})

/**
 * #526: the ledger searched by product and by document number, in the service, so a search runs over every page and
 * the summary counts what the table lists.
 *
 * The customer's documents, by date:
 *   03-10 INV-2026-00101  bolt 100 × 0.20 @20 %, washer 200 × 0.05 @20 %   → 30 / 6 / 36
 *   03-11 BILL-2026-00055 bolt 1000 × 0.15 @20 % (a purchase)              → 150 / 30 / 180
 *   03-12 INV-2026-00102  gadget 1 × 50 @9 %                                → 50 / 4.5 / 54.5
 *   03-15 CRN-2026-00007  bolt 10 × 0.20 @20 % (a credit note)              → 2 / 0.4 / 2.4
 *   03-16 BILL-2026-00056 profile 1 × 10 @20 % (a purchase)                → 10 / 2 / 12
 *   03-18 CS-2026-00009   washer 100 × 0.05 @20 % (a cash sale)            → 5 / 1 / 6
 *   03-20 INV-2026-00103  bolt 50 × 0.20, gadget 1 × 100, both @20 %, stored as an import stores them: `lineTotal` NET
 *                                                                           → 110 / 22 / 132
 * Purchase prices: bolt 0.12, washer 0.01, gadget 20, profile 4.
 */
describe('#526: searching the ledger by product and by number', () => {
  const NET_LINES = true

  function line(product: any, quantity: number, unitPrice: number, taxRate: number, netLineTotal = false) {
    const net = quantity * unitPrice
    const tax = +(net * taxRate / 100).toFixed(2)
    return {
      productId: product._id, description: product.name, quantity, unit: 'pcs', unitPrice, discount: 0, taxRate,
      taxAmount: tax, lineTotal: +(netLineTotal ? net : net + tax).toFixed(2),
    }
  }

  async function doc(orgId: any, contactId: any, fields: Record<string, any>, lines: any[]) {
    const subtotal = +lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0).toFixed(2)
    const taxTotal = +lines.reduce((s, l) => s + l.taxAmount, 0).toFixed(2)
    const total = +(subtotal + taxTotal).toFixed(2)
    return createTestInvoice(orgId, contactId, {
      type: 'invoice', direction: 'outgoing', status: 'sent', ...fields,
      issueDate: new Date(fields.issueDate), lines, subtotal, taxTotal, total, totalBase: total, amountDue: total,
    } as any)
  }

  async function fixture() {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const other = await createTestContact(org._id)
    const bolt = await createTestProduct(org._id, { name: 'Болт М8Х25 DIN 933', sku: 'BLT-0825', barcode: '3800123456789', purchasePrice: 0.12 } as any)
    const washer = await createTestProduct(org._id, { name: 'Шайба М8', sku: 'SHB-08', barcode: '3800000000002', purchasePrice: 0.01 } as any)
    const gadget = await createTestProduct(org._id, { name: 'Gadget Pro', sku: 'GDG-1', barcode: '4000000000001', purchasePrice: 20 } as any)
    const profile = await createTestProduct(org._id, { name: 'Профил 40Х40', sku: 'PRF-4040', barcode: '3800000000040', purchasePrice: 4 } as any)
    await doc(org._id, contact._id, { invoiceNumber: 'INV-2026-00101', issueDate: '2026-03-10' }, [line(bolt, 100, 0.2, 20), line(washer, 200, 0.05, 20)])
    await doc(org._id, contact._id, { invoiceNumber: 'BILL-2026-00055', issueDate: '2026-03-11', direction: 'incoming', status: 'received' }, [line(bolt, 1000, 0.15, 20)])
    await doc(org._id, contact._id, { invoiceNumber: 'INV-2026-00102', issueDate: '2026-03-12' }, [line(gadget, 1, 50, 9)])
    await doc(org._id, contact._id, { invoiceNumber: 'CRN-2026-00007', issueDate: '2026-03-15', type: 'credit_note' }, [line(bolt, 10, 0.2, 20)])
    await doc(org._id, contact._id, { invoiceNumber: 'BILL-2026-00056', issueDate: '2026-03-16', direction: 'incoming', status: 'received' }, [line(profile, 1, 10, 20)])
    await doc(org._id, contact._id, { invoiceNumber: 'CS-2026-00009', issueDate: '2026-03-18', type: 'cash_sale', status: 'paid' }, [line(washer, 100, 0.05, 20)])
    await doc(org._id, contact._id, { invoiceNumber: 'INV-2026-00103', issueDate: '2026-03-20' }, [line(bolt, 50, 0.2, 20, NET_LINES), line(gadget, 1, 100, 20, NET_LINES)])
    // Another customer's bolts: never in this ledger.
    await doc(org._id, other._id, { invoiceNumber: 'INV-2026-00200', issueDate: '2026-03-21' }, [line(bolt, 999, 1, 20)])
    return { orgId: String(org._id), contactId: String(contact._id) }
  }

  const rowsOf = (r: { entries: Array<{ documentNumber: string; productName?: string }> }) =>
    r.entries.map(e => `${e.documentNumber} ${e.productName}`)

  /** Every summary figure, to the cent of a float sum. */
  function expectSummary(actual: Record<string, number>, expected: Record<string, number>) {
    for (const [k, v] of Object.entries(expected)) {
      expect(`${k} ${actual[k].toFixed(6)}`).toBe(`${k} ${v.toFixed(6)}`)
    }
  }

  it('Product: Cyrillic in any case, a look-alike Latin letter, the SKU and the barcode find the same lines', async () => {
    const { orgId, contactId } = await fixture()
    const boltRows = [
      'INV-2026-00103 Болт М8Х25 DIN 933',
      'CRN-2026-00007 Болт М8Х25 DIN 933',
      'BILL-2026-00055 Болт М8Х25 DIN 933',
      'INV-2026-00101 Болт М8Х25 DIN 933',
    ]
    for (const productSearch of ['болт', 'БОЛТ', 'M8X25', 'm8x25 din', 'blt-0825', '3800123456789', '38001234']) {
      const r = await getContactLedger(orgId, contactId, { productSearch })
      expect(`${productSearch}: ${rowsOf(r).join(' | ')}`).toBe(`${productSearch}: ${boltRows.join(' | ')}`)
      expect(r.total).toBe(4)
    }
    // Several words must all match one product: only the washer is a „шайба" of M8.
    expect(rowsOf(await getContactLedger(orgId, contactId, { productSearch: 'шайба м8' }))).toEqual([
      'CS-2026-00009 Шайба М8',
      'INV-2026-00101 Шайба М8',
    ])
    const none = await getContactLedger(orgId, contactId, { productSearch: 'no-such-thing' })
    expect(none.total).toBe(0)
    expect(none.entries).toEqual([])
    expect(none.summary).toEqual({
      totalSales: 0, totalPurchases: 0, balance: 0, totalSalesNet: 0, totalTax: 0, totalSalesGross: 0, totalCreditNotes: 0,
      profitabilityNet: 0, profitabilityGross: 0,
    })
  })

  it('Invoice #: part of the number, in any case, across every type the ledger lists', async () => {
    const { orgId, contactId } = await fixture()
    expect(rowsOf(await getContactLedger(orgId, contactId, { documentNumber: '2026-0010' }))).toEqual([
      'INV-2026-00103 Болт М8Х25 DIN 933',
      'INV-2026-00103 Gadget Pro',
      'INV-2026-00102 Gadget Pro',
      'INV-2026-00101 Болт М8Х25 DIN 933',
      'INV-2026-00101 Шайба М8',
    ])
    expect(rowsOf(await getContactLedger(orgId, contactId, { documentNumber: 'inv-2026-00102' }))).toEqual(['INV-2026-00102 Gadget Pro'])
    expect(rowsOf(await getContactLedger(orgId, contactId, { documentNumber: 'crn' }))).toEqual(['CRN-2026-00007 Болт М8Х25 DIN 933'])
    expect(rowsOf(await getContactLedger(orgId, contactId, { documentNumber: 'cs-2026' }))).toEqual(['CS-2026-00009 Шайба М8'])
    // Another customer's document is not this ledger's, whatever its number.
    expect((await getContactLedger(orgId, contactId, { documentNumber: '00200' })).total).toBe(0)
    // The summary follows the number too: the three invoices, nothing else.
    expectSummary((await getContactLedger(orgId, contactId, { documentNumber: '2026-0010' })).summary as any, {
      totalSalesNet: 190, totalTax: 32.5, totalSalesGross: 222.5, totalCreditNotes: 0, totalPurchases: 0, balance: 222.5,
    })
  })

  it('both: a row must satisfy both, and on a form-made line the summary is the row', async () => {
    const { orgId, contactId } = await fixture()
    const r = await getContactLedger(orgId, contactId, { productSearch: 'болт', documentNumber: '00101' })
    expect(rowsOf(r)).toEqual(['INV-2026-00101 Болт М8Х25 DIN 933'])
    expect(r.entries[0].lineTotal).toBe(24)
    expectSummary(r.summary as any, {
      totalSalesNet: 20, totalTax: 4, totalSalesGross: 24, totalSales: 24, totalPurchases: 0, balance: 24,
      // The cost of 100 bolts at 0.12.
      profitabilityNet: 20 - 12, profitabilityGross: 24 - 12,
    })
  })

  it('neither: the ledger answers exactly as without the options, blank ones included', async () => {
    const { orgId, contactId } = await fixture()
    const plain = await getContactLedger(orgId, contactId)
    expect(await getContactLedger(orgId, contactId, { productSearch: '   ', documentNumber: '' })).toEqual(plain)
    expect(plain.total).toBe(9)
    // The documents' own figures. Credit notes come off the gross and the net (the summary's long-standing rule).
    expectSummary(plain.summary as any, {
      totalSalesNet: 195 - 2.4, totalTax: 33.5, totalSalesGross: 228.5 - 2.4, totalCreditNotes: 2.4,
      totalPurchases: 192, balance: 226.1 - 192,
      // bolts 12 + 6, washers 2 + 1, gadgets 20 + 20: what the outgoing documents sold, credit note aside.
      profitabilityNet: 192.6 - 61, profitabilityGross: 226.1 - 61,
    })
  })

  it('a page past the first holds the rest of the search, each row once', async () => {
    const { orgId, contactId } = await fixture()
    const first = await getContactLedger(orgId, contactId, { productSearch: 'болт', page: 0, size: 3 })
    const second = await getContactLedger(orgId, contactId, { productSearch: 'болт', page: 1, size: 3 })
    expect([first.total, first.totalPages, second.total, second.totalPages]).toEqual([4, 2, 4, 2])
    expect(rowsOf(first)).toEqual([
      'INV-2026-00103 Болт М8Х25 DIN 933',
      'CRN-2026-00007 Болт М8Х25 DIN 933',
      'BILL-2026-00055 Болт М8Х25 DIN 933',
    ])
    expect(rowsOf(second)).toEqual(['INV-2026-00101 Болт М8Х25 DIN 933'])
    // Both lines of one document across a page boundary, in the document's order, on every request.
    for (let i = 0; i < 3; i++) {
      const a = await getContactLedger(orgId, contactId, { documentNumber: '00103', page: 0, size: 1 })
      const b = await getContactLedger(orgId, contactId, { documentNumber: '00103', page: 1, size: 1 })
      expect([...rowsOf(a), ...rowsOf(b)]).toEqual(['INV-2026-00103 Болт М8Х25 DIN 933', 'INV-2026-00103 Gadget Pro'])
    }
  })

  it('the summary under a Product filter counts the matching lines only, imported net lines at their gross', async () => {
    const { orgId, contactId } = await fixture()
    const r = await getContactLedger(orgId, contactId, { productSearch: 'болт' })
    // INV-101's bolts 20 / 4 / 24, INV-103's 10 / 2 / 12 (its stored `lineTotal` 10 is the net; its share of the
    // document's 132 is 12), the credit note's 2.4 off; the bill's 180 is a purchase. Cost: 150 bolts at 0.12.
    expectSummary(r.summary as any, {
      totalSalesNet: 20 + 10 - 2.4, totalTax: 4 + 2, totalSalesGross: 24 + 12 - 2.4, totalSales: 33.6, totalCreditNotes: 2.4,
      totalPurchases: 180, balance: 33.6 - 180,
      profitabilityNet: 27.6 - 18, profitabilityGross: 33.6 - 18,
    })
    // A search that finds every product counts every line, so it is the unfiltered summary.
    const all = await getContactLedger(orgId, contactId, { productSearch: '-' })
    const plain = await getContactLedger(orgId, contactId)
    expect(all.total).toBe(plain.total)
    expectSummary(all.summary as any, plain.summary as any)
  })

  it('a session without purchases finds no bill by either search, and the summary holds no purchase', async () => {
    const { orgId, contactId } = await fixture()
    const byNumber = await getContactLedger(orgId, contactId, { outgoingOnly: true, documentNumber: 'BILL-2026-00055' })
    expect(byNumber.total).toBe(0)
    expect(byNumber.entries).toEqual([])
    expect(byNumber.summary.totalPurchases).toBe(0)
    // The profile was only ever bought.
    expect((await getContactLedger(orgId, contactId, { outgoingOnly: true, productSearch: 'профил' })).total).toBe(0)
    expect(rowsOf(await getContactLedger(orgId, contactId, { productSearch: 'профил' }))).toEqual(['BILL-2026-00056 Профил 40Х40'])
    const bolts = await getContactLedger(orgId, contactId, { outgoingOnly: true, productSearch: 'болт' })
    expect(rowsOf(bolts)).toEqual([
      'INV-2026-00103 Болт М8Х25 DIN 933',
      'CRN-2026-00007 Болт М8Х25 DIN 933',
      'INV-2026-00101 Болт М8Х25 DIN 933',
    ])
    expect(bolts.summary.totalPurchases).toBe(0)
    expect(+bolts.summary.balance.toFixed(6)).toBe(33.6)
  })

  it('under a Type filter the cost is the cost of that type: profitability follows the table', async () => {
    const { orgId, contactId } = await fixture()
    // Invoices only: the cash sale's 100 washers (cost 1) are not theirs.
    const invoices = await getContactLedger(orgId, contactId, { documentTypes: ['invoice'] })
    expectSummary(invoices.summary as any, { totalSalesNet: 190, totalSalesGross: 222.5, profitabilityNet: 190 - 60, profitabilityGross: 222.5 - 60 })
    // Credit notes only: nothing was sold, so nothing cost anything.
    const notes = await getContactLedger(orgId, contactId, { documentTypes: ['credit_note'] })
    expectSummary(notes.summary as any, { totalSalesNet: -2.4, totalSalesGross: -2.4, profitabilityNet: -2.4, profitabilityGross: -2.4 })
  })
})
