import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestUser,
  createTestWarehouse,
  createTestProduct,
  createTestStockLevel,
  createTestFiscalDevice,
  createTestPOSTransaction,
} from '../helpers/factories'
import { EltradeSimulator } from '../helpers/eltrade-simulator'
import { migrateTill } from '../helpers/migrate-till'
import { posController } from 'invoicing-api/src/controllers/pos.controller'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { Invoice, POSSession, POSTransaction, StockMovement } from 'db/models'
import { getRepos } from 'services/context'
import { getNextNumber, generateUNP } from 'services/biz/sequence.service'
import { requestHash } from 'services/biz/hot-path-key'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * A POS sale retried with one `Idempotency-Key` happens once (FR-20.37, #155; AC 7, 18, 57).
 *
 * Over HTTP, against an Eltrade played by `EltradeSimulator`, so "one fiscal command" is
 * counted on the device rather than inferred from the database.
 *
 * A crash is a process dying between two steps; no `catch` runs. The crash cases therefore
 * set up exactly the record the route leaves at that point and send the retry.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
const registered: string[] = []

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(posController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  for (const id of registered.splice(0)) unregisterPrinter(id)
  await clearCollections()
}, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string }) {
  return (signer as any).decorator.jwt.sign({
    id: u.id, orgId: u.orgId, role: 'admin', email: 'cashier@test.com', username: 'cashier',
    firstName: 'Иван', lastName: 'Петров', operatorCode: '0001',
    permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}

async function post(path: string, token: string, body: any, key?: string) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: JSON.stringify(body),
  }))
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

/** 2 × 10.00 net at 20 % → 24.00 to pay. */
function saleBody(productId: string, quantity = 2) {
  return {
    type: 'sale',
    lines: [{ productId, name: 'Болт DIN 933 М8Х25', quantity, unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 2 * quantity, lineTotal: 10 * quantity }],
    subtotal: 10 * quantity, discountTotal: 0, taxTotal: 2 * quantity, total: 12 * quantity,
    payments: [{ method: 'cash', amount: 12 * quantity }],
    changeDue: 0,
    nonFiscal: false,
  }
}

async function world(printer?: (sim: EltradeSimulator, deviceId: string) => any) {
  const org = await createTestOrg()
  const warehouse = await createTestWarehouse(org._id)
  const user = await createTestUser(org._id, { operatorCode: '0001' } as any)
  const product = await createTestProduct(org._id, { sellingPrice: 10, taxRate: 20 } as any)
  await createTestStockLevel(org._id, product._id, warehouse._id, { quantity: 100 })
  const device = await createTestFiscalDevice(org._id, warehouse._id, {
    name: 'Eltrade A3', deviceNumber: 'ED123456', manufacturer: 'eltrade', connectionType: 'browser', status: 'online',
  } as any)
  const deviceId = String(device._id)
  const sim = new EltradeSimulator()
  const eltrade = new EltradeFiscalPrinter(sim.exchange, deviceId)
  registerPrinter(deviceId, printer ? printer(sim, deviceId) : eltrade)
  registered.push(deviceId)

  const session = await getRepos().posSessions.create({
    orgId: String(org._id), warehouseId: String(warehouse._id), cashierId: String(user._id),
    sessionNumber: await getNextNumber(String(org._id), 'POS', 6),
    openedAt: new Date(), status: 'open', openingBalance: 0, currency: 'EUR',
    totalSales: 0, totalReturns: 0, totalCash: 0, totalCard: 0, transactionCount: 0,
  } as any)
  const token = await tokenFor({ id: String(user._id), orgId: String(org._id) })
  const url = `/org/${org._id}/trade/pos/session/${session.id}/transaction`
  return { org, user, product, deviceId, sim, eltrade, token, url, sessionId: session.id, orgId: String(org._id) }
}

const fiscalReceipts = (sim: EltradeSimulator) => sim.receipts.filter(r => r.kind === 'fiscal' && !r.voided)
const movements = (orgId: string) => StockMovement.countDocuments({ orgId, type: 'dispatch' }).exec()
const session = (id: string) => POSSession.findById(id).lean().exec() as Promise<any>

