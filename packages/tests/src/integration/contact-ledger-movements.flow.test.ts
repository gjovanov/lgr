import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestInvoice, createTestProduct, createTestStockMovement, createTestWarehouse } from '../helpers/factories'
import { StockMovement } from 'db/models'
import { getContactLedger, withoutLedgerCosts } from 'services/biz/contact-ledger.service'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

/**
 * The stock movements behind a contact's documents, and the ones no document carries.
 *
 * The customer's ledger, newest first (W1 „Main", W2 „Second"; a bolt costs 0.12):
 *   03-14 INV-C     washer 2 @ W1, issued for a till sale        → its goods left on SM-CS (the till sale's, no contact)
 *   03-13 SM-RET    a return of 1 bolt into W1, no document      → a row of its own, its value negative
 *   03-12 INV-B     bolt 3 @ W1, issued for a stock note         → its goods left on SM-NOTE (sklrazp_0000000111)
 *   03-11 SM-OUT    a transfer of 4 bolts out of W1, no document → a row of its own (sklrazp_0000000222), 09:30
 *   03-10 INV-A     bolt 10 @ W1, washer 5 @ W2, a service       → SM-A1 (W1), SM-A2 (W2), and none for the service
 * and four movements of the customer's that hold no goods: a draft, a cancelled one, one rolled back with its
 * document, and a record of goods another movement moved.
 *
 * The supplier's:
 *   03-16 SM-BACK   a return of 2 bolts out of W1, no document   → a row of its own, its value negative
 *   03-15 SM-R2     a receipt of 50 bolts, no bill yet            → a row of its own
 *   03-14 SM-R3     a receipt of 20 bolts, held by a DRAFT bill   → a row of its own: a draft is no row of the ledger
 *   03-09 BILL-1    bolt 100 @ W1, made from the receipt SM-R1   → its goods came on SM-R1
 */
const at = (day: string, time = '00:00:00') => new Date(`2026-${day}T${time}.000Z`)

function line(product: any, quantity: number, unitPrice: number, warehouseId?: any) {
  const net = quantity * unitPrice
  return {
    ...(product ? { productId: product._id } : {}), description: product?.name ?? 'Delivery to site', quantity, unit: 'pcs', unitPrice, discount: 0,
    taxRate: 20, taxAmount: +(net * 0.2).toFixed(2), lineTotal: +(net * 1.2).toFixed(2), ...(warehouseId ? { warehouseId } : {}),
  }
}

async function doc(orgId: any, contactId: any, fields: Record<string, any>, lines: any[]) {
  const subtotal = +lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0).toFixed(2)
  const taxTotal = +lines.reduce((s, l) => s + l.taxAmount, 0).toFixed(2)
  const total = +(subtotal + taxTotal).toFixed(2)
  return createTestInvoice(orgId, contactId, {
    type: 'invoice', direction: 'outgoing', status: 'sent', ...fields, lines, subtotal, taxTotal, total, totalBase: total, amountDue: total,
  } as any)
}

function movement(orgId: any, movementNumber: string, fields: Record<string, any>, product: any, quantity: number, unitCost = 0.12) {
  return createTestStockMovement(orgId, {
    movementNumber, status: 'completed', ...fields,
    lines: [{ productId: product._id, quantity, unitCost, totalCost: +(quantity * unitCost).toFixed(2) }],
    totalAmount: +(quantity * unitCost).toFixed(2),
  } as any)
}

const source = (marker: string, docNumber: string, movementIds: unknown[], detectedBy = 'manual') =>
  ({ stockSource: { marker, docNumber, movementIds, detectedBy, linkedAt: new Date() } })

