import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Types } from 'mongoose'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestProduct, createTestInvoice } from '../helpers/factories'
import { lastPricesForContact } from 'services/biz/last-price.service'

/**
 * #145 — "Продажна фактура: последна цена за клиент". The price a product was last SOLD at to
 * this customer: issued sales invoices and cash sales only, newest first, same currency, the
 * document being edited excluded.
 *
 * NOTE: no `.rejects` / `.resolves` (CLAUDE.md Known Issues).
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const day = (d: string) => new Date(`${d}T10:00:00Z`)
function line(productId: Types.ObjectId, unitPrice: number) {
  return { productId, description: 'Болт DIN 933 М8Х20', quantity: 1, unit: 'pcs', unitPrice, discount: 0, taxRate: 20, taxAmount: unitPrice * 0.2, lineTotal: unitPrice * 1.2 }
}

async function world() {
  const org = await createTestOrg()
  const customer = await createTestContact(org._id)
  const other = await createTestContact(org._id)
  const bolt = await createTestProduct(org._id, { name: 'Болт' } as any)
  const nut = await createTestProduct(org._id, { name: 'Гайка' } as any)
  const sold = (price: number, issueDate: string, extra: Record<string, any> = {}) =>
    createTestInvoice(org._id, (extra.contactId ?? customer._id) as any, {
      status: 'sent', issueDate: day(issueDate), lines: [line(bolt._id, price)], ...extra,
    } as any)
  return { org, customer, other, bolt, nut, sold, orgId: String(org._id), cid: String(customer._id), bid: String(bolt._id) }
}

describe('lastPricesForContact (#145)', () => {
  it('returns the price of the NEWEST issued sale to this customer', async () => {
    const w = await world()
    await w.sold(10, '2026-09-01', { invoiceNumber: 'INV-0001' })
    await w.sold(12.5, '2026-10-05', { invoiceNumber: 'INV-0002' })
    await w.sold(11, '2026-09-20', { invoiceNumber: 'INV-0003' })

    const p = await lastPricesForContact(w.orgId, w.cid, [w.bid])

    expect(p[w.bid].price).toBe(12.5)
    expect(p[w.bid].invoiceNumber).toBe('INV-0002')
  })

  it('ignores drafts, voided and cancelled documents, proformas and credit notes', async () => {
    const w = await world()
    await w.sold(10, '2026-09-01', { invoiceNumber: 'INV-REAL' })
    // All newer, all not a price that was actually charged:
    await w.sold(99, '2026-10-01', { status: 'draft' })
    await w.sold(98, '2026-10-02', { status: 'voided' })
    await w.sold(97, '2026-10-03', { status: 'cancelled' })
    await w.sold(96, '2026-10-04', { type: 'proforma' })
    await w.sold(95, '2026-10-05', { type: 'credit_note' })

    const p = await lastPricesForContact(w.orgId, w.cid, [w.bid])

    expect(p[w.bid].price).toBe(10)
    expect(p[w.bid].invoiceNumber).toBe('INV-REAL')
  })

  it('counts a cash sale, and a paid invoice', async () => {
    const w = await world()
    await w.sold(10, '2026-09-01', { status: 'paid' })
    await w.sold(14, '2026-09-10', { type: 'cash_sale', invoiceNumber: 'CS-0001', status: 'paid' })

    const p = await lastPricesForContact(w.orgId, w.cid, [w.bid])

    expect(p[w.bid]).toMatchObject({ price: 14, invoiceNumber: 'CS-0001' })
  })

  it("never answers with another customer's price, or a purchase", async () => {
    const w = await world()
    await w.sold(10, '2026-09-01')
    await w.sold(50, '2026-10-01', { contactId: w.other._id })
    await w.sold(40, '2026-10-02', { direction: 'incoming' })

    expect((await lastPricesForContact(w.orgId, w.cid, [w.bid]))[w.bid].price).toBe(10)
  })

  it('keeps to the currency asked for', async () => {
    const w = await world()
    await w.sold(10, '2026-09-01', { currency: 'EUR' })
    await w.sold(20, '2026-10-01', { currency: 'BGN' })

    expect((await lastPricesForContact(w.orgId, w.cid, [w.bid], { currency: 'EUR' }))[w.bid].price).toBe(10)
    expect((await lastPricesForContact(w.orgId, w.cid, [w.bid], { currency: 'BGN' }))[w.bid].price).toBe(20)
  })

  it('does not let the document being edited answer for itself', async () => {
    const w = await world()
    await w.sold(10, '2026-09-01')
    const editing = await w.sold(30, '2026-10-01')

    const p = await lastPricesForContact(w.orgId, w.cid, [w.bid], { excludeInvoiceId: String((editing as any)._id) })

    expect(p[w.bid].price).toBe(10)
  })

  it('answers per product, and leaves out products never sold to the customer', async () => {
    const w = await world()
    await createTestInvoice(w.org._id, w.customer._id, {
      status: 'sent', issueDate: day('2026-09-01'), lines: [line(w.bolt._id, 10), line(w.nut._id, 0.35)],
    } as any)
    const neverSold = await createTestProduct(w.org._id)

    const p = await lastPricesForContact(w.orgId, w.cid, [w.bid, String(w.nut._id), String(neverSold._id)])

    expect(p[w.bid].price).toBe(10)
    expect(p[String(w.nut._id)].price).toBe(0.35)
    expect(p[String(neverSold._id)]).toBeUndefined()
  })

  it('is empty, not an error, for nothing to look up or a malformed id', async () => {
    const w = await world()
    expect(await lastPricesForContact(w.orgId, w.cid, [])).toEqual({})
    expect(await lastPricesForContact(w.orgId, 'not-an-id', [w.bid])).toEqual({})
    expect(await lastPricesForContact(w.orgId, w.cid, ['nope'])).toEqual({})
  })
})
