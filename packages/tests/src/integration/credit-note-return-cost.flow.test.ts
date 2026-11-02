import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import type { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { draftOf, line, send } from '../helpers/receipt-world'
import { createTestContact, createTestInvoice, createTestOrg, createTestProduct, createTestStockLevel, createTestUser, createTestWarehouse } from '../helpers/factories'
import { CostLayer, Product, StockLevel, StockMovement } from 'db/models'
import { createInvoiceStockMovement } from 'services/biz/invoicing.service'
import { reportById } from 'services/biz/report-registry'
import { validateParams } from 'services/biz/report-registry.types'

/**
 * The prod sweep's D4 (#461): a credit note's return re-entered stock at the selling price, so an article's cost went
 * 4.00 to 4.1394 after 23 returned at 10.00. Every return pulled the average towards the selling price. It comes back
 * at what it left at, as #276 did for a void and a till storno always has, and otherwise at today's average.
 *
 * ⚠ The line's `unitCost` stays the document's price, as on every invoice-born line, because FR-07 and the digest
 * read their value columns off it. What the goods are worth is `resolvedUnitCost`, which stock, the cost layers and
 * the valuation entry read. So FR-07 gets its profit right too: it took a return's cost to be its price.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => { await setupTestDB(); app = tillApp() as any }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { forgetDevices(); await clearCollections() }, 30_000)

const onBank = async (w: TillWorld, quantity: number) => {
  const d = await draftOf(w, { method: 'bank_transfer', lines: [line(w, quantity)] })
  expect((await send(w, d.id)).status).toBe(200)
  return d
}

async function creditNote(w: TillWorld, invoice: { id: string; contactId: string }, quantity: number) {
  const note = await draftOf(w, { type: 'credit_note', method: 'bank_transfer', lines: [line(w, quantity)], extra: { relatedInvoiceId: invoice.id, contactId: invoice.contactId } })
  const r = await send(w, note.id)
  expect(r.status).toBe(200)
  return note
}

describe('a credit note\'s goods come back at what they cost (D4)', () => {
  it('the sweep\'s run: 23 returned of a price of 10.00, at a cost of 4.00, and the cost is 4.00', async () => {
    const w = await tillWorld(app, { stock: 100 })
    const invoice = await onBank(w, 23)
    expect(await w.stock()).toEqual({ quantity: 77, avgCost: 4 })

    await creditNote(w, invoice, 23)

    expect(await w.stock()).toEqual({ quantity: 100, avgCost: 4 })
  })

  it('a part comes back the same way, and the line keeps the document\'s price beside what it is worth', async () => {
    const w = await tillWorld(app, { stock: 10 })
    const invoice = await onBank(w, 4)

    const note = await creditNote(w, invoice, 1)

    expect(await w.stock()).toEqual({ quantity: 7, avgCost: 4 })
    const movement: any = await StockMovement.findOne({ orgId: w.oid, invoiceId: note.id, type: 'return' }).lean()
    expect(movement.status).toBe('completed')
    expect(movement.lines[0]).toMatchObject({ quantity: 1, unitCost: 10, totalCost: 10, resolvedUnitCost: 4 })
  })

  it('at what it left at, not at what it costs by now', async () => {
    const w = await tillWorld(app, { stock: 10 })
    const invoice = await onBank(w, 5)
    // A delivery since at 8.00: 5 at 4.00 and 5 at 8.00 are 6.00 each.
    await StockLevel.updateOne({ orgId: w.oid, productId: w.product._id, warehouseId: w.warehouse._id }, { $set: { quantity: 10, availableQuantity: 10, avgCost: 6 } })

    await creditNote(w, invoice, 5)

    // (10 × 6.00 + 5 × 4.00) / 15
    const { quantity, avgCost } = await w.stock()
    expect(quantity).toBe(15)
    expect(avgCost).toBeCloseTo(80 / 15, 6)
  })

  it('an invoice for a till sale: the goods left on the sale, and they come back at that', async () => {
    const w = await tillWorld(app, { stock: 10 })
    const sale = await w.sell(2)
    const contact = await draftOf(w, { method: 'bank_transfer' })
    const invoiced = await w.call('POST', `/invoices/${sale.json.transaction.id}/to-invoice`, { contactId: contact.contactId })
    expect(invoiced.status).toBe(200)
    await StockLevel.updateOne({ orgId: w.oid, productId: w.product._id, warehouseId: w.warehouse._id }, { $set: { avgCost: 6 } })

    const note = await creditNote(w, { id: String(invoiced.json.invoice.id), contactId: contact.contactId }, 1)

    const movement: any = await StockMovement.findOne({ orgId: w.oid, invoiceId: note.id, type: 'return' }).lean()
    expect(movement.lines[0].resolvedUnitCost).toBe(4)
  })

  it('FR-07: the value stays what the document said, and the profit comes to what the sale left', async () => {
    const w = await tillWorld(app, { stock: 10 })
    const invoice = await onBank(w, 3)
    await creditNote(w, invoice, 1)

    const day = new Date().toISOString().slice(0, 10)
    const entry = reportById('warehouse-operations')!
    const result = await entry.handler!({ orgId: w.orgId, params: validateParams(entry, { operation: 'sales', period: { preset: 'custom', from: day, to: day } }), output: 'table' } as any)

    const row: any = result.rows.find((x: any) => x.productId === String(w.product._id))
    // Sold 3 at 10.00, one back: 2 sold, for 20.00, at a cost of 8.00.
    expect(row).toMatchObject({ quantity: 2, value: 20, cost: 8, profit: 12 })
  })

  describe('with no dispatch to read it off', () => {
    async function world(o: { level?: boolean; costingMethod?: string } = {}) {
      const org = await createTestOrg()
      const user = await createTestUser(org._id)
      const contact = await createTestContact(org._id)
      const product = await createTestProduct(org._id, { purchasePrice: 3, sellingPrice: 10, ...(o.costingMethod ? { costingMethod: o.costingMethod } : {}) } as any)
      const warehouse = await createTestWarehouse(org._id)
      if (o.level) await createTestStockLevel(org._id, product._id, warehouse._id, { quantity: 10, availableQuantity: 10, avgCost: 4 } as any)
      const note = await createTestInvoice(org._id, contact._id, {
        direction: 'outgoing', type: 'credit_note', status: 'sent',
        lines: [{
          productId: String(product._id), warehouseId: String(warehouse._id), description: 'Bolt', quantity: 2, unit: 'pcs', unitPrice: 10,
          discount: 0, taxRate: 20, taxAmount: 4, lineTotal: 24,
        }],
      })
      await createInvoiceStockMovement(note, String(user._id))
      return { org, product, warehouse }
    }
    const levelOf = (w: { org: any; product: any; warehouse: any }) =>
      StockLevel.findOne({ orgId: w.org._id, productId: w.product._id, warehouseId: w.warehouse._id }).lean() as Promise<any>

    it('today\'s average, so a return moves no average', async () => {
      const w = await world({ level: true })
      expect(await levelOf(w)).toMatchObject({ quantity: 12, avgCost: 4 })
    })

    it('with no average either, what the article is bought at. Never the selling price', async () => {
      const w = await world()
      expect(await levelOf(w)).toMatchObject({ quantity: 2, avgCost: 3 })
    })

    it('sold before the delivery was booked: the dispatch consumed nothing and its line says only its price, so today\'s average', async () => {
      const org = await createTestOrg()
      const user = await createTestUser(org._id)
      const contact = await createTestContact(org._id)
      const product = await createTestProduct(org._id, { purchasePrice: 3, sellingPrice: 10 } as any)
      const warehouse = await createTestWarehouse(org._id)
      const lineOf = (quantity: number, unitPrice: number) => ({
        productId: String(product._id), warehouseId: String(warehouse._id), description: 'Bolt', quantity, unit: 'pcs', unitPrice,
        discount: 0, taxRate: 0, taxAmount: 0, lineTotal: quantity * unitPrice,
      })
      const invoice = await createTestInvoice(org._id, contact._id, { direction: 'outgoing', type: 'invoice', status: 'sent', lines: [lineOf(5, 10)] })
      await createInvoiceStockMovement(invoice, String(user._id), undefined, { allowNegative: true })
      const dispatch: any = await StockMovement.findOne({ orgId: org._id, invoiceId: invoice._id, type: 'dispatch' }).lean()
      expect(dispatch.lines[0].resolvedUnitCost).toBe(10)
      const bill = await createTestInvoice(org._id, contact._id, { direction: 'incoming', type: 'invoice', status: 'received', lines: [lineOf(20, 4)] })
      await createInvoiceStockMovement(bill, String(user._id))
      const levelNow = () => levelOf({ org, product, warehouse })
      expect(await levelNow()).toMatchObject({ quantity: 15, avgCost: 4 })

      const note = await createTestInvoice(org._id, contact._id, {
        direction: 'outgoing', type: 'credit_note', status: 'sent', relatedInvoiceId: invoice._id, lines: [lineOf(5, 10)],
      } as any)
      await createInvoiceStockMovement(note, String(user._id))

      // At the line's 10.00 the average would be (15 × 4.00 + 5 × 10.00) / 20 = 5.50.
      expect(await levelNow()).toMatchObject({ quantity: 20, avgCost: 4 })
    })

    it('a layer is made at that, for a method that keeps layers', async () => {
      const w = await world({ level: true, costingMethod: 'fifo' })
      const layers: any[] = await CostLayer.find({ orgId: w.org._id, productId: w.product._id, warehouseId: w.warehouse._id }).lean()
      expect(layers).toHaveLength(1)
      expect(layers[0]).toMatchObject({ remainingQuantity: 2, unitCost: 4 })
    })
  })

  it('a layer-kept article: the return\'s layer holds what the goods left at', async () => {
    const w = await tillWorld(app, { stock: 0 })
    await Product.updateOne({ _id: w.product._id }, { $set: { costingMethod: 'fifo' } })
    const bill = await createTestInvoice(w.oid, (await createTestContact(w.oid))._id, {
      direction: 'incoming', type: 'invoice', status: 'received',
      lines: [{ productId: String(w.product._id), warehouseId: String(w.warehouse._id), description: 'Болт', quantity: 10, unit: 'бр.', unitPrice: 5, discount: 0, taxRate: 0, taxAmount: 0, lineTotal: 50 }],
    })
    await createInvoiceStockMovement(bill, String(w.user._id))
    const invoice = await onBank(w, 2)

    const note = await creditNote(w, invoice, 2)

    const layers: any[] = await CostLayer.find({ orgId: w.oid, productId: w.product._id, warehouseId: w.warehouse._id, sourceMovementId: { $exists: true } }).lean()
    const movement: any = await StockMovement.findOne({ orgId: w.oid, invoiceId: note.id, type: 'return' }).lean()
    expect(movement.lines[0].resolvedUnitCost).toBe(5)
    expect(layers.every(l => l.unitCost === 5)).toBe(true)
    expect(layers.reduce((s, l) => s + l.remainingQuantity, 0)).toBe(10)
  })

  it('a supplier\'s credit note is untouched: the goods leave, and a dispatch consumes what it consumes', async () => {
    const w = await tillWorld(app, { stock: 10 })
    const contact = await createTestContact(w.oid)
    const note = await createTestInvoice(w.oid, contact._id, {
      direction: 'incoming', type: 'credit_note', status: 'received',
      lines: [{ productId: String(w.product._id), warehouseId: String(w.warehouse._id), description: 'Болт', quantity: 2, unit: 'бр.', unitPrice: 7, discount: 0, taxRate: 0, taxAmount: 0, lineTotal: 14 }],
    })

    await createInvoiceStockMovement(note, String(w.user._id))

    expect(await w.stock()).toEqual({ quantity: 8, avgCost: 4 })
    const movement: any = await StockMovement.findOne({ orgId: w.oid, invoiceId: note._id, type: 'return' }).lean()
    expect(movement.lines[0].unitCost).toBe(7)
  })
})
