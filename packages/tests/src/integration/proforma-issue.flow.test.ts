import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { allowSalesWithoutPrinter, createTestOrg, createTestUser, createTestContact, createTestProduct, createTestWarehouse, createTestStockLevel } from '../helpers/factories'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { emailRequestBlock } from 'invoicing-api/src/lib/email-guards'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { resolveDocPrefix } from 'services/biz/invoice-numbering.service'
import { getCurrentNumber } from 'services/biz/sequence.service'
import { eventBus } from 'services/events/event-bus'
import { Invoice, StockLevel, StockMovement } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
// The proforma is the body the proforma form sends (`invoicing-ui` is a private app package).
import { buildPayload } from '../../../invoicing-ui/src/composables/document-form/document-payload'
import { DOCUMENT_CONFIGS } from '../../../invoicing-ui/src/composables/document-form/configs'

/**
 * FR-22.22: a proforma can be issued. It takes its number from the proforma series — PRF-…, the
 * prefix the sequences registry names — and, once issued, it can be emailed. Converting it lands
 * on an invoice that carries over the payment method, place of deal, notes, tags and due date.
 *
 * ⚠ An offer is not a sale. Nothing issued a proforma before, and the issue route treated one as
 * a sales invoice: it DISPATCHED its lines and announced `invoice.posted` — a receivable, for an
 * offer the customer may never accept. Issuing, voiding and converting a proforma move no stock
 * and post nothing.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
const posted: any[] = []
let unsubscribe: () => void = () => {}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(invoiceController)
  unsubscribe = eventBus.on('invoice.posted', (p: any) => { posted.push(p) })
}, 60_000)

afterAll(async () => {
  unsubscribe()
  await teardownTestDB()
}, 60_000)

afterEach(async () => {
  posted.length = 0
  await clearCollections()
}, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const PERMISSIONS = DEFAULT_ROLE_PERMISSIONS.admin
async function tokenFor(u: { id: string; orgId: string }) {
  return (signer as any).decorator.jwt.sign({
    id: u.id, orgId: u.orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Test', lastName: 'Admin', permissions: PERMISSIONS, ownRecordsModules: [],
  })
}

const YEAR = new Date().getFullYear()

async function world() {
  const org = await createTestOrg()
  await allowSalesWithoutPrinter(org._id)
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const contact = await createTestContact(org._id)
  const contactId = String(contact._id)
  const token = await tokenFor({ id: String(user._id), orgId })
  const product = await createTestProduct(org._id, { sellingPrice: 40, taxRate: 20 })
  const warehouse = await createTestWarehouse(org._id, { isDefault: true })
  await createTestStockLevel(org._id, product._id, warehouse._id, { quantity: 100, availableQuantity: 100 })

  async function call(method: string, path: string, body?: any) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/invoices${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }

  /** A proforma for 5 pieces of a stocked article, as the proforma form sends it. */
  async function proforma(extra: Record<string, any> = {}): Promise<string> {
    const res = await call('POST', '', {
      ...buildPayload({
        contactId, issueDate: '2026-10-26', validUntil: '2026-11-25', paymentMethod: 'card', currency: 'EUR',
        exchangeRate: 1, notes: 'Доставка до обекта', terms: '', tags: ['ремонт'], placeOfTransaction: 'Пловдив',
        lines: [{
          productId: String(product._id), description: product.name, quantity: 5, unit: 'pcs',
          unitPrice: 40, discount: 0, taxRate: 20, warehouseId: String(warehouse._id),
        }],
      }, DOCUMENT_CONFIGS.proforma),
      ...extra,
    })
    expect(res.status).toBe(200)
    return String(res.json.invoice.id)
  }

  const stock = async () => Number((await StockLevel.findOne({ orgId, productId: product._id, warehouseId: warehouse._id }).lean().exec() as any)?.quantity)
  const movements = async (invoiceId: string) => StockMovement.countDocuments({ orgId, invoiceId }).exec()
  const load = async (id: string) => (await Invoice.findById(id).lean().exec()) as any
  return { orgId, userId: String(user._id), call, proforma, stock, movements, load }
}

