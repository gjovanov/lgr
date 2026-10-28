import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestUser, createTestContact, createTestWarehouse, createTestProduct, createTestStockLevel,
} from '../helpers/factories'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { requestHash } from 'services/biz/hot-path-key'
import { planDeleteDocFiles } from 'services/biz/files/doc-delete.service'
import { eventBus } from 'services/events/event-bus'
import { DocFile, Invoice, StockLevel, StockMovement } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * „Фактура към касова продажба" (#171): an invoice issued for a cash sale is the tax document of
 * a sale the cash sale already booked. It moves no stock, posts no journal entry, is born paid,
 * and its cash sale's quantities are a budget no set of invoices may exceed.
 *
 * Driven over HTTP through the real controller, because the guards live on the routes.
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
const posted: any[] = []
const paymentsRecorded: any[] = []
const offs: Array<() => void> = []

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(invoiceController)
  offs.push(eventBus.on('invoice.posted', (p: any) => { posted.push(p) }))
  offs.push(eventBus.on('payment.recorded', (p: any) => { paymentsRecorded.push(p) }))
}, 60_000)
afterAll(async () => {
  for (const off of offs) off()
  await teardownTestDB()
}, 60_000)
afterEach(async () => {
  posted.length = 0
  paymentsRecorded.length = 0
  await clearCollections()
}, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string }) {
  return (signer as any).decorator.jwt.sign({
    id: u.id, orgId: u.orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Мария', lastName: 'Иванова', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const customer = await createTestContact(org._id, { companyName: 'Купувач ООД', type: 'customer' } as any)
  const other = await createTestContact(org._id, { companyName: 'Друг ЕООД', type: 'both' } as any)
  const supplier = await createTestContact(org._id, { companyName: 'Доставчик АД', type: 'supplier' } as any)
  const warehouse = await createTestWarehouse(org._id)
  const bolt = await createTestProduct(org._id, { name: 'Болт М8', sellingPrice: 10, taxRate: 20 } as any)
  const nut = await createTestProduct(org._id, { name: 'Гайка М8', sellingPrice: 5, taxRate: 20 } as any)
  await createTestStockLevel(org._id, bolt._id, warehouse._id, { quantity: 100 })
  await createTestStockLevel(org._id, nut._id, warehouse._id, { quantity: 100 })
  const token = await tokenFor({ id: String(user._id), orgId })

  async function call(method: string, path: string, body?: any, key?: string) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/invoices${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }

  const line = (product: any, quantity: number, unitPrice: number) => ({
    productId: String(product._id), warehouseId: String(warehouse._id),
    description: product.name, quantity, unitPrice, taxRate: 20,
    taxAmount: +(quantity * unitPrice * 0.2).toFixed(2), lineTotal: +(quantity * unitPrice * 1.2).toFixed(2),
  })
  /** A back-office cash sale, as the terminal posts it. */
  async function cashSale(lines: Array<[any, number, number]>, opts: { contactId?: string; paymentMethod?: string; issueDate?: string } = {}) {
    const ls = lines.map(([p, q, price]) => line(p, q, price))
    const subtotal = +ls.reduce((s, l) => s + l.quantity * l.unitPrice, 0).toFixed(2)
    const taxTotal = +ls.reduce((s, l) => s + l.taxAmount, 0).toFixed(2)
    const res = await call('POST', '', {
      type: 'cash_sale', direction: 'outgoing', issueDate: opts.issueDate || '2026-10-20', currency: 'EUR',
      ...(opts.contactId ? { contactId: opts.contactId } : {}),
      lines: ls, subtotal, taxTotal, total: +(subtotal + taxTotal).toFixed(2), paymentMethod: opts.paymentMethod || 'cash',
    })
    expect(res.status).toBe(200)
    return Invoice.findById(res.json.invoice.id).lean().exec() as Promise<any>
  }
  const toInvoice = (csId: unknown, body: Record<string, any>, key?: string) => call('POST', `/${csId}/to-invoice`, body, key)
  const stateOf = async (csId: unknown) => (await call('GET', `/${csId}/to-invoice`)).json.invoicing
  const lineId = (cs: any, i: number) => String(cs.lines[i]._id)
  const stock = async (product: any) => Number(((await StockLevel.findOne({ orgId, productId: product._id }).lean().exec()) as any)?.quantity)
  const load = (id: unknown) => Invoice.findById(id).lean().exec() as Promise<any>
  const movementsOf = (id: unknown) => StockMovement.countDocuments({ orgId, invoiceId: id }).exec()

  return { org, orgId, user, customer, other, supplier, warehouse, bolt, nut, call, cashSale, toInvoice, stateOf, lineId, stock, load, movementsOf }
}

describe('an invoice for a cash sale', () => {
  it('copies the whole sale, is born paid, and moves no stock and posts nothing', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 2, 10], [w.nut, 3, 5]], { paymentMethod: 'card' })
    expect(await w.stock(w.bolt)).toBe(98)
    expect(await w.stock(w.nut)).toBe(97)

    const res = await w.toInvoice(cs._id, { contactId: String(w.customer._id), issueDate: '2026-10-22' })
    expect(res.status).toBe(200)
    const inv = await w.load(res.json.invoice.id)

    expect(inv.type).toBe('invoice')
    expect(inv.direction).toBe('outgoing')
    expect(inv.status).toBe('paid')
    expect(inv.invoiceNumber).toMatch(/^INV-/)
    expect(String(inv.contactId)).toBe(String(w.customer._id))
    // The receipt's own figures, to the cent.
    expect([inv.subtotal, inv.taxTotal, inv.total]).toEqual([cs.subtotal, cs.taxTotal, cs.total])
    expect(inv.lines.map((l: any) => [String(l.cashSaleLineId), l.quantity, l.unitPrice])).toEqual(
      cs.lines.map((l: any) => [String(l._id), l.quantity, l.unitPrice]),
    )
    expect(inv.payments).toHaveLength(1)
    expect(inv.payments[0]).toMatchObject({ method: 'card', origin: 'cash_register', amount: cs.total, reference: cs.invoiceNumber })
    expect([inv.amountPaid, inv.amountDue]).toEqual([cs.total, 0])
    expect(inv.cashSaleRef).toMatchObject({ number: cs.invoiceNumber })
    expect(String(inv.cashSaleRef.cashSaleId)).toBe(String(cs._id))
    expect(new Date(inv.taxEventDate).toISOString().slice(0, 10)).toBe('2026-10-20')
    expect(inv.stockSource?.marker).toBe(`cash_sale:${cs.invoiceNumber}`)
    expect(inv.preparedBy).toBe('Мария Иванова')
    // Like every outgoing document, it carries the amount in words (in Bulgarian by default).
    expect(inv.notes).toMatch(/^Словом/)

    // The cash sale moved the goods; the invoice moves none, and books no revenue or payment.
    expect(await w.movementsOf(inv._id)).toBe(0)
    expect([await w.stock(w.bolt), await w.stock(w.nut)]).toEqual([98, 97])
    expect(posted.filter(p => p.invoiceId === String(inv._id))).toHaveLength(0)
    expect(paymentsRecorded).toHaveLength(0)

    // The cash sale is untouched — the link lives on the invoice only (FR-20.51).
    const after = await w.load(cs._id)
    expect(after.updatedAt).toEqual(cs.updatedAt)

    // Both directions are visible.
    const state = await w.stateOf(cs._id)
    expect(state.state).toBe('full')
    expect(state.canInvoice).toBe(false)
    expect(state.invoices.map((i: any) => i.number)).toEqual([inv.invoiceNumber])
    const cashList = await w.call('GET', '?type=cash_sale')
    expect(cashList.json.invoices[0]).toMatchObject({ invoicingState: 'full', invoices: [{ number: inv.invoiceNumber }] })
    const invList = await w.call('GET', '?type=invoice')
    expect(invList.json.invoices[0]).toMatchObject({ cashSaleNumber: cs.invoiceNumber, cashSaleId: String(cs._id) })
    expect((await w.call('GET', '?type=cash_sale&invoiced=yes')).json.invoices).toHaveLength(1)
    expect((await w.call('GET', '?type=cash_sale&invoiced=no')).json.invoices).toHaveLength(0)
  }, 60_000)

  it('takes the next SALES_DOC number: the conversion burns none', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 1, 10]])
    const first = await w.toInvoice(cs._id, { contactId: String(w.customer._id) })
    const draft = await w.call('POST', '', {
      type: 'invoice', direction: 'outgoing', contactId: String(w.customer._id), issueDate: '2026-10-22', currency: 'EUR',
      lines: [{ productId: String(w.nut._id), warehouseId: String(w.warehouse._id), description: 'Гайка М8', quantity: 1, unitPrice: 5, taxRate: 20 }],
      subtotal: 5, taxTotal: 1, total: 6, paymentMethod: 'bank_transfer',
    })
    const sent = await w.call('POST', `/${draft.json.invoice.id}/send`, {})
    const suffix = (n: string) => Number(n.match(/(\d+)$/)![1])
    expect(suffix(sent.json.invoice.invoiceNumber)).toBe(suffix(first.json.invoice.invoiceNumber) + 1)
  }, 60_000)

  it('invoices a day without a customer in parts, never beyond what was sold', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 10, 10]])

    const a = await w.toInvoice(cs._id, { contactId: String(w.customer._id), lines: [{ lineId: w.lineId(cs, 0), quantity: 4 }] })
    expect(a.status).toBe(200)
    expect(a.json.invoice.total).toBe(48)

    const tooMuch = await w.toInvoice(cs._id, { contactId: String(w.other._id), lines: [{ lineId: w.lineId(cs, 0), quantity: 7 }] })
    expect(tooMuch.status).toBe(409)
    expect(tooMuch.json.code).toBe('cash_sale_quantity_exceeded')
    expect((await w.stateOf(cs._id)).lines[0]).toMatchObject({ quantity: 10, invoiced: 4, remaining: 6 })

    const rest = await w.toInvoice(cs._id, { contactId: String(w.other._id) })
    expect(rest.status).toBe(200)
    expect(rest.json.invoice.lines[0].quantity).toBe(6)

    const more = await w.toInvoice(cs._id, { contactId: String(w.customer._id) })
    expect(more.status).toBe(409)
    expect(more.json.code).toBe('cash_sale_fully_invoiced')
    expect((await w.stateOf(cs._id)).state).toBe('full')
    expect(await w.stock(w.bolt)).toBe(90)
  }, 60_000)

  it('invoices a sale that names a customer whole, and once', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 2, 10], [w.nut, 1, 5]], { contactId: String(w.customer._id) })

    const part = await w.toInvoice(cs._id, { contactId: String(w.customer._id), lines: [{ lineId: w.lineId(cs, 0), quantity: 2 }] })
    expect(part.status).toBe(422)
    expect(part.json.code).toBe('cash_sale_whole_only')

    const whole = await w.toInvoice(cs._id, { contactId: String(w.other._id) })
    expect(whole.status).toBe(200)
    const again = await w.toInvoice(cs._id, { contactId: String(w.other._id) })
    expect(again.status).toBe(409)
    expect((await w.stateOf(cs._id)).reason).toBeTruthy()
  }, 60_000)

  it('keeps a draft when asked; the draft holds its quantities and /send issues it paid, posting nothing', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 3, 10]])
    const res = await w.toInvoice(cs._id, { contactId: String(w.customer._id), issue: false })
    expect(res.status).toBe(200)
    expect(res.json.invoice.status).toBe('draft')
    expect(res.json.invoice.invoiceNumber).toMatch(/^DRF-/)
    expect((await w.stateOf(cs._id)).state).toBe('full')

    const sent = await w.call('POST', `/${res.json.invoice.id}/send`, {})
    expect(sent.status).toBe(200)
    const inv = await w.load(res.json.invoice.id)
    expect(inv.status).toBe('paid')
    expect(inv.invoiceNumber).toMatch(/^INV-/)
    expect(inv.payments).toEqual([expect.objectContaining({ origin: 'cash_register', method: 'cash', amount: 36 })])
    expect(await w.movementsOf(inv._id)).toBe(0)
    expect(await w.stock(w.bolt)).toBe(97)
    expect(posted).toHaveLength(0)
    expect(paymentsRecorded).toHaveLength(0)
  }, 60_000)

  it('voiding the invoice moves nothing and gives the quantities back to the sale', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 2, 10]])
    const inv = (await w.toInvoice(cs._id, { contactId: String(w.customer._id) })).json.invoice

    const voided = await w.call('POST', `/${inv.id}/void`)
    expect(voided.status).toBe(200)
    expect(voided.json.invoice.status).toBe('voided')
    expect(await w.movementsOf(inv.id)).toBe(0)
    expect(await w.stock(w.bolt)).toBe(98)
    expect((await w.stateOf(cs._id)).state).toBe('none')

    const anew = await w.toInvoice(cs._id, { contactId: String(w.other._id) })
    expect(anew.status).toBe(200)
  }, 60_000)

  it('takes ordinary credit and debit notes: a credit note returns its goods', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 2, 10]])
    const inv = (await w.toInvoice(cs._id, { contactId: String(w.customer._id) })).json.invoice

    const cn = await w.call('POST', '', {
      type: 'credit_note', direction: 'outgoing', contactId: String(w.customer._id), relatedInvoiceId: inv.id,
      issueDate: '2026-10-23', currency: 'EUR',
      lines: [{ productId: String(w.bolt._id), warehouseId: String(w.warehouse._id), description: 'Болт М8', quantity: 1, unitPrice: 10, taxRate: 20 }],
      subtotal: 10, taxTotal: 2, total: 12,
    })
    expect(cn.status).toBe(200)
    const sent = await w.call('POST', `/${cn.json.invoice.id}/send`, {})
    expect(sent.status).toBe(200)
    expect(await w.stock(w.bolt)).toBe(99)
    expect(posted.filter(p => p.invoiceId === cn.json.invoice.id)).toHaveLength(1)

    const dn = await w.call('POST', '', {
      type: 'debit_note', direction: 'outgoing', contactId: String(w.customer._id), relatedInvoiceId: inv.id,
      issueDate: '2026-10-23', currency: 'EUR',
      lines: [{ description: 'Доплащане', quantity: 1, unitPrice: 2, taxRate: 20 }],
      subtotal: 2, taxTotal: 0.4, total: 2.4,
    })
    expect(dn.status).toBe(200)
  }, 60_000)

  it('an issued one keeps the sale\'s lines and dates; the customer and notes can change', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 2, 10]])
    const inv = await w.load((await w.toInvoice(cs._id, { contactId: String(w.customer._id) })).json.invoice.id)
    const lines = inv.lines.map((l: any) => ({ ...l, productId: String(l.productId), warehouseId: String(l.warehouseId), cashSaleLineId: String(l.cashSaleLineId), _id: undefined }))

    const changed = await w.call('PUT', `/${inv._id}`, { lines: [{ ...lines[0], quantity: 1 }] })
    expect(changed.status).toBe(422)
    expect(changed.json.code).toBe('invoice_for_cash_sale_issued')

    const redated = await w.call('PUT', `/${inv._id}`, { issueDate: '2026-11-01' })
    expect(redated.status).toBe(422)

    const ok = await w.call('PUT', `/${inv._id}`, { contactId: String(w.other._id), notes: 'Към касова бележка', total: 1, lines })
    expect(ok.status).toBe(200)
    const after = await w.load(inv._id)
    expect(String(after.contactId)).toBe(String(w.other._id))
    expect(after.notes).toBe('Към касова бележка')
    expect(after.total).toBe(inv.total)
    expect(after.cashSaleRef.number).toBe(cs.invoiceNumber)
  }, 60_000)

  it('a draft of a day without a customer may invoice less, at the sale\'s terms only', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 10, 10], [w.nut, 4, 5]])
    const draft = await w.load((await w.toInvoice(cs._id, { contactId: String(w.customer._id), issue: false })).json.invoice.id)
    const lines = draft.lines.map((l: any) => ({
      productId: String(l.productId), warehouseId: String(l.warehouseId), cashSaleLineId: String(l.cashSaleLineId),
      description: l.description, quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice, discount: l.discount, taxRate: l.taxRate,
    }))

    const less = await w.call('PUT', `/${draft._id}`, { lines: [{ ...lines[0], quantity: 3 }], total: 999, subtotal: 999 })
    expect(less.status).toBe(200)
    const after = await w.load(draft._id)
    expect(after.lines).toHaveLength(1)
    expect([after.subtotal, after.taxTotal, after.total]).toEqual([30, 6, 36])
    expect((await w.stateOf(cs._id)).lines.map((l: any) => l.remaining)).toEqual([7, 4])

    const repriced = await w.call('PUT', `/${draft._id}`, { lines: [{ ...lines[0], quantity: 3, unitPrice: 9 }] })
    expect(repriced.status).toBe(422)
    expect(repriced.json.code).toBe('line_terms_fixed')

    const extra = await w.call('PUT', `/${draft._id}`, { lines: [lines[0], { description: 'Услуга', quantity: 1, unitPrice: 50, taxRate: 20 }] })
    expect(extra.status).toBe(422)
    expect(extra.json.code).toBe('line_not_in_cash_sale')

    const over = await w.call('PUT', `/${draft._id}`, { lines: [{ ...lines[0], quantity: 11 }] })
    expect(over.status).toBe(409)
  }, 60_000)

  it('a cash sale keeps its lines while an invoice points into them', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 2, 10]])
    await w.toInvoice(cs._id, { contactId: String(w.customer._id) })
    const res = await w.call('PUT', `/${cs._id}`, {
      lines: [{ productId: String(w.bolt._id), warehouseId: String(w.warehouse._id), description: 'Болт М8', quantity: 2, unitPrice: 10, taxRate: 20 }],
    })
    expect(res.status).toBe(409)
    expect(res.json.code).toBe('cash_sale_invoiced')
  }, 60_000)

  it('refuses a supplier, a date before the sale, and anything but a paid cash sale', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 1, 10]])

    const supplier = await w.toInvoice(cs._id, { contactId: String(w.supplier._id) })
    expect([supplier.status, supplier.json.code]).toEqual([422, 'contact_not_customer'])

    const early = await w.toInvoice(cs._id, { contactId: String(w.customer._id), issueDate: '2026-10-19' })
    expect([early.status, early.json.code]).toEqual([422, 'issue_date_before_sale'])

    const inv = (await w.toInvoice(cs._id, { contactId: String(w.customer._id) })).json.invoice
    const ofInvoice = await w.toInvoice(inv.id, { contactId: String(w.customer._id) })
    expect([ofInvoice.status, ofInvoice.json.code]).toEqual([422, 'not_a_cash_sale'])

    const missing = await w.toInvoice('6a0000000000000000000000', { contactId: String(w.customer._id) })
    expect(missing.status).toBe(404)
  }, 60_000)

  it('a plain create cannot forge the link', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 1, 10]])
    const res = await w.call('POST', '', {
      type: 'invoice', direction: 'outgoing', contactId: String(w.customer._id), issueDate: '2026-10-22', currency: 'EUR',
      cashSaleRef: { cashSaleId: String(cs._id), number: cs.invoiceNumber, issueDate: '2026-10-20' },
      lines: [{ productId: String(w.bolt._id), warehouseId: String(w.warehouse._id), description: 'Болт М8', quantity: 1, unitPrice: 10, taxRate: 20, cashSaleLineId: String(cs.lines[0]._id) }],
      subtotal: 10, taxTotal: 2, total: 12,
    })
    expect(res.status).toBe(200)
    const inv = await w.load(res.json.invoice.id)
    expect(inv.cashSaleRef).toBeUndefined()
    expect(inv.lines[0].cashSaleLineId).toBeUndefined()
    expect((await w.stateOf(cs._id)).state).toBe('none')
  }, 60_000)
})

