import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestProduct } from '../helpers/factories'
import { internalOrderController } from 'invoicing-api/src/controllers/internal-order.controller'
import { customerOrderCtx, renderInternalOrderPdf } from 'invoicing-api/src/lib/internal-order-pdf'
import { buildCustomerOrderMarkdown } from 'reporting/pdf/customer-order.pdf'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { tokenize } from 'services/biz/auth.service'
import { forgetMember, forgetRole } from 'services/biz/access/live'
import { InternalOrder, Org, Role, User } from 'db/models'
import { config } from 'config'
import { withImplied } from 'config/access'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * The customer order's printed sheet: `renderInternalOrderPdf` (the one function the route and an
 * e-mail's attachment both call) and `GET /invoicing/internal-orders/:id/export`.
 *
 * What the page says is `unit/customer-order-sheet.test.ts`; here it is what the sheet is built
 * FROM (this org's records and no other's), that a PDF comes out under the order's number, that
 * another org's id is 404, and who the route answers.
 *
 * Driven over HTTP through the real controller. NOTE: no `.rejects` / `.resolves` (Bun-on-Windows
 * deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(internalOrderController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string }) {
  return (signer as any).decorator.jwt.sign({
    id: u.id, orgId: u.orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Мария', lastName: 'Иванова', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}

const isPdf = (bytes: Buffer | Uint8Array) => Buffer.from(bytes).subarray(0, 4).toString() === '%PDF'

/** An org with its own client, two articles and an admin; `order()` stores a customer order of both articles. */
async function world(name = 'ПРОБА ООД') {
  const org = await createTestOrg({ name, taxNumber: '123456786', vatNumber: 'BG123456786', email: 'office@proba.test', phone: '+359 2 000 0000' } as any)
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const client = await createTestContact(org._id, {
    companyName: 'Клиент Едно ЕООД', type: 'customer', taxId: '987654321', vatNumber: 'BG987654321', email: 'orders@klient.test', phone: '+359 88 000 0000',
  } as any)
  // Prices no quantity, date or number of the fixture repeats: none may reach the sheet.
  const bolt = await createTestProduct(org._id, { sku: 'TST-00001', name: 'ВИНТ М8Х25 - DIN 933', unit: 'pcs', sellingPrice: 7.31, purchasePrice: 4.57 } as any)
  const nut = await createTestProduct(org._id, { sku: 'TST-00002', name: 'ГАЙКА М8 - DIN 934', unit: 'kg', sellingPrice: 61.07, purchasePrice: 38.93 } as any)
  const token = await tokenFor({ id: String(user._id), orgId })

  async function order(over: Record<string, any> = {}) {
    return InternalOrder.create({
      orgId: org._id,
      orderNumber: 'ORDI-2026-00042',
      status: 'confirmed',
      statusHistory: [{ status: 'confirmed', changedAt: new Date() }],
      contactId: client._id,
      issueDate: new Date('2026-11-16T00:00:00Z'),
      requestedDeliveryDate: new Date('2026-11-20T00:00:00Z'),
      priority: 'normal',
      currency: 'EUR',
      exchangeRate: 1,
      lines: [
        { productId: bolt._id, description: 'Болт по поръчка', sku: 'CL-77', quantity: 1000, unit: 'pcs', expectedUnitPrice: 7.31, pricePinned: true, taxRate: 20 },
        // The line carries no SKU of its own: the article's is printed.
        { productId: nut._id, description: nut.name, quantity: 2.5, unit: 'kg', expectedUnitPrice: 61.07, taxRate: 20 },
      ],
      notes: 'Доставка до обяд',
      createdBy: user._id,
      ...over,
    } as any) as Promise<any>
  }

  const raw = (path: string, as: string | null = token) => app.handle(new Request(`http://localhost/org/${orgId}${path}`, {
    headers: as ? { authorization: `Bearer ${as}` } : {},
  }))
  const exportOf = (id: unknown, as: string | null = token, locale = 'bg') => raw(`/invoicing/internal-orders/${id}/export?locale=${locale}`, as)

  return { org, orgId, user, client, bolt, nut, token, order, raw, exportOf }
}

/** A member whose role holds exactly `caps` (FR-27), and the token they sign in with. */
async function memberWith(w: Awaited<ReturnType<typeof world>>, name: string, caps: string[]) {
  await Org.updateOne({ _id: w.org._id }, { $set: { 'settings.access.model': 'roles' } }).exec()
  const role: any = await Role.create({
    orgId: w.org._id, name, isBuiltin: false, edited: true, version: 1,
    legacy: { role: 'member', permissions: ['invoicing.read'] },
    caps: withImplied(caps as any),
  } as any)
  const member = await createTestUser(w.org._id, { role: 'member', username: name, email: `${name}@ordi-print.test` } as any)
  await User.updateOne({ _id: member._id }, { $set: { roleId: role._id } }).exec()
  forgetMember(member._id)
  forgetRole(role._id)
  return (signer as any).decorator.jwt.sign(await tokenize((await User.findById(member._id).exec())!)) as Promise<string>
}

describe('renderInternalOrderPdf', () => {
  it('an order of the org: a PDF, named by the order\'s number, with the order it printed', async () => {
    const w = await world()
    const ordi = await w.order()
    const result = await renderInternalOrderPdf(w.orgId, String(ordi._id), { locale: 'bg' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(isPdf(result.buffer)).toBe(true)
    // A header and nothing else is 9 bytes; a page of text is thousands.
    expect(result.buffer.length).toBeGreaterThan(5_000)
    expect(result.filename).toBe('ORDI-2026-00042.pdf')
    expect(String(result.order._id)).toBe(String(ordi._id))
    expect(result.order.orderNumber).toBe('ORDI-2026-00042')

    // No locale named: it still prints (in English).
    const plain = await renderInternalOrderPdf(w.orgId, String(ordi._id))
    expect(plain.ok && isPdf(plain.buffer)).toBe(true)
    // Printing changed nothing on the order.
    const after: any = await InternalOrder.findById(ordi._id).lean().exec()
    expect(String(after.updatedAt)).toBe(String(ordi.updatedAt))
  }, 120_000)

  it('a draft prints too, under the number it has', async () => {
    const w = await world()
    const draft = await w.order({ status: 'draft', orderNumber: 'DRF-ORDI-2026-00007' })
    const result = await renderInternalOrderPdf(w.orgId, String(draft._id), { locale: 'bg' })
    expect(result.ok && isPdf(result.buffer)).toBe(true)
    expect(result.ok && result.filename).toBe('DRF-ORDI-2026-00007.pdf')
  }, 120_000)

  it('an id that is not an order of this org is 404: another org\'s, an unknown one, a malformed one', async () => {
    const mine = await world()
    const theirs = await world('ДРУГА ЕООД')
    const foreign = await theirs.order({ orderNumber: 'ORDI-2026-00099' })

    for (const id of [String(foreign._id), '0123456789abcdef01234567', 'not-an-id', '']) {
      const result = await renderInternalOrderPdf(mine.orgId, id, { locale: 'bg' })
      expect({ id, ...result }).toEqual({ id, ok: false, status: 404, message: 'Incoming order not found' })
    }
    // A malformed org is nobody's order either, not a server error.
    expect(await renderInternalOrderPdf('nobody', String(foreign._id))).toMatchObject({ ok: false, status: 404 })
    // Its own org prints it.
    const own = await renderInternalOrderPdf(theirs.orgId, String(foreign._id), { locale: 'bg' })
    expect(own.ok && own.filename).toBe('ORDI-2026-00099.pdf')
  }, 120_000)
})

describe('what the sheet is built from', () => {
  it('the org as the supplier, the contact as the customer, each line\'s own words before its article\'s', async () => {
    const w = await world()
    const ordi: any = (await w.order()).toObject()
    const ctx = await customerOrderCtx(w.orgId, ordi, 'bg')
    expect(ctx.org).toEqual({ name: 'ПРОБА ООД', taxId: '123456786', vatId: 'BG123456786', email: 'office@proba.test', phone: '+359 2 000 0000' })
    expect(ctx.customer).toEqual({ name: 'Клиент Едно ЕООД', taxId: '987654321', vatId: 'BG987654321', email: 'orders@klient.test', phone: '+359 88 000 0000' })

    const text = buildCustomerOrderMarkdown(ctx)
    expect(text).toContain('# ПОТВЪРЖДЕНИЕ НА ПОРЪЧКА')
    expect(text).toContain('**Поръчка №** ORDI-2026-00042')
    expect(text).toContain('| 1 | Болт по поръчка | <span class="one-line">CL-77</span> | 1000 | БР. |')
    expect(text).toContain('| 2 | ГАЙКА М8 - DIN 934 | <span class="one-line">TST-00002</span> | 2.5 | КГ. |')
    expect(text).toContain('**Бележки:** Доставка до обяд')
    // The order's prices and its articles' prices: none of them, nor a currency.
    for (const figure of ['7.31', '61.07', '4.57', '38.93', '7310', '152.6', 'EUR', '€']) {
      expect({ figure, printed: text.includes(figure) }).toEqual({ figure, printed: false })
    }
  }, 60_000)

  it('a person as the customer, by name; the numbers a contact keeps elsewhere', async () => {
    const w = await world()
    const person = await createTestContact(w.org._id, {
      companyName: '', firstName: 'Иван', lastName: 'Петров', type: 'customer', taxNumber: '111222333', email: '', phone: '', mobile: '0888 000 000',
    } as any)
    const ordi: any = (await w.order({ contactId: person._id })).toObject()
    expect((await customerOrderCtx(w.orgId, ordi, 'bg')).customer).toMatchObject({ name: 'Иван Петров', taxId: '111222333', phone: '0888 000 000' })
  }, 60_000)

  it('a contact or an article of another org is not read: the sheet names neither', async () => {
    const w = await world()
    const other = await world('ДРУГА ЕООД')
    const ordi: any = (await w.order({
      contactId: other.client._id,
      lines: [{ productId: other.nut._id, description: 'Ред с чужд артикул', quantity: 3, unit: 'pcs' }],
    })).toObject()
    const ctx = await customerOrderCtx(w.orgId, ordi, 'bg')
    expect(ctx.customer.name).toBe('')
    expect(ctx.productInfo).toEqual({})
    const text = buildCustomerOrderMarkdown(ctx)
    expect(text).not.toContain('Клиент Едно')
    expect(text).not.toContain('TST-00002')
    expect(text).toContain('| 1 | Ред с чужд артикул |  | 3 | БР. |')
  }, 60_000)

  it('the foot names the org\'s own day, not the server\'s', async () => {
    const w = await world()
    const ordi: any = (await w.order()).toObject()
    const dayIn = async (timezone: string) => {
      await Org.updateOne({ _id: w.org._id }, { $set: { 'settings.timezone': timezone } }).exec()
      return (await customerOrderCtx(w.orgId, ordi, 'bg')).generatedAt!
    }
    // UTC+14 and UTC-12 are 26 hours apart: at no instant do they share a calendar day.
    const [ahead, behind] = [await dayIn('Pacific/Kiritimati'), await dayIn('Etc/GMT+12')]
    expect(ahead.toISOString()).toMatch(/T00:00:00\.000Z$/)
    expect(behind.toISOString()).toMatch(/T00:00:00\.000Z$/)
    expect((ahead.getTime() - behind.getTime()) / 86_400_000).toBeGreaterThanOrEqual(1)
    // A zone nobody can read falls back to UTC instead of failing the print.
    const utc = await dayIn('Nowhere/Nothing')
    expect(Math.abs(utc.getTime() - Date.now())).toBeLessThan(2 * 86_400_000)
  }, 60_000)
})

describe('GET /invoicing/internal-orders/:id/export', () => {
  it('answers the PDF as a download named by the order\'s number', async () => {
    const w = await world()
    const ordi = await w.order()
    const res = await w.exportOf(ordi._id)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="ORDI-2026-00042.pdf"')
    expect(isPdf(Buffer.from(await res.arrayBuffer()))).toBe(true)

    // A language there is no page for, one named twice, none named: the sheet all the same.
    for (const query of ['?locale=xx', '?locale=bg&locale=de', '']) {
      const odd = await w.raw(`/invoicing/internal-orders/${ordi._id}/export${query}`)
      expect({ query, status: odd.status }).toEqual({ query, status: 200 })
      expect(isPdf(Buffer.from(await odd.arrayBuffer()))).toBe(true)
    }
  }, 120_000)

  it('nobody signed in: 401; an id that is not this org\'s order: 404', async () => {
    const w = await world()
    const other = await world('ДРУГА ЕООД')
    const ordi = await w.order()
    const foreign = await other.order({ orderNumber: 'ORDI-2026-00099' })

    expect((await w.exportOf(ordi._id, null)).status).toBe(401)
    for (const id of [foreign._id, '0123456789abcdef01234567', 'not-an-id']) {
      const res = await w.exportOf(id)
      expect({ id: String(id), status: res.status }).toEqual({ id: String(id), status: 404 })
      expect(await res.json()).toEqual({ message: 'Incoming order not found' })
    }
    // Another org's session on this org's address is stopped by the tenant guard, before the order is looked for.
    expect((await w.exportOf(ordi._id, other.token)).status).toBe(403)
  }, 120_000)

  it('a role that reads orders but may not export is refused; one that may export prints', async () => {
    const w = await world()
    const ordi = await w.order()

    const reader = await memberWith(w, 'orders-reader', ['orders.view'])
    // It opens the order...
    expect((await w.raw(`/invoicing/internal-orders/${ordi._id}`, reader)).status).toBe(200)
    // ...and is not handed its sheet.
    const refused = await w.exportOf(ordi._id, reader)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ message: 'Forbidden' })

    const printer = await memberWith(w, 'orders-printer', ['orders.view', 'sales-docs.export'])
    const printed = await w.exportOf(ordi._id, printer)
    expect(printed.status).toBe(200)
    expect(isPdf(Buffer.from(await printed.arrayBuffer()))).toBe(true)

    // A role with the export but no orders does not reach the route at all.
    const outsider = await memberWith(w, 'no-orders', ['sales-docs.view', 'sales-docs.export'])
    expect((await w.exportOf(ordi._id, outsider)).status).toBe(403)
  }, 180_000)
})
