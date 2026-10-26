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
import { createTransferMovements } from 'services/biz/stock-transfer.service'
import { findPosRow } from 'services/biz/cash-register/pos-union'
import { setDisplayPrefix } from 'services/biz/sequence.service'
import { getRepos } from 'services/context'
import { Invoice, Org, POSSession, POSTransaction, Sequence, StockLevel, StockMovement } from 'db/models'
import { tillApp, tillWorld, forgetDevices } from '../helpers/till-world'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-21 R2 — a cash-register sale over HTTP, through each door of the one service (D-4).
 *
 * The till (FR-21.15–FR-21.17, FR-21.20): a sale rung up at the till is a cash-register document —
 * the register block, a CS number, the УНП, exactly one receipt on the Eltrade simulator, the
 * session's totals, and stock linked by `invoiceId`. A failure before the receipt may print takes the
 * sale back; a failure after it is recorded on the document and shown.
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
  app = tillApp()
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  forgetDevices()
  await clearCollections()
}, 30_000)

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

describe('FR-21.15 — a till sale is a cash-register document', () => {
  it('a fiscal sale on the Eltrade: the register block, a CS number, the УНП, one receipt, the session totals, stock by invoiceId', async () => {
    const w = await tillWorld(app)
    const res = await w.sell(2, { tendered: 30 })

    expect(res.status).toBe(200)
    expect(res.json.receiptError).toBeUndefined()
    expect(res.json.stockError).toBeUndefined()
    const doc: any = await Invoice.findById(res.json.transaction.id).lean()
    const year = new Date().getFullYear()
    expect(doc).toMatchObject({
      type: 'cash_sale', direction: 'outgoing', status: 'paid', invoiceNumber: `CS-${year}-00001`,
      currency: 'EUR', exchangeRate: 1, subtotal: 20, taxTotal: 4, total: 24, amountPaid: 24, amountDue: 0,
    })
    expect(doc.completedAt).toBeTruthy()
    expect(doc.register).toMatchObject({
      origin: 'pos', fiscalDeviceNumber: 'ED123456', operatorCode: '0001', unp: 'ED123456-0001-0000001',
      isFiscal: true, changeDue: 6, sessionTotalsApplied: true, stornoState: 'none',
    })
    expect(String(doc.register.sessionId)).toBe(w.sessionId)
    expect(String(doc.register.warehouseId)).toBe(String(w.warehouse._id))
    expect(doc.register.fiscal.state).toBe('printed')
    expect(doc.register.legacy).toBeUndefined()
    // The lines are the document's: gross, the product's unit, the session's warehouse (D-7).
    expect(doc.lines[0]).toMatchObject({ description: 'Болт DIN 933 М8Х25', quantity: 2, unit: 'бр.', lineTotal: 24, taxAmount: 4 })
    expect(String(doc.lines[0].warehouseId)).toBe(String(w.warehouse._id))
    // The payment is what the drawer kept; what was handed over stays on it.
    expect(doc.payments.map((p: any) => [p.method, p.amount, p.tendered])).toEqual([['cash', 24, 30]])

    // Exactly one receipt, under the document's УНП.
    const receipts = w.sim!.receipts.filter(r => r.kind === 'fiscal' && !r.voided)
    expect(receipts).toHaveLength(1)
    expect(receipts[0].header[1]).toBe('ED123456-0001-0000001')
    expect(doc.register.fiscalReceiptNumber).toBe(receipts[0].number)

    // The drawer: 24 kept of the 30 tendered.
    const session: any = await POSSession.findById(w.sessionId).lean()
    expect(session).toMatchObject({ totalSales: 24, totalCash: 24, transactionCount: 1 })

    // Stock through the invoice path: the movement names the document.
    const moved: any[] = await StockMovement.find({ orgId: w.oid, invoiceId: doc._id }).lean()
    expect(moved.map(m => [m.type, m.status])).toEqual([['dispatch', 'completed']])
    expect(String(doc.register.movementId)).toBe(String(moved[0]._id))
    expect((await w.stock()).quantity).toBe(8)

    // The till's answer is the POS row it stands for; nothing is written to the old store.
    expect(res.json.transaction).toMatchObject({
      transactionNumber: doc.invoiceNumber, type: 'sale', status: 'completed', total: 24, changeDue: 6,
      unpNumber: 'ED123456-0001-0000001', fiscalReceiptNumber: receipts[0].number,
    })
    expect(res.json.transaction.payments).toEqual([{ method: 'cash', amount: 30 }])
    expect(await POSTransaction.countDocuments({ orgId: w.oid })).toBe(0)
    // TXN allocates nothing any more (D-5).
    expect(await Sequence.countDocuments({ orgId: w.oid, prefix: 'TXN' })).toBe(0)
  }, 60_000)

  it('the readers that still speak POS rows read it once, as the row it stands for', async () => {
    const w = await tillWorld(app)
    const { json } = await w.sell()

    const row = await findPosRow(w.orgId, json.transaction.id)
    expect(row).toMatchObject({ transactionNumber: json.transaction.transactionNumber, type: 'sale', status: 'completed', total: 24 })
    const list = await w.call('GET', '/trade/pos/transactions?size=10')
    expect(list.json.total).toBe(1)
    const ofSession = await w.call('GET', `/trade/pos/session/${w.sessionId}/transaction`)
    expect(ofSession.json.transactions.map((t: any) => t.id)).toEqual([json.transaction.id])
    const journal = await w.call('GET', '/cash-register/documents')
    expect(journal.json.rows.map((r: any) => [r.number, r.store, r.origin, r.kind])).toEqual([[json.transaction.transactionNumber, 'invoice', 'pos', 'sale']])
  }, 60_000)

  it('a text receipt, and no device at all: the same document, its receipt state says which', async () => {
    const w = await tillWorld(app)
    const text = await w.sell(1, { nonFiscal: true })
    expect(text.status).toBe(200)
    const doc: any = await Invoice.findById(text.json.transaction.id).lean()
    expect(doc.register).toMatchObject({ isFiscal: false, fiscal: { state: 'printed', mode: 'text' } })
    expect(doc.register.unp).toBeUndefined()
    expect(w.sim!.receipts.filter(r => r.kind === 'fiscal')).toHaveLength(0)

    const bare = await tillWorld(app, { device: false })
    const none = await bare.sell(1)
    expect(none.status).toBe(200)
    const plain: any = await Invoice.findById(none.json.transaction.id).lean()
    expect(plain.register.fiscal.state).toBe('none')
    expect(plain.register.isFiscal).toBe(false)
  }, 60_000)

  it('a session number comes from the registry, under the org\'s own prefix', async () => {
    const w = await tillWorld(app, { device: false })
    const year = new Date().getFullYear()
    expect(w.session.sessionNumber).toBe(`POS-${year}-000001`)

    await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 100 } })
    await setDisplayPrefix(w.orgId, 'POS', 'KS')
    const next = await w.call('POST', '/trade/pos/session', { warehouseId: String(w.warehouse._id), openingBalance: 0, currency: 'EUR' })
    expect(next.json.session.sessionNumber).toBe(`KS-${year}-000002`)
  }, 60_000)

  it('a return or an exchange is not rung up: a sale is reversed by its storno', async () => {
    const w = await tillWorld(app, { device: false })
    const res = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, { ...w.saleBody(), type: 'return' })
    expect(res.status).toBe(422)
    expect(res.json.code).toBe('register_type_unsupported')
    expect(await Invoice.countDocuments({ orgId: w.oid })).toBe(0)
  }, 60_000)
})

