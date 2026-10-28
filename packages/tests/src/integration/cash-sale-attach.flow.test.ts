import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { mongoose } from 'db/connection'
import {
  createTestOrg, createTestUser, createTestContact, createTestWarehouse, createTestProduct, createTestStockLevel,
  createTestJournalEntry,
} from '../helpers/factories'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { Invoice, JournalEntry, StockLevel, StockMovement } from 'db/models'
import { getRepos } from 'services/context'
import { reverseInvoiceStockMovement } from 'services/biz/invoicing.service'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
const { Types } = mongoose

/**
 * FR-21 §11 — an invoice entered before its till sale arrived, attached to that cash sale.
 *
 * The till sold the goods and the day's export brought the sale in; a фактура written for the
 * customer had dispatched the same goods again. Attached, the invoice is what R0 issues from the
 * start: the invoice FOR that cash sale. Its dispatch is taken back (once), it moves no stock from
 * then on, it is paid with the till's money, and the sale's quantities stay a budget no set of
 * invoices exceeds.
 *
 * Over HTTP through the real controller. NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(invoiceController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const DAY = '2026-10-20'

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const customer = await createTestContact(org._id, { companyName: 'Купувач ООД', type: 'customer' } as any)
  const other = await createTestContact(org._id, { companyName: 'Друг ЕООД', type: 'customer' } as any)
  const warehouse = await createTestWarehouse(org._id)
  const bolt = await createTestProduct(org._id, { name: 'Болт М8', sellingPrice: 10, taxRate: 20 } as any)
  const nut = await createTestProduct(org._id, { name: 'Гайка М8', sellingPrice: 5, taxRate: 20 } as any)
  const washer = await createTestProduct(org._id, { name: 'Шайба М8', sellingPrice: 1, taxRate: 20 } as any)
  for (const p of [bolt, nut, washer]) await createTestStockLevel(org._id, p._id, warehouse._id, { quantity: 100 })
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Мария', lastName: 'Иванова', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  async function call(method: string, path: string, body?: any) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/invoices${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }
  const line = (product: any, quantity: number, unitPrice: number) => ({
    productId: String(product._id), warehouseId: String(warehouse._id),
    description: product.name, quantity, unitPrice, taxRate: 20,
    taxAmount: +(quantity * unitPrice * 0.2).toFixed(2), lineTotal: +(quantity * unitPrice * 1.2).toFixed(2),
  })
  const totals = (ls: any[]) => {
    const subtotal = +ls.reduce((s, l) => s + l.quantity * l.unitPrice, 0).toFixed(2)
    const taxTotal = +ls.reduce((s, l) => s + l.taxAmount, 0).toFixed(2)
    return { subtotal, taxTotal, total: +(subtotal + taxTotal).toFixed(2) }
  }
  /** A till day, as the import books it: a cash sale with no customer. */
  async function cashSale(lines: Array<[any, number, number]>, opts: { contactId?: string; issueDate?: string } = {}) {
    const ls = lines.map(([p, q, price]) => line(p, q, price))
    const res = await call('POST', '', {
      type: 'cash_sale', direction: 'outgoing', issueDate: opts.issueDate || DAY, currency: 'EUR',
      ...(opts.contactId ? { contactId: opts.contactId } : {}), lines: ls, ...totals(ls), paymentMethod: 'cash',
    })
    expect(res.status).toBe(200)
    return Invoice.findById(res.json.invoice.id).lean().exec() as Promise<any>
  }
  /** An ordinary sales invoice, issued: it dispatches its goods. */
  async function invoice(lines: Array<[any, number, number]>, opts: { contactId?: string; issueDate?: string; paymentMethod?: string; issue?: boolean } = {}) {
    const ls = lines.map(([p, q, price]) => line(p, q, price))
    const res = await call('POST', '', {
      type: 'invoice', direction: 'outgoing', contactId: opts.contactId || String(customer._id), issueDate: opts.issueDate || DAY,
      currency: 'EUR', lines: ls, ...totals(ls), paymentMethod: opts.paymentMethod || 'bank_transfer',
    })
    expect(res.status).toBe(200)
    if (opts.issue !== false) expect((await call('POST', `/${res.json.invoice.id}/send`, {})).status).toBe(200)
    return Invoice.findById(res.json.invoice.id).lean().exec() as Promise<any>
  }
  const attach = (invId: unknown, csId: unknown) => call('POST', `/${invId}/attach-to-cash-sale`, { cashSaleId: String(csId) })
  const candidates = async (invId: unknown) => (await call('GET', `/${invId}/cash-sale-candidates`)).json
  const stock = async (product: any) => Number(((await StockLevel.findOne({ orgId, productId: product._id }).lean().exec()) as any)?.quantity)
  const load = (id: unknown) => Invoice.findById(id).lean().exec() as Promise<any>
  const invoicing = async (csId: unknown) => (await call('GET', `/${csId}/to-invoice`)).json.invoicing
  return { orgId, customer, other, bolt, nut, washer, call, cashSale, invoice, attach, candidates, stock, load, invoicing }
}

