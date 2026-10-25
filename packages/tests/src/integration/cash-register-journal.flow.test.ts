import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestUser, createTestWarehouse, createTestProduct, createTestContact,
  createTestPOSSession, createTestPOSTransaction, createTestInvoice, createTestStockMovement,
} from '../helpers/factories'
import { Invoice, POSTransaction } from 'db/models'
import { fromPosTransaction } from 'services/biz/cash-register/mapping'
import { cashRegisterController } from 'invoicing-api/src/controllers/cash-register.controller'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import type { Types } from 'mongoose'

/**
 * FR-21.12 — the cash-register journal: one list, one detail, both stores.
 *
 * The journal shows the till's sales (still POS rows, or documents), the back office's and the
 * PlusMinus imports' in one row shape. Filters, sort and paging run across both stores; a POS row a
 * document copied is read from the document. The route reads for the POS app AND the invoicing app,
 * and for a till signed in with a PIN.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(cashRegisterController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() })

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
function tokenFor(userId: string, orgId: string, role = 'admin', extra: Record<string, any> = {}) {
  return (signer as any).decorator.jwt.sign({
    id: userId, orgId, role, email: `${role}@test.com`, username: role, firstName: 'A', lastName: 'B',
    operatorCode: '0001', permissions: (DEFAULT_ROLE_PERMISSIONS as any)[role] || [], ownRecordsModules: [], ...extra,
  })
}

/** Instants in Sofia time (UTC+3 in October). */
const sofia = (iso: string) => new Date(`${iso}+03:00`)

