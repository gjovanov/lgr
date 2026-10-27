import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestContact, createTestOrg, createTestProduct, createTestStockLevel, createTestUser, createTestWarehouse } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import { AuditLog, INVOICE_NUMBER_KEY, Invoice, StockLevel, StockMovement } from 'db/models'
import { invoiceNumberClash } from 'migrations/migrations/0010-invoice-number-clash'
import { laterOf, listNumberClashes, prepareClashCorrection } from 'services/biz/number-clash.service'
import { createInvoiceStockMovement } from 'services/biz/invoicing.service'
import { getRepos } from 'services/context'
import { createApiApp } from '../../../portal-api/src/api.js'

/**
 * A legal number issued twice (FR-20.51, AC 51): both documents in the books under the one number,
 * the second flagged with the first (`numberClash`), and the later of the two corrected by a credit
 * note and a re-issue, prepared as drafts that move no stock. Never by editing or deleting either.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => {
  await setupTestDB()
}, 60_000)
afterAll(async () => {
  await teardownTestDB()
}, 60_000)
afterEach(async () => {
  await clearCollections()
}, 60_000)

const db = () => mongoose.connection.db as any
const oid = () => new mongoose.Types.ObjectId()
const year = new Date().getFullYear()
const day = 86_400_000

async function org(slug: string) {
  const o = await createTestOrg({ slug } as any)
  const admin = await createTestUser(o._id as any, { role: 'admin' } as any)
  const customer = await createTestContact(o._id as any, { companyName: 'Customer', type: 'customer' } as any)
  const wh = await createTestWarehouse(o._id as any)
  const bolt = await createTestProduct(o._id as any, { name: 'Bolt M8', sellingPrice: 10, taxRate: 20 } as any)
  await createTestStockLevel(o._id as any, bolt._id as any, wh._id as any, { quantity: 10 })
  return { orgId: String(o._id), oid: o._id as any, admin, customer, wh, bolt }
}
const sale = (w: any, number: string, over: Record<string, unknown> = {}) => ({
  _id: oid(), orgId: w.oid, type: 'invoice', direction: 'outgoing', invoiceNumber: number, status: 'sent', issueDate: new Date(), createdAt: new Date(),
  contactId: w.customer._id, currency: 'EUR', exchangeRate: 1, subtotal: 10, taxTotal: 2, total: 12, amountPaid: 0, amountDue: 12,
  billingAddress: { street: 'Main 1', city: 'Sofia', country: 'BG' },
  lines: [{ _id: oid(), productId: w.bolt._id, warehouseId: w.wh._id, description: 'Bolt', quantity: 1, unit: 'pcs', unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 2, lineTotal: 12 }],
  payments: [], ...over,
})

describe('the invoice number key (AC 51)', () => {
  it('an ordinary number stays unique; the pair\'s second fits, flagged with the first; a third never', async () => {
    const w = await org('clash-key')
    const first = sale(w, `INV-${year}-00007`)
    await Invoice.collection.insertOne(first as any)
    const plain = await captureRejection(Invoice.collection.insertOne(sale(w, `INV-${year}-00007`) as any))
    expect(plain?.code).toBe(11000)
    await Invoice.collection.insertOne(sale(w, `INV-${year}-00007`, { numberClash: { withId: first._id, withNumber: `INV-${year}-00007`, source: 'fenced_export', at: new Date() } }) as any)
    const third = await captureRejection(Invoice.collection.insertOne(sale(w, `INV-${year}-00007`, { numberClash: { withId: first._id, withNumber: `INV-${year}-00007`, source: 'reseed_kept', at: new Date() } }) as any))
    expect(third?.code).toBe(11000)
    // Another org may use the number as it likes.
    const other = await org('clash-key-2')
    await Invoice.collection.insertOne(sale(other, `INV-${year}-00007`) as any)
    // An invoice saved through the model carries no flag: the key reads it as null.
    const saved: any = await getRepos().invoices.create({ ...sale(w, `INV-${year}-00008`), _id: undefined, dueDate: new Date(), createdBy: w.admin._id } as any)
    expect(((await Invoice.collection.findOne({ _id: new mongoose.Types.ObjectId(saved.id) } as any)) as any)?.numberClash).toBeUndefined()
  })

  it('migration 0010 makes the new key, drops the old one, and does nothing the second time', async () => {
    await org('clash-migration')
    const invoices = db().collection('invoices')
    await invoices.dropIndex(INVOICE_NUMBER_KEY).catch(() => {})
    await invoices.createIndex({ orgId: 1, invoiceNumber: 1 }, { unique: true, name: 'orgId_1_invoiceNumber_1' })
    const logs: string[] = []
    await invoiceNumberClash.up({ db: db(), log: (m: string) => logs.push(m), orgFilter: {} } as any)
    let names = ((await invoices.indexes()) as any[]).map(i => i.name)
    expect([names.includes(INVOICE_NUMBER_KEY), names.includes('orgId_1_invoiceNumber_1')]).toEqual([true, false])
    await invoiceNumberClash.up({ db: db(), log: (m: string) => logs.push(m), orgFilter: {} } as any)
    names = ((await invoices.indexes()) as any[]).map(i => i.name)
    expect([names.includes(INVOICE_NUMBER_KEY), names.includes('orgId_1_invoiceNumber_1'), logs.length]).toEqual([true, false, 1])
    const key: any = ((await invoices.indexes()) as any[]).find(i => i.name === INVOICE_NUMBER_KEY)
    expect([key.unique, key.key]).toEqual([true, { orgId: 1, invoiceNumber: 1, 'numberClash.withId': 1 }])
  })
})

describe('correcting a number issued twice (AC 51)', () => {
  it('the later of the pair is annulled by a credit note and re-issued, as drafts that move no stock, once', async () => {
    const w = await org('clash-fix')
    const number = `INV-${year}-00042`
    const earlier = sale(w, number, { issueDate: new Date(Date.now() - day), createdAt: new Date(Date.now() - day) })
    await Invoice.collection.insertOne(earlier as any)
    const later = sale(w, number, { total: 24, subtotal: 20, taxTotal: 4, amountDue: 24, numberClash: { withId: earlier._id, withNumber: number, source: 'fenced_export', at: new Date() } })
    await Invoice.collection.insertOne(later as any)
    expect(String(laterOf(earlier, later)._id)).toBe(String(later._id))

    const [pair] = await listNumberClashes(w.orgId)
    expect(pair).toMatchObject({ id: String(later._id), number, later: 'flagged', correctable: true, correction: null, resolved: false, other: { id: String(earlier._id) } })

    const made = await prepareClashCorrection(w.orgId, String(later._id), { id: String(w.admin._id) })
    expect(made.target).toBe(String(later._id))
    const cn: any = await Invoice.collection.findOne({ _id: new mongoose.Types.ObjectId(made.creditNote.id) } as any)
    const re: any = await Invoice.collection.findOne({ _id: new mongoose.Types.ObjectId(made.reissue.id) } as any)
    expect([cn.type, cn.status, String(cn.relatedInvoiceId), cn.total, cn.stockSource?.marker]).toEqual(['credit_note', 'draft', String(later._id), 24, `number_clash:${String(later._id)}`])
    expect([re.type, re.status, re.total, re.stockSource?.marker, re.invoiceNumber === number]).toEqual(['invoice', 'draft', 24, `number_clash:${String(later._id)}`, false])
    expect(re.lines.map((l: any) => l.productId && String(l.productId))).toEqual([String(w.bolt._id)])
    // Neither moves stock when it is issued: the goods left once, with the document annulled.
    const before = await StockMovement.countDocuments({ orgId: w.oid })
    for (const id of [made.creditNote.id, made.reissue.id]) await createInvoiceStockMovement((await getRepos().invoices.findById(id)) as any, String(w.admin._id))
    expect(await StockMovement.countDocuments({ orgId: w.oid })).toBe(before)
    expect(Number(((await StockLevel.findOne({ orgId: w.oid, productId: w.bolt._id }).lean()) as any)?.quantity)).toBe(10)
    // Neither document of the pair was edited.
    expect([((await Invoice.collection.findOne({ _id: later._id } as any)) as any).total, ((await Invoice.collection.findOne({ _id: earlier._id } as any)) as any).invoiceNumber]).toEqual([24, number])
    // Prepared once; resolved once both drafts are issued.
    expect((await captureRejection(prepareClashCorrection(w.orgId, String(later._id), { id: String(w.admin._id) })))?.code).toBe('already_prepared')
    let [after] = await listNumberClashes(w.orgId)
    expect([after.correction?.creditNote?.number, after.correction?.reissue?.status, after.resolved]).toEqual([cn.invoiceNumber, 'draft', false])
    await Invoice.collection.updateMany({ _id: { $in: [cn._id, re._id] } } as any, { $set: { status: 'sent' } })
    ;[after] = await listNumberClashes(w.orgId)
    expect(after.resolved).toBe(true)
    expect(await AuditLog.exists({ orgId: w.oid, entityType: 'invoice', entityName: number, action: 'update' })).toBeTruthy()
  })

  it('the later may be the other one; a cash sale\'s pair is corrected by a person', async () => {
    const w = await org('clash-other')
    const number = `INV-${year}-00050`
    const later = sale(w, number)
    await Invoice.collection.insertOne(later as any)
    const flagged = sale(w, number, { issueDate: new Date(Date.now() - day), createdAt: new Date(Date.now() - day), numberClash: { withId: later._id, withNumber: number, source: 'reseed_kept', at: new Date() } })
    await Invoice.collection.insertOne(flagged as any)
    expect((await listNumberClashes(w.orgId))[0].later).toBe('other')
    const made = await prepareClashCorrection(w.orgId, String(flagged._id), { id: String(w.admin._id) })
    expect(made.target).toBe(String(later._id))
    expect(String(((await Invoice.collection.findOne({ _id: new mongoose.Types.ObjectId(made.creditNote.id) } as any)) as any).relatedInvoiceId)).toBe(String(later._id))

    const cs = sale(w, `CS-${year}-00001`, { type: 'cash_sale' })
    await Invoice.collection.insertOne(cs as any)
    const cs2 = sale(w, `CS-${year}-00001`, { type: 'cash_sale', numberClash: { withId: cs._id, withNumber: `CS-${year}-00001`, source: 'fenced_export', at: new Date() } })
    await Invoice.collection.insertOne(cs2 as any)
    expect((await captureRejection(prepareClashCorrection(w.orgId, String(cs2._id), { id: String(w.admin._id) })))?.code).toBe('not_correctable_here')
    expect((await captureRejection(prepareClashCorrection(w.orgId, String(cs._id), { id: String(w.admin._id) })))?.code).toBe('not_found')
  })

  it('the routes: listed for a reader, prepared by a writer', async () => {
    const w = await org('clash-routes')
    const number = `INV-${year}-00060`
    const first = sale(w, number)
    await Invoice.collection.insertOne(first as any)
    const second = sale(w, number, { numberClash: { withId: first._id, withNumber: number, source: 'fenced_export', at: new Date() } })
    await Invoice.collection.insertOne(second as any)
    const app = new Elysia().use(createApiApp())
    const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
    const token = (role: string, permissions: string[]) => (signer as any).decorator.jwt.sign({ id: String(w.admin._id), orgId: w.orgId, role, email: `${role}@clash.test`, username: role, permissions })
    const call = async (method: string, path: string, t: string) => {
      const res = await app.handle(new Request(`http://localhost/api${path}`, { method, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined }))
      return { status: res.status, json: await res.json().catch(() => null) as any }
    }
    const reader = await token('nra_auditor', DEFAULT_ROLE_PERMISSIONS.nra_auditor as string[])
    const listed = await call('GET', `/org/${w.orgId}/invoicing/number-clashes`, reader)
    expect([listed.status, listed.json?.clashes?.length]).toEqual([200, 1])
    expect((await call('POST', `/org/${w.orgId}/invoicing/number-clashes/${String(second._id)}/prepare`, reader)).status).toBe(403)
    const writer = await token('admin', DEFAULT_ROLE_PERMISSIONS.admin as string[])
    const prepared = await call('POST', `/org/${w.orgId}/invoicing/number-clashes/${String(second._id)}/prepare`, writer)
    expect([prepared.status, prepared.json?.correction?.creditNote?.number?.length > 0]).toEqual([200, true])
    expect((await call('POST', `/org/${w.orgId}/invoicing/number-clashes/${String(second._id)}/prepare`, writer)).json?.code).toBe('already_prepared')
  })
})
