import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import type { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { createTestProduct, createTestStockLevel } from '../helpers/factories'
import { Invoice } from 'db/models'
import { tillLineAmounts, tillTotals } from 'config/pos-totals'
import { buildPayloadLines, computeTotals } from '../../../invoicing-ui/src/composables/document-form/document-payload'
import { DOCUMENT_CONFIGS } from '../../../invoicing-ui/src/composables/document-form/configs'

/**
 * #573 — a cash sale's line amounts are the server's.
 *
 * A line's VAT and gross are what the sale's total is shared out by per VAT rate (`grossByRate`): what its device is
 * given when the lines do not print exactly, and since #572 the VAT the sale stores. They were stored as the request
 * sent them, so a client sending other amounts (an old tab, an API client, a test helper) moved the split on the
 * receipt and in the books, while the total, which is checked, stayed put. Each door now computes them from the
 * line's terms by its own screen's rule: `tillLineAmounts` at the till, the cash-sale form's at the back office.
 * An imported day keeps its file's. Synthetic prices.
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

const stored = (id: string) => Invoice.findById(id).lean().exec() as Promise<any>
const amountsOf = (doc: any) => doc.lines.map((l: any) => [l.taxAmount, l.lineTotal])
const salesOf = (w: TillWorld) => w.sim!.receipts.at(-1)!.sales.map(s => [s.group, s.amount])

/** What a client may send instead of a line's own amounts: its own rounding, none at all, or anything. */
type Garble = (line: any, i: number) => any
const GARBLES: Record<string, Garble> = {
  'no amounts': ({ taxAmount, lineTotal, ...line }) => line,
  'no VAT': ({ taxAmount, ...line }) => line,
  'gross where the net goes, and the net where the gross goes': line => ({ ...line, lineTotal: line.taxAmount + line.lineTotal, taxAmount: 0 }),
  'lopsided': (line, i) => ({ ...line, taxAmount: 0, lineTotal: i === 0 ? 9 : 1 }),
}

describe('#573 — a cash sale stores the line amounts its door computes', () => {
  it('at the till: whatever amounts a line carries, the sale stores and prints the terminal\'s', async () => {
    const w = await tillWorld(app)
    const [strainer, pipe] = await articles(w, [{ name: 'Цедка', price: 4.2233, rate: 20 }, { name: 'Тръба', price: 5.5555, rate: 9 }])
    const cart = [{ quantity: 1, unitPrice: strainer.price, taxRate: 20 }, { quantity: 1, unitPrice: pipe.price, taxRate: 9 }]
    const screen = tillTotals(cart)
    // What `PosTerminalView` sends.
    const lines = [strainer, pipe].map((a, i) => ({
      productId: a.id, name: a.name, quantity: 1, unitPrice: a.price, discount: 0, taxRate: a.rate, ...tillLineAmounts(cart[i]),
    }))
    const ring = (ls: any[]) => w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, {
      type: 'sale', lines: ls,
      subtotal: screen.subtotal, discountTotal: 0, taxTotal: screen.taxTotal, total: screen.total,
      payments: [{ method: 'cash', amount: screen.total }], changeDue: 0,
    })

    // The till's schema asks every line for a net (`lineTotal`): one with none is refused before any of this.
    const garbles = Object.entries(GARBLES).filter(([name]) => name !== 'no amounts')
    for (const [name, garble] of [['as the terminal sends them', (l: any) => l] as const, ...garbles]) {
      const res = await ring(lines.map(garble))
      expect(res.status, name).toBe(200)
      const doc = await stored(String(res.json.transaction.id ?? res.json.transaction._id))
      // Each line's VAT, and its gross: net + VAT, rounded (FR-21.5).
      expect(amountsOf(doc), name).toEqual([[0.84, 5.06], [0.5, 6.06]])
      // The lines do not print exactly: one line per rate, at 11.13 shared out as 5.06 and 6.06 weigh.
      expect(salesOf(w), name).toEqual([['Б', 5.06], ['Г', 6.07]])
      expect(doc, name).toMatchObject({ total: 11.13, taxTotal: 1.34, subtotal: 9.79 })
      // The till's answer, read back as the POS row the sale stands for, carries them too.
      expect(res.json.transaction.lines.map((l: any) => [l.taxAmount, l.lineTotal]), name).toEqual([[0.84, 4.22], [0.5, 5.56]])
    }
  }, 120_000)

  it('at the back office, joining the session: whatever amounts a line carries, the sale stores and prints the form\'s', async () => {
    const w = await tillWorld(app)
    const [strainer, washer, pipe] = await articles(w, [
      { name: 'Цедка', price: 4.2233, rate: 20 }, { name: 'Шайба', price: 0.1234, rate: 20 }, { name: 'Тръба', price: 5.5555, rate: 9 },
    ])
    const form = [[strainer, 1], [washer, 2], [pipe, 1]].map(([a, quantity]: any) => ({
      productId: a.id, warehouseId: String(w.warehouse._id), description: a.name, quantity, unit: 'бр.', unitPrice: a.price, taxRate: a.rate,
    }))
    // What the cash-sale form sends, and the totals it shows.
    const lines = buildPayloadLines(form, DOCUMENT_CONFIGS.cash_sale)
    const totals = computeTotals(form, DOCUMENT_CONFIGS.cash_sale)
    expect(totals).toMatchObject({ total: 11.42, taxTotal: 1.4, subtotal: 10.02 })
    const right = lines.map(l => [l.taxAmount, l.lineTotal])
    expect(right).toEqual([[0.84, 5.07], [0.05, 0.3], [0.5, 6.06]])

    for (const [name, garble] of [['as the form sends them', (l: any) => l] as const, ...Object.entries(GARBLES)]) {
      const res = await w.cashierBackOfficeSale(1, { lines: lines.map(garble), subtotal: totals.subtotal, taxTotal: totals.taxTotal, total: totals.total })
      expect(res.status, name).toBe(200)
      const doc = await stored(res.json.invoice.id)
      expect(doc.register.fiscal.state, name).toBe('printed')
      expect(amountsOf(doc), name).toEqual(right)
      // 11.42 shared out as 5.37 and 6.06 weigh.
      expect(salesOf(w), name).toEqual([['Б', 5.37], ['Г', 6.05]])
      expect(doc, name).toMatchObject({ total: 11.42, taxTotal: 1.4, subtotal: 10.02 })
    }
  }, 120_000)

  it('at the back office without a session, and on its edit: the form\'s amounts; an imported day keeps its file\'s', async () => {
    const w = await tillWorld(app)
    const [strainer, pipe] = await articles(w, [{ name: 'Цедка', price: 4.2233, rate: 20 }, { name: 'Тръба', price: 5.5555, rate: 9 }])
    const form = [strainer, pipe].map(a => ({
      productId: a.id, warehouseId: String(w.warehouse._id), description: a.name, quantity: 1, unit: 'бр.', unitPrice: a.price, taxRate: a.rate,
    }))
    const lines = buildPayloadLines(form, DOCUMENT_CONFIGS.cash_sale)
    const totals = computeTotals(form, DOCUMENT_CONFIGS.cash_sale)
    const right = [[0.84, 5.07], [0.5, 6.06]]
    expect(lines.map(l => [l.taxAmount, l.lineTotal])).toEqual(right)

    // The clerk has no session: the sale stays the back office's, and stays editable.
    const res = await w.sessionlessSale(1, { lines: lines.map(GARBLES.lopsided), subtotal: totals.subtotal, taxTotal: totals.taxTotal, total: totals.total })
    expect(res.status).toBe(200)
    const id = res.json.invoice.id
    const made = await stored(id)
    expect(made.register.origin).toBe('backoffice')
    expect(amountsOf(made)).toEqual(right)

    const edited = await w.call('PUT', `/invoices/${id}`, { lines: lines.map(GARBLES['no VAT']).map((l: any) => ({ ...l, lineTotal: 1 })) }, undefined, w.clerkToken)
    expect(edited.status).toBe(200)
    expect(amountsOf(await stored(id))).toEqual(right)

    // A PlusMinus till day: its file's amounts, as the import sends them (FR-21.30).
    const day = await w.backOfficeSale(1, {
      tags: ['cash-register-import'], skipStockMovement: true,
      lines: lines.map((l: any, i: number) => ({ ...l, taxAmount: i ? 0.51 : 0.83, lineTotal: i ? 6.07 : 5.06 })),
      subtotal: 9.79, taxTotal: 1.34, total: 11.13,
    })
    expect(day.status).toBe(200)
    const imported = await stored(day.json.invoice.id)
    expect(imported.register.origin).toBe('import')
    expect(amountsOf(imported)).toEqual([[0.83, 5.06], [0.51, 6.07]])
    expect(imported).toMatchObject({ total: 11.13, taxTotal: 1.34 })
    // And on its edit: what a person corrects an imported day to stands.
    const corrected = await w.call('PUT', `/invoices/${day.json.invoice.id}`, {
      lines: imported.lines.map((l: any, i: number) => ({
        productId: String(l.productId), warehouseId: String(l.warehouseId), description: l.description, quantity: l.quantity, unit: l.unit,
        unitPrice: l.unitPrice, taxRate: l.taxRate, taxAmount: i ? 0.5 : 0.84, lineTotal: i ? 6.06 : 5.07,
      })),
    }, undefined, w.clerkToken)
    expect(corrected.status).toBe(200)
    expect(amountsOf(await stored(day.json.invoice.id))).toEqual([[0.84, 5.07], [0.5, 6.06]])
  }, 120_000)
})
