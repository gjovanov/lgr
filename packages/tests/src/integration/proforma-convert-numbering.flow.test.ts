import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { allowSalesWithoutPrinter, createTestOrg, createTestUser, createTestContact } from '../helpers/factories'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { resolveDocPrefix } from 'services/biz/invoice-numbering.service'
import { getCurrentNumber, setDisplayPrefix } from 'services/biz/sequence.service'
import { Invoice } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
// The form's own payload builder, reached by path (`invoicing-ui` is a private app package): the
// proforma below is the body the proforma form sends.
import { buildPayload } from '../../../invoicing-ui/src/composables/document-form/document-payload'
import { DOCUMENT_CONFIGS } from '../../../invoicing-ui/src/composables/document-form/configs'

/**
 * FR-22.3 (B-5): converting a proforma burned an invoice number. The converted DRAFT took a number
 * from the ISSUED sales series, issuing it took another, and the first was left on no document —
 * a gap in the series. The draft now takes a draft number, so convert + issue continues the
 * series with no gap.
 *
 * FR-22.9 (B-11): a proforma's validity is stored — as its dueDate, the field the model has.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(invoiceController)
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
const suffix = (number: string) => Number(number.match(/(\d+)$/)![1])

async function world() {
  const org = await createTestOrg()
  await allowSalesWithoutPrinter(org._id)
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const contact = await createTestContact(org._id)
  const contactId = String(contact._id)
  const token = await tokenFor({ id: String(user._id), orgId })

  async function call(method: string, path: string, body?: any) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/invoices${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }

  // Free-text lines move no stock, so issuing needs no warehouse set-up.
  const lines = [{ description: 'Монтаж', quantity: 2, unit: 'pcs', unitPrice: 50, discount: 0, taxRate: 20 }]

  /** A sales invoice issued the ordinary way — the number the series is at. */
  async function issuedInvoice(): Promise<string> {
    const created = await call('POST', '', buildPayload({
      contactId, issueDate: '2026-10-20', dueDate: '2026-11-19', currency: 'EUR', exchangeRate: 1, tags: [], lines,
    }, DOCUMENT_CONFIGS.invoice))
    expect(created.status).toBe(200)
    const sent = await call('POST', `/${created.json.invoice.id}/send`, {})
    expect(sent.status).toBe(200)
    return sent.json.invoice.invoiceNumber
  }

  async function proforma(validUntil = '2026-11-30'): Promise<string> {
    const res = await call('POST', '', buildPayload({
      contactId, issueDate: '2026-10-20', validUntil, paymentMethod: 'card', currency: 'EUR', exchangeRate: 1,
      notes: '', terms: '', tags: [], lines,
    }, DOCUMENT_CONFIGS.proforma))
    expect(res.status).toBe(200)
    return String(res.json.invoice.id)
  }

  const load = async (id: string) => (await Invoice.findById(id).lean().exec()) as any
  return { orgId, call, issuedInvoice, proforma, load }
}

describe('converting a proforma burns no invoice number (FR-22.3)', () => {
  it('the converted invoice is a draft with a DRAFT number; the issued series does not move', async () => {
    const w = await world()
    await w.issuedInvoice()
    const counterBefore = await getCurrentNumber(w.orgId, 'SALES_DOC', YEAR)

    const conv = await w.call('POST', `/${await w.proforma()}/convert`, {})

    expect(conv.status).toBe(200)
    const draft = conv.json.invoice
    expect(draft.status).toBe('draft')
    const draftPrefix = await resolveDocPrefix(w.orgId, 'invoice', 'outgoing', 'draft')
    expect(draft.invoiceNumber).toStartWith(`${draftPrefix}-${YEAR}-`)
    expect(await getCurrentNumber(w.orgId, 'SALES_DOC', YEAR)).toBe(counterBefore)
    expect((await w.load(draft.id)).numberHistory).toEqual([
      expect.objectContaining({ number: draft.invoiceNumber, status: 'draft' }),
    ])
  })

  it('convert + issue continues the sales series with no gap', async () => {
    const w = await world()
    const previous = await w.issuedInvoice()
    const conv = await w.call('POST', `/${await w.proforma()}/convert`, {})
    const draftNumber = conv.json.invoice.invoiceNumber

    const sent = await w.call('POST', `/${conv.json.invoice.id}/send`, {})

    expect(sent.status).toBe(200)
    const issued = sent.json.invoice
    expect(suffix(issued.invoiceNumber)).toBe(suffix(previous) + 1)
    expect(issued.draftNumber).toBe(draftNumber)
    expect((await w.load(issued.id)).numberHistory.map((h: any) => [h.number, h.status])).toEqual([
      [draftNumber, 'draft'],
      [issued.invoiceNumber, 'sent'],
    ])
    // And the next invoice issued the ordinary way follows on from it.
    expect(suffix(await w.issuedInvoice())).toBe(suffix(previous) + 2)
  })

  it("the draft number takes the org's own prefix for drafts, from the sequences configuration", async () => {
    const w = await world()
    await setDisplayPrefix(w.orgId, 'DRAFT_INV', 'ЧЕРН')

    const conv = await w.call('POST', `/${await w.proforma()}/convert`, {})

    expect(conv.status).toBe(200)
    expect(conv.json.invoice.invoiceNumber).toStartWith(`ЧЕРН-${YEAR}-`)
  })

  it('the proforma is marked converted and points at the draft', async () => {
    const w = await world()
    const id = await w.proforma()
    const conv = await w.call('POST', `/${id}/convert`, {})
    const prf = await w.load(id)
    expect(prf.status).toBe('converted')
    expect(String(prf.convertedInvoiceId)).toBe(conv.json.invoice.id)
    expect(String((await w.load(conv.json.invoice.id)).proformaId)).toBe(id)
  })
})

describe("a proforma's validity is stored (FR-22.9)", () => {
  it('the date on the form is the date stored — it used to be the issue date', async () => {
    const w = await world()
    const id = await w.proforma('2026-11-30')
    const stored = await w.load(id)
    expect(new Date(stored.dueDate).toISOString().slice(0, 10)).toBe('2026-11-30')
    // …and the list, which reads `dueDate` for its „Валидна до" column, shows it.
    const listed = await w.call('GET', '?type=proforma')
    expect(listed.json.invoices.find((i: any) => String(i._id ?? i.id) === id).dueDate.slice(0, 10)).toBe('2026-11-30')
  })

  it('converting carries it over as the invoice due date', async () => {
    const w = await world()
    const conv = await w.call('POST', `/${await w.proforma('2026-11-30')}/convert`, {})
    expect(new Date((await w.load(conv.json.invoice.id)).dueDate).toISOString().slice(0, 10)).toBe('2026-11-30')
  })
})
