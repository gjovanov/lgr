import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { allowSalesWithoutPrinter, createTestOrg, createTestUser, createTestContact, createTestProduct, createTestWarehouse, createTestStockLevel } from '../helpers/factories'
import ExcelJS from 'exceljs'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { invoiceExportController } from 'invoicing-api/src/controllers/invoice-export.controller'
import { agingReportController } from 'invoicing-api/src/controllers/aging-report.controller'
import { contactController } from 'invoicing-api/src/controllers/contact.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { resolveDocPrefix } from 'services/biz/invoice-numbering.service'
import { getCurrentNumber, setDisplayPrefix } from 'services/biz/sequence.service'
import { getInvoiceSummary } from 'services/biz/invoice-summary.service'
import { getContactLedger } from 'services/biz/contact-ledger.service'
import { eventBus } from 'services/events/event-bus'
import { Invoice, StockLevel, StockMovement } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
// The offer is the body the offer form sends (`invoicing-ui` is a private app package).
import { buildPayload } from '../../../invoicing-ui/src/composables/document-form/document-payload'
import { DOCUMENT_CONFIGS } from '../../../invoicing-ui/src/composables/document-form/configs'

/**
 * The offer („оферта"): a quote like the proforma, laid out the same, in a series of its own — DRF-OFR
 * while a draft, OFR once issued. It is converted, once, into a proforma or straight into an invoice.
 *
 * ⚠ A quote is no sale (FR-22.22). Issued, it is `sent` with its total as amountDue, which is exactly
 * what every receivable reader counts: the dashboard, the aging, a contact's balance and ledger counted
 * every issued proforma never converted as owed. An offer, most of which are never accepted, would have
 * filled them. Each of those readers leaves the quotes out, and the ledger lists them without counting.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
const posted: any[] = []
let unsubscribe: () => void = () => {}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(invoiceController).use(invoiceExportController).use(agingReportController).use(contactController)
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
async function tokenFor(u: { id: string; orgId: string }) {
  return (signer as any).decorator.jwt.sign({
    id: u.id, orgId: u.orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Test', lastName: 'Admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
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

  async function request(method: string, path: string, body?: any) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}${path}`, {
      method,
      // No body, no content type: as a press that sends nothing does.
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }
  const call = (method: string, path: string, body?: any) => request(method, `/invoices${path}`, body)
  /** The list export, as the list's Export dialog asks for it: the file itself. */
  const exportList = (body: Record<string, any>) => app.handle(new Request(`http://localhost/org/${orgId}/invoicing/export/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ format: 'xlsx', mode: 'compact', ...body }),
  }))

  const line = (quantity = 5) => ({
    productId: String(product._id), description: product.name, quantity, unit: 'pcs',
    unitPrice: 40, discount: 10, taxRate: 20, warehouseId: String(warehouse._id),
  })
  /** A document of `type` for 5 pieces of a stocked article, as its form sends it. */
  async function make(docType: 'offer' | 'proforma' | 'invoice', extra: Record<string, any> = {}): Promise<string> {
    const res = await call('POST', '', {
      ...buildPayload({
        contactId, issueDate: '2026-10-26', validUntil: '2026-11-25', dueDate: '2026-11-25',
        paymentMethod: docType === 'invoice' ? 'bank_transfer' : 'card', currency: 'EUR', exchangeRate: 1,
        notes: 'Оферта за ремонта', terms: 'Валидна 30 дни', tags: ['ремонт'], placeOfTransaction: 'Пловдив',
        lines: [line()],
      }, DOCUMENT_CONFIGS[docType]),
      ...extra,
    })
    expect(res.status).toBe(200)
    return String(res.json.invoice.id)
  }
  const offer = (extra?: Record<string, any>) => make('offer', extra)
  const issued = async (id: string) => {
    const sent = await call('POST', `/${id}/send`, {})
    expect(sent.status).toBe(200)
    return sent.json.invoice
  }

  const stock = async () => Number((await StockLevel.findOne({ orgId, productId: product._id, warehouseId: warehouse._id }).lean().exec() as any)?.quantity)
  const movements = async (invoiceId: string) => StockMovement.countDocuments({ orgId, invoiceId }).exec()
  const load = async (id: string) => (await Invoice.findById(id).lean().exec()) as any
  return { orgId, contactId, request, call, exportList, make, offer, issued, stock, movements, load }
}

/** A workbook's sheet names (the export names its sheet by its title) and every cell's text. */
async function workbookText(res: Response): Promise<{ sheets: string[]; cells: string[] }> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await res.arrayBuffer())
  const sheets: string[] = []
  const cells: string[] = []
  wb.eachSheet((ws) => {
    sheets.push(ws.name)
    ws.eachRow((row) => row.eachCell((c) => { cells.push(String(c.text ?? '')) }))
  })
  return { sheets, cells }
}

describe('an offer has a series of its own: DRF-OFR, then OFR', () => {
  it('a new offer is a draft of the offer draft series, and no other series moves', async () => {
    const w = await world()
    const id = await w.offer()

    const doc = await w.load(id)
    expect(doc).toMatchObject({ type: 'offer', direction: 'outgoing', status: 'draft' })
    expect(await resolveDocPrefix(w.orgId, 'offer', 'outgoing', 'draft')).toBe('DRF-OFR')
    expect(doc.invoiceNumber).toBe(`DRF-OFR-${YEAR}-00001`)
    expect(await getCurrentNumber(w.orgId, 'DRAFT_OFR', YEAR)).toBe(1)
    for (const other of ['DRAFT_PRF', 'DRAFT_INV', 'OFFER', 'PROFORMA', 'SALES_DOC']) {
      expect({ other, at: await getCurrentNumber(w.orgId, other, YEAR) }).toEqual({ other, at: 0 })
    }
    // Its validity is kept as its dueDate, as a proforma's is (B-11).
    expect(new Date(doc.dueDate).toISOString().slice(0, 10)).toBe('2026-11-25')
  })

  it('issued, it takes the next OFR number; the proforma and sales series stay where they are', async () => {
    const w = await world()
    const id = await w.offer()
    const draft = await w.load(id)

    const sent = await w.issued(id)

    expect(sent.status).toBe('sent')
    expect(await resolveDocPrefix(w.orgId, 'offer', 'outgoing', 'issued')).toBe('OFR')
    expect(sent.invoiceNumber).toBe(`OFR-${YEAR}-00001`)
    expect(sent.draftNumber).toBe(draft.invoiceNumber)
    expect((await w.load(id)).numberHistory.map((h: any) => [h.number, h.status])).toEqual([
      [draft.invoiceNumber, 'draft'],
      [`OFR-${YEAR}-00001`, 'sent'],
    ])
    expect(await getCurrentNumber(w.orgId, 'OFFER', YEAR)).toBe(1)
    expect(await getCurrentNumber(w.orgId, 'PROFORMA', YEAR)).toBe(0)
    expect(await getCurrentNumber(w.orgId, 'SALES_DOC', YEAR)).toBe(0)
    // The next one follows on, and a proforma issued meanwhile keeps its own series.
    expect((await w.issued(await w.make('proforma'))).invoiceNumber).toBe(`PRF-${YEAR}-00001`)
    expect((await w.issued(await w.offer())).invoiceNumber).toBe(`OFR-${YEAR}-00002`)
  })

  it("an org renames its offer series on the sequences page, and the numbers follow", async () => {
    const w = await world()
    await setDisplayPrefix(w.orgId, 'DRAFT_OFR', 'ЧОФ')
    await setDisplayPrefix(w.orgId, 'OFFER', 'ОФ')

    const id = await w.offer()

    expect((await w.load(id)).invoiceNumber).toBe(`ЧОФ-${YEAR}-00001`)
    expect((await w.issued(id)).invoiceNumber).toBe(`ОФ-${YEAR}-00001`)
  })

  it('the form previews the next number of its own series', async () => {
    const w = await world()
    await w.offer()

    expect((await w.call('GET', '/peek-next?type=offer&direction=outgoing&status=draft')).json.next).toBe(`DRF-OFR-${YEAR}-00002`)
    expect((await w.call('GET', '/peek-next?type=offer&direction=outgoing')).json.next).toBe(`OFR-${YEAR}-00001`)
  })

  it("its list's Export gives the offers alone, under the offers' title", async () => {
    const w = await world()
    const issued = await w.issued(await w.offer())
    const draft = await w.load(await w.offer())
    const proforma = await w.issued(await w.make('proforma'))

    const res = await w.exportList({ docType: 'offer', locale: 'bg' })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('offer-compact-')
    const { sheets, cells } = await workbookText(res)
    expect(sheets).toEqual(['Оферти'])
    expect(cells).toContain(issued.invoiceNumber)
    expect(cells).toContain(draft.invoiceNumber)
    expect(cells).not.toContain(proforma.invoiceNumber)
    // And the proforma list's export holds no offer.
    const prf = await workbookText(await w.exportList({ docType: 'proforma', locale: 'bg' }))
    expect(prf.sheets).toEqual(['Проформи'])
    expect(prf.cells).toContain(proforma.invoiceNumber)
    expect(prf.cells).not.toContain(issued.invoiceNumber)
  })

  it('its list holds the offers alone, and the proforma list none of them', async () => {
    const w = await world()
    const offerId = await w.offer()
    const proformaId = await w.make('proforma')

    const offers = (await w.call('GET', '?type=offer')).json.invoices.map((i: any) => String(i.id ?? i._id))
    const proformas = (await w.call('GET', '?type=proforma')).json.invoices.map((i: any) => String(i.id ?? i._id))
    expect(offers).toEqual([offerId])
    expect(proformas).toEqual([proformaId])
  })
})

describe('an offer is no sale (FR-22.22)', () => {
  it('issuing it moves no stock, posts nothing and records no payment, whatever its method', async () => {
    const w = await world()
    const id = await w.offer()

    await w.issued(id)

    expect(await w.stock()).toBe(100)
    expect(await w.movements(id)).toBe(0)
    expect(posted.filter((p) => p.invoiceId === id)).toEqual([])
    // Its method is card: only an invoice is paid on issue.
    expect((await w.load(id)).payments).toEqual([])
  })

  it('voiding an issued offer moves no stock either', async () => {
    const w = await world()
    const id = await w.offer()
    await w.issued(id)

    const voided = await w.call('POST', `/${id}/void`, {})

    expect(voided.status).toBe(200)
    expect(voided.json.invoice.status).toBe('voided')
    expect(await w.stock()).toBe(100)
    expect(await w.movements(id)).toBe(0)
  })

  it('it takes no payment: the invoice it becomes does', async () => {
    const w = await world()
    const id = await w.offer()
    await w.issued(id)

    const paid = await w.call('POST', `/${id}/payments`, { date: '2026-10-26', amount: 10, method: 'bank_transfer' })

    expect(paid.status).toBe(422)
    expect(paid.json.code).toBe('quote_takes_no_payment')
    expect((await w.load(id)).payments).toEqual([])
  })

  it('nobody owes it: not in the outstanding total, the aging or a contact balance — nor an issued proforma', async () => {
    const w = await world()
    // An issued offer and an issued proforma are `sent`, their totals due; the invoice is the only debt.
    await w.issued(await w.offer())
    await w.issued(await w.make('proforma'))
    const invoice = await w.issued(await w.make('invoice'))
    const owed = Math.round(invoice.total * 100) / 100

    const summary = await getInvoiceSummary(w.orgId, { direction: 'outgoing' })
    expect(summary.outstanding).toEqual({ amount: owed, count: 1 })

    const aging = await w.request('GET', '/invoicing/reports/aging')
    expect(aging.status).toBe(200)
    expect(aging.json.data.map((r: any) => r.totalOutstanding)).toEqual([owed])

    const balance = await w.request('GET', `/invoicing/contact/${w.contactId}/summary`)
    expect(balance.status).toBe(200)
    expect(balance.json.openBalance).toBe(owed)
    // A type named by the caller is the caller's: the summary of the offers alone is theirs to ask for.
    expect((await getInvoiceSummary(w.orgId, { type: 'offer' })).outstanding.count).toBe(1)
  })

  it('the contact ledger lists the quotes, and counts only the sale in its totals', async () => {
    const w = await world()
    const offerId = await w.offer()
    await w.issued(offerId)
    const proformaId = await w.make('proforma')
    await w.issued(proformaId)
    const invoice = await w.issued(await w.make('invoice'))

    const ledger = await getContactLedger(w.orgId, w.contactId)

    expect(ledger.entries.map((e) => e.documentType).sort()).toEqual(['invoice', 'offer', 'proforma'])
    expect(+ledger.summary.totalSalesGross.toFixed(2)).toBe(+Number(invoice.total).toFixed(2))
    expect(+ledger.summary.totalSalesNet.toFixed(2)).toBe(+Number(invoice.subtotal).toFixed(2))
    // Filtered to the offers, it lists them and still counts nothing.
    const offersOnly = await getContactLedger(w.orgId, w.contactId, { documentTypes: ['offer'] })
    expect(offersOnly.entries.map((e) => e.documentId)).toEqual([offerId])
    expect(offersOnly.summary.totalSalesGross).toBe(0)
  })
})

describe('an offer is converted, once, into a proforma or an invoice', () => {
  it('into an invoice: a draft of the sales draft series that names the offer and carries the deal over', async () => {
    const w = await world()
    const id = await w.offer()
    await w.issued(id)
    const offer = await w.load(id)
    const salesBefore = await getCurrentNumber(w.orgId, 'SALES_DOC', YEAR)

    const conv = await w.call('POST', `/${id}/convert`, { target: 'invoice' })

    expect(conv.status).toBe(200)
    const inv = await w.load(conv.json.invoice.id)
    expect(inv).toMatchObject({
      type: 'invoice', direction: 'outgoing', status: 'draft', paymentMethod: 'card', placeOfTransaction: 'Пловдив',
      notes: offer.notes, terms: offer.terms, tags: ['ремонт'], subtotal: offer.subtotal, taxTotal: offer.taxTotal, total: offer.total,
    })
    expect(inv.invoiceNumber).toStartWith(`DRF-INV-${YEAR}-`)
    expect(String(inv.offerId)).toBe(id)
    expect(inv.proformaId).toBeUndefined()
    expect(new Date(inv.dueDate).toISOString().slice(0, 10)).toBe('2026-11-25')
    expect(inv.lines.map((l: any) => [l.quantity, l.unitPrice, l.discount])).toEqual(offer.lines.map((l: any) => [l.quantity, l.unitPrice, l.discount]))
    const after = await w.load(id)
    expect(after.status).toBe('converted')
    expect(String(after.convertedInvoiceId)).toBe(String(inv._id))
    expect(after.statusHistory.at(-1)).toMatchObject({ status: 'converted', fromStatus: 'sent', reason: `converted_to ${inv.invoiceNumber}` })
    // Converting moved nothing and drew no number of the sales series.
    expect(await getCurrentNumber(w.orgId, 'SALES_DOC', YEAR)).toBe(salesBefore)
    expect(await w.stock()).toBe(100)

    // The invoice is what sells: issued, it takes the next sales number, dispatches, and is paid by card (FR-22.19).
    const sent = await w.issued(String(inv._id))
    expect(sent.invoiceNumber).toBe(`INV-${YEAR}-00001`)
    expect(sent.status).toBe('paid')
    expect(await w.stock()).toBe(95)
  })

  it('into a proforma: a draft of the proforma draft series, which becomes an invoice still naming the offer', async () => {
    const w = await world()
    const id = await w.offer()
    const issuedOffer = await w.issued(id)

    const conv = await w.call('POST', `/${id}/convert`, { target: 'proforma' })

    expect(conv.status).toBe(200)
    const prfId = String(conv.json.invoice.id)
    const prf = await w.load(prfId)
    expect(prf).toMatchObject({ type: 'proforma', direction: 'outgoing', status: 'draft', paymentMethod: 'card', placeOfTransaction: 'Пловдив', tags: ['ремонт'] })
    expect(prf.invoiceNumber).toStartWith(`DRF-PRF-${YEAR}-`)
    expect(String(prf.offerId)).toBe(id)
    expect(new Date(prf.dueDate).toISOString().slice(0, 10)).toBe('2026-11-25')
    expect((await w.load(id)).status).toBe('converted')
    expect(await getCurrentNumber(w.orgId, 'PROFORMA', YEAR)).toBe(0)

    // The proforma goes on as every proforma does: issued from its series, then converted into an invoice.
    const issuedPrf = await w.issued(prfId)
    expect(issuedPrf.invoiceNumber).toBe(`PRF-${YEAR}-00001`)
    const inv = await w.call('POST', `/${prfId}/convert`, {})
    expect(inv.status).toBe(200)
    const invoice = await w.load(inv.json.invoice.id)
    expect(String(invoice.proformaId)).toBe(prfId)
    expect(String(invoice.offerId)).toBe(id)
    expect(await w.stock()).toBe(100)

    // The lists name the chain: what the offer became, and the offer a proforma came from.
    const offerRow = (await w.call('GET', '?type=offer')).json.invoices[0]
    expect(offerRow).toMatchObject({ status: 'converted', convertedInvoiceNumber: issuedPrf.invoiceNumber, convertedInvoiceType: 'proforma' })
    const prfRow = (await w.call('GET', '?type=proforma')).json.invoices[0]
    expect(prfRow).toMatchObject({ offerNumber: issuedOffer.invoiceNumber, convertedInvoiceType: 'invoice' })
    const invRow = (await w.call('GET', '?type=invoice')).json.invoices[0]
    expect(invRow).toMatchObject({ proformaNumber: issuedPrf.invoiceNumber, offerNumber: issuedOffer.invoiceNumber })
  })

  it('a draft offer converts too; the default target is the invoice', async () => {
    const w = await world()
    const id = await w.offer()

    const conv = await w.call('POST', `/${id}/convert`)

    expect(conv.status).toBe(200)
    expect(conv.json.invoice.type).toBe('invoice')
    expect((await w.load(id)).statusHistory.at(-1)).toMatchObject({ status: 'converted', fromStatus: 'draft' })
  })

  it('once: a converted offer converts no more, into either', async () => {
    const w = await world()
    const id = await w.offer()
    await w.issued(id)
    expect((await w.call('POST', `/${id}/convert`, { target: 'proforma' })).status).toBe(200)

    for (const target of ['proforma', 'invoice']) {
      const again = await w.call('POST', `/${id}/convert`, { target })
      expect({ target, status: again.status, code: again.json?.code }).toEqual({ target, status: 400, code: 'already_converted' })
    }
    expect(await Invoice.countDocuments({ orgId: w.orgId, offerId: id }).exec()).toBe(1)
  })

  it('⚠ two presses at once — „→ Проформа" and „→ Фактура" — make one document, and the offer names it', async () => {
    const w = await world()
    const id = await w.offer()
    await w.issued(id)

    const [a, b] = await Promise.all([
      w.call('POST', `/${id}/convert`, { target: 'proforma' }),
      w.call('POST', `/${id}/convert`, { target: 'invoice' }),
    ])

    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1)
    const loser = a.status === 200 ? b : a
    expect([400, 409]).toContain(loser.status)
    expect(loser.json.code).toBe('already_converted')
    const made = await Invoice.find({ orgId: w.orgId, offerId: id }).lean().exec()
    expect(made).toHaveLength(1)
    const now = await w.load(id)
    expect(now.status).toBe('converted')
    expect(String(now.convertedInvoiceId)).toBe(String(made[0]._id))
  })

  it('a voided offer converts into nothing — and since this change, neither does a voided proforma', async () => {
    const w = await world()
    for (const make of [() => w.offer(), () => w.make('proforma')]) {
      const id = await make()
      await w.issued(id)
      expect((await w.call('POST', `/${id}/void`, {})).status).toBe(200)

      const conv = await w.call('POST', `/${id}/convert`, {})

      expect({ status: conv.status, code: conv.json?.code }).toEqual({ status: 400, code: 'quote_withdrawn' })
    }
    expect(await Invoice.countDocuments({ orgId: w.orgId, type: 'invoice' }).exec()).toBe(0)
  })

  it('what is no quote, or a target a quote does not have, is refused and makes nothing', async () => {
    const w = await world()
    const invoiceId = await w.make('invoice')
    const proformaId = await w.make('proforma')
    const offerId = await w.offer()
    const before = await Invoice.countDocuments({ orgId: w.orgId }).exec()

    const notQuote = await w.call('POST', `/${invoiceId}/convert`, {})
    expect({ status: notQuote.status, code: notQuote.json?.code }).toEqual({ status: 400, code: 'not_a_quote' })
    const proformaIntoProforma = await w.call('POST', `/${proformaId}/convert`, { target: 'proforma' })
    expect({ status: proformaIntoProforma.status, code: proformaIntoProforma.json?.code }).toEqual({ status: 400, code: 'conversion_not_offered' })
    // A target no quote has is no body the route takes.
    expect((await w.call('POST', `/${offerId}/convert`, { target: 'credit_note' })).status).toBe(422)

    expect(await Invoice.countDocuments({ orgId: w.orgId }).exec()).toBe(before)
    expect((await w.load(offerId)).status).toBe('draft')
  })
})
