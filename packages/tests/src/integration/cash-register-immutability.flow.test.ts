import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestUser, createTestWarehouse, createTestProduct, createTestContact,
  createTestPOSSession, createTestPOSTransaction, createTestInvoice,
} from '../helpers/factories'
import { DocFile, Invoice, POSTransaction } from 'db/models'
import { fromPosTransaction } from 'services/biz/cash-register/mapping'
import { requestHash } from 'services/biz/hot-path-key'
import { planDeleteDocFiles } from 'services/biz/files/doc-delete.service'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { posController } from 'invoicing-api/src/controllers/pos.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import type { Types } from 'mongoose'

/**
 * FR-21.10 / FR-21.11 — the guards R1 puts in place before any till document exists.
 *
 * - A till document or a storno is never edited, deleted or voided (409): a POS row was immutable
 *   because no route could change it, and `PUT /invoices/:id` edits any document in any status.
 * - A keyed retry finds its sale in either store: R2 writes till sales as documents, and after a
 *   rollback to R1 a retry must replay that document, never ring the sale up again. Since R2 this
 *   code is the one that writes them: it replays a finished document and finishes an interrupted
 *   one, and a till document is stornoed like any sale (the R1 refusals are gone with R1).
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(invoiceController).use(posController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() })

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const AT = new Date('2026-10-21T11:00:00.000Z')

async function world() {
  const org = await createTestOrg()
  const orgId = org._id as Types.ObjectId
  const user = await createTestUser(orgId, { operatorCode: '0001' } as any)
  const wh = await createTestWarehouse(orgId)
  const product = await createTestProduct(orgId, { name: 'Bolt M8' } as any)
  const contact = await createTestContact(orgId)
  const session = await createTestPOSSession(orgId, wh._id as Types.ObjectId, user._id as Types.ObjectId)
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId: String(orgId), role: 'admin', email: 'a@test.com', username: 'admin',
    firstName: 'A', lastName: 'B', operatorCode: '0001', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  async function call(method: string, path: string, body?: any, key?: string) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }
  /** A till sale as R2 writes it: a cash-register document. */
  async function tillDocument(over: Record<string, any> = {}, docOver: Record<string, any> = {}) {
    const row = await createTestPOSTransaction(orgId, session._id as Types.ObjectId, user._id as Types.ObjectId, {
      createdAt: AT, total: 24, taxTotal: 4, subtotal: 20, completedAt: AT,
      lines: [{ productId: product._id, name: 'Bolt M8', quantity: 2, unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 4, lineTotal: 20 }] as any,
      payments: [{ method: 'cash', amount: 24 }],
      ...over,
    } as any)
    const doc = { ...fromPosTransaction(row.toObject(), session.toObject()), ...docOver }
    await Invoice.collection.insertOne(doc as any)
    await POSTransaction.deleteOne({ _id: row._id })
    return doc
  }
  return { orgId, user, wh, product, contact, session, call, tillDocument }
}

describe('FR-21.11 — a till document or a storno cannot be edited, deleted or voided', () => {
  it('PUT, DELETE and /void answer 409 register_document_immutable for a till document', async () => {
    const w = await world()
    const doc = await w.tillDocument()
    for (const [method, path] of [['PUT', `/invoices/${doc._id}`], ['DELETE', `/invoices/${doc._id}`], ['POST', `/invoices/${doc._id}/void`]] as const) {
      const res = await w.call(method, path, method === 'PUT' ? { notes: 'edited' } : undefined)
      expect(res.status).toBe(409)
      expect(res.json.code).toBe('register_document_immutable')
    }
    expect((await Invoice.findById(doc._id).lean() as any).notes).toBeUndefined()
  })

  it('a cash_storno too, whatever its origin', async () => {
    const w = await world()
    const storno = await createTestInvoice(w.orgId, w.contact._id as Types.ObjectId, {
      type: 'cash_storno', direction: 'outgoing', status: 'paid', register: { origin: 'backoffice' },
    } as any)
    const res = await w.call('PUT', `/invoices/${storno._id}`, { notes: 'edited' })
    expect(res.status).toBe(409)
  })

  it('a back-office cash sale stays editable, as before (FR-20.51 owns that)', async () => {
    const w = await world()
    const sale = await createTestInvoice(w.orgId, w.contact._id as Types.ObjectId, {
      type: 'cash_sale', direction: 'outgoing', status: 'paid',
    } as any)
    const res = await w.call('PUT', `/invoices/${sale._id}`, { notes: 'edited' })
    expect(res.status).toBe(200)
  })

  it('a stornoed back-office sale is not voided, edited or deleted: its storno already reversed it', async () => {
    const w = await world()
    const sale = await createTestInvoice(w.orgId, w.contact._id as Types.ObjectId, {
      type: 'cash_sale', direction: 'outgoing', status: 'paid', register: { origin: 'backoffice', stornoState: 'full' },
    } as any)
    for (const [method, path] of [['POST', `/invoices/${sale._id}/void`], ['PUT', `/invoices/${sale._id}`], ['DELETE', `/invoices/${sale._id}`]] as const) {
      const res = await w.call(method, path, method === 'PUT' ? { notes: 'edited' } : undefined)
      expect(res.status).toBe(409)
      expect(res.json.code).toBe('register_document_immutable')
    }
    expect((await Invoice.findById(sale._id).lean() as any).status).toBe('paid')
  })

  it('the Files rollback skips a till document and says why', async () => {
    const w = await world()
    const doc = await w.tillDocument()
    const file = await DocFile.create({
      orgId: w.orgId, docType: 'cash_register', docNumber: 'X1', docDate: '2026-10-21', originalName: 'x.xlsx',
      currentPath: 'x', currentChecksum: 'x', mimeType: 'application/octet-stream', size: 1, uploadedBy: w.user._id,
      status: 'committed', committedIds: [doc._id],
    } as any)
    const plan = await planDeleteDocFiles(String(w.orgId), [String(file._id)], { rollback: true, force: true })
    const p: any = plan.plans[0]
    expect(p.invoices[0].action).toBe('skip')
    expect(p.warnings.join(' ')).toMatch(/cannot be edited, deleted or voided/)
  })
})

