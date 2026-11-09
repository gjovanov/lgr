import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import type { Elysia } from 'elysia'
import { mongoose } from 'db/connection'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { createTestInvoice } from '../helpers/factories'
import { Invoice, Org, StockMovement } from 'db/models'
import { rollBack } from 'services/biz/cash-register/register.service'

/**
 * #454: the transfers a document asks for are drawn up before it is written or issued, and confirmed by it.
 * A request that will not go through never confirms them, and a draft left behind stays in the movements list
 * and moves goods if somebody confirms it. The next attempt draws up its own.
 *
 * What a refusal cancels: the drafts the caller drew up. Never a confirmed transfer (a real movement), and never
 * a colleague's draft the request named.
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

let seq = 0
async function transfer(w: TillWorld, status: 'draft' | 'completed', createdBy: unknown = w.user._id): Promise<string> {
  const m: any = await StockMovement.create({
    orgId: w.oid, movementNumber: `SM-2026-9${String(++seq).padStart(4, '0')}`, type: 'transfer', status, date: new Date(),
    fromWarehouseId: w.warehouse._id, toWarehouseId: w.warehouse._id, createdBy,
    lines: [{ productId: w.product._id, quantity: 1, unitCost: 1, totalCost: 1 }],
  })
  return String(m._id)
}
const statusOf = async (id: string) => ((await StockMovement.findById(id).lean().exec()) as any)?.status

describe('a joined sale refused before it is written (#454)', () => {
  it('a total that does not add up cancels its own drafts, and nothing else', async () => {
    const w = await tillWorld(app)
    const own = await transfer(w, 'draft')
    const confirmed = await transfer(w, 'completed')
    const colleagues = await transfer(w, 'draft', w.clerk._id)

    const r = await w.cashierBackOfficeSale(2, { total: 999, pendingTransferIds: [own, confirmed, colleagues] })

    expect(r.status).toBe(422)
    expect(r.json.code).toBe('cash_sale_total_mismatch')
    expect(await statusOf(own)).toBe('cancelled')
    expect(await statusOf(confirmed)).toBe('completed')
    expect(await statusOf(colleagues)).toBe('draft')
    expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_sale' })).toBe(0)
  }, 60_000)

  it('a refusal by the register (no printer) cancels them too', async () => {
    const w = await tillWorld(app)
    await Org.updateOne({ _id: w.oid }, { $set: { 'settings.cashRegister.requireConnectedDevice': true } })
    forgetDevices()
    const own = await transfer(w, 'draft')

    const r = await w.cashierBackOfficeSale(1, { receipt: 'fiscal', pendingTransferIds: [own] })

    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(await statusOf(own)).toBe('cancelled')
    expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_sale' })).toBe(0)
  }, 60_000)

  it('a sale refused for want of a session (#492) cancels its own drafts too', async () => {
    const w = await tillWorld(app)
    const own = await transfer(w, 'draft', w.clerk._id)

    const r = await w.backOfficeSale(1, { pendingTransferIds: [own] })   // the clerk, who has no session

    expect(r.status).toBe(409)
    expect(r.json).toMatchObject({ code: 'fiscal_device_not_connected', noSession: true })
    expect(await statusOf(own)).toBe('cancelled')
    expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_sale' })).toBe(0)
  }, 60_000)

  it('a refused list of transfers cancels the drafts in it', async () => {
    const w = await tillWorld(app)
    const own = await transfer(w, 'draft')
    const nowhere = String(new mongoose.Types.ObjectId())

    const r = await w.cashierBackOfficeSale(1, { pendingTransferIds: [own, nowhere] })

    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(r.status).toBeLessThan(500)
    expect(await statusOf(own)).toBe('cancelled')
  }, 60_000)

  it('a sale that goes through confirms them, as before', async () => {
    const w = await tillWorld(app)
    await Org.updateOne({ _id: w.oid }, { $set: { 'settings.cashRegister.requireConnectedDevice': false } })
    const own = await transfer(w, 'draft')

    const r = await w.cashierBackOfficeSale(1, { pendingTransferIds: [own] })

    expect(r.status).toBe(200)
    expect(await statusOf(own)).toBe('completed')
  }, 60_000)
})

describe('an issue whose transfers cannot be confirmed (#454)', () => {
  it('cancels the drafts it did not confirm, and leaves the invoice a draft', async () => {
    const w = await tillWorld(app)
    const own = await transfer(w, 'draft')
    const nowhere = String(new mongoose.Types.ObjectId())
    const draft: any = await createTestInvoice(w.oid, undefined as any, { status: 'draft', direction: 'outgoing', type: 'invoice', lines: [] } as any)

    const r = await w.call('POST', `/invoices/${draft._id}/send`, { pendingTransferIds: [own, nowhere] })

    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(r.status).toBeLessThan(500)
    expect(await statusOf(own)).toBe('cancelled')
    expect(((await Invoice.findById(draft._id).lean().exec()) as any).status).toBe('draft')
  }, 60_000)
})

describe('a sale rolled back before it reached the device or the drawer (#454)', () => {
  it('takes its unconfirmed transfers with it; a confirmed one stays', async () => {
    const w = await tillWorld(app)
    const own = await transfer(w, 'draft')
    const confirmed = await transfer(w, 'completed')
    const doc: any = await Invoice.create({
      orgId: w.oid, invoiceNumber: '~pending:test', type: 'cash_sale', direction: 'outgoing', status: 'paid',
      issueDate: new Date(), dueDate: new Date(), currency: 'EUR', exchangeRate: 1, lines: [],
      subtotal: 0, taxTotal: 0, total: 0, totalBase: 0, amountPaid: 0, amountDue: 0, createdBy: w.user._id,
      contactId: new mongoose.Types.ObjectId(), billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
      register: { origin: 'backoffice', transfersToConfirm: [own, confirmed] },
    } as any)

    await rollBack(doc.toObject())

    expect(await Invoice.exists({ _id: doc._id })).toBeNull()
    expect(await statusOf(own)).toBe('cancelled')
    expect(await statusOf(confirmed)).toBe('completed')
  }, 60_000)
})
