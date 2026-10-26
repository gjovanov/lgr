import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { captureRejection } from '../helpers/capture-rejection'
import {
  createTestOrg, createTestUser, createTestContact, createTestProduct, createTestWarehouse, createTestStockLevel,
} from '../helpers/factories'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { stockAvailabilityController } from 'invoicing-api/src/controllers/stock-availability.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { getCurrentNumber } from 'services/biz/sequence.service'
import { Invoice, StockLevel } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
// The UI's own modules, reached by path (`invoicing-ui` is a private app package): the issue
// requests the list and the document form both make, and the form's payload and note prefill.
import { createTransfers, prepareIssue, sendIssue, type IssueClient } from '../../../invoicing-ui/src/composables/document-issue'
import { buildPayload, noteFromInvoice } from '../../../invoicing-ui/src/composables/document-form/document-payload'
import { DOCUMENT_CONFIGS } from '../../../invoicing-ui/src/composables/document-form/configs'

/**
 * FR-22 slice 2a — the document form issues, and starts a note from an invoice.
 *
 * FR-22.17: issuing from the form takes exactly the list's path: the document as stored, the
 * availability check for its stocked lines, the transfer the check proposes when a warehouse is
 * short, then `/send`. The requests are one module (`invoicing-ui/composables/document-issue`),
 * which the list and the form both call — and this test calls it against the real routes.
 * FR-22 §5.2: an issue the server refuses leaves the draft a draft — no number burned.
 *
 * FR-22.21: „Кредитно известие" / „Дебитно известие" on an issued invoice opens a note that
 * starts as the invoice (`noteFromInvoice`); the note the form then saves is one the API takes,
 * and it corrects what was charged, in the currency it was charged in.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(invoiceController).use(stockAvailabilityController)
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

afterEach(async () => {
  await clearCollections()
}, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string }) {
  return (signer as any).decorator.jwt.sign({
    id: u.id, orgId: u.orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Test', lastName: 'Admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}

const YEAR = new Date().getFullYear()

/** The routes behind an axios-shaped client: a refusal rejects with `{ response: { status, data } }`, as axios does. */
function clientFor(token: string): IssueClient {
  async function call(method: string, url: string, body?: any, headers: Record<string, string> = {}) {
    const res = await app.handle(new Request(`http://localhost${url}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    const data = await res.json().catch(() => null)
    if (res.status >= 400) throw Object.assign(new Error(data?.message || `HTTP ${res.status}`), { response: { status: res.status, data } })
    return { data }
  }
  return {
    get: (url) => call('GET', url),
    post: (url, body, cfg) => call('POST', url, body ?? {}, cfg?.headers),
  }
}

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const orgUrl = `/org/${orgId}`
  const user = await createTestUser(org._id)
  const contact = await createTestContact(org._id)
  const contactId = String(contact._id)
  const client = clientFor(await tokenFor({ id: String(user._id), orgId }))
  const product = await createTestProduct(org._id, { sellingPrice: 50, taxRate: 20 })
  const store = await createTestWarehouse(org._id, { name: 'Магазин', code: 'ST', isDefault: true })
  const depot = await createTestWarehouse(org._id, { name: 'Склад', code: 'DP' })
  await createTestStockLevel(org._id, product._id, store._id, { quantity: 2, availableQuantity: 2 })
  await createTestStockLevel(org._id, product._id, depot._id, { quantity: 50, availableQuantity: 50 })

  /** A document as its form sends it: `quantity` of the stocked article, from the store. */
  async function draft(configKey: keyof typeof DOCUMENT_CONFIGS, quantity: number, extra: Record<string, any> = {}): Promise<string> {
    const { data } = await client.post(`${orgUrl}/invoices`, buildPayload({
      contactId, issueDate: '2026-10-26', dueDate: '2026-11-25', validUntil: '2026-11-25', paymentMethod: 'bank_transfer',
      currency: 'EUR', exchangeRate: 1, notes: '', terms: '', tags: [],
      lines: [{
        productId: String(product._id), description: product.name, quantity, unit: 'pcs',
        unitPrice: 50, discount: 0, taxRate: 20, warehouseId: String(store._id),
      }],
      ...extra,
    }, DOCUMENT_CONFIGS[configKey]))
    return String(data.invoice.id)
  }

  const level = async (wh: any) => Number((await StockLevel.findOne({ orgId, productId: product._id, warehouseId: wh._id }).lean().exec() as any).quantity)
  const load = async (id: string) => (await Invoice.findById(id).lean().exec()) as any
  return { orgId, orgUrl, client, contactId, store, depot, draft, level, load }
}

describe("issuing from the form takes the list's path (FR-22.17)", () => {
  it('a short warehouse holds the issue back with a transfer proposal; confirming it issues the document', async () => {
    const w = await world()
    const id = await w.draft('invoice', 5)

    const { invoice, check } = await prepareIssue(w.client, w.orgUrl, id)

    expect(invoice.status).toBe('draft')
    expect(check).toMatchObject({ sufficient: false, allResolvable: true })
    expect(check!.proposals[0].sources[0]).toMatchObject({ fromWarehouseId: String(w.depot._id), transferQuantity: 3 })
    // Nothing is issued while the transfer is being decided.
    expect((await w.load(id)).status).toBe('draft')

    const transferIds = await createTransfers(w.client, w.orgUrl, check!.proposals)
    const issued = await sendIssue(w.client, w.orgUrl, id, { pendingTransferIds: transferIds })

    expect(issued.status).toBe('sent')
    expect(issued.invoiceNumber).toBe(`INV-${YEAR}-00001`)
    expect(await w.level(w.store)).toBe(0) // 2 + 3 transferred − 5 sold
    expect(await w.level(w.depot)).toBe(47)
  })

  it('with the stock there, it asks nothing more and issues from the sales series', async () => {
    const w = await world()
    const id = await w.draft('invoice', 2)

    const { check } = await prepareIssue(w.client, w.orgUrl, id)
    expect(check).toBeNull()
    const issued = await sendIssue(w.client, w.orgUrl, id)

    expect(issued).toMatchObject({ status: 'sent', invoiceNumber: `INV-${YEAR}-00001` })
    expect(await w.level(w.store)).toBe(0)
  })

  it('a proforma is issued without a stock check, and moves nothing (FR-22.22)', async () => {
    const w = await world()
    const id = await w.draft('proforma', 40)

    const { check } = await prepareIssue(w.client, w.orgUrl, id)
    expect(check).toBeNull()
    const issued = await sendIssue(w.client, w.orgUrl, id)

    expect(issued.status).toBe('sent')
    expect(issued.invoiceNumber).toStartWith('PRF-')
    expect(await w.level(w.store)).toBe(2)
  })

  it('refused (§5.2): the document stays a draft, says why, and no number is burned', async () => {
    const w = await world()
    const id = await w.draft('invoice', 5)

    // Issued past the check — what a stale form would do: the server refuses it whole.
    const err = await captureRejection(sendIssue(w.client, w.orgUrl, id))

    expect(err?.response?.status).toBe(400)
    expect(String(err?.response?.data?.message)).toContain('Insufficient stock')
    const doc = await w.load(id)
    expect(doc.status).toBe('draft')
    expect(doc.invoiceNumber).toStartWith('DRF-')
    expect(await getCurrentNumber(w.orgId, 'SALES_DOC', YEAR)).toBe(0)
    // …and it can be issued again once the stock is there.
    expect((await prepareIssue(w.client, w.orgUrl, id)).check).not.toBeNull()
  })
})

describe('a note started from the invoice it corrects (FR-22.21)', () => {
  /** An issued USD invoice: 3 boxes at 10 % off, paid by card. */
  async function issuedInvoice(w: Awaited<ReturnType<typeof world>>) {
    const id = await w.draft('invoice', 2, {
      currency: 'USD', exchangeRate: 0.92, paymentMethod: 'card',
      lines: [
        { description: 'Кутия болтове М8', quantity: 3, unit: 'box', unitPrice: 68, discount: 10, taxRate: 20 },
        { description: 'Монтаж', quantity: 1, unit: 'pcs', unitPrice: 50, discount: 0, taxRate: 20 },
      ],
    })
    await sendIssue(w.client, w.orgUrl, id)
    // The note's form reads the invoice through the API, as the edit form does.
    return (await w.client.get(`${w.orgUrl}/invoices/${id}`)).data.invoice
  }

  for (const type of ['credit_note', 'debit_note'] as const) {
    it(`a ${type.replace('_', ' ')} starts as the invoice, and the API takes it`, async () => {
      const w = await world()
      const invoice = await issuedInvoice(w)

      const start = noteFromInvoice(invoice)
      expect(start).toMatchObject({
        contactId: w.contactId, relatedInvoiceId: String(invoice.id), currency: 'USD', exchangeRate: 0.92, paymentMethod: 'card',
      })
      // The user keeps one box of the three.
      const { data } = await w.client.post(`${w.orgUrl}/invoices`, buildPayload({
        ...start, issueDate: '2026-10-27', dueDate: '2026-11-26', reason: 'Върната стока', tags: [],
        lines: [{ ...start.lines[0], quantity: 1 }],
      }, DOCUMENT_CONFIGS[type]))
      const issued = await sendIssue(w.client, w.orgUrl, String(data.invoice.id))

      expect(issued).toMatchObject({ type, status: 'sent', currency: 'USD', exchangeRate: 0.92, paymentMethod: 'card' })
      expect(String(issued.relatedInvoiceId)).toBe(String(invoice.id))
      expect(String(issued.contactId)).toBe(w.contactId)
      expect(issued.lines).toHaveLength(1)
      expect(issued.lines[0]).toMatchObject({ quantity: 1, unit: 'box', unitPrice: 68, discount: 10 })
      // 68 less 10 %, + 20 % VAT — what one box was charged.
      expect(issued.total).toBe(73.44)
    })
  }
})