describe('FR-21.10 — a keyed till retry finds its sale in either store', () => {
  const body = (productId: string) => ({
    type: 'sale',
    lines: [{ productId, name: 'Bolt M8', quantity: 2, unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 4, lineTotal: 20 }],
    subtotal: 20, discountTotal: 0, taxTotal: 4, total: 24,
    payments: [{ method: 'cash', amount: 24 }], changeDue: 0, nonFiscal: true,
  })

  it('a sale R2 wrote as a document is replayed from it: no second sale', async () => {
    const w = await world()
    const b = body(String(w.product._id))
    const hash = requestHash(`pos.sale:${w.session._id}`, b)
    const doc = await w.tillDocument({ clientKey: 'retry-key-0001', requestHash: hash, transactionNumber: 'CS-2026-00007' })

    const res = await w.call('POST', `/trade/pos/session/${w.session._id}/transaction`, b, 'retry-key-0001')
    expect(res.status).toBe(200)
    expect(res.json.transaction.id).toBe(String(doc._id))
    expect(res.json.transaction.transactionNumber).toBe('CS-2026-00007')
    expect(await POSTransaction.countDocuments({ orgId: w.orgId })).toBe(0)
  })

  it('the same key with a different body is 422; a document an interrupted request left is finished by its retry', async () => {
    const w = await world()
    const b = body(String(w.product._id))
    await w.tillDocument({ clientKey: 'retry-key-0002', requestHash: requestHash(`pos.sale:${w.session._id}`, b) })
    // A different request (paid by card), still a valid one: the totals are checked before the key.
    const reused = await w.call('POST', `/trade/pos/session/${w.session._id}/transaction`, { ...b, payments: [{ method: 'card', amount: 24 }] }, 'retry-key-0002')
    expect(reused.status).toBe(422)

    // No lease on it: the request that wrote it is gone. Its retry finishes it, as one sale.
    const left = await w.tillDocument(
      { clientKey: 'retry-key-0003', requestHash: requestHash(`pos.sale:${w.session._id}`, b), transactionNumber: 'X2', completedAt: undefined },
    )
    const retry = await w.call('POST', `/trade/pos/session/${w.session._id}/transaction`, b, 'retry-key-0003')
    expect(retry.status).toBe(200)
    expect(retry.json.transaction.id).toBe(String(left._id))
    expect((await Invoice.findById(left._id).lean() as any).completedAt).toBeTruthy()
    expect(await Invoice.countDocuments({ orgId: w.orgId, clientKey: 'retry-key-0003' })).toBe(1)
  })

  it('a till sale held as a document is stornoed: it stays paid, and a cash_storno reverses it', async () => {
    const w = await world()
    const doc = await w.tillDocument()
    const res = await w.call('POST', `/trade/pos/session/${w.session._id}/storno`, { originalTransactionId: String(doc._id), reason: 'customer_return' })
    expect(res.status).toBe(200)
    const sale: any = await Invoice.findById(doc._id).lean()
    expect(sale.status).toBe('paid')
    expect(sale.register.stornoState).toBe('full')
    const storno: any = await Invoice.findOne({ orgId: w.orgId, type: 'cash_storno' }).lean()
    expect(String(storno.relatedInvoiceId)).toBe(String(doc._id))
    expect(sale.register.stornoedBy.map(String)).toEqual([String(storno._id)])
    expect(res.json.transaction.id).toBe(String(storno._id))
  })

  it('POST /invoices refuses a key a till sale already carries', async () => {
    const w = await world()
    await createTestPOSTransaction(w.orgId, w.session._id as Types.ObjectId, w.user._id as Types.ObjectId, { clientKey: 'till-key-00001' } as any)
    const res = await w.call('POST', '/invoices', {
      type: 'cash_sale', direction: 'outgoing', issueDate: '2026-10-21', currency: 'EUR',
      lines: [{ description: 'x', quantity: 1, unitPrice: 10, taxRate: 0 }], subtotal: 10, total: 10, paymentMethod: 'cash',
    }, 'till-key-00001')
    expect(res.status).toBe(422)
    expect(res.json.code).toBe('idempotency_key_reused')
  })
})