describe('concurrency and retries', () => {
  it('parallel conversions never invoice more than was sold, and leave no placeholder behind', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 5, 10]])
    const body = { contactId: String(w.customer._id), lines: [{ lineId: w.lineId(cs, 0), quantity: 2 }] }
    const answers = await Promise.all([1, 2, 3, 4].map(() => w.toInvoice(cs._id, body)))

    expect(answers.filter(a => a.status === 200)).toHaveLength(2)
    expect(answers.filter(a => a.status === 409)).toHaveLength(2)
    expect((await w.stateOf(cs._id)).lines[0]).toMatchObject({ invoiced: 4, remaining: 1 })
    expect(await Invoice.countDocuments({ orgId: w.orgId, invoiceNumber: /^~pending:/ }).exec()).toBe(0)
  }, 60_000)

  it('a retry with its key returns the same invoice; another body with the key is 422', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 4, 10]])
    const body = { contactId: String(w.customer._id), lines: [{ lineId: w.lineId(cs, 0), quantity: 1 }] }
    const first = await w.toInvoice(cs._id, body, 'cs-inv-key-01')
    const again = await w.toInvoice(cs._id, body, 'cs-inv-key-01')
    const other = await w.toInvoice(cs._id, { ...body, lines: [{ lineId: w.lineId(cs, 0), quantity: 2 }] }, 'cs-inv-key-01')

    expect(again.status).toBe(200)
    expect(again.json.invoice.id).toBe(first.json.invoice.id)
    expect(other.status).toBe(422)
    expect((await w.stateOf(cs._id)).lines[0].invoiced).toBe(1)
  }, 60_000)

  it('a crashed conversion is resumed by its retry; an unkeyed one stops holding once its lease lapses', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 2, 10]])
    const body = { contactId: String(w.customer._id) }
    const stuck = (extra: Record<string, any>) => Invoice.create({
      orgId: w.orgId, type: 'invoice', direction: 'outgoing', contactId: w.customer._id, status: 'draft',
      issueDate: new Date('2026-10-22'), dueDate: new Date('2026-10-22'), currency: 'EUR', exchangeRate: 1,
      lines: [{ productId: w.bolt._id, description: 'Болт М8', quantity: 2, unit: 'pcs', unitPrice: 10, taxRate: 20, taxAmount: 4, lineTotal: 24, cashSaleLineId: cs.lines[0]._id }],
      subtotal: 20, taxTotal: 4, total: 24, totalBase: 24,
      billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
      cashSaleRef: { cashSaleId: cs._id, number: cs.invoiceNumber, issueDate: cs.issueDate },
      stockSource: { marker: `cash_sale:${cs.invoiceNumber}`, docNumber: cs.invoiceNumber, movementIds: [], detectedBy: 'cash_sale', linkedAt: new Date() },
      leaseUntil: new Date(Date.now() - 1000), createdBy: w.user._id, ...extra,
    } as any)

    // Keyed: what the route leaves when it dies between the claim and the number.
    await stuck({ invoiceNumber: '~pending:cs-inv-key-02', clientKey: 'cs-inv-key-02', requestHash: requestHash(`invoice.toInvoice:${cs._id}`, body) })
    const resumed = await w.toInvoice(cs._id, body, 'cs-inv-key-02')
    expect(resumed.status).toBe(200)
    expect(resumed.json.invoice.invoiceNumber).toMatch(/^INV-/)
    expect(await Invoice.countDocuments({ orgId: w.orgId, 'cashSaleRef.cashSaleId': cs._id }).exec()).toBe(1)

    // Unkeyed: it never became a document, so it neither holds the sale nor lingers.
    await w.call('POST', `/${resumed.json.invoice.id}/void`)
    await stuck({ invoiceNumber: '~pending:dead-request' })
    const fresh = await w.toInvoice(cs._id, body)
    expect(fresh.status).toBe(200)
    expect(await Invoice.countDocuments({ orgId: w.orgId, invoiceNumber: /^~pending:/ }).exec()).toBe(0)
  }, 60_000)
})

describe('Files rollback', () => {
  it('will not roll back a cash sale while an invoice stands for it', async () => {
    const w = await world()
    const cs = await w.cashSale([[w.bolt, 2, 10]])
    const inv = (await w.toInvoice(cs._id, { contactId: String(w.customer._id) })).json.invoice
    const doc = await DocFile.create({
      orgId: w.org._id, docType: 'cash_register', docNumber: '20261020_200000', docDate: '2026-10-20',
      originalName: 'salesAnalysis_20261020_200000.xlsx', currentPath: '/nowhere', currentChecksum: 'x',
      mimeType: 'application/octet-stream', size: 1, uploadedBy: w.user._id, status: 'committed', committedIds: [cs._id],
      // Uploaded before it was committed, as every real one is — otherwise the plan calls it stale.
      uploadedAt: new Date(Date.now() - 3_600_000),
    } as any)

    const plan = await planDeleteDocFiles(w.orgId, [String(doc._id)], { rollback: true })
    expect(plan.plans[0].blocked).toContain(inv.invoiceNumber)
    expect(plan.plans[0].invoices[0].action).toBe('skip')
  }, 60_000)
})
