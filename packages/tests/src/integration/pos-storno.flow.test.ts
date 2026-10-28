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
} from '../helpers/factories'
import { EltradeSimulator } from '../helpers/eltrade-simulator'
import { posController, stornoRefundBuckets, expectedTotals } from 'invoicing-api/src/controllers/pos.controller'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { Invoice, POSSession, POSTransaction, StockLevel } from 'db/models'
import { tillRow } from '../helpers/till-row'
import { getRepos } from 'services/context'
import { getNextNumber } from 'services/biz/sequence.service'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * #145 — STORNO from the cash-sales journal: the goods go back, the register goes DOWN, and the
 * fiscal device prints the storno receipt. Three defects the button would have exposed:
 *
 *   1. only `totalReturns` moved, so after a cash refund the close screen still expected the
 *      refunded cash in the drawer;
 *   2. a storno receipt that FAILED to print still cancelled the sale, put the stock back and
 *      counted the refund — LGR and the device's Z-report disagreed with nothing marking it;
 *   3. read-then-write: two clicks could both refund the same sale.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in CLAUDE.md's Known Issues.
 */

let app: Elysia
const registered: string[] = []

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(posController)
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

afterEach(async () => {
  for (const id of registered.splice(0)) unregisterPrinter(id)
  await clearCollections()
}, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string }) {
  return (signer as any).decorator.jwt.sign({
    id: u.id, orgId: u.orgId, role: 'admin',
    email: 'cashier@test.com', username: 'cashier', firstName: 'Иван', lastName: 'Петров',
    operatorCode: '0001', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}

async function post(path: string, token: string, body: any) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }))
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

/** 2 × 10.00 net at 20 % → 24.00, paid with 30.00 cash → 6.00 change. */
function saleBody(productId: string, nonFiscal = true) {
  return {
    type: 'sale',
    lines: [{ productId, name: 'Болт DIN 933 М8Х20', quantity: 2, unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 4, lineTotal: 20 }],
    subtotal: 20, discountTotal: 0, taxTotal: 4, total: 24,
    payments: [{ method: 'cash', amount: 30 }],
    changeDue: 6,
    nonFiscal,
  }
}

async function openSession(orgId: string, warehouseId: string, cashierId: string) {
  return getRepos().posSessions.create({
    orgId, warehouseId, cashierId,
    sessionNumber: await getNextNumber(orgId, 'POS', 6),
    openedAt: new Date(), status: 'open', openingBalance: 100, currency: 'EUR',
    totalSales: 0, totalReturns: 0, totalCash: 0, totalCard: 0, totalOther: 0, transactionCount: 0,
  } as any)
}

async function world() {
  const org = await createTestOrg()
  const warehouse = await createTestWarehouse(org._id)
  const user = await createTestUser(org._id, { operatorCode: '0001' } as any)
  const product = await createTestProduct(org._id, { sellingPrice: 10, taxRate: 20 } as any)
  await createTestStockLevel(org._id, product._id, warehouse._id, { quantity: 10, availableQuantity: 10 } as any)
  const session = await openSession(String(org._id), String(warehouse._id), String(user._id))
  const token = await tokenFor({ id: String(user._id), orgId: String(org._id) })
  const base = `/org/${org._id}/trade/pos/session/${session.id}`
  return { org, warehouse, user, product, session, token, base }
}

async function sell(w: Awaited<ReturnType<typeof world>>, nonFiscal = true) {
  const { status, json } = await post(`${w.base}/transaction`, w.token, saleBody(String(w.product._id), nonFiscal))
  expect(status).toBe(200)
  return String(json.transaction.id || json.transaction._id)
}

const sessionOf = (w: { session: { id: string } }) => POSSession.findById(w.session.id).lean().exec() as any
/** FR-21: a till sale is a cash-register document since R2; read as the POS row it stands for. */
const txnById = (id: string) => tillRow(id)
async function stockOf(w: Awaited<ReturnType<typeof world>>) {
  const level = await StockLevel.findOne({ orgId: w.org._id, productId: w.product._id, warehouseId: w.warehouse._id }).lean().exec() as any
  return level.quantity
}