describe('a keyed POS sale happens once', () => {
  it('5 concurrent requests with one key: one transaction, one movement, one fiscal receipt (AC 7, 18)', async () => {
    const w = await world()
    const body = saleBody(String(w.product._id))

    const answers = await Promise.all(Array.from({ length: 5 }, () => post(w.url, w.token, body, 'sale-key-0001')))

    expect(answers.map(a => a.status)).toEqual([200, 200, 200, 200, 200])
    const ids = new Set(answers.map(a => a.json.transaction.id))
    expect(ids.size).toBe(1)
    expect(new Set(answers.map(a => a.json.transaction.fiscalReceiptNumber)).size).toBe(1)

    // FR-21: one cash-register document; the till writes no POS row any more.
    expect(await Invoice.countDocuments({ orgId: w.orgId, type: 'cash_sale' }).exec()).toBe(1)
    expect(await POSTransaction.countDocuments({ orgId: w.orgId }).exec()).toBe(0)
    expect(await movements(w.orgId)).toBe(1)
    expect(fiscalReceipts(w.sim)).toHaveLength(1)
    const s = await session(w.sessionId)
    expect(s.transactionCount).toBe(1)
    expect(s.totalSales).toBe(24)
  }, 60_000)

  it('a retry after success returns the first response and does nothing new', async () => {
    const w = await world()
    const body = saleBody(String(w.product._id))

    const first = await post(w.url, w.token, body, 'sale-key-0002')
    const again = await post(w.url, w.token, body, 'sale-key-0002')

    expect(again.status).toBe(200)
    expect(again.json.transaction.id).toBe(first.json.transaction.id)
    expect(again.json.transaction.unpNumber).toBe(first.json.transaction.unpNumber)
    expect(again.json.transaction.fiscalReceiptNumber).toBe(first.json.transaction.fiscalReceiptNumber)
    expect(fiscalReceipts(w.sim)).toHaveLength(1)
    expect(await movements(w.orgId)).toBe(1)
    expect((await session(w.sessionId)).transactionCount).toBe(1)
  }, 60_000)

  it('the same key with a different body is refused with 422 and changes nothing', async () => {
    const w = await world()
    await post(w.url, w.token, saleBody(String(w.product._id), 2), 'sale-key-0003')

    const other = await post(w.url, w.token, saleBody(String(w.product._id), 3), 'sale-key-0003')

    expect(other.status).toBe(422)
    expect(other.json.code).toBe('idempotency_key_reused')
    expect(fiscalReceipts(w.sim)).toHaveLength(1)
    expect(await Invoice.countDocuments({ orgId: w.orgId, type: 'cash_sale' }).exec()).toBe(1)
  }, 60_000)

  it('a malformed key is refused rather than ignored', async () => {
    const w = await world()
    const res = await post(w.url, w.token, saleBody(String(w.product._id)), 'short')
    expect(res.status).toBe(400)
    expect(res.json.code).toBe('idempotency_key_invalid')
    expect(fiscalReceipts(w.sim)).toHaveLength(0)
  }, 60_000)

  it('without a key, two requests are two sales — today\'s behaviour (the kill switch)', async () => {
    const w = await world()
    const body = saleBody(String(w.product._id))
    await post(w.url, w.token, body)
    await post(w.url, w.token, body)
    expect(fiscalReceipts(w.sim)).toHaveLength(2)
    expect((await session(w.sessionId)).transactionCount).toBe(2)
  }, 60_000)
})

