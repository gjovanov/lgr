import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestUser,
  createTestContact,
  createTestWarehouse,
  createTestProduct,
  createTestStockLevel,
} from '../helpers/factories'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { stockAvailabilityController } from 'invoicing-api/src/controllers/stock-availability.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { createTransferMovements } from 'services/biz/stock-transfer.service'
import { Invoice, StockLevel, StockMovement } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-21 R2 — a cash-register sale over HTTP.
 *
 * FR-21.24: the cash-sale form sells stock that is short in the till's warehouse by creating
 * draft transfers first (`/stock-availability/create-transfers`) and handing their ids to the
 * create as `pendingTransferIds`. The create confirms them before it dispatches. The body schema
 * of `POST /invoices` must declare the field, or Elysia drops it before the handler reads it.
 *
 * The ids come from the client, so only this org's transfers are confirmed, on every route that
 * takes them (`POST /invoices` and `/:id/send`).
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(invoiceController).use(stockAvailabilityController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string }) {
  return (signer as any).decorator.jwt.sign({
    id: u.id, orgId: u.orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Test', lastName: 'Admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}

/** An org with a till warehouse short of stock and a depot that holds plenty. */
async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const contact = await createTestContact(org._id)
  const till = await createTestWarehouse(org._id, { name: 'Till' } as any)
  const depot = await createTestWarehouse(org._id, { name: 'Depot' } as any)
  const product = await createTestProduct(org._id, { sellingPrice: 10, taxRate: 0 } as any)
  await createTestStockLevel(org._id, product._id, till._id, { quantity: 3, availableQuantity: 3, avgCost: 4 } as any)
  await createTestStockLevel(org._id, product._id, depot._id, { quantity: 20, availableQuantity: 20, avgCost: 4 } as any)
  const token = await tokenFor({ id: String(user._id), orgId })

  async function call(method: string, path: string, body?: any, key?: string) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}${path}`, {
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

  const line = (quantity: number) => ({
    productId: String(product._id), warehouseId: String(till._id),
    description: 'Болт М8', quantity, unitPrice: 10, taxRate: 0,
  })
  const cashSale = (quantity: number, extra: Record<string, unknown> = {}) => ({
    type: 'cash_sale', direction: 'outgoing', issueDate: '2026-10-26', currency: 'EUR',
    lines: [line(quantity)], subtotal: 10 * quantity, total: 10 * quantity, paymentMethod: 'cash',
    ...extra,
  })

  /** What the form does when the till is short: check, then create the proposed transfers. */
  async function transfersFor(quantity: number): Promise<string[]> {
    const check = await call('POST', '/invoicing/stock-availability/check', {
      lines: [{ productId: String(product._id), warehouseId: String(till._id), quantity }],
    })
    expect(check.status).toBe(200)
    expect(check.json.sufficient).toBe(false)
    expect(check.json.allResolvable).toBe(true)
    const created = await call('POST', '/invoicing/stock-availability/create-transfers', { proposals: check.json.proposals })
    expect(created.status).toBe(200)
    return created.json.transferIds
  }

  const level = async (warehouseId: unknown) =>
    (await StockLevel.findOne({ orgId, productId: product._id, warehouseId }).lean().exec() as any)?.quantity
  const movement = async (id: string) => StockMovement.findById(id).lean().exec() as Promise<any>

  return { org, orgId, user, contact, till, depot, product, call, line, cashSale, transfersFor, level, movement }
}

/** A draft transfer in an org the caller does not belong to. */
async function foreignTransfer(): Promise<{ id: string; orgId: string }> {
  const org = await createTestOrg()
  const user = await createTestUser(org._id)
  const from = await createTestWarehouse(org._id)
  const to = await createTestWarehouse(org._id)
  const product = await createTestProduct(org._id)
  await createTestStockLevel(org._id, product._id, from._id, { quantity: 50, availableQuantity: 50 } as any)
  const [id] = await createTransferMovements(String(org._id), [{
    productId: String(product._id), productName: 'Foreign', toWarehouseId: String(to._id), toWarehouseName: 'B',
    sources: [{ fromWarehouseId: String(from._id), fromWarehouseName: 'A', available: 50, transferQuantity: 5 }],
    totalTransfer: 5, deficit: 0,
  }], String(user._id))
  return { id, orgId: String(org._id) }
}

describe('FR-21.24 — a cash sale confirms the transfers it asked for', () => {
  it('the form flow over HTTP: the transfer is confirmed, then the sale dispatches', async () => {
    const w = await world()
    const transferIds = await w.transfersFor(10)
    expect(transferIds).toHaveLength(1)

    const res = await w.call('POST', '/invoices', w.cashSale(10, { pendingTransferIds: transferIds }))

    expect(res.status).toBe(200)
    const sale = await Invoice.findById(res.json.invoice.id).lean().exec() as any
    expect(sale.pendingTransferIds.map(String)).toEqual(transferIds)
    expect((await w.movement(transferIds[0])).status).toBe('completed')
    // 3 on the shelf + 7 brought over − 10 sold; the depot gave its 7.
    expect(await w.level(w.till._id)).toBe(0)
    expect(await w.level(w.depot._id)).toBe(13)
    expect(await StockMovement.countDocuments({ orgId: w.orgId, invoiceId: sale._id, type: 'dispatch' }).exec()).toBe(1)
  }, 60_000)

  it('with an Idempotency-Key: confirmed once, and a retry replays without moving anything again', async () => {
    const w = await world()
    const transferIds = await w.transfersFor(10)
    const body = w.cashSale(10, { pendingTransferIds: transferIds })

    const first = await w.call('POST', '/invoices', body, 'cs-transfer-0001')
    const again = await w.call('POST', '/invoices', body, 'cs-transfer-0001')

    expect(first.status).toBe(200)
    expect(again.status).toBe(200)
    expect(again.json.invoice.id).toBe(first.json.invoice.id)
    expect((await w.movement(transferIds[0])).status).toBe('completed')
    expect(await w.level(w.till._id)).toBe(0)
    expect(await w.level(w.depot._id)).toBe(13)
    expect(await StockMovement.countDocuments({ orgId: w.orgId, type: 'dispatch' }).exec()).toBe(1)
  }, 60_000)

  it("another org's transfer, or a movement that is not a transfer, is refused before anything is written", async () => {
    const w = await world()
    const foreign = await foreignTransfer()
    const receipt = await StockMovement.create({
      orgId: w.orgId, movementNumber: 'SM-2026-09999', type: 'receipt', status: 'draft', date: new Date(),
      toWarehouseId: w.till._id, lines: [{ productId: w.product._id, quantity: 100, unitCost: 4, totalCost: 400 }],
      totalAmount: 400, createdBy: w.user._id,
    } as any)

    for (const id of [foreign.id, String(receipt._id)]) {
      const res = await w.call('POST', '/invoices', w.cashSale(2, { pendingTransferIds: [id] }))
      expect(res.status).toBe(422)
      expect(res.json.code).toBe('pending_transfer_invalid')
    }

    expect((await w.movement(foreign.id)).status).toBe('draft')
    expect((await w.movement(String(receipt._id))).status).toBe('draft')
    expect(await Invoice.countDocuments({ orgId: w.orgId }).exec()).toBe(0)
    expect(await w.level(w.till._id)).toBe(3)
    // Refused before the insert, so no CS number was drawn: the next sale takes the first one.
    const next = await w.call('POST', '/invoices', w.cashSale(1))
    expect(next.status).toBe(200)
    expect(next.json.invoice.invoiceNumber).toMatch(/-0*1$/)
  }, 60_000)
})

describe("FR-21.24 — issuing a draft confirms only this org's transfers", () => {
  const invoiceBody = (w: Awaited<ReturnType<typeof world>>, quantity: number) => ({
    type: 'invoice', direction: 'outgoing', contactId: String(w.contact._id), issueDate: '2026-10-26', currency: 'EUR',
    lines: [w.line(quantity)], subtotal: 10 * quantity, total: 10 * quantity, paymentMethod: 'bank_transfer',
  })

  it('a draft issued with its own transfer: confirmed, then dispatched', async () => {
    const w = await world()
    const draft = await w.call('POST', '/invoices', invoiceBody(w, 10))
    expect(draft.status).toBe(200)
    const transferIds = await w.transfersFor(10)

    const sent = await w.call('POST', `/invoices/${draft.json.invoice.id}/send`, { pendingTransferIds: transferIds })

    expect(sent.status).toBe(200)
    expect((await w.movement(transferIds[0])).status).toBe('completed')
    expect(await w.level(w.till._id)).toBe(0)
  }, 60_000)

  it("another org's transfer is refused, stays a draft there, and the document stays a draft here", async () => {
    const w = await world()
    const foreign = await foreignTransfer()
    const draft = await w.call('POST', '/invoices', invoiceBody(w, 2))
    expect(draft.status).toBe(200)

    const sent = await w.call('POST', `/invoices/${draft.json.invoice.id}/send`, { pendingTransferIds: [foreign.id] })

    expect(sent.status).toBe(422)
    expect(sent.json.code).toBe('pending_transfer_invalid')
    expect((await w.movement(foreign.id)).status).toBe('draft')
    const doc = await Invoice.findById(draft.json.invoice.id).lean().exec() as any
    expect(doc.status).toBe('draft')
    expect(doc.issue?.leaseUntil ?? null).toBeNull()
  }, 60_000)
})