describe('attaching an invoice to the cash sale of its day', () => {
  it('takes back its dispatch once, links it, and makes it paid by the till', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 5, 10], [w.nut, 4, 5]])
    const inv = await w.invoice([[w.bolt, 2, 10]])
    expect(await w.stock(w.bolt)).toBe(93) // the till's 5 and the invoice's 2: the same 2 went twice

    const offer = await w.candidates(inv._id)
    expect(offer).toMatchObject({ eligible: true, day: DAY, considered: 1 })
    expect(offer.candidates.map((c: any) => c.number)).toEqual([cs.invoiceNumber])

    const res = await w.attach(inv._id, cs._id)
    expect(res.status).toBe(200)
    const after = await w.load(inv._id)
    expect(String(after.cashSaleRef.cashSaleId)).toBe(String(cs._id))
    expect(after.cashSaleRef.number).toBe(cs.invoiceNumber)
    expect(String(after.lines[0].cashSaleLineId)).toBe(String(cs.lines[0]._id))
    expect(after.stockSource?.marker).toBe(`cash_sale:${cs.invoiceNumber}`)
    expect(after.status).toBe('paid')
    expect([after.amountPaid, after.amountDue]).toEqual([after.total, 0])
    expect(after.payments).toHaveLength(1)
    expect(after.payments[0]).toMatchObject({ origin: 'cash_register', method: 'cash', amount: after.total, reference: cs.invoiceNumber })
    expect(new Date(after.taxEventDate).toISOString().slice(0, 10)).toBe(DAY)
    expect(after.invoiceNumber).toBe(inv.invoiceNumber) // the issued document keeps its number

    // Its dispatch is back, once, and says why.
    expect(await w.stock(w.bolt)).toBe(95)
    const back: any = await StockMovement.findOne({ orgId: w.orgId, invoiceId: inv._id, toWarehouseId: { $exists: true } }).lean().exec()
    expect(back.notes).toBe(`Attached to cash sale ${cs.invoiceNumber} — its goods left on the till`)
    const st = await w.invoicing(cs._id)
    expect(st.state).toBe('partial')
    expect(st.lines.map((l: any) => [l.invoiced, l.remaining])).toEqual([[2, 3], [0, 4]])

    // A retry answers with the same invoice and moves nothing again.
    expect((await w.attach(inv._id, cs._id)).status).toBe(200)
    expect(await w.stock(w.bolt)).toBe(95)
    expect(await StockMovement.countDocuments({ orgId: w.orgId, invoiceId: inv._id }).exec()).toBe(2)

    // Voided afterwards, it moves nothing (the goods are the till's) and frees the sale's quantities.
    expect((await w.call('POST', `/${inv._id}/void`, {})).status).toBe(200)
    expect(await w.stock(w.bolt)).toBe(95)
    expect((await w.invoicing(cs._id)).state).toBe('none')
  }, 60_000)

  it('replaces the cash it was settled with on issue by the till\'s payment', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 3, 10]])
    const inv = await w.invoice([[w.bolt, 3, 10]], { paymentMethod: 'cash' })
    expect(inv.status).toBe('paid')
    expect(inv.payments.map((p: any) => p.origin)).toEqual(['cash_on_issue'])

    expect((await w.attach(inv._id, cs._id)).status).toBe(200)
    const after = await w.load(inv._id)
    expect(after.payments.map((p: any) => [p.origin, p.amount])).toEqual([['cash_register', after.total]])
    expect(await w.stock(w.bolt)).toBe(97)
  }, 60_000)

  it('is refused when the invoice is not that sale\'s', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 5, 10], [w.nut, 4, 5]])
    const codeOf = async (invId: unknown) => (await w.attach(invId, cs._id)).json.code

    expect(await codeOf((await w.invoice([[w.bolt, 1, 10]], { issueDate: '2026-10-21' }))._id)).toBe('different_day')
    expect(await codeOf((await w.invoice([[w.washer, 1, 1]]))._id)).toBe('line_not_in_cash_sale')
    expect(await codeOf((await w.invoice([[w.bolt, 1, 11]]))._id)).toBe('line_terms_differ')
    expect(await codeOf((await w.invoice([[w.bolt, 6, 10]]))._id)).toBe('line_quantity_exceeds')
    expect(await codeOf((await w.invoice([[w.bolt, 1, 10]], { issue: false }))._id)).toBe('invoice_not_issued')

    // A payment recorded by hand: the till took the money, so it is not replaced silently.
    const paidByHand = await w.invoice([[w.bolt, 1, 10]])
    await Invoice.updateOne({ _id: paidByHand._id }, { $set: { payments: [{ date: new Date(), amount: 5, method: 'bank_transfer' }] } }).exec()
    expect(await codeOf(paidByHand._id)).toBe('invoice_has_payments')

    // Nothing of any refused invoice was linked or moved back.
    expect(await Invoice.countDocuments({ type: 'invoice', 'cashSaleRef.cashSaleId': cs._id }).exec()).toBe(0)
    expect(await StockMovement.countDocuments({ toWarehouseId: { $exists: true }, notes: /^Attached/ }).exec()).toBe(0)
    // The offer lists the sale only for an invoice that fits it.
    const misfit = await w.invoice([[w.bolt, 1, 11]])
    expect((await w.candidates(misfit._id)).candidates).toEqual([])
  }, 60_000)

  it('against an imported till day, an invoice at its own price attaches: the day\'s price is an average', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 5, 10]])
    // As the import books a day: one line per article, at the day's value ÷ quantity.
    await Invoice.updateOne({ _id: cs._id }, { $set: { reference: `salesAnalysis:${DAY}`, 'register.origin': 'import', 'lines.0.unitPrice': 9.7667 } }).exec()
    const inv = await w.invoice([[w.bolt, 2, 10]])
    expect((await w.candidates(inv._id)).candidates.map((c: any) => c.number)).toEqual([cs.invoiceNumber])
    expect((await w.attach(inv._id, cs._id)).status).toBe(200)
    expect(await w.stock(w.bolt)).toBe(95)
    // It keeps its own price: it is the tax document of its own sale.
    expect((await w.load(inv._id)).lines[0].unitPrice).toBe(10)
  }, 60_000)

  it('completes a till overlap repaired by hand: links it, and reverses nothing a second time', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 5, 10]])
    await Invoice.updateOne({ _id: cs._id }, { $set: { reference: `salesAnalysis:${DAY}`, 'register.origin': 'import' } }).exec()
    const inv = await w.invoice([[w.bolt, 2, 10]])
    // The repair as it was done before this button: reverse the dispatch, then mark the till day.
    const repo = await getRepos().invoices.findOne({ id: String(inv._id), orgId: w.orgId } as any)
    await reverseInvoiceStockMovement(repo as any, String(inv.createdBy))
    await Invoice.updateOne({ _id: inv._id }, {
      $set: { stockSource: { marker: `salesAnalysis:${DAY}`, docNumber: cs.invoiceNumber, detectedBy: 'till-overlap, snapshot-arbitrated', linkedAt: new Date() } },
    }).exec()
    const movements = () => StockMovement.countDocuments({ orgId: w.orgId, invoiceId: inv._id }).exec()
    expect([await w.stock(w.bolt), await movements()]).toEqual([95, 2])

    // Still counted twice until now: it has no cashSaleRef. The till day is its only candidate.
    expect((await w.candidates(inv._id)).candidates.map((c: any) => c.number)).toEqual([cs.invoiceNumber])
    expect((await w.attach(inv._id, cs._id)).status).toBe(200)
    const after = await w.load(inv._id)
    expect(String(after.cashSaleRef.cashSaleId)).toBe(String(cs._id))
    expect(after.stockSource).toMatchObject({ marker: `cash_sale:${cs.invoiceNumber}`, detectedBy: 'cash_sale' })
    expect([await w.stock(w.bolt), await movements()]).toEqual([95, 2])
    // A retry is the finished attach.
    expect((await w.attach(inv._id, cs._id)).status).toBe(200)
    expect(await movements()).toBe(2)
  }, 60_000)

  it('does not trust a till marker for another day, or one set before its dispatch came back', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 5, 10]])
    await Invoice.updateOne({ _id: cs._id }, { $set: { reference: `salesAnalysis:${DAY}`, 'register.origin': 'import' } }).exec()
    const mark = (id: unknown, day: string) => Invoice.updateOne({ _id: id }, {
      $set: { stockSource: { marker: `salesAnalysis:${day}`, detectedBy: 'till-overlap', linkedAt: new Date() } },
    }).exec()

    const otherDay = await w.invoice([[w.bolt, 1, 10]])
    await mark(otherDay._id, '2026-10-19')
    expect((await w.attach(otherDay._id, cs._id)).json.code).toBe('invoice_moves_no_stock')
    expect((await w.candidates(otherDay._id)).candidates).toEqual([])

    // Marked, but never reversed: with the marker set, a reversal would not even run.
    const unreversed = await w.invoice([[w.bolt, 1, 10]])
    await mark(unreversed._id, DAY)
    const res = await w.attach(unreversed._id, cs._id)
    expect([res.status, res.json.code]).toEqual([409, 'attach_needs_attention'])
    const after = await w.load(unreversed._id)
    expect(after.cashSaleRef).toBeUndefined()
    expect(after.stockSource.marker).toBe(`salesAnalysis:${DAY}`)
    expect(await w.stock(w.bolt)).toBe(93) // the till's 5 and both invoices' 1: nothing came back
  }, 60_000)

  it('is refused for a stornoed sale, and its claim does not linger', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 5, 10]])
    const inv = await w.invoice([[w.bolt, 2, 10]])
    await Invoice.updateOne({ _id: cs._id }, { $set: { 'register.stornoState': 'full' } }).exec()
    const res = await w.attach(inv._id, cs._id)
    expect([res.status, res.json.code]).toEqual([422, 'cash_sale_stornoed'])
    const after = await w.load(inv._id)
    expect(after.cashSaleRef).toBeUndefined()
    expect(await w.stock(w.bolt)).toBe(93) // nothing moved back
  }, 60_000)

  it('gives way to the invoices the sale already has: its claim comes last', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 3, 10]])
    // Entered first (the older _id), attached second.
    const inv = await w.invoice([[w.bolt, 2, 10]])
    // Meanwhile the sale was invoiced from the till side for 2 of its 3.
    const conversion = await w.call('POST', `/${cs._id}/to-invoice`, {
      contactId: String(w.other._id), lines: [{ lineId: String(cs.lines[0]._id), quantity: 2 }],
    })
    expect(conversion.status).toBe(200)
    const res = await w.attach(inv._id, cs._id)
    expect(res.status).toBe(422)
    expect(res.json.code).toBe('line_quantity_exceeds')
    expect((await w.load(inv._id)).cashSaleRef).toBeUndefined()
  }, 60_000)

  it('a sale to a named customer takes one invoice of that customer, whole', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 2, 10], [w.nut, 1, 5]], { contactId: String(w.customer._id) })
    expect((await w.attach((await w.invoice([[w.bolt, 2, 10], [w.nut, 1, 5]], { contactId: String(w.other._id) }))._id, cs._id)).json.code)
      .toBe('contact_mismatch')
    expect((await w.attach((await w.invoice([[w.bolt, 2, 10]]))._id, cs._id)).json.code).toBe('cash_sale_whole_only')
    const whole = await w.invoice([[w.bolt, 2, 10], [w.nut, 1, 5]])
    expect((await w.attach(whole._id, cs._id)).status).toBe(200)
    expect((await w.invoicing(cs._id)).state).toBe('full')
    // And no second one.
    const again = await w.invoice([[w.bolt, 2, 10], [w.nut, 1, 5]])
    expect((await w.attach(again._id, cs._id)).json.code).toBe('cash_sale_fully_invoiced')
  }, 60_000)

  it('posts nothing of its own: a draft entry goes, a posted one refuses, a payment\'s entry is the payment\'s', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 5, 10]])
    // What `invoice.posted` / `payment.recorded` make in an org that keeps journals (no handlers run here).
    const entryFor = (invId: unknown, status: 'draft' | 'posted') =>
      createTestJournalEntry(new Types.ObjectId(w.orgId), new Types.ObjectId(), new Types.ObjectId(), { status, sourceModule: 'invoicing', sourceId: invId } as any)
    const statusOf = async (je: any) => ((await JournalEntry.findById(je._id).lean().exec()) as any)?.status

    // Posted to the ledger: refused, before anything is linked or moved.
    const posted = await w.invoice([[w.bolt, 1, 10]])
    const postedEntry = await entryFor(posted._id, 'posted')
    expect(await w.candidates(posted._id)).toMatchObject({ eligible: false, code: 'invoice_in_ledger' })
    const refused = await w.attach(posted._id, cs._id)
    expect([refused.status, refused.json.code]).toEqual([409, 'invoice_in_ledger'])
    expect((await w.load(posted._id)).cashSaleRef).toBeUndefined()
    expect(await statusOf(postedEntry)).toBe('posted')

    // A draft entry: attached, and the entry is voided — it would post the sale a second time.
    const drafted = await w.invoice([[w.bolt, 1, 10]])
    const draftEntry = await entryFor(drafted._id, 'draft')
    await Invoice.updateOne({ _id: drafted._id }, { $set: { journalEntryId: draftEntry._id } }).exec()
    expect((await w.attach(drafted._id, cs._id)).status).toBe(200)
    expect(await statusOf(draftEntry)).toBe('voided')

    // The posted entry of its on-issue cash payment names the invoice too, but it is the payment's:
    // it goes with that payment, and does not refuse the attach.
    const cash = await w.invoice([[w.bolt, 1, 10]], { paymentMethod: 'cash' })
    const payEntry = await entryFor(cash._id, 'posted')
    await Invoice.updateOne({ _id: cash._id, 'payments.origin': 'cash_on_issue' }, { $set: { 'payments.$.journalEntryId': payEntry._id } }).exec()
    expect((await w.candidates(cash._id)).eligible).toBe(true)
    expect((await w.attach(cash._id, cs._id)).status).toBe(200)
    expect(await statusOf(payEntry)).toBe('voided')
  }, 60_000)
})