async function world() {
  const org = await createTestOrg()
  const orgId = org._id as Types.ObjectId
  const user = await createTestUser(orgId, { firstName: 'Rosa', lastName: 'Dodova' } as any)
  const wh = await createTestWarehouse(orgId, { name: 'Склад 1' } as any)
  const other = await createTestWarehouse(orgId, { name: 'Склад 2' } as any)
  const product = await createTestProduct(orgId, { name: 'Bolt M8' } as any)
  const contact = await createTestContact(orgId, { companyName: 'Client Ltd' })
  const session = await createTestPOSSession(orgId, wh._id as Types.ObjectId, user._id as Types.ObjectId, { sessionNumber: 'POS-2026-000009' })
  const token = await tokenFor(String(user._id), String(orgId))
  const cid = contact._id as Types.ObjectId
  const line = (over: Record<string, any> = {}) => ({
    productId: product._id, description: 'Bolt M8', quantity: 2, unit: 'бр.', unitPrice: 10, discount: 0,
    taxRate: 20, taxAmount: 4, lineTotal: 24, warehouseId: wh._id, ...over,
  })

  // A back-office cash sale paid by card, on the 20th.
  const backOffice = await createTestInvoice(orgId, cid, {
    type: 'cash_sale', direction: 'outgoing', status: 'paid', invoiceNumber: 'CS-2026-00001',
    issueDate: new Date('2026-10-20T00:00:00.000Z'), lines: [line()], subtotal: 20, taxTotal: 4, total: 24,
    amountPaid: 24, amountDue: 0, payments: [{ date: new Date('2026-10-20'), method: 'card', amount: 24 }], paymentMethod: 'card',
  } as any)
  // A PlusMinus day imported before `register.origin` existed: told apart by its marker. One free-text line.
  const imported = await createTestInvoice(orgId, cid, {
    type: 'cash_sale', direction: 'outgoing', status: 'paid', invoiceNumber: 'CSR-2026-00002', contactId: undefined,
    issueDate: new Date('2026-10-21T00:00:00.000Z'), reference: 'salesAnalysis:2026-10-21', tags: ['cash-register-import'],
    lines: [line(), line({ productId: undefined, description: 'Unknown thing', warehouseId: undefined })],
    subtotal: 40, taxTotal: 8, total: 48, amountPaid: 48, amountDue: 0, payments: [], paymentMethod: 'cash',
  } as any)
  // A voided back-office sale, on the 21st.
  await createTestInvoice(orgId, cid, {
    type: 'cash_sale', direction: 'outgoing', status: 'voided', invoiceNumber: 'CS-2026-00003',
    issueDate: new Date('2026-10-21T00:00:00.000Z'), lines: [line()], subtotal: 20, taxTotal: 4, total: 24, amountPaid: 0,
  } as any)
  await createTestStockMovement(orgId, { invoiceId: backOffice._id, type: 'dispatch', status: 'completed', movementNumber: 'SM-2026-00001' } as any)

  const pos = (over: Record<string, any>) => createTestPOSTransaction(orgId, session._id as Types.ObjectId, user._id as Types.ObjectId, {
    lines: [{ productId: product._id, name: 'Bolt M8', quantity: 1, unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 2, lineTotal: 10 }] as any,
    subtotal: 10, discountTotal: 0, taxTotal: 2, total: 12, payments: [{ method: 'cash', amount: 20 }], changeDue: 8,
    isFiscal: true, fiscalDeviceNumber: 'ED399266', fiscal: { state: 'printed', mode: 'fiscal' },
    ...over,
  } as any)
  // A till sale still a POS row, at 22:30 on the 21st in Sofia (19:30 UTC), with its dispatch.
  const tillMovement = await createTestStockMovement(orgId, { type: 'dispatch', status: 'completed', movementNumber: 'SM-2026-00002' } as any)
  await pos({ transactionNumber: 'TXN-2026-0000001', createdAt: sofia('2026-10-21T22:30:00'), unpNumber: 'ED399266-0001-0000001', movementId: tillMovement._id })
  // A till sale copied to a document (both stores), stornoed by a storno held only as a document.
  const copied = await pos({
    transactionNumber: 'TXN-2026-0000002', createdAt: sofia('2026-10-21T10:00:00'), unpNumber: 'ED399266-0001-0000002', status: 'cancelled',
  })
  const stornoRow = await pos({
    transactionNumber: 'TXN-2026-0000003', type: 'storno', createdAt: sofia('2026-10-21T10:30:00'), unpNumber: 'ED399266-0001-0000003',
    originalTransactionId: copied._id, stornoReason: 'customer_return', changeDue: 0, payments: [{ method: 'cash', amount: 12 }],
  })
  await Invoice.collection.insertOne(fromPosTransaction(copied.toObject(), session.toObject(), { stornoedBy: [stornoRow._id] }) as any)
  await Invoice.collection.insertOne(fromPosTransaction(stornoRow.toObject(), session.toObject()) as any)
  await POSTransaction.deleteOne({ _id: stornoRow._id })

  async function get(path: string, tok = token) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/cash-register${path}`, { headers: { authorization: `Bearer ${tok}` } }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }
  return { orgId, user, wh, other, product, contact, session, token, backOffice, imported, copied, stornoRow, get }
}

const numbers = (res: any) => res.json.rows.map((r: any) => r.number)

describe('the journal list', () => {
  it('lists every cash-register document and POS row once, newest first', async () => {
    const w = await world()
    const res = await w.get('/documents')
    expect(res.status).toBe(200)
    expect(res.json.total).toBe(6)
    // By date; the two documents dated the 21st (no time of day) tie, and the newer id goes first.
    expect(numbers(res)).toEqual([
      'TXN-2026-0000001', 'TXN-2026-0000003', 'TXN-2026-0000002', 'CS-2026-00003', 'CSR-2026-00002', 'CS-2026-00001',
    ])
    // The copied sale appears once, read from its document.
    expect(res.json.rows.filter((r: any) => r.number === 'TXN-2026-0000002').map((r: any) => r.store)).toEqual(['invoice'])
  })

  it('one row shape for every source', async () => {
    const w = await world()
    const res = await w.get('/documents')
    const by = (n: string) => res.json.rows.find((r: any) => r.number === n)
    expect(by('TXN-2026-0000001')).toMatchObject({
      store: 'pos', kind: 'sale', origin: 'pos', status: 'completed', total: 12, currency: 'EUR', hasTime: true,
      payments: [{ method: 'cash', amount: 12, tendered: 20 }], sessionNumber: 'POS-2026-000009', warehouseName: 'Склад 1',
      cashierName: 'Rosa Dodova', stock: 'moved', fiscal: { isFiscal: true, state: 'printed', unp: 'ED399266-0001-0000001', deviceNumber: 'ED399266' },
    })
    expect(by('TXN-2026-0000002')).toMatchObject({ status: 'stornoed', stornoedBy: [String(w.stornoRow._id)] })
    expect(by('TXN-2026-0000003')).toMatchObject({ kind: 'storno', relatedId: String(w.copied._id) })
    expect(by('CS-2026-00001')).toMatchObject({ origin: 'backoffice', contactName: 'Client Ltd', paymentLabel: 'card', stock: 'moved' })
    expect(by('CSR-2026-00002')).toMatchObject({ origin: 'import', hasTime: false, payments: [{ method: 'cash', amount: 48 }], stock: 'none' })
    expect(by('CS-2026-00003')).toMatchObject({ status: 'voided' })
  })

  it('filters by kind, origin and status across both stores', async () => {
    const w = await world()
    expect(numbers(await w.get('/documents?kind=storno'))).toEqual(['TXN-2026-0000003'])
    expect(numbers(await w.get('/documents?origin=import'))).toEqual(['CSR-2026-00002'])
    expect(numbers(await w.get('/documents?origin=backoffice')).sort()).toEqual(['CS-2026-00001', 'CS-2026-00003'])
    expect(numbers(await w.get('/documents?origin=pos')).sort()).toEqual(['TXN-2026-0000001', 'TXN-2026-0000002', 'TXN-2026-0000003'])
    expect(numbers(await w.get('/documents?status=stornoed'))).toEqual(['TXN-2026-0000002'])
    expect(numbers(await w.get('/documents?status=voided'))).toEqual(['CS-2026-00003'])
    expect((await w.get('/documents?status=completed')).json.total).toBe(4)
  })

  it('searches the number and the УНП, filters by method, session and warehouse', async () => {
    const w = await world()
    expect(numbers(await w.get('/documents?search=0000003'))).toEqual(['TXN-2026-0000003'])
    expect(numbers(await w.get('/documents?search=ED399266-0001-0000001'))).toEqual(['TXN-2026-0000001'])
    expect(numbers(await w.get('/documents?paymentMethod=card'))).toEqual(['CS-2026-00001'])
    expect((await w.get(`/documents?sessionId=${w.session._id}`)).json.total).toBe(3)
    expect((await w.get(`/documents?warehouseId=${w.other._id}`)).json.total).toBe(0)
    expect((await w.get(`/documents?warehouseId=${w.wh._id}`)).json.total).toBe(6)
  })

  it('filters by receipt state; a sale from before the receipt was a recorded step goes by its receipt number', async () => {
    const w = await world()
    const legacy = (over: Record<string, any>) => createTestPOSTransaction(w.orgId, w.session._id as Types.ObjectId, w.user._id as Types.ObjectId, {
      lines: [{ productId: w.product._id, name: 'Bolt M8', quantity: 1, unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 2, lineTotal: 10 }] as any,
      subtotal: 10, discountTotal: 0, taxTotal: 2, total: 12, payments: [{ method: 'card', amount: 12 }], changeDue: 0,
      createdAt: sofia('2026-10-19T09:00:00'), ...over,
    } as any)
    await legacy({ transactionNumber: 'TXN-2026-0000101', isFiscal: true, fiscalReceiptNumber: '0000412', unpNumber: 'ED399266-0001-0000101' })
    await legacy({ transactionNumber: 'TXN-2026-0000102', isFiscal: false })

    const printed = await w.get('/documents?fiscalState=printed')
    expect(numbers(printed).sort()).toEqual(['TXN-2026-0000001', 'TXN-2026-0000002', 'TXN-2026-0000003', 'TXN-2026-0000101'])
    expect(printed.json.rows.find((r: any) => r.number === 'TXN-2026-0000101').fiscal.state).toBe('printed')
    // The back office prints nothing, and neither did the text-mode sale.
    expect(numbers(await w.get('/documents?fiscalState=none')).sort())
      .toEqual(['CS-2026-00001', 'CS-2026-00003', 'CSR-2026-00002', 'TXN-2026-0000102'])
    expect(numbers(await w.get('/documents?fiscalState=failed'))).toEqual([])
  })

  it('a date range is whole days in the org\'s zone (Sofia by default)', async () => {
    const w = await world()
    // 22:30 on the 21st in Sofia is 19:30 UTC: still the 21st.
    const day = await w.get('/documents?dateFrom=2026-10-21&dateTo=2026-10-21')
    expect(numbers(day).sort()).toEqual(['CS-2026-00003', 'CSR-2026-00002', 'TXN-2026-0000001', 'TXN-2026-0000002', 'TXN-2026-0000003'])
    expect(numbers(await w.get('/documents?dateFrom=2026-10-20&dateTo=2026-10-20'))).toEqual(['CS-2026-00001'])
  })

  it('pages across both stores without repeating or losing a row', async () => {
    const w = await world()
    const all = numbers(await w.get('/documents?size=50'))
    const paged: string[] = []
    for (let page = 0; page < 3; page++) paged.push(...numbers(await w.get(`/documents?size=2&page=${page}`)))
    expect(paged).toEqual(all)
    const asc = numbers(await w.get('/documents?size=50&sortOrder=asc'))
    expect(asc).toEqual([...all].reverse())
  })
})

describe('the journal detail', () => {
  it('a POS row: gross lines, its movement, its session', async () => {
    const w = await world()
    const list = await w.get('/documents?origin=pos&kind=sale&status=completed')
    const res = await w.get(`/documents/${list.json.rows[0].id}`)
    expect(res.status).toBe(200)
    expect(res.json.lines).toEqual([expect.objectContaining({ description: 'Bolt M8', lineTotal: 12, taxAmount: 2, unmatched: false })])
    expect(res.json.movements.map((m: any) => m.number)).toEqual(['SM-2026-00002'])
    expect(res.json.session).toMatchObject({ number: 'POS-2026-000009' })
  })

  it('the storno chain, both ways', async () => {
    const w = await world()
    const sale = await w.get(`/documents/${w.copied._id}`)
    expect(sale.json.related.map((r: any) => r.number)).toEqual(['TXN-2026-0000003'])
    const storno = await w.get(`/documents/${w.stornoRow._id}`)
    expect(storno.json.related.map((r: any) => r.number)).toEqual(['TXN-2026-0000002'])
  })

  it('an imported day shows its free-text line, which counts and moves nothing', async () => {
    const w = await world()
    const res = await w.get(`/documents/${w.imported._id}`)
    expect(res.json.lines.map((l: any) => [l.description, l.unmatched])).toEqual([['Bolt M8', false], ['Unknown thing', true]])
  })

  it('404 for an id that is not a cash-register document', async () => {
    const w = await world()
    expect((await w.get(`/documents/${w.contact._id}`)).status).toBe(404)
    expect((await w.get('/documents/not-an-id')).status).toBe(404)
  })
})

describe('who reads it', () => {
  it('the POS app\'s reader and the invoicing app\'s reader; not someone with neither', async () => {
    const w = await world()
    const as = async (role: string) => (await w.get('/documents', await tokenFor(String(w.user._id), String(w.orgId), role))).status
    expect(await as('sales')).toBe(200)        // pos.read
    expect(await as('accountant')).toBe(200)   // invoicing.read
    expect(await as('hr_manager')).toBe(403)
  })

  it('a till signed in with a PIN reads its journal', async () => {
    const w = await world()
    const pin = await tokenFor(String(w.user._id), String(w.orgId), 'sales', { amr: ['pin'] })
    expect((await w.get('/documents', pin)).status).toBe(200)
  })

  it('another org\'s journal is refused', async () => {
    const w = await world()
    const stranger = await createTestOrg()
    const res = await w.get('/documents', await tokenFor(String(w.user._id), String(stranger._id)))
    expect(res.status).toBe(403)
  })
})
