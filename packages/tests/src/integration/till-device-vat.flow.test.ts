import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import type { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { createTestContact, createTestProduct, createTestStockLevel } from '../helpers/factories'
import type { SimReceipt } from '../helpers/eltrade-simulator'
import { Invoice } from 'db/models'
import { computePosTotals, roundCents } from 'config/pos-totals'

/**
 * #554 — the VAT a sale stores is the VAT its fiscal device took out.
 *
 * A device adds up the money of each VAT group and takes the VAT out of that. Where a sale's lines do not print
 * exactly, LGR gives it one line per rate at the sale's total shared out in the lines' proportions
 * (`linesOnDevice`), which in a two-rate sale can sit a cent from each rate's own rounding (`computePosTotals`).
 * The till and the back office stored the latter, so a sale's VAT, and the drawer's journal entry, could be a cent
 * off the receipt's. These read the device's figures off the simulator's own sums. Synthetic prices.
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

const RATE_OF_GROUP: Record<string, number> = { 'А': 0, 'Б': 20, 'Г': 9 }

/** What the device took out of a receipt: per VAT group, the VAT out of what it added up there. */
function vatOnDevice(receipt: SimReceipt): number {
  const byGroup = new Map<string, number>()
  for (const s of receipt.sales) byGroup.set(s.group, roundCents((byGroup.get(s.group) || 0) + s.amount))
  return roundCents([...byGroup].reduce((sum, [group, gross]) => {
    const rate = RATE_OF_GROUP[group]
    return sum + roundCents((gross * rate) / (100 + rate))
  }, 0))
}

interface Article { id: string; name: string; price: number; rate: number }

async function articles(w: TillWorld, specs: Omit<Article, 'id'>[]): Promise<Article[]> {
  const out: Article[] = []
  for (const s of specs) {
    const p = await createTestProduct(w.oid, { name: s.name, sellingPrice: s.price, purchasePrice: 1, taxRate: s.rate, unit: 'бр.' } as any)
    await createTestStockLevel(w.oid, p._id, w.warehouse._id, { quantity: 50, availableQuantity: 50, avgCost: 1 } as any)
    out.push({ id: String(p._id), ...s })
  }
  return out
}

/** The till's request, as `PosTerminalView` sends it: net prices, each line's net and its rounded VAT. */
function tillSale(items: [Article, number][]) {
  const t = computePosTotals(items.map(([a, quantity]) => ({ quantity, unitPrice: a.price, taxRate: a.rate })))
  return {
    t,
    body: {
      type: 'sale',
      lines: items.map(([a, quantity]) => ({
        productId: a.id, name: a.name, quantity, unitPrice: a.price, discount: 0, taxRate: a.rate,
        taxAmount: Math.round(quantity * a.price * (a.rate / 100) * 100) / 100, lineTotal: quantity * a.price,
      })),
      subtotal: t.subtotal, discountTotal: 0, taxTotal: t.taxTotal, total: t.total,
      payments: [{ method: 'cash', amount: t.total }], changeDue: 0,
    },
  }
}

/** A document's lines as the forms send them (`document-payload.ts`): each line's VAT and gross, rounded on its own. */
function formLines(w: TillWorld, items: [Article, number][]) {
  return items.map(([a, quantity]) => {
    const net = quantity * a.price
    return {
      productId: a.id, warehouseId: String(w.warehouse._id), description: a.name, quantity, unit: 'бр.', unitPrice: a.price,
      taxRate: a.rate, taxAmount: +(net * a.rate / 100).toFixed(2), lineTotal: +(net * (1 + a.rate / 100)).toFixed(2),
    }
  })
}

const stored = (id: string) => Invoice.findById(id).lean().exec() as Promise<any>

describe('#554 — a sale stores the VAT its device took out', () => {
  it('at the till: a two-rate sale whose lines do not print exactly, its storno, and its session report', async () => {
    const w = await tillWorld(app)
    const [strainer, pipe] = await articles(w, [{ name: 'Цедка', price: 4.2233, rate: 20 }, { name: 'Тръба', price: 5.5555, rate: 9 }])
    const { t, body } = tillSale([[strainer, 1], [pipe, 1]])
    // Each rate's own gross: 5.07 + 6.06, VAT 0.85 + 0.50.
    expect(t).toMatchObject({ total: 11.13, taxTotal: 1.35 })

    const res = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, body)
    expect(res.status).toBe(200)
    expect(res.json.receiptError).toBeUndefined()
    const receipt = w.sim!.receipts.at(-1)!
    expect(receipt.kind).toBe('fiscal')
    // The lines say 5.06 and 6.06 against a total of 11.13: a line per rate, at the total shared out in their proportions.
    expect(receipt.sales.map(s => [s.group, s.amount])).toEqual([['Б', 5.06], ['Г', 6.07]])
    expect(vatOnDevice(receipt)).toBe(1.34)

    const id = String(res.json.transaction.id ?? res.json.transaction._id)
    expect(await stored(id)).toMatchObject({ total: 11.13, taxTotal: 1.34, subtotal: 9.79 })
    expect(res.json.transaction).toMatchObject({ total: 11.13, taxTotal: 1.34, subtotal: 9.79 })

    // Each rate's VAT on the session report is the device's, and they add up to what the sale stores.
    const report = (await w.call('GET', `/trade/pos/session/${w.sessionId}/report`)).json.report
    expect(report.vat).toEqual([
      { rate: 20, net: 4.22, vat: 0.84, gross: 5.06 },
      { rate: 9, net: 5.57, vat: 0.5, gross: 6.07 },
    ])

    // Its storno carries the sale's own figures, which are now what the device takes out of it again.
    const storno = await w.storno(id)
    expect(storno.status).toBe(200)
    const back = w.sim!.receipts.at(-1)!
    expect(back.kind).toBe('storno')
    expect(vatOnDevice(back)).toBe(1.34)
    const stornoId = String(storno.json.transaction?.id ?? storno.json.transaction?._id ?? storno.json.storno?.id)
    expect(await stored(stornoId)).toMatchObject({ total: 11.13, taxTotal: 1.34, subtotal: 9.79 })
  }, 60_000)

  it('at the back office: a cash sale that joins the session and prints on its device', async () => {
    const w = await tillWorld(app)
    const [strainer, washer, pipe] = await articles(w, [
      { name: 'Цедка', price: 4.2233, rate: 20 }, { name: 'Шайба', price: 0.1234, rate: 20 }, { name: 'Тръба', price: 5.5555, rate: 9 },
    ])
    const items: [Article, number][] = [[strainer, 1], [washer, 2], [pipe, 1]]
    const t = computePosTotals(items.map(([a, quantity]) => ({ quantity, unitPrice: a.price, taxRate: a.rate })))
    expect(t).toMatchObject({ total: 11.42, taxTotal: 1.39 })

    const res = await w.cashierBackOfficeSale(1, { lines: formLines(w, items), subtotal: t.subtotal, taxTotal: t.taxTotal, total: t.total })
    expect(res.status).toBe(200)
    const doc = await stored(res.json.invoice.id)
    expect(doc.register.fiscal.state).toBe('printed')
    expect(vatOnDevice(w.sim!.receipts.at(-1)!)).toBe(1.4)
    expect(doc).toMatchObject({ total: 11.42, taxTotal: 1.4, subtotal: 10.02 })
  }, 60_000)

  it('a sale that prints its lines exactly keeps the VAT it always had', async () => {
    const w = await tillWorld(app)
    const [bolt, nut] = await articles(w, [{ name: 'Болт', price: 10, rate: 20 }, { name: 'Гайка', price: 1, rate: 9 }])
    const { t, body } = tillSale([[bolt, 2], [nut, 3]])
    const res = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, body)
    expect(res.status).toBe(200)
    expect(w.sim!.receipts.at(-1)!.sales.map(s => [s.group, s.quantity])).toEqual([['Б', 2], ['Г', 3]])
    expect(vatOnDevice(w.sim!.receipts.at(-1)!)).toBe(t.taxTotal)
    expect(await stored(String(res.json.transaction.id ?? res.json.transaction._id))).toMatchObject({ total: 27.27, taxTotal: 4.27, subtotal: 23 })
  }, 60_000)

  it('a cash invoice paid as it is issued: its receipt prints the invoice\'s lines and books the device\'s VAT', async () => {
    const w = await tillWorld(app)
    const [washer] = await articles(w, [{ name: 'Шайба', price: 0.125, rate: 20 }])
    const lines = formLines(w, [[washer, 1], [washer, 1]])
    // Each line's VAT is 0.03 on its own; the device takes 0.05 out of their 0.30.
    expect(lines.map(l => [l.taxAmount, l.lineTotal])).toEqual([[0.03, 0.15], [0.03, 0.15]])
    const contact = await createTestContact(w.oid, { companyName: 'Клиент ООД', type: 'customer' } as any)
    const draft = await w.call('POST', '/invoices', {
      type: 'invoice', direction: 'outgoing', contactId: String(contact._id), issueDate: new Date().toISOString().slice(0, 10),
      currency: 'EUR', lines, subtotal: 0.25, taxTotal: 0.06, total: 0.3, paymentMethod: 'cash',
    })
    expect(draft.status).toBe(200)
    const sent = await w.call('POST', `/invoices/${draft.json.invoice.id}/send`, {})
    expect(sent.status).toBe(200)

    const receipt = w.sim!.receipts.at(-1)!
    expect(receipt.sales.map(s => s.amount)).toEqual([0.15, 0.15])
    expect(receipt.texts.some(t => t.includes('Фактура №'))).toBe(true)
    expect(vatOnDevice(receipt)).toBe(0.05)
    const [doc] = await Invoice.find({ type: 'payment_receipt', 'register.paidInvoiceId': draft.json.invoice.id }).lean().exec() as any[]
    expect(doc).toMatchObject({ total: 0.3, taxTotal: 0.05, subtotal: 0.25 })
    expect(doc.lines.map((l: any) => l.taxAmount)).toEqual([0.03, 0.03])
  }, 60_000)
})