async function fixture() {
  const org = await createTestOrg()
  const o = org._id
  const customer = await createTestContact(o, { companyName: 'Customer' } as any)
  const supplier = await createTestContact(o, { companyName: 'Supplier', type: 'supplier' } as any)
  const other = await createTestContact(o, { companyName: 'Somebody else' } as any)
  const main = await createTestWarehouse(o, { name: 'Main', code: 'W1' } as any)
  const second = await createTestWarehouse(o, { name: 'Second', code: 'W2' } as any)
  const bolt = await createTestProduct(o, { name: 'Bolt', sku: 'BLT', purchasePrice: 0.12 } as any)
  const washer = await createTestProduct(o, { name: 'Washer', sku: 'WSH', purchasePrice: 0.01 } as any)

  // INV-A: a movement out of each warehouse it sells from, and a line that moves nothing.
  const invA = await doc(o, customer._id, { invoiceNumber: 'INV-A', issueDate: at('03-10') }, [line(bolt, 10, 0.2, main._id), line(washer, 5, 0.05, second._id), line(null, 1, 10)])
  const a1 = await movement(o, 'SM-A1', { type: 'dispatch', date: at('03-10', '10:00:00'), fromWarehouseId: main._id, contactId: customer._id, invoiceId: invA._id }, bolt, 10, 0.2)
  const a2 = await movement(o, 'SM-A2', { type: 'dispatch', date: at('03-10', '10:00:01'), fromWarehouseId: second._id, contactId: customer._id, invoiceId: invA._id }, washer, 5, 0.05)

  // INV-B: the invoice of a stock note. The note's movement is claimed by it, and it books none of its own.
  const note = await movement(o, 'SM-NOTE', { type: 'transfer', date: at('03-05', '08:00:00'), fromWarehouseId: main._id, contactId: customer._id, reference: 'sklrazp_0000000111' }, bolt, 3)
  const invB = await doc(o, customer._id, { invoiceNumber: 'INV-B', issueDate: at('03-12'), ...source('sklrazp:0000000111', '0000000111', [note._id], 'lines') }, [line(bolt, 3, 0.2, main._id)])
  await StockMovement.updateOne({ _id: note._id }, { $set: { invoiceId: invB._id } })

  // INV-C: the invoice of a till sale to nobody in particular. The sale's movement stays the sale's.
  const sale = await doc(o, other._id, { invoiceNumber: 'CS-1', type: 'cash_sale', status: 'paid', issueDate: at('03-14', '09:00:00') }, [line(washer, 2, 0.05, main._id)])
  const cs = await movement(o, 'SM-CS', { type: 'dispatch', date: at('03-14', '09:00:00'), fromWarehouseId: main._id, invoiceId: sale._id }, washer, 2, 0.05)
  await doc(o, customer._id, { invoiceNumber: 'INV-C', issueDate: at('03-14'), ...source(`cash_sale:${sale._id}`, 'CS-1', [cs._id]) }, [line(washer, 2, 0.05, main._id)])

  // The customer's movements that no document carries, and four that hold no goods.
  const out = await movement(o, 'SM-OUT', { type: 'transfer', date: at('03-11', '09:30:00'), fromWarehouseId: main._id, contactId: customer._id, reference: 'sklrazp_0000000222' }, bolt, 4)
  const ret = await movement(o, 'SM-RET', { type: 'return', date: at('03-13', '12:00:00'), toWarehouseId: main._id, contactId: customer._id }, bolt, 1)
  await movement(o, 'SM-DRAFT', { type: 'dispatch', status: 'draft', date: at('03-11'), fromWarehouseId: main._id, contactId: customer._id }, bolt, 7)
  await movement(o, 'SM-CANCELLED', { type: 'dispatch', status: 'cancelled', date: at('03-11'), fromWarehouseId: main._id, contactId: customer._id }, bolt, 7)
  await movement(o, 'SM-ROLLED', { type: 'dispatch', date: at('03-11'), fromWarehouseId: main._id, contactId: customer._id, reversedBy: a1._id, reversedAt: new Date() }, bolt, 7)
  await movement(o, 'SM-RECORD', { type: 'dispatch', date: at('03-11'), fromWarehouseId: main._id, contactId: customer._id, recordOnly: true }, bolt, 7)
  // Somebody else's: never in this ledger.
  await movement(o, 'SM-OTHER', { type: 'dispatch', date: at('03-11'), fromWarehouseId: main._id, contactId: other._id }, bolt, 9)

  // The supplier: a bill made from a receipt, a receipt no bill has come for, one a draft bill holds, a return.
  const r1 = await movement(o, 'SM-R1', { type: 'receipt', date: at('03-08', '07:00:00'), toWarehouseId: main._id, contactId: supplier._id }, bolt, 100)
  const bill = await doc(o, supplier._id, { invoiceNumber: 'BILL-1', direction: 'incoming', status: 'received', issueDate: at('03-09'), ...source(`movement:${r1._id}`, 'SM-R1', [r1._id]) }, [line(bolt, 100, 0.12, main._id)])
  await StockMovement.updateOne({ _id: r1._id }, { $set: { invoiceId: bill._id } })
  const r2 = await movement(o, 'SM-R2', { type: 'receipt', date: at('03-15', '07:00:00'), toWarehouseId: main._id, contactId: supplier._id }, bolt, 50)
  const r3 = await movement(o, 'SM-R3', { type: 'receipt', date: at('03-14', '07:00:00'), toWarehouseId: main._id, contactId: supplier._id }, bolt, 20)
  const draft = await doc(o, supplier._id, { invoiceNumber: 'DRF-BILL-2', direction: 'incoming', status: 'draft', issueDate: at('03-14'), ...source(`movement:${r3._id}`, 'SM-R3', [r3._id]) }, [line(bolt, 20, 0.12, main._id)])
  await StockMovement.updateOne({ _id: r3._id }, { $set: { invoiceId: draft._id } })
  await movement(o, 'SM-BACK', { type: 'return', date: at('03-16', '07:00:00'), fromWarehouseId: main._id, contactId: supplier._id }, bolt, 2)

  return {
    org: o, customer: customer._id,
    orgId: String(o), customerId: String(customer._id), supplierId: String(supplier._id),
    ids: { a1: String(a1._id), a2: String(a2._id), note: String(note._id), cs: String(cs._id), out: String(out._id), ret: String(ret._id), r2: String(r2._id) },
    mainId: String(main._id),
  }
}