describe('FR-21.16 — one failure rule, and the stock checked before the print', () => {
  it('by default the till sells what the warehouse does not hold, as it always did', async () => {
    const w = await tillWorld(app, { stock: 1 })
    const res = await w.sell(3)
    expect(res.status).toBe(200)
    expect(res.json.stockError).toBeUndefined()
    expect((await w.stock()).quantity).toBe(-2)
  }, 60_000)

  it('an org that does not allow it: refused before the receipt, and nothing is written — no number, no receipt, no total', async () => {
    const w = await tillWorld(app, { stock: 1 })
    await Org.updateOne({ _id: w.oid }, { $set: { 'settings.cashRegister.allowNegativeStock': false } }).exec()

    const res = await w.sell(3)

    expect(res.status).toBe(400)
    expect(res.json.code).toBe('insufficient_stock')
    expect(await Invoice.countDocuments({ orgId: w.oid })).toBe(0)
    expect(w.sim!.receipts).toHaveLength(0)
    expect((await POSSession.findById(w.sessionId).lean() as any).transactionCount).toBe(0)
    expect((await w.stock()).quantity).toBe(1)
    // The CS series lost nothing: the next sale takes the first number.
    const next = await w.sell(1)
    expect(next.json.transaction.transactionNumber).toMatch(/-00001$/)
  }, 60_000)

  it('a failure after the receipt printed is recorded on the document, and the sale stands', async () => {
    const w = await tillWorld(app)
    const repo = getRepos().stockMovements as any
    repo.create = async () => { throw new Error('write concern timeout') }
    try {
      const res = await w.sell(2)

      expect(res.status).toBe(200)
      expect(res.json.stockError).toBe('write concern timeout')
      const doc: any = await Invoice.findById(res.json.transaction.id).lean()
      expect(doc.register.stockError).toBe('write concern timeout')
      expect(doc.register.fiscal.state).toBe('printed')
      expect(doc.completedAt).toBeTruthy()
      expect((await POSSession.findById(w.sessionId).lean() as any).totalSales).toBe(24)
      expect((await w.stock()).quantity).toBe(10)
    } finally {
      delete repo.create
    }
  }, 60_000)
})
