import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import type { Elysia } from 'elysia'
import type { Types } from 'mongoose'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestPOSTransaction } from '../helpers/factories'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { requestHash } from 'services/biz/hot-path-key'
import { Invoice, POSSession, POSTransaction, StockMovement } from 'db/models'

/**
 * FR-21.10 / §6 edge 1 — a keyed till request across the deploy.
 *
 * The till sends one `Idempotency-Key` per attempt and repeats it on a retry. A request that an R1
 * binary answered — or left half-done — is retried against R2, which writes documents: the retry
 * must find the sale in the OLD store, copy it, and replay or finish it there. Never a second
 * sale, a second УНП or a second receipt. (The reverse, R2 → R1, is R1's own test: its code replays
 * a document it cannot write, `cash-register-immutability.flow` on R1.)
 *
 * `pos-idempotency.flow` runs #155's cases on the new store, its crash cases included: they leave
 * a POS row mid-sale, which is exactly what an R1 pod dying during the deploy leaves.
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

/** The POS row an R1 till wrote for this request: finished, its receipt printed, its stock moved. */
async function soldByR1(w: TillWorld, key: string, quantity = 2) {
  const body = w.saleBody(quantity)
  const dispatch = await StockMovement.create({
    orgId: w.oid, movementNumber: 'SM-2026-00777', type: 'dispatch', status: 'completed', date: new Date(),
    fromWarehouseId: w.warehouse._id, notes: 'POS sale TXN-2026-0000077',
    lines: [{ productId: w.product._id, quantity, unitCost: 10, totalCost: 10 * quantity, resolvedUnitCost: 4 }],
    totalAmount: 10 * quantity, createdBy: w.user._id,
  } as any)
  const row = await createTestPOSTransaction(w.oid, w.sessionId as any, w.user._id as Types.ObjectId, {
    ...body, transactionNumber: 'TXN-2026-0000077', status: 'completed',
    unpNumber: 'ED123456-0001-0000041', fiscalReceiptNumber: '0000117', fiscalDeviceNumber: 'ED123456', isFiscal: true,
    fiscal: { state: 'printed', mode: 'fiscal', receiptNo: '0000117' }, sessionTotalsApplied: true, movementId: dispatch._id,
    clientKey: key, requestHash: requestHash(`pos.sale:${w.sessionId}`, body), completedAt: new Date(),
  } as any)
  await POSSession.updateOne({ _id: w.sessionId }, { $inc: { totalSales: 12 * quantity, totalCash: 12 * quantity, transactionCount: 1 } }).exec()
  return { body, row, dispatch }
}

describe('a keyed till request an R1 till answered, retried against R2', () => {
  it('is copied and replayed: no second document, УНП or receipt, and the POS row stays as it was', async () => {
    const w = await tillWorld(app)
    const { body, row, dispatch } = await soldByR1(w, 'deploy-key-0001')
    const before: any = await POSTransaction.findById(row._id).lean()

    const res = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, body, 'deploy-key-0001')

    expect(res.status).toBe(200)
    expect(res.json.transaction).toMatchObject({
      id: String(row._id), transactionNumber: 'TXN-2026-0000077', unpNumber: 'ED123456-0001-0000041', fiscalReceiptNumber: '0000117',
    })
    expect(await Invoice.countDocuments({ orgId: w.oid })).toBe(1)
    expect(w.sim!.receipts).toHaveLength(0)
    expect((await POSSession.findById(w.sessionId).lean() as any).transactionCount).toBe(1)
    expect(await StockMovement.countDocuments({ orgId: w.oid, type: 'dispatch' })).toBe(1)
    // The copy names its movement, and the frozen row is untouched.
    expect(String((await StockMovement.findById(dispatch._id).lean() as any).invoiceId)).toBe(String(row._id))
    expect(((await POSTransaction.findById(row._id).lean()) as any).updatedAt).toEqual(before.updatedAt)

    // A second retry reads the copy.
    const again = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, body, 'deploy-key-0001')
    expect(again.json.transaction.id).toBe(String(row._id))
    expect(await Invoice.countDocuments({ orgId: w.oid })).toBe(1)
  }, 60_000)

  it('the same key on a different request is 422, whichever store holds it', async () => {
    const w = await tillWorld(app)
    await soldByR1(w, 'deploy-key-0002')
    const res = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, w.saleBody(3), 'deploy-key-0002')
    expect(res.status).toBe(422)
    expect(res.json.code).toBe('idempotency_key_reused')
    expect(w.sim!.receipts).toHaveLength(0)
  }, 60_000)

  it('a keyed storno an R1 till made: the storno and its sale are copied, and the storno is replayed', async () => {
    const w = await tillWorld(app)
    const { row } = await soldByR1(w, 'deploy-key-0003')
    await POSTransaction.collection.updateOne({ _id: row._id }, { $set: { status: 'cancelled' } })
    const stornoBody = { originalTransactionId: String(row._id), reason: 'customer_return' }
    const stornoRow = await createTestPOSTransaction(w.oid, w.sessionId as any, w.user._id as Types.ObjectId, {
      type: 'storno', status: 'completed', transactionNumber: 'TXN-2026-0000078', total: 24, subtotal: 20, taxTotal: 4,
      lines: (row as any).lines, payments: [{ method: 'cash', amount: 24 }], originalTransactionId: row._id,
      clientKey: 'deploy-storno-01', requestHash: requestHash(`pos.storno:${w.sessionId}`, stornoBody), completedAt: new Date(),
    } as any)

    const res = await w.call('POST', `/trade/pos/session/${w.sessionId}/storno`, stornoBody, 'deploy-storno-01')

    expect(res.status).toBe(200)
    expect(res.json.transaction.id).toBe(String(stornoRow._id))
    const sale: any = await Invoice.findById(row._id).lean()
    expect(sale.register.stornoState).toBe('full')
    expect(sale.register.stornoedBy.map(String)).toEqual([String(stornoRow._id)])
    expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_storno' })).toBe(1)
    expect(w.sim!.receipts).toHaveLength(0)
  }, 60_000)
})

describe('a keyed till sale under R2', () => {
  it('a keyed back-office create cannot take the key a till document holds', async () => {
    const w = await tillWorld(app, { device: false })
    const sale = await w.sell(1, {}, 'shared-key-0001')
    expect(sale.status).toBe(200)
    const res = await w.call('POST', '/invoices', {
      type: 'cash_sale', direction: 'outgoing', issueDate: '2026-10-26', currency: 'EUR',
      lines: [{ productId: String(w.product._id), warehouseId: String(w.warehouse._id), description: 'x', quantity: 1, unitPrice: 10, taxRate: 20 }],
      subtotal: 10, total: 12, paymentMethod: 'cash',
    }, 'shared-key-0001')
    expect(res.status).toBe(422)
    expect(await Invoice.countDocuments({ orgId: w.oid })).toBe(1)
  }, 60_000)
})