/** A row as `number | type | product | its movements`. */
const brief = (r: { entries: any[] }) =>
  r.entries.map(e => `${e.documentNumber || '—'} | ${e.documentType}${e.movementType ? `:${e.movementType}` : ''} | ${e.productName || '—'} | ${e.movements.map((m: any) => m.number).join('+') || '—'}`)

const CUSTOMER_ROWS = [
  'INV-C | invoice | Washer | SM-CS',
  '— | stock_movement:return | Bolt | SM-RET',
  'INV-B | invoice | Bolt | SM-NOTE',
  '— | stock_movement:transfer | Bolt | SM-OUT',
  'INV-A | invoice | Bolt | SM-A1',
  'INV-A | invoice | Washer | SM-A2',
  'INV-A | invoice | — | —',
]

describe('stock movements in the contact ledger', () => {
  it('a line names the movements that moved its goods, and a movement no document carries is a row of its own', async () => {
    const f = await fixture()
    const r = await getContactLedger(f.orgId, f.customerId)
    expect(brief(r)).toEqual(CUSTOMER_ROWS)
    expect(r.total).toBe(7)

    // A document's line: the movement of its own warehouse, by id, number and type; the note it stands for by its reference too.
    expect(r.entries[4].movements).toEqual([{ id: f.ids.a1, number: 'SM-A1', type: 'dispatch' }])
    expect(r.entries[5].movements).toEqual([{ id: f.ids.a2, number: 'SM-A2', type: 'dispatch' }])
    expect(r.entries[2].movements).toEqual([{ id: f.ids.note, number: 'SM-NOTE', type: 'transfer', reference: 'sklrazp_0000000111' }])
    expect(r.entries[0].movements).toEqual([{ id: f.ids.cs, number: 'SM-CS', type: 'dispatch' }])

    // The movement's own row: no document, the movement as it stands, valued at cost, and no tax.
    expect(r.entries[3]).toEqual({
      date: '2026-03-11T09:30:00.000Z', documentNumber: '', documentId: f.ids.out, documentType: 'stock_movement', movementType: 'transfer',
      movements: [{ id: f.ids.out, number: 'SM-OUT', type: 'transfer', reference: 'sklrazp_0000000222' }],
      productId: expect.any(String), productName: 'Bolt', quantity: 4, unitPrice: 0.12, warehouseId: f.mainId, warehouseName: 'Main', lineTotal: 0.48,
    })
    // Goods that came back take their value back, as a credit note's line does.
    expect([r.entries[1].quantity, r.entries[1].unitPrice, r.entries[1].lineTotal, r.entries[1].warehouseName]).toEqual([1, -0.12, -0.12, 'Main'])
  })

  it('the summary counts the documents, with the movements listed or not', async () => {
    const f = await fixture()
    const withMovements = await getContactLedger(f.orgId, f.customerId)
    const documentsOnly = await getContactLedger(f.orgId, f.customerId, { documentTypes: ['invoice', 'cash_sale', 'proforma', 'credit_note', 'debit_note'] })
    expect(withMovements.summary).toEqual(documentsOnly.summary)
    // INV-A 12.25 + 2.45, INV-B 0.60 + 0.12, INV-C 0.10 + 0.02.
    expect(+withMovements.summary.totalSalesNet.toFixed(2)).toBe(12.95)
    expect(+withMovements.summary.totalSalesGross.toFixed(2)).toBe(15.54)
    expect(withMovements.summary.totalPurchases).toBe(0)
  })

  it('Type: the documents alone, the movements alone, or both', async () => {
    const f = await fixture()
    const movements = await getContactLedger(f.orgId, f.customerId, { documentTypes: ['stock_movement'] })
    expect(brief(movements)).toEqual(['— | stock_movement:return | Bolt | SM-RET', '— | stock_movement:transfer | Bolt | SM-OUT'])
    expect(movements.total).toBe(2)
    expect([movements.summary.totalSales, movements.summary.totalPurchases, movements.summary.balance]).toEqual([0, 0, 0])

    const invoices = await getContactLedger(f.orgId, f.customerId, { documentTypes: ['invoice'] })
    expect(brief(invoices)).toEqual(CUSTOMER_ROWS.filter(row => !row.includes('stock_movement')))
    expect(invoices.total).toBe(5)

    expect(brief(await getContactLedger(f.orgId, f.customerId, { documentTypes: ['invoice', 'stock_movement'] }))).toEqual(CUSTOMER_ROWS)
    // A type no document of theirs has leaves the movements, when they are asked for with it.
    expect((await getContactLedger(f.orgId, f.customerId, { documentTypes: ['proforma', 'stock_movement'] })).total).toBe(2)
    expect((await getContactLedger(f.orgId, f.customerId, { documentTypes: ['proforma'] })).total).toBe(0)
  })

  it('a page is cut across documents and movements alike, each row once', async () => {
    const f = await fixture()
    const pages: string[] = []
    for (let page = 0; page < 4; page++) {
      const r = await getContactLedger(f.orgId, f.customerId, { page, size: 2 })
      expect([r.total, r.totalPages]).toEqual([7, 4])
      pages.push(...brief(r))
    }
    expect(pages).toEqual(CUSTOMER_ROWS)
  })

  it('Product: the lines of the article, of a document or of a movement', async () => {
    const f = await fixture()
    expect(brief(await getContactLedger(f.orgId, f.customerId, { productSearch: 'washer' }))).toEqual([
      'INV-C | invoice | Washer | SM-CS',
      'INV-A | invoice | Washer | SM-A2',
    ])
    const bolts = await getContactLedger(f.orgId, f.customerId, { productSearch: 'blt' })
    expect(brief(bolts)).toEqual([
      '— | stock_movement:return | Bolt | SM-RET',
      'INV-B | invoice | Bolt | SM-NOTE',
      '— | stock_movement:transfer | Bolt | SM-OUT',
      'INV-A | invoice | Bolt | SM-A1',
    ])
    expect(bolts.total).toBe(4)
  })

  it('Invoice #: a document by its number, a movement by its number or by the document it was booked from', async () => {
    const f = await fixture()
    const find = async (documentNumber: string) => brief(await getContactLedger(f.orgId, f.customerId, { documentNumber }))
    // A movement no document carries, by either.
    expect(await find('sm-out')).toEqual(['— | stock_movement:transfer | Bolt | SM-OUT'])
    expect(await find('0000000222')).toEqual(['— | stock_movement:transfer | Bolt | SM-OUT'])
    // A movement a document carries brings the document, whole.
    expect(await find('SM-A1')).toEqual(CUSTOMER_ROWS.slice(4))
    expect(await find('sklrazp_0000000111')).toEqual(['INV-B | invoice | Bolt | SM-NOTE'])
    // …also when the movement is another document's and names nobody: the till sale this invoice stands for.
    expect(await find('SM-CS')).toEqual(['INV-C | invoice | Washer | SM-CS'])
    // A document's own number finds no movement's row.
    expect(await find('INV-A')).toEqual(CUSTOMER_ROWS.slice(4))
    // What every number holds finds everything, once.
    expect(await find('-')).toEqual(CUSTOMER_ROWS)
    // Nobody else's movement, and none that holds no goods.
    for (const number of ['SM-OTHER', 'SM-DRAFT', 'SM-CANCELLED', 'SM-ROLLED', 'SM-RECORD', 'SM-R1']) expect(await find(number)).toEqual([])
    // Both searches: a row satisfies both.
    expect(brief(await getContactLedger(f.orgId, f.customerId, { documentNumber: 'SM-A', productSearch: 'washer' }))).toEqual(['INV-A | invoice | Washer | SM-A2'])
    // The summary follows the number: INV-B alone.
    const r = await getContactLedger(f.orgId, f.customerId, { documentNumber: 'sklrazp_0000000111' })
    expect(+r.summary.totalSalesGross.toFixed(2)).toBe(0.72)
  })

  it("a period's last day is whole, in the shop's time: what was booked during it is in", async () => {
    const f = await fixture()
    const within = (dateFrom?: string, dateTo?: string) => getContactLedger(f.orgId, f.customerId, { dateFrom, dateTo })
    // SM-OUT was booked at 09:30 on the 11th.
    expect(brief(await within('2026-03-11', '2026-03-11'))).toEqual(['— | stock_movement:transfer | Bolt | SM-OUT'])
    expect(brief(await within(undefined, '2026-03-10'))).toEqual(CUSTOMER_ROWS.slice(4))
    expect(brief(await within('2026-03-12'))).toEqual(CUSTOMER_ROWS.slice(0, 3))
    // What is no date bounds nothing.
    expect(brief(await within('soon', 'later'))).toEqual(CUSTOMER_ROWS)

    // A document that keeps its moment, as a till document does, counts on its day too: in the rows and in the summary.
    await doc(f.org, f.customer, { invoiceNumber: 'CS-EVENING', type: 'cash_sale', status: 'paid', issueDate: at('03-11', '17:45:00') }, [line(null, 1, 5)])
    const day = await within('2026-03-11', '2026-03-11')
    expect(brief(day)).toEqual(['CS-EVENING | cash_sale | — | —', '— | stock_movement:transfer | Bolt | SM-OUT'])
    expect(+day.summary.totalSalesGross.toFixed(2)).toBe(6)

    // Sofia is two hours ahead in March: 23:30 on the 11th there is 21:30 UTC, and 00:30 on the 12th is 22:30 UTC.
    await doc(f.org, f.customer, { invoiceNumber: 'CS-LATE', type: 'cash_sale', status: 'paid', issueDate: at('03-11', '21:30:00') }, [line(null, 1, 5)])
    await doc(f.org, f.customer, { invoiceNumber: 'CS-NEXT-DAY', type: 'cash_sale', status: 'paid', issueDate: at('03-11', '22:30:00') }, [line(null, 1, 5)])
    expect((await within('2026-03-11', '2026-03-11')).entries.map(e => e.documentNumber)).toEqual(['CS-LATE', 'CS-EVENING', ''])
    expect((await within('2026-03-12', '2026-03-12')).entries.map(e => e.documentNumber)).toEqual(['INV-B', 'CS-NEXT-DAY'])
    // An instant, not a calendar date, bounds as it is.
    expect((await within('2026-03-11T21:00:00.000Z', '2026-03-11T22:00:00.000Z')).entries.map(e => e.documentNumber)).toEqual(['CS-LATE'])
  })

  it("a supplier's: the bill names its receipt, and the deliveries no bill has come for are rows", async () => {
    const f = await fixture()
    const r = await getContactLedger(f.orgId, f.supplierId)
    expect(brief(r)).toEqual([
      '— | stock_movement:return | Bolt | SM-BACK',
      '— | stock_movement:receipt | Bolt | SM-R2',
      // Held by a bill still in draft: the draft is no row, and the delivery happened.
      '— | stock_movement:receipt | Bolt | SM-R3',
      'BILL-1 | invoice | Bolt | SM-R1',
    ])
    expect(JSON.stringify(r)).not.toContain('DRF-BILL-2')
    expect([r.entries[1].documentId, r.entries[1].quantity, r.entries[1].unitPrice, r.entries[1].lineTotal]).toEqual([f.ids.r2, 50, 0.12, 6])
    expect([r.entries[0].unitPrice, r.entries[0].lineTotal]).toEqual([-0.12, -0.24])
    // The summary is the bill's.
    expect(r.summary.totalPurchases).toBe(14.4)
  })

  it('without the purchases side: no bill, no receipt and no return to the supplier; what went to a customer stays', async () => {
    const f = await fixture()
    const supplier = await getContactLedger(f.orgId, f.supplierId, { outgoingOnly: true })
    expect(supplier.entries).toEqual([])
    expect(supplier.total).toBe(0)
    for (const documentNumber of ['SM-R2', 'SM-R3', 'SM-BACK', 'SM-R1', 'BILL-1']) {
      expect((await getContactLedger(f.orgId, f.supplierId, { outgoingOnly: true, documentNumber })).total).toBe(0)
    }
    expect((await getContactLedger(f.orgId, f.supplierId, { outgoingOnly: true, documentTypes: ['stock_movement'] })).total).toBe(0)
    expect(brief(await getContactLedger(f.orgId, f.customerId, { outgoingOnly: true }))).toEqual(CUSTOMER_ROWS)
  })

  it('without the cost figures a movement row carries no unit cost and no value; a document row keeps its price', async () => {
    const f = await fixture()
    const r = withoutLedgerCosts(await getContactLedger(f.orgId, f.customerId))
    expect(brief(r)).toEqual(CUSTOMER_ROWS)
    for (const e of r.entries) {
      if (e.documentType === 'stock_movement') {
        expect(['unitPrice', 'lineTotal'].filter(k => k in e)).toEqual([])
        expect(e.quantity).toBeGreaterThan(0)
      } else {
        expect(typeof e.unitPrice).toBe('number')
      }
    }
    expect('profitabilityNet' in r.summary).toBe(false)
  })
})