describe('a sale interrupted by a crash is finished by its retry, never printed twice (AC 57)', () => {
  /**
   * The record the route leaves when the process dies right after storing `attemptedAt` and the
   * device's counter — the moment before (or while) the device prints.
   */
  async function interruptedSale(w: Awaited<ReturnType<typeof world>>, key: string) {
    const body = saleBody(String(w.product._id))
    const counterBefore = await w.eltrade.getLastReceiptNumber()
    const unpNumber = await generateUNP(w.orgId, 'ED123456', '0001')
    // FR-21.26: an older release's row, inserted as it left it (the model refuses writes).
    await createTestPOSTransaction(w.orgId as any, w.sessionId as any, w.user._id as any, {
      ...body, orgId: w.orgId, sessionId: w.sessionId,
      transactionNumber: await getNextNumber(w.orgId, 'TXN', 7), status: 'completed',
      unpNumber, fiscalDeviceNumber: 'ED123456', isFiscal: true,
      fiscal: { state: 'pending', mode: 'fiscal', attemptedAt: new Date(), counterBefore },
      clientKey: key, requestHash: requestHash(`pos.sale:${w.sessionId}`, body),
      leaseUntil: new Date(Date.now() - 1000), // the process that held it is gone
      createdBy: String(w.user._id),
    } as any)
    // R4: 0008/0009 copied the row with its key, its fiscal step and its counter; the retry resumes that.
    await migrateTill(w.orgId)
    return { body, unpNumber, counterBefore: counterBefore! }
  }

  it('died before the device printed: the retry prints one receipt and finishes every step', async () => {
    const w = await world()
    const { body, unpNumber } = await interruptedSale(w, 'crash-key-0001')

    const res = await post(w.url, w.token, body, 'crash-key-0001')

    expect(res.status).toBe(200)
    expect(res.json.receiptError).toBeUndefined()
    expect(fiscalReceipts(w.sim)).toHaveLength(1)
    expect(w.sim.receipts[0].header[1]).toBe(unpNumber)
    expect(res.json.transaction.fiscalReceiptNumber).toBe(w.sim.receipts[0].number)
    expect(await movements(w.orgId)).toBe(1)
    expect((await session(w.sessionId)).transactionCount).toBe(1)

    // And the retry of the retry changes nothing.
    await post(w.url, w.token, body, 'crash-key-0001')
    expect(fiscalReceipts(w.sim)).toHaveLength(1)
    expect((await session(w.sessionId)).transactionCount).toBe(1)
  }, 60_000)

  it('died after the device printed: the retry records that receipt and prints nothing', async () => {
    const w = await world()
    const { body, unpNumber } = await interruptedSale(w, 'crash-key-0002')
    // The device printed the receipt; the process died before saving its number.
    await w.eltrade.openFiscalReceipt('0001', 'Иван Петров', unpNumber)
    await w.eltrade.printSaleLine('Болт DIN 933 М8Х25', 2, 12, 'Б' as any, undefined, 20)
    await w.eltrade.printPayment('cash' as any, 24)
    const printed = await w.eltrade.closeFiscalReceipt()

    const res = await post(w.url, w.token, body, 'crash-key-0002')

    expect(res.status).toBe(200)
    expect(fiscalReceipts(w.sim)).toHaveLength(1)
    expect(res.json.transaction.fiscalReceiptNumber).toBe(printed.fiscalReceiptNumber)
    expect(res.json.transaction.fiscal.state).toBe('printed')
    expect(await movements(w.orgId)).toBe(1)
    expect((await session(w.sessionId)).transactionCount).toBe(1)
  }, 60_000)

  it('the device moved on by more than one document: unknown, not reprinted, the cashier is told', async () => {
    const w = await world()
    const { body } = await interruptedSale(w, 'crash-key-0003')
    w.sim.lastDocNumber += 2

    const res = await post(w.url, w.token, body, 'crash-key-0003')

    expect(res.status).toBe(200)
    expect(fiscalReceipts(w.sim)).toHaveLength(0)
    expect(res.json.transaction.fiscal.state).toBe('unknown')
    expect(res.json.receiptError).toMatch(/cannot confirm/)
    // The rest of the sale still completes — the goods left and the money is in the drawer.
    expect(await movements(w.orgId)).toBe(1)
    expect((await session(w.sessionId)).transactionCount).toBe(1)
  }, 60_000)

  it('a device that cannot report its counter (Tremol): unknown, never reprinted', async () => {
    // The Eltrade driver with the counter read removed — what a Tremol offers today.
    const w = await world((sim, deviceId) => {
      const p = new EltradeFiscalPrinter(sim.exchange, deviceId) as any
      return new Proxy(p, { get: (t, k) => (k === 'getLastReceiptNumber' ? undefined : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) })
    })
    const body = saleBody(String(w.product._id))
    await createTestPOSTransaction(w.orgId as any, w.sessionId as any, w.user._id as any, {
      ...body, orgId: w.orgId, sessionId: w.sessionId,
      transactionNumber: await getNextNumber(w.orgId, 'TXN', 7), status: 'completed',
      unpNumber: await generateUNP(w.orgId, 'ED123456', '0001'), fiscalDeviceNumber: 'ED123456', isFiscal: true,
      fiscal: { state: 'pending', mode: 'fiscal', attemptedAt: new Date() },
      clientKey: 'crash-key-0004', requestHash: requestHash(`pos.sale:${w.sessionId}`, body),
      leaseUntil: new Date(Date.now() - 1000), createdBy: String(w.user._id),
    } as any)
    await migrateTill(w.orgId)

    const res = await post(w.url, w.token, body, 'crash-key-0004')

    expect(res.status).toBe(200)
    expect(fiscalReceipts(w.sim)).toHaveLength(0)
    expect(res.json.transaction.fiscal.state).toBe('unknown')
  }, 60_000)

  it('a retry while another request still holds the sale waits for it instead of starting again', async () => {
    const w = await world()
    const body = saleBody(String(w.product._id))
    const first = post(w.url, w.token, body, 'wait-key-0001')
    // Let the first request insert and take the lease before the duplicate arrives.
    await new Promise(r => setTimeout(r, 20))
    const second = await post(w.url, w.token, body, 'wait-key-0001')
    const a = await first

    expect(second.status).toBe(200)
    expect(second.json.transaction.id).toBe(a.json.transaction.id)
    expect(fiscalReceipts(w.sim)).toHaveLength(1)
  }, 60_000)
})