describe('POS storno (#145)', () => {
  it('takes the refund back out of the register, not only into totalReturns', async () => {
    const w = await world()
    const saleId = await sell(w)
    // The sale kept 24.00 of the 30.00 tendered: opening 100 + 24 expected in the drawer.
    expect(expectedTotals(await sessionOf(w)).cash).toBe(124)

    const { status, json } = await post(`${w.base}/storno`, w.token, { originalTransactionId: saleId, reason: 'customer_return' })

    expect(status).toBe(200)
    expect(json.receiptError).toBeUndefined()
    const s = await sessionOf(w)
    expect(s.totalReturns).toBe(24)
    // ⚠ The point: the close screen now expects the float only — the 24.00 went back to the customer.
    expect(expectedTotals(s).cash).toBe(100)
    expect((await txnById(saleId)).status).toBe('cancelled')
    expect(await stockOf(w)).toBe(10)
  })

  it('refuses a second storno of the same sale', async () => {
    const w = await world()
    const saleId = await sell(w)
    expect((await post(`${w.base}/storno`, w.token, { originalTransactionId: saleId, reason: 'customer_return' })).status).toBe(200)

    const again = await post(`${w.base}/storno`, w.token, { originalTransactionId: saleId, reason: 'customer_return' })

    expect(again.status).toBe(400)
    expect(expectedTotals(await sessionOf(w)).cash).toBe(100)
    expect(await stockOf(w)).toBe(10)
  })

  it('refunds exactly once when two stornos of the same sale race', async () => {
    const w = await world()
    const saleId = await sell(w)

    const results = await Promise.all([
      post(`${w.base}/storno`, w.token, { originalTransactionId: saleId, reason: 'customer_return' }),
      post(`${w.base}/storno`, w.token, { originalTransactionId: saleId, reason: 'customer_return' }),
    ])

    expect(results.filter(r => r.status === 200)).toHaveLength(1)
    const s = await sessionOf(w)
    expect(s.totalReturns).toBe(24)
    expect(expectedTotals(s).cash).toBe(100)
    expect(await stockOf(w)).toBe(10) // not 12: the goods came back once
    // One storno document, which counts; the till writes no POS row any more.
    expect(await Invoice.countDocuments({ orgId: w.org._id, type: 'cash_storno', status: 'paid' })).toBe(1)
    expect(await POSTransaction.countDocuments({ orgId: w.org._id })).toBe(0)
  })

  it('reverses NOTHING when the fiscal storno receipt fails to print', async () => {
    const w = await world()
    const device = await createTestFiscalDevice(w.org._id, w.warehouse._id, {
      name: 'Eltrade A3', deviceNumber: 'ED123456', manufacturer: 'eltrade', connectionType: 'browser', status: 'online',
    } as any)
    const deviceId = String(device._id)
    const sim = new EltradeSimulator()
    const printer = new EltradeFiscalPrinter(sim.exchange, deviceId)
    registerPrinter(deviceId, printer)
    registered.push(deviceId)

    // A real FISCAL sale, so the storno has a fiscal receipt to cite and must print one.
    const saleId = await sell(w, false)
    const sale = await txnById(saleId)
    expect(sale.isFiscal).toBe(true)
    expect(sale.fiscalReceiptNumber).toBeTruthy()
    const before = await sessionOf(w)
    const stockBefore = await stockOf(w)

    ;(printer as any).printStornoReceipt = async () => { throw new Error('paper out') }
    const { status, json } = await post(`${w.base}/storno`, w.token, { originalTransactionId: saleId, reason: 'customer_return' })

    expect(status).toBe(503)
    expect(json.code).toBe('fiscal_error')
    expect(json.message).toContain('paper out')
    // The sale stands, the drawer and the stock are untouched — LGR agrees with the device.
    expect((await txnById(saleId)).status).toBe('completed')
    const after = await sessionOf(w)
    expect(after.totalReturns).toBe(before.totalReturns)
    expect(after.totalCash).toBe(before.totalCash)
    expect(await stockOf(w)).toBe(stockBefore)
    // The attempted storno is voided, not left looking like a completed refund.
    const stornos = await Invoice.find({ orgId: w.org._id, type: 'cash_storno' }).lean().exec() as any[]
    expect(stornos.length).toBe(1)
    expect(stornos.every(t => t.status === 'voided')).toBe(true)

    // And it can simply be retried once the printer is back.
    delete (printer as any).printStornoReceipt
    const retry = await post(`${w.base}/storno`, w.token, { originalTransactionId: saleId, reason: 'customer_return' })
    expect(retry.status).toBe(200)
    expect(retry.json.receiptError).toBeUndefined()
    expect((await txnById(saleId)).status).toBe('cancelled')
  })

  it('refuses a storno from a session of another warehouse', async () => {
    const w = await world()
    const saleId = await sell(w)
    const otherWarehouse = await createTestWarehouse(w.org._id, { name: 'Склад 2', code: 'WH2' } as any)
    const other = await openSession(String(w.org._id), String(otherWarehouse._id), String(w.user._id))

    const { status, json } = await post(`/org/${w.org._id}/trade/pos/session/${other.id}/storno`, w.token, {
      originalTransactionId: saleId, reason: 'customer_return',
    })

    expect(status).toBe(400)
    expect(json.code).toBe('storno_other_warehouse')
    expect((await txnById(saleId)).status).toBe('completed')
  })
})

describe('stornoRefundBuckets', () => {
  it('mirrors the sale: cash kept = tendered − change', () => {
    expect(stornoRefundBuckets(undefined, { payments: [{ method: 'cash', amount: 30 }], changeDue: 6 }))
      .toEqual({ cash: 24, card: 0, other: 0 })
  })

  it('splits a mixed tender into its buckets, old mobile/voucher tenders into other', () => {
    expect(stornoRefundBuckets(undefined, {
      payments: [{ method: 'card', amount: 15 }, { method: 'cash', amount: 10 }, { method: 'voucher', amount: 5 }],
      changeDue: 1,
    })).toEqual({ cash: 9, card: 15, other: 5 })
  })

  it('uses the refund the operator states when one is given', () => {
    expect(stornoRefundBuckets([{ method: 'card', amount: 24 }], { payments: [{ method: 'cash', amount: 30 }], changeDue: 6 }))
      .toEqual({ cash: 0, card: 24, other: 0 })
  })

  it('never goes negative', () => {
    expect(stornoRefundBuckets(undefined, { payments: [], changeDue: 3 })).toEqual({ cash: 0, card: 0, other: 0 })
  })
})
