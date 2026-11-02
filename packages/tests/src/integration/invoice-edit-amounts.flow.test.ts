import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import type { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { forgetDevices, tillApp, tillWorld, type TillWorld } from '../helpers/till-world'
import { draftOf, line, pay, raw, receiptsOf, send } from '../helpers/receipt-world'
import { Invoice } from 'db/models'

/**
 * `PUT /invoices/:id` stored what it was sent and nothing else: the header figures a form leaves out
 * (`emitTaxTotal: false` on every type but the sales invoice) stayed at what they were, and lines sent
 * without their amounts were stored without them. Now it derives them as `POST` does, by one function
 * (`services/biz/document-amounts.ts`), and what is due follows the total, on every document.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

let app: Elysia
beforeAll(async () => { await setupTestDB(); app = tillApp() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { forgetDevices(); await clearCollections() })

const put = (w: TillWorld, id: string, body: Record<string, unknown>) => w.call('PUT', `/invoices/${id}`, body)

/** A line as a hand-written API client sends one: its numbers, none of its amounts. */
const bare = (w: TillWorld, quantity: number, price = 10, extra: Record<string, unknown> = {}) => ({
  productId: String(w.product._id), warehouseId: String(w.warehouse._id), description: 'Болт DIN 933 М8Х25',
  quantity, unit: 'бр.', unitPrice: price, taxRate: 20, ...extra,
})

/** What the form sends for a type that emits no `taxTotal` and no `totalBase`. */
const formBody = (w: TillWorld, quantity: number, extra: Record<string, unknown> = {}) => {
  const l = line(w, quantity)
  return { lines: [l], subtotal: +(l.lineTotal - l.taxAmount).toFixed(2), total: l.lineTotal, ...extra }
}

const issuedInvoice = async (w: TillWorld, method = 'bank_transfer') => {
  const d = await draftOf(w, { method })
  expect((await send(w, d.id)).status).toBe(200)
  return d
}

const issuedNote = async (w: TillWorld, type = 'credit_note') => {
  const inv = await issuedInvoice(w)
  const note = await draftOf(w, { type, method: 'bank_transfer', extra: { relatedInvoiceId: inv.id, contactId: inv.contactId } })
  expect((await send(w, note.id)).status).toBe(200)
  return note
}

describe('a line sent without its amounts', () => {
  it('is stored with both: VAT and the gross total, discount and all', async () => {
    const w = await tillWorld(app, { device: false })
    const d = await draftOf(w, { method: 'bank_transfer' })

    const r = await put(w, d.id, { lines: [bare(w, 2, 100, { discount: 10 })], subtotal: 200, discountTotal: 20, total: 216 })

    expect(r.status).toBe(200)
    expect((await raw(d.id)).lines[0]).toMatchObject({ quantity: 2, unitPrice: 100, discount: 10, taxAmount: 36, lineTotal: 216 })
  })

  it('on an issued document too, and on each of eleven lines', async () => {
    const w = await tillWorld(app, { device: false })
    const d = await issuedInvoice(w)
    const lines = Array.from({ length: 11 }, (_, i) => bare(w, i + 1))
    const total = lines.reduce((s, l) => s + l.quantity * 12, 0)

    const r = await put(w, d.id, { lines, subtotal: +(total / 1.2).toFixed(2), total })

    expect(r.status).toBe(200)
    const stored = (await raw(d.id)).lines
    expect(stored).toHaveLength(11)
    for (const [i, l] of stored.entries()) expect(l).toMatchObject({ taxAmount: (i + 1) * 2, lineTotal: (i + 1) * 12 })
  })

  it('a line that sent them keeps them: an imported line\'s `lineTotal` is net', async () => {
    const w = await tillWorld(app, { device: false })
    const d = await draftOf(w, { method: 'bank_transfer' })

    await put(w, d.id, { lines: [bare(w, 2, 10, { taxAmount: 4.01, lineTotal: 20 })], subtotal: 20, total: 24.01 })

    expect((await raw(d.id)).lines[0]).toMatchObject({ taxAmount: 4.01, lineTotal: 20 })
  })

  it('takes the model\'s other required fields as `POST` does', async () => {
    const w = await tillWorld(app, { device: false })
    const d = await draftOf(w, { method: 'bank_transfer' })

    await put(w, d.id, { lines: [{ quantity: 1, unitPrice: 10, taxRate: 0 }], subtotal: 10, total: 10 })

    expect((await raw(d.id)).lines[0]).toMatchObject({ unit: 'pcs', description: '', taxAmount: 0, lineTotal: 10 })
  })
})

describe('the header a request leaves out, when its lines change', () => {
  it('a bill, a proforma and a note: as the form sends them, `taxTotal` and `totalBase` follow', async () => {
    const w = await tillWorld(app, { device: false })
    const inv = await issuedInvoice(w)
    const docs = {
      proforma: await draftOf(w, { type: 'proforma', method: 'bank_transfer', extra: { exchangeRate: 2 } }),
      bill: await draftOf(w, { method: 'bank_transfer', extra: { direction: 'incoming', exchangeRate: 2 } }),
      note: await draftOf(w, { type: 'credit_note', method: 'bank_transfer', extra: { relatedInvoiceId: inv.id, contactId: inv.contactId, exchangeRate: 2 } }),
    }
    for (const d of Object.values(docs)) {
      expect((await put(w, d.id, formBody(w, 3))).status).toBe(200)
      expect(await raw(d.id)).toMatchObject({ subtotal: 30, taxTotal: 6, total: 36, totalBase: 72 })
    }
  })

  it('what the request did send stands', async () => {
    const w = await tillWorld(app, { device: false })
    const d = await draftOf(w, { method: 'bank_transfer' })

    await put(w, d.id, formBody(w, 3, { taxTotal: 5.99, totalBase: 40 }))

    expect(await raw(d.id)).toMatchObject({ taxTotal: 5.99, totalBase: 40, total: 36 })
  })

  it('the exchange rate moves the base, whether the lines came along or not', async () => {
    const w = await tillWorld(app, { device: false })
    const d = await draftOf(w, { method: 'bank_transfer' })
    expect(await raw(d.id)).toMatchObject({ total: 24, totalBase: 24 })

    await put(w, d.id, { exchangeRate: 1.5 })

    expect(await raw(d.id)).toMatchObject({ total: 24, totalBase: 36 })
  })

  it('a total moved with no lines moves the base and leaves the VAT', async () => {
    const w = await tillWorld(app, { device: false })
    const d = await draftOf(w, { method: 'bank_transfer' })

    await put(w, d.id, { total: 30 })

    expect(await raw(d.id)).toMatchObject({ total: 30, totalBase: 30, taxTotal: 4 })
  })

  it('lines with no total at all: every figure comes from them, components rounded first', async () => {
    const w = await tillWorld(app, { device: false })
    const d = await issuedInvoice(w)

    const r = await put(w, d.id, { lines: [bare(w, 3, 0.33), bare(w, 1, 100, { discount: 10 })] })

    expect(r.status).toBe(200)
    // Net 0.99 + 100, 10 off, VAT 0.198 + 18: 100.99 - 10 + 18.2.
    expect(await raw(d.id)).toMatchObject({ subtotal: 100.99, discountTotal: 10, taxTotal: 18.2, total: 109.19, totalBase: 109.19, amountDue: 109.19 })
  })

  it('a save that changes no line leaves a header the document brought with it', async () => {
    const w = await tillWorld(app, { device: false })
    const d = await draftOf(w, { method: 'bank_transfer', extra: { exchangeRate: 2 } })
    // An imported document's header is the PDF's, and its lines' own VAT can sum a cent away from it.
    await Invoice.updateOne({ _id: d.id }, { $set: { taxTotal: 4.01, totalBase: 48.03 } })

    const r = await put(w, d.id, { ...formBody(w, 2), notes: 'only this' })

    expect(r.status).toBe(200)
    expect(await raw(d.id)).toMatchObject({ notes: 'only this', taxTotal: 4.01, totalBase: 48.03, total: 24 })
  })

  it('linking a product changes no money, and no figure', async () => {
    const w = await tillWorld(app, { device: false })
    const d = await draftOf(w, { method: 'bank_transfer', lines: [line(w, 2, 10, 20, { productId: undefined })] })
    await Invoice.updateOne({ _id: d.id }, { $set: { taxTotal: 4.01 } })

    await put(w, d.id, { lines: [bare(w, 2)] })

    const doc = await raw(d.id)
    expect(String(doc.lines[0].productId)).toBe(String(w.product._id))
    expect(doc).toMatchObject({ taxTotal: 4.01, total: 24 })
  })
})

describe('what is due follows the total', () => {
  it('an issued credit note, before any money moves', async () => {
    const w = await tillWorld(app, { device: false })
    const note = await issuedNote(w)
    expect(await raw(note.id)).toMatchObject({ status: 'sent', total: 24, amountPaid: 0, amountDue: 24 })

    const r = await put(w, note.id, formBody(w, 1))

    expect(r.status).toBe(200)
    expect(await raw(note.id)).toMatchObject({ status: 'sent', total: 12, amountPaid: 0, amountDue: 12 })
    // The answer says so too: the form reads the document it gets back.
    expect(r.json.invoice.amountDue).toBe(12)
  })

  it('an issued debit note, where LGR prints', async () => {
    const w = await tillWorld(app)
    const note = await issuedNote(w, 'debit_note')

    expect((await put(w, note.id, formBody(w, 3))).status).toBe(200)

    expect(await raw(note.id)).toMatchObject({ status: 'sent', total: 36, amountDue: 36 })
  })

  it('an issued invoice paid by bank, which the counter rule leaves alone', async () => {
    for (const device of [true, false]) {
      const w = await tillWorld(app, { device })
      const d = await issuedInvoice(w)

      await put(w, d.id, formBody(w, 3))

      expect(await raw(d.id)).toMatchObject({ status: 'sent', total: 36, amountDue: 36 })
    }
  })

  it('a draft, so that it is issued owing what it says', async () => {
    const w = await tillWorld(app, { device: false })
    const d = await draftOf(w, { method: 'bank_transfer' })

    await put(w, d.id, formBody(w, 3))
    expect(await raw(d.id)).toMatchObject({ status: 'draft', total: 36, amountDue: 36 })

    await send(w, d.id)
    expect(await raw(d.id)).toMatchObject({ status: 'sent', total: 36, amountDue: 36 })
  })

  it('a received bill, which no conditional write stands in front of', async () => {
    const w = await tillWorld(app, { device: false })
    const bill = await draftOf(w, { method: 'bank_transfer', extra: { direction: 'incoming', reference: 'S-1' } })
    expect((await w.call('POST', `/invoices/${bill.id}/receive`, {})).status).toBe(200)

    expect((await put(w, bill.id, formBody(w, 3))).status).toBe(200)

    expect(await raw(bill.id)).toMatchObject({ status: 'received', total: 36, amountDue: 36 })
  })

  it('less what was paid, and never below nothing', async () => {
    const w = await tillWorld(app, { device: false })
    const d = await issuedInvoice(w)
    expect((await pay(w, d.id, 10, 'bank_transfer')).status).toBe(200)

    await put(w, d.id, formBody(w, 3))
    expect(await raw(d.id)).toMatchObject({ total: 36, amountPaid: 10, amountDue: 26 })

    await put(w, d.id, { total: 6 })
    expect(await raw(d.id)).toMatchObject({ total: 6, amountPaid: 10, amountDue: 0 })
  })

  it('a payment that lands right after the edit leaves it right: it is derived from what is there', async () => {
    const w = await tillWorld(app, { device: false })
    const d = await issuedInvoice(w)
    await put(w, d.id, formBody(w, 3))

    await pay(w, d.id, 10, 'bank_transfer')

    expect(await raw(d.id)).toMatchObject({ total: 36, amountPaid: 10, amountDue: 26 })
  })

  it('an edit that moves no total does not touch it', async () => {
    const w = await tillWorld(app, { device: false })
    const d = await issuedInvoice(w)
    await Invoice.updateOne({ _id: d.id }, { $set: { amountDue: 7 } })

    await put(w, d.id, { notes: 'only this' })

    expect((await raw(d.id)).amountDue).toBe(7)
  })

  // #454: the status followed none of it, so a paid document owing money still read `paid`.
  it('an invoice paid in full by bank, raised: partially paid, and paid again once lowered back', async () => {
    const w = await tillWorld(app, { device: false })
    const d = await issuedInvoice(w)
    expect((await pay(w, d.id, 24, 'bank_transfer')).status).toBe(200)
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountDue: 0 })

    expect((await put(w, d.id, formBody(w, 3))).status).toBe(200)
    const raised = await raw(d.id)
    expect(raised).toMatchObject({ status: 'partially_paid', total: 36, amountPaid: 24, amountDue: 12 })
    // No longer paid in full, so not since then either.
    expect(raised.paidAt).toBeUndefined()
    expect(raised.statusHistory.at(-1)).toMatchObject({ fromStatus: 'paid', status: 'partially_paid', reason: 'total edited' })

    expect((await put(w, d.id, formBody(w, 2))).status).toBe(200)
    const back = await raw(d.id)
    expect(back).toMatchObject({ status: 'paid', total: 24, amountDue: 0 })
    expect(back.paidAt).toBeDefined()
  })

  it('a received bill paid in full, raised: partially paid', async () => {
    const w = await tillWorld(app, { device: false })
    const bill = await draftOf(w, { method: 'bank_transfer', extra: { direction: 'incoming', reference: 'S-2' } })
    expect((await w.call('POST', `/invoices/${bill.id}/receive`, {})).status).toBe(200)
    expect((await pay(w, bill.id, 24, 'bank_transfer')).status).toBe(200)
    expect((await raw(bill.id)).status).toBe('paid')

    expect((await put(w, bill.id, formBody(w, 3))).status).toBe(200)

    expect(await raw(bill.id)).toMatchObject({ status: 'partially_paid', total: 36, amountPaid: 24, amountDue: 12 })
  })

  it('a client\'s `amountDue` is not taken, with the total or without it', async () => {
    const w = await tillWorld(app, { device: false })
    const d = await issuedInvoice(w)

    expect((await put(w, d.id, { notes: 'only this', amountDue: 1 })).status).toBe(200)
    expect((await raw(d.id)).amountDue).toBe(24)

    expect((await put(w, d.id, { ...formBody(w, 3), amountDue: 999 })).status).toBe(200)
    expect((await raw(d.id)).amountDue).toBe(36)
  })

  it('a cash sale stays paid: nothing is due on one', async () => {
    const w = await tillWorld(app, { device: false })
    const sale = await w.backOfficeSale(2)
    expect(sale.status).toBe(200)
    const id = String(sale.json.invoice.id)

    expect((await put(w, id, formBody(w, 3))).status).toBe(200)

    expect((await raw(id)).amountDue).toBe(0)
  })
})