describe('a proforma is issued from the proforma series (FR-22.22)', () => {
  it('it takes the next PRF number; the sales series does not move', async () => {
    const w = await world()
    const id = await w.proforma()
    const draft = await w.load(id)
    const salesBefore = await getCurrentNumber(w.orgId, 'SALES_DOC', YEAR)

    const sent = await w.call('POST', `/${id}/send`, {})

    expect(sent.status).toBe(200)
    expect(sent.json.invoice.status).toBe('sent')
    const prefix = await resolveDocPrefix(w.orgId, 'proforma', 'outgoing', 'issued')
    expect(sent.json.invoice.invoiceNumber).toBe(`${prefix}-${YEAR}-00001`)
    expect(sent.json.invoice.draftNumber).toBe(draft.invoiceNumber)
    expect(await getCurrentNumber(w.orgId, 'PROFORMA', YEAR)).toBe(1)
    expect(await getCurrentNumber(w.orgId, 'SALES_DOC', YEAR)).toBe(salesBefore)

    // The next one follows on.
    const second = await w.call('POST', `/${await w.proforma()}/send`, {})
    expect(second.json.invoice.invoiceNumber).toBe(`${prefix}-${YEAR}-00002`)
  })

  it('an offer is not a sale: issuing it moves no stock and posts nothing', async () => {
    const w = await world()
    const id = await w.proforma()

    await w.call('POST', `/${id}/send`, {})

    expect(await w.stock()).toBe(100)
    expect(await w.movements(id)).toBe(0)
    expect(posted.filter((p) => p.invoiceId === id)).toEqual([])
    // Nor is it paid on issue, whatever its method says: only a sales invoice is.
    expect((await w.load(id)).payments).toEqual([])
  })

  it('voiding an issued proforma moves no stock either', async () => {
    const w = await world()
    const id = await w.proforma()
    await w.call('POST', `/${id}/send`, {})

    const voided = await w.call('POST', `/${id}/void`, {})

    expect(voided.status).toBe(200)
    expect(voided.json.invoice.status).toBe('voided')
    expect(await w.stock()).toBe(100)
    expect(await w.movements(id)).toBe(0)
  })

  it('once issued it can be emailed; a draft still cannot', async () => {
    const w = await world()
    const id = await w.proforma()
    const user = { role: 'admin', permissions: PERMISSIONS }
    expect(emailRequestBlock({ user, to: 'client@example.com', invoice: await w.load(id) })?.status).toBe(422)

    await w.call('POST', `/${id}/send`, {})

    expect(emailRequestBlock({ user, to: 'client@example.com', invoice: await w.load(id) })).toBeNull()
  })
})

describe('converting a proforma carries the deal over (FR-22.22)', () => {
  it('the invoice keeps its payment method, place of deal, notes, tags and due date', async () => {
    const w = await world()
    const id = await w.proforma()
    await w.call('POST', `/${id}/send`, {})

    const conv = await w.call('POST', `/${id}/convert`, {})

    expect(conv.status).toBe(200)
    const inv = await w.load(conv.json.invoice.id)
    expect(inv).toMatchObject({
      type: 'invoice', status: 'draft', paymentMethod: 'card', placeOfTransaction: 'Пловдив',
      notes: 'Доставка до обекта', tags: ['ремонт'],
    })
    expect(new Date(inv.dueDate).toISOString().slice(0, 10)).toBe('2026-11-25')
    expect((await w.load(id)).status).toBe('converted')
    // Converting moved nothing: the invoice dispatches when it is issued.
    expect(await w.stock()).toBe(100)
  })

  it('a card proforma, converted and issued, is an invoice paid by card (FR-22.19)', async () => {
    const w = await world()
    const conv = await w.call('POST', `/${await w.proforma()}/convert`, {})

    const sent = await w.call('POST', `/${conv.json.invoice.id}/send`, {})

    expect(sent.status).toBe(200)
    expect(sent.json.invoice.status).toBe('paid')
    expect(sent.json.invoice.payments.map((p: any) => [p.method, p.amount])).toEqual([['card', 240]])
    // The INVOICE dispatches: 5 of the 100.
    expect(await w.stock()).toBe(95)
  })
})