describe('storno, session open and session close with a key', () => {
  async function soldOnce(w: Awaited<ReturnType<typeof world>>) {
    const sale = await post(w.url, w.token, saleBody(String(w.product._id)), 'sale-for-storno-1')
    expect(sale.status).toBe(200)
    return sale.json.transaction.id as string
  }
  const stornoUrl = (w: Awaited<ReturnType<typeof world>>) => w.url.replace(/\/transaction$/, '/storno')
  const stornoReceipts = (sim: EltradeSimulator) => sim.receipts.filter(r => r.kind === 'storno' && !r.voided)

  it('a storno sent 3 times concurrently with one key: one storno, one storno receipt, one refund', async () => {
    const w = await world()
    const saleId = await soldOnce(w)
    const body = { originalTransactionId: saleId, reason: 'customer_return' }

    const answers = await Promise.all([1, 2, 3].map(() => post(stornoUrl(w), w.token, body, 'storno-key-0001')))

    expect(answers.map(a => a.status)).toEqual([200, 200, 200])
    expect(new Set(answers.map(a => a.json.transaction.id)).size).toBe(1)
    expect(stornoReceipts(w.sim)).toHaveLength(1)
    expect(await Invoice.countDocuments({ orgId: w.orgId, type: 'cash_storno' }).exec()).toBe(1)
    expect(await StockMovement.countDocuments({ orgId: w.orgId, type: 'return' }).exec()).toBe(1)
    const s = await session(w.sessionId)
    expect(s.totalReturns).toBe(24)
    expect(s.transactionCount).toBe(2)
  }, 60_000)

  it('a duplicate that reads the sale after the first claimed it, before its row exists, answers as the first does', async () => {
    const w = await world()
    const saleId = await soldOnce(w)
    const body = { originalTransactionId: saleId, reason: 'customer_return' }

    // The window, held open: the first request has claimed the sale and not yet written its storno.
    await Invoice.updateOne({ _id: saleId }, { $set: { 'register.stornoState': 'full' } }).exec()
    const duplicate = post(stornoUrl(w), w.token, body, 'storno-key-0003')
    await new Promise(res => setTimeout(res, 250))
    // ...and now the first request itself runs.
    await Invoice.updateOne({ _id: saleId }, { $set: { 'register.stornoState': 'none' } }).exec()
    const first = await post(stornoUrl(w), w.token, body, 'storno-key-0003')
    const late = await duplicate

    expect([first.status, late.status]).toEqual([200, 200])
    expect(late.json.transaction.id).toBe(first.json.transaction.id)
    expect(stornoReceipts(w.sim)).toHaveLength(1)
  }, 60_000)

  it('a keyed storno of a sale another request reversed is refused at once, not after the wait', async () => {
    const w = await world()
    const saleId = await soldOnce(w)
    const body = { originalTransactionId: saleId, reason: 'customer_return' }
    expect((await post(stornoUrl(w), w.token, body, 'storno-key-0004')).status).toBe(200)

    const started = Date.now()
    const other = await post(stornoUrl(w), w.token, body, 'storno-key-0005')
    expect(other.status).toBe(400)
    expect(other.json.message).toContain('already cancelled')
    expect(Date.now() - started).toBeLessThan(1000)
  }, 60_000)

  it('a storno retried after success returns it, instead of "already cancelled"', async () => {
    const w = await world()
    const saleId = await soldOnce(w)
    const body = { originalTransactionId: saleId, reason: 'customer_return' }
    const first = await post(stornoUrl(w), w.token, body, 'storno-key-0002')
    const again = await post(stornoUrl(w), w.token, body, 'storno-key-0002')

    expect(again.status).toBe(200)
    expect(again.json.transaction.id).toBe(first.json.transaction.id)
    expect(stornoReceipts(w.sim)).toHaveLength(1)

    const other = await post(stornoUrl(w), w.token, { ...body, reason: 'operator_error' }, 'storno-key-0002')
    expect(other.status).toBe(422)
  }, 60_000)

  it('a session open retried with its key returns the same session', async () => {
    const w = await world()
    const openUrl = `/org/${w.orgId}/trade/pos/session`
    // The world's session belongs to this cashier; close it out of the way first.
    await POSSession.updateOne({ _id: w.sessionId }, { $set: { status: 'closed' } }).exec()
    const body = { warehouseId: String((await session(w.sessionId)).warehouseId), openingBalance: 50, currency: 'EUR' }

    const [a, b] = await Promise.all([post(openUrl, w.token, body, 'open-key-0001'), post(openUrl, w.token, body, 'open-key-0001')])
    const c = await post(openUrl, w.token, body, 'open-key-0001')

    expect([a.status, b.status, c.status]).toEqual([200, 200, 200])
    expect(new Set([a, b, c].map(x => x.json.session.id)).size).toBe(1)
    expect(await POSSession.countDocuments({ orgId: w.orgId, status: 'open' }).exec()).toBe(1)
  }, 60_000)

  it('a session close retried with its key: one Z-report, and the close comes back', async () => {
    const w = await world()
    await soldOnce(w)
    const closeUrl = `/org/${w.orgId}/trade/pos/session/${w.sessionId}/close`
    const body = { counted: { cash: 24 } }
    const zReports = () => w.sim.reports.filter(r => r.cmd === 0x45).length

    const [a, b] = await Promise.all([post(closeUrl, w.token, body, 'close-key-0001'), post(closeUrl, w.token, body, 'close-key-0001')])
    const c = await post(closeUrl, w.token, body, 'close-key-0001')

    expect([a.status, b.status, c.status]).toEqual([200, 200, 200])
    expect(zReports()).toBe(1)
    expect(c.json.fiscalStatus).toBe('closed')
    expect(c.json.session.status).toBe('closed')

    const other = await post(closeUrl, w.token, { counted: { cash: 25 } }, 'close-key-0001')
    expect(other.status).toBe(422)
  }, 60_000)
})