describe('none of it gets past a receipt (FR-23 §2.7)', () => {
  /** An invoice with a printed receipt on it: its total is the receipts' now. */
  const frozen = async (w: TillWorld, lines?: any[]) => {
    const d = await draftOf(w, { lines })
    expect((await send(w, d.id)).status).toBe(200)
    expect(await receiptsOf(d.id)).toHaveLength(1)
    return d
  }
  const figures = (doc: any) => ({
    lines: doc.lines.map((l: any) => [l.quantity, l.unitPrice, l.taxAmount, l.lineTotal]),
    subtotal: doc.subtotal, taxTotal: doc.taxTotal, total: doc.total, totalBase: doc.totalBase, amountDue: doc.amountDue,
  })

  it('lines that move the money, with no total: refused, and nothing is written', async () => {
    const w = await tillWorld(app)
    const d = await frozen(w)
    const before = figures(await raw(d.id))

    const r = await put(w, d.id, { lines: [bare(w, 3)] })

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('fiscally_paid')
    expect(figures(await raw(d.id))).toEqual(before)
  })

  it('a cent on each of two rates is a form\'s rounding on its own, but with no total sent it moves the total: refused', async () => {
    const w = await tillWorld(app)
    const d = await frozen(w, [line(w, 1, 10, 20), line(w, 1, 10, 9)])
    const before = figures(await raw(d.id))

    // Each rate moves by one cent, inside the slack `movesPrintedMoney` gives a line. The total the
    // request leaves out would move by two, past a receipt that printed the old one.
    const r = await put(w, d.id, { lines: [bare(w, 1, 10.01), bare(w, 1, 10.01, { taxRate: 9 })] })

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('fiscally_paid')
    expect(figures(await raw(d.id))).toEqual(before)
  })

  it('a save that moves no money still goes through, and moves no figure', async () => {
    const w = await tillWorld(app)
    const d = await frozen(w)
    const before = figures(await raw(d.id))

    const r = await put(w, d.id, { ...formBody(w, 2), notes: 'only this' })

    expect(r.status).toBe(200)
    expect(figures(await raw(d.id))).toEqual(before)
  })

  it('a hold on the document: the edit gives way, with what it derived', async () => {
    const w = await tillWorld(app)
    const d = await issuedInvoice(w)
    await Invoice.updateOne({ _id: d.id }, { $push: { receiptHolds: { receiptId: new (Invoice.base as any).Types.ObjectId(), amount: 24 } } })
    const before = figures(await raw(d.id))

    const r = await put(w, d.id, formBody(w, 3))

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('payment_in_progress')
    expect(figures(await raw(d.id))).toEqual(before)
  })

  it('a payment between the read and the write: the edit is told, and writes nothing it derived', async () => {
    const w = await tillWorld(app)
    const d = await issuedInvoice(w)
    const real = Invoice.findOneAndUpdate
    let inside: any
    ;(Invoice as any).findOneAndUpdate = function (filter: any, update: any, ...rest: any[]) {
      if (inside || update?.$set?.total !== 36) return (real as any).call(Invoice, filter, update, ...rest)
      const chain = {
        lean: () => chain,
        exec: async () => {
          inside = await pay(w, d.id, 20, 'bank_transfer')
          return (real as any).call(Invoice, filter, update, ...rest).lean().exec()
        },
      }
      return chain
    }
    let r: any
    try {
      r = await put(w, d.id, formBody(w, 3))
    } finally {
      ;(Invoice as any).findOneAndUpdate = real
    }

    expect(inside.status).toBe(200)
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('document_changed')
    expect(await raw(d.id)).toMatchObject({ status: 'partially_paid', total: 24, taxTotal: 4, totalBase: 24, amountPaid: 20, amountDue: 4 })
  })

  it('an invoice for a cash sale keeps the sale\'s figures: the service owns them', async () => {
    const w = await tillWorld(app, { device: false })
    const sale = await w.backOfficeSale(2)
    const { contactId } = await draftOf(w, { method: 'bank_transfer' })
    const made = await w.call('POST', `/invoices/${sale.json.invoice.id}/to-invoice`, { contactId })
    expect(made.status).toBe(200)
    const id = String(made.json.invoice.id)
    const before = await raw(id)

    const r = await put(w, id, { total: 1, totalBase: 1, taxTotal: 1, notes: 'only this' })

    expect(r.status).toBe(200)
    expect(await raw(id)).toMatchObject({ notes: 'only this', total: before.total, totalBase: before.totalBase, taxTotal: before.taxTotal, amountDue: before.amountDue })
  })
})

describe('both doors, one rule', () => {
  it('`POST` derives what it is not sent the same way', async () => {
    const w = await tillWorld(app, { device: false })
    const contactId = (await draftOf(w, { method: 'bank_transfer' })).contactId

    const r = await w.call('POST', '/invoices', {
      type: 'invoice', direction: 'outgoing', contactId, issueDate: '2026-10-05', currency: 'EUR', exchangeRate: 2,
      lines: [bare(w, 3, 0.33)], subtotal: 0.99, total: 1.19,
    })

    expect(r.status).toBe(200)
    const doc = await raw(String(r.json.invoice.id))
    // VAT 0.198: the line stores 0.20, and the header the rounded sum of what the numbers make.
    expect(doc.lines[0]).toMatchObject({ taxAmount: 0.2, lineTotal: 1.19 })
    expect(doc).toMatchObject({ taxTotal: 0.2, totalBase: 2.38, amountDue: 1.19 })
  })
})
