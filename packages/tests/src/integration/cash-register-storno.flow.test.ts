import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import type { Elysia } from 'elysia'
import type { Types } from 'mongoose'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestAccount, createTestContact, createTestInvoice, createTestPOSTransaction, createTestStockMovement } from '../helpers/factories'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { tillRow } from '../helpers/till-row'
import { migrateTill } from '../helpers/migrate-till'
import { Invoice, Org, POSSession, POSTransaction, StockLevel, StockMovement } from 'db/models'
import { buildInvoiceHtml } from 'reporting/pdf/invoice.pdf'
import { requestHash } from 'services/biz/hot-path-key'
import { createMovementValuationEntry } from 'services/biz/auto-journal.service'
import { reportById } from 'services/biz/report-registry'
import { validateParams } from 'services/biz/report-registry.types'
import { getRepos } from 'services/context'

/**
 * FR-21.18 — a storno is its own `cash_storno` document (D-2, §3.5).
 *
 * The cases #145 set for the till (`pos-storno.flow`, `pos-idempotency.flow`) run on the new store
 * as they are. These are what the document changes:
 * - the sale stays `paid`, with `stornoState: 'full'` and the storno that reversed it;
 * - the storno is numbered in the cash-register series, positive, pointing at the sale;
 * - its return brings the goods back at the cost they left at, not at the sale price;
 * - a back-office sale is reversed from the journal without a session, printing nothing;
 * - an imported till day and an invoiced sale are refused;
 * - a sale still held as a POS row is copied first, and the frozen row is never written.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = tillApp()
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  forgetDevices()
  await clearCollections()
}, 30_000)

const year = new Date().getFullYear()

describe('a storno of a till sale', () => {
  it('is a cash_storno document; the sale stays paid, stornoed; one storno receipt; the drawer gives the money back', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(2, { tendered: 30 })
    const saleId = sale.json.transaction.id

    const res = await w.storno(saleId)

    expect(res.status).toBe(200)
    const storno: any = await Invoice.findById(res.json.transaction.id).lean()
    expect(storno).toMatchObject({
      type: 'cash_storno', status: 'paid', invoiceNumber: `CS-${year}-00002`, total: 24, amountPaid: 24,
    })
    expect(String(storno.relatedInvoiceId)).toBe(saleId)
    expect(storno.register).toMatchObject({
      origin: 'pos', unp: 'ED123456-0001-0000002', isFiscal: true,
      storno: { originalUnp: 'ED123456-0001-0000001', reason: 'customer_return' },
    })
    expect(storno.register.fiscal.state).toBe('printed')
    expect(String(storno.register.storno.originalId)).toBe(saleId)
    // The refund is what the sale kept: 24.00 of the 30.00 handed over.
    expect(storno.payments.map((p: any) => [p.method, p.amount])).toEqual([['cash', 24]])

    const original: any = await Invoice.findById(saleId).lean()
    expect(original.status).toBe('paid')
    expect(original.register.stornoState).toBe('full')
    expect(original.register.stornoedBy.map(String)).toEqual([String(storno._id)])
    expect(original.register.cancelledAt).toBeTruthy()
    // To the readers that still speak POS rows it is the stornoed sale it always was.
    expect((await tillRow(saleId)).status).toBe('cancelled')

    expect(w.sim!.receipts.filter(r => r.kind === 'storno' && !r.voided)).toHaveLength(1)
    const session: any = await POSSession.findById(w.sessionId).lean()
    expect(session).toMatchObject({ totalSales: 24, totalReturns: 24, totalCash: 0, transactionCount: 2 })
  }, 60_000)

  it('brings the goods back at the cost they left at, not at the sale price', async () => {
    const w = await tillWorld(app, { device: false })
    expect(await w.stock()).toEqual({ quantity: 10, avgCost: 4 })
    const sale = await w.sell(2)

    const res = await w.storno(sale.json.transaction.id)

    expect(res.status).toBe(200)
    // The till restocked at 10.00, the sale price: avgCost went to (8 × 4 + 2 × 10) / 10 = 5.20.
    expect(await w.stock()).toEqual({ quantity: 10, avgCost: 4 })
    const ret: any[] = await StockMovement.find({ orgId: w.oid, type: 'return' }).lean()
    expect(ret).toHaveLength(1)
    expect(String(ret[0].invoiceId)).toBe(res.json.transaction.id)
    // What it sold for stays its `unitCost`, which FR-07 reads as its value; what it is worth is apart (#467).
    expect(ret[0].lines.map((l: any) => [l.quantity, l.unitCost, l.resolvedUnitCost])).toEqual([[2, 10, 4]])
  }, 60_000)

  it('the journal reverses it too, from an open session of its warehouse; without one it says so', async () => {
    const w = await tillWorld(app, { device: false })
    const sale = await w.sell(1)
    const id = sale.json.transaction.id

    const none = await w.call('POST', `/cash-register/documents/${id}/storno`, { reason: 'operator_error' })
    expect(none.status).toBe(400)
    expect(none.json.code).toBe('storno_needs_session')

    const res = await w.call('POST', `/cash-register/documents/${id}/storno`, { reason: 'operator_error', sessionId: w.sessionId })
    expect(res.status).toBe(200)
    expect((await Invoice.findById(id).lean() as any).register.stornoState).toBe('full')
    expect((await POSSession.findById(w.sessionId).lean() as any).totalReturns).toBe(12)
  }, 60_000)

  it('a failed storno finished late never hands back the claim another storno holds', async () => {
    const w = await tillWorld(app, { device: false })
    const sale = await w.sell(1)
    const saleId = sale.json.transaction.id
    const won = await w.storno(saleId, 'storno-late-b')
    expect(won.status).toBe(200)
    // An earlier storno of the same sale whose receipt failed, left before it was voided (a crash).
    const body = { originalTransactionId: saleId, reason: 'customer_return' }
    const late: any = await Invoice.create({
      orgId: w.oid, invoiceNumber: 'CS-LATE-A', type: 'cash_storno', direction: 'outgoing', status: 'paid',
      issueDate: new Date(), dueDate: new Date(), currency: 'EUR', exchangeRate: 1, total: 12,
      lines: [{ description: 'x', quantity: 1, unit: 'бр.', unitPrice: 10, taxRate: 20, taxAmount: 2, lineTotal: 12 }],
      billingAddress: { street: '-' }, relatedInvoiceId: saleId, createdBy: w.user._id,
      clientKey: 'storno-late-a', requestHash: requestHash(`pos.storno:${w.sessionId}`, body),
      register: { origin: 'pos', sessionId: w.sessionId, fiscal: { state: 'failed', mode: 'fiscal' }, receiptError: 'paper out' },
    })

    const retry = await w.storno(saleId, 'storno-late-a')

    expect(retry.status).toBe(503)
    expect((await Invoice.findById(late._id).lean() as any).status).toBe('voided')
    const original: any = await Invoice.findById(saleId).lean()
    expect(original.register.stornoState).toBe('full')
    expect(original.register.stornoedBy.map(String)).toEqual([won.json.transaction.id])
    // So a third storno is still refused.
    expect((await w.storno(saleId)).status).toBe(400)
  }, 60_000)

  // #281 (owner, 2026-10-27): a fiscally printed sale is reversed by a storno receipt on the device.
  it('a fiscal sale is not reversed while its device is offline: refused, and nothing moves', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    expect(sale.status).toBe(200)
    const saleId = sale.json.transaction.id
    const before = { stock: await w.stock(), session: await POSSession.findById(w.sessionId).lean() as any }
    forgetDevices() // the device goes offline: its record stays, no bridge holds it

    for (const res of [
      await w.storno(saleId),
      await w.call('POST', `/cash-register/documents/${saleId}/storno`, { reason: 'operator_error', sessionId: w.sessionId }),
    ]) {
      expect(res.status).toBe(503)
      expect(res.json.code).toBe('fiscal_device_unavailable')
    }

    const original: any = await Invoice.findById(saleId).lean()
    // Never claimed: the refusal comes before the claim.
    expect(original.register.stornoState).toBe('none')
    expect(original.register.stornoedBy || []).toHaveLength(0)
    expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_storno' })).toBe(0)
    expect(await w.stock()).toEqual(before.stock)
    const session: any = await POSSession.findById(w.sessionId).lean()
    expect([session.totalReturns, session.totalCash]).toEqual([before.session.totalReturns, before.session.totalCash])
  }, 60_000)

  it('a text-receipt sale is still reversed with its device offline: it printed nothing fiscal', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1, { text: true })
    expect(sale.status).toBe(200)
    forgetDevices()

    const res = await w.storno(sale.json.transaction.id)

    expect(res.status).toBe(200)
    expect((await Invoice.findById(sale.json.transaction.id).lean() as any).register.stornoState).toBe('full')
  }, 60_000)

  it('a cashier may not reverse a sale', async () => {
    const w = await tillWorld(app, { device: false, role: 'sales' })
    const sale = await w.sell(1)
    const res = await w.call('POST', `/cash-register/documents/${sale.json.transaction.id}/storno`, { reason: 'operator_error', sessionId: w.sessionId })
    expect(res.status).toBe(403)
  }, 60_000)
})

describe('a storno of a back-office sale', () => {
  it('needs no session and prints nothing; the goods come back and no drawer moves', async () => {
    const w = await tillWorld(app)
    const sale = await w.sessionlessSale(2)
    expect(sale.status).toBe(200)
    expect((await w.stock()).quantity).toBe(8)

    const res = await w.call('POST', `/cash-register/documents/${sale.json.invoice.id}/storno`, { reason: 'customer_return' })

    expect(res.status).toBe(200)
    const storno: any = await Invoice.findById(res.json.transaction.id).lean()
    expect(storno).toMatchObject({ type: 'cash_storno', status: 'paid', total: 24 })
    expect(storno.register).toMatchObject({ origin: 'backoffice', isFiscal: false, fiscal: { state: 'none' } })
    expect(storno.register.sessionId).toBeUndefined()
    // A back-office sale records no payment rows: its storno refunds the header method, in full.
    expect(storno.payments.map((p: any) => [p.method, p.amount])).toEqual([['cash', 24]])
    expect(w.sim!.receipts).toHaveLength(0)
    expect((await w.stock()).quantity).toBe(10)
    const session: any = await POSSession.findById(w.sessionId).lean()
    expect(session).toMatchObject({ totalReturns: 0, transactionCount: 0 })
    expect((await Invoice.findById(sale.json.invoice.id).lean() as any).register.stornoState).toBe('full')
  }, 60_000)

  it('an imported till day is refused: it is corrected by importing it again', async () => {
    const w = await tillWorld(app, { device: false })
    const day = await w.backOfficeSale(1, { reference: 'salesAnalysis:2026-10-25', skipStockMovement: true })
    const res = await w.call('POST', `/cash-register/documents/${day.json.invoice.id}/storno`, { reason: 'operator_error' })
    expect(res.status).toBe(409)
    expect(res.json.code).toBe('storno_imported_day')
  }, 60_000)

  it('an invoiced sale is refused: the credit note to its invoice corrects it (a quantity is corrected once)', async () => {
    const w = await tillWorld(app, { device: false })
    const sale = await w.backOfficeSale(1)
    const contact = await createTestContact(w.oid)
    await createTestInvoice(w.oid, contact._id as Types.ObjectId, {
      status: 'paid', cashSaleRef: { cashSaleId: sale.json.invoice.id, number: sale.json.invoice.invoiceNumber, issueDate: new Date() },
    } as any)

    const res = await w.call('POST', `/cash-register/documents/${sale.json.invoice.id}/storno`, { reason: 'customer_return' })
    expect(res.status).toBe(409)
    expect(res.json.code).toBe('cash_sale_invoiced')
    expect((await Invoice.findById(sale.json.invoice.id).lean() as any).register?.stornoState).toBeUndefined()
  }, 60_000)

  it('a storno is not itself reversed, and a sale is reversed once', async () => {
    const w = await tillWorld(app, { device: false })
    const sale = await w.backOfficeSale(1)
    const first = await w.call('POST', `/cash-register/documents/${sale.json.invoice.id}/storno`, { reason: 'customer_return' })
    expect(first.status).toBe(200)
    const again = await w.call('POST', `/cash-register/documents/${sale.json.invoice.id}/storno`, { reason: 'customer_return' })
    expect(again.status).toBe(400)
    const ofStorno = await w.call('POST', `/cash-register/documents/${first.json.transaction.id}/storno`, { reason: 'customer_return' })
    expect(ofStorno.status).toBe(400)
    expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_storno' })).toBe(1)
  }, 60_000)
})

describe('a sale an older release rang up (§6 edge 3)', () => {
  it('is stornoed as its copy: the claim is taken on the copy, and the frozen POS row is never written', async () => {
    const w = await tillWorld(app, { device: false })
    const dispatch = await createTestStockMovement(w.oid, {
      type: 'dispatch', status: 'completed', fromWarehouseId: w.warehouse._id, notes: 'POS sale TXN-2026-0000041',
      lines: [{ productId: w.product._id, quantity: 2, unitCost: 10, totalCost: 20, resolvedUnitCost: 4 }],
    } as any)
    const row = await createTestPOSTransaction(w.oid, w.session._id ?? w.sessionId, w.user._id as Types.ObjectId, {
      transactionNumber: 'TXN-2026-0000041', status: 'completed', completedAt: new Date(),
      lines: [{ productId: w.product._id, name: 'Болт DIN 933 М8Х25', quantity: 2, unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 4, lineTotal: 20 }],
      subtotal: 20, taxTotal: 4, total: 24, payments: [{ method: 'cash', amount: 24 }], movementId: dispatch._id,
    } as any)
    // R4: the row was copied by 0008/0009 (keeping its `_id`), not on the spot by the storno.
    await migrateTill(w.oid)
    const before: any = await POSTransaction.findById(row._id).lean()

    const res = await w.storno(String(row._id))

    expect(res.status).toBe(200)
    const after: any = await POSTransaction.findById(row._id).lean()
    expect(after.status).toBe('completed')
    expect(after.updatedAt).toEqual(before.updatedAt)
    const copy: any = await Invoice.findById(row._id).lean()
    expect(copy).toMatchObject({ type: 'cash_sale', invoiceNumber: 'TXN-2026-0000041', status: 'paid' })
    expect(copy.register).toMatchObject({ origin: 'pos', stornoState: 'full', legacy: { transactionNumber: 'TXN-2026-0000041' } })
    // Its movement is linked to it, and the goods came back through it.
    expect(String((await StockMovement.findById(dispatch._id).lean() as any).invoiceId)).toBe(String(row._id))
    const storno: any = await Invoice.findById(res.json.transaction.id).lean()
    expect(String(storno.relatedInvoiceId)).toBe(String(row._id))
    expect(storno.invoiceNumber).toBe(`CS-${year}-00001`)
    const ret: any[] = await StockMovement.find({ orgId: w.oid, type: 'return', invoiceId: storno._id }).lean()
    expect(ret.map(m => [m.lines[0].unitCost, m.lines[0].resolvedUnitCost])).toEqual([[10, 4]])
  }, 60_000)
})

describe('a till storno\'s return: its price as its value, its cost apart (#467)', () => {
  const returnOf = async (w: TillWorld, stornoId: string) =>
    StockMovement.findOne({ orgId: w.oid, invoiceId: stornoId, type: 'return' }).lean() as Promise<any>

  it('FR-07: a sale given back whole leaves nothing sold, no value and no profit', async () => {
    const w = await tillWorld(app, { device: false })
    const sale = await w.sell(3)
    expect((await w.storno(sale.json.transaction.id)).status).toBe(200)
    const keep = await w.sell(2)
    expect(keep.status).toBe(200)

    // The report reads its days on the process's clock (`dayStart`), so the day is today's there, not UTC's.
    const now = new Date()
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const entry = reportById('warehouse-operations')!
    const result = await entry.handler!({ orgId: w.orgId, params: validateParams(entry, { operation: 'sales', period: { preset: 'custom', from: day, to: day } }), output: 'table' } as any)

    const row: any = result.rows.find((x: any) => x.productId === String(w.product._id))
    // Sold 3 and 2 at 10.00, the 3 back: 2 sold, for 20.00, at a cost of 8.00. At cost, the 3 took 12.00 off the value
    // and the profit kept the 18.00 the customer took back.
    expect(row).toMatchObject({ quantity: 2, value: 20, cost: 8, profit: 12 })
  }, 60_000)

  it('the valuation entry takes it back at what it left at, not at what the article costs by now', async () => {
    const w = await tillWorld(app, { device: false })
    const inventory = await createTestAccount(w.oid, { code: '304', name: 'Goods', type: 'asset', subType: 'current_asset' })
    const cogs = await createTestAccount(w.oid, { code: '601', name: 'Cost of sales', type: 'expense', subType: 'cost_of_goods_sold' })
    await Org.updateOne({ _id: w.oid }, { $set: {
      'settings.inventory.defaultInventoryAccountId': inventory._id,
      'settings.inventory.defaultCOGSAccountId': cogs._id,
    } })
    const sale = await w.sell(2)
    // A delivery since, at a higher price.
    await StockLevel.updateOne({ orgId: w.oid, productId: w.product._id, warehouseId: w.warehouse._id }, { $set: { avgCost: 7 } })
    const res = await w.storno(sale.json.transaction.id)
    expect(res.status).toBe(200)

    const ret = await getRepos().stockMovements.findById(String((await returnOf(w, res.json.transaction.id))._id))
    const je = await createMovementValuationEntry(w.orgId, ret, ret!.lines, new Date())
    // 2 × 4.00. With its cost in `unitCost` too, the entry read the line as saying nothing, and took 2 × 7.00.
    expect(je?.lines?.[0]?.baseDebit).toBe(8)
    expect(String(je.lines[0].accountId)).toBe(String(inventory._id))
  }, 60_000)

  it('an article sold at what it cost comes back at that, though the line resolved to its own price', async () => {
    const w = await tillWorld(app, { device: false })
    // The average is the selling price, 10.00: WAC keeps no allocations, so the line says only `resolvedUnitCost` 10.
    await StockLevel.updateOne({ orgId: w.oid, productId: w.product._id, warehouseId: w.warehouse._id }, { $set: { avgCost: 10 } })
    const sale = await w.sell(2)
    const dispatch: any = await StockMovement.findOne({ orgId: w.oid, invoiceId: sale.json.transaction.id, type: 'dispatch' }).lean()
    expect(dispatch.lines[0]).toMatchObject({ unitCost: 10, resolvedUnitCost: 10, costingMethod: 'wac' })
    // A delivery since, at a lower price.
    await StockLevel.updateOne({ orgId: w.oid, productId: w.product._id, warehouseId: w.warehouse._id }, { $set: { avgCost: 7 } })

    const res = await w.storno(sale.json.transaction.id)

    expect(res.status).toBe(200)
    expect((await returnOf(w, res.json.transaction.id)).lines[0].resolvedUnitCost).toBe(10)
    // (8 × 7.00 + 2 × 10.00) / 10. Read as saying nothing, it came back at 7.00, and FR-07 kept 6.00 of cost for a sale given back.
    const { quantity, avgCost } = await w.stock()
    expect(quantity).toBe(10)
    expect(avgCost).toBeCloseTo(7.6, 6)
  }, 60_000)

  it('sold out of a warehouse with no stock of it: back at what the article is bought at, never at the selling price', async () => {
    const w = await tillWorld(app, { device: false })
    await StockLevel.deleteOne({ orgId: w.oid, productId: w.product._id, warehouseId: w.warehouse._id })
    const sale = await w.sell(2)
    expect(sale.status).toBe(200)
    const dispatch: any = await StockMovement.findOne({ orgId: w.oid, invoiceId: sale.json.transaction.id, type: 'dispatch' }).lean()
    // It consumed nothing, so its line says only its price (`confirmMovement`).
    expect(dispatch.lines[0]).toMatchObject({ unitCost: 10, resolvedUnitCost: 10 })

    const res = await w.storno(sale.json.transaction.id)

    expect(res.status).toBe(200)
    expect((await returnOf(w, res.json.transaction.id)).lines[0]).toMatchObject({ unitCost: 10, resolvedUnitCost: 4 })
    // At 10.00 the level would hold the selling price as its average, for the next sale to read as its cost.
    expect(await w.stock()).toEqual({ quantity: 0, avgCost: 4 })
  }, 60_000)
})

describe('the invoice for a cash sale (D-14), now that till sales are documents', () => {
  it('a stornoed sale cannot be invoiced: its storno already reversed it', async () => {
    const w = await tillWorld(app, { device: false })
    const sale = await w.backOfficeSale(1)
    expect((await w.call('POST', `/cash-register/documents/${sale.json.invoice.id}/storno`, { reason: 'customer_return' })).status).toBe(200)
    const customer = await createTestContact(w.oid)

    const res = await w.call('POST', `/invoices/${sale.json.invoice.id}/to-invoice`, { contactId: String(customer._id) })

    expect(res.status).toBe(422)
    expect(res.json.code).toBe('cash_sale_stornoed')
  }, 60_000)

  it("an invoice for a fiscal till sale names its УНП and receipt number, and prints them (§3.9)", async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    const customer = await createTestContact(w.oid)

    const res = await w.call('POST', `/invoices/${sale.json.transaction.id}/to-invoice`, { contactId: String(customer._id) })

    expect(res.status).toBe(200)
    const inv: any = await Invoice.findById(res.json.invoice.id).lean()
    expect(inv.cashSaleRef).toMatchObject({
      number: sale.json.transaction.transactionNumber,
      unp: 'ED123456-0001-0000001',
      receiptNumber: sale.json.transaction.fiscalReceiptNumber,
    })
    const { html } = buildInvoiceHtml(inv, { name: 'Test Org' } as any, customer as any, undefined, { locale: 'bg' })
    expect(html).toContain('УНП ED123456-0001-0000001')
    expect(html).toContain(`ФБ № ${sale.json.transaction.fiscalReceiptNumber}`)
    // And the till sale cannot be stornoed now: its invoice is what corrects it.
    const storno = await w.storno(sale.json.transaction.id)
    expect(storno.status).toBe(409)
    expect(storno.json.code).toBe('cash_sale_invoiced')
  }, 60_000)
})
