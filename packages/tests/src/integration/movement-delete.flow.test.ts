import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestUser, createTestWarehouse } from '../helpers/factories'
import { movementController } from 'warehouse-api/src/controllers/movement.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import { DocFile, Invoice, StockLevel, StockMovement } from 'db/models'

/**
 * #448: a draft stock movement could not be removed. One saved by mistake stayed in the list for good,
 * and moved goods if somebody confirmed it; field tests left them behind, and removing them took a
 * write to the database.
 *
 * `DELETE` takes a draft that nothing else names. It and `confirmMovement` take the same hold, so a
 * delete can never land in the middle of a confirm that has already moved stock, and two confirms
 * can no longer both move it.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(movementController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const main = await createTestWarehouse(org._id, { isDefault: true } as any)
  const bolt = await createTestProduct(org._id, { sku: 'PRD-0001', name: 'Болт М8', purchasePrice: 5, sellingPrice: 10, taxRate: 20 } as any)
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Мария', lastName: 'Иванова', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })

  async function call(method: string, path: string, body?: any) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }

  /** A receipt into the main warehouse, saved as a draft. */
  const draft = async (quantity = 4) => {
    const res = await call('POST', '/warehouse/movement', {
      type: 'receipt', date: '2026-11-02', toWarehouseId: String(main._id),
      lines: [{ productId: String(bolt._id), quantity, unitCost: 5, totalCost: quantity * 5 }], totalAmount: quantity * 5,
    })
    expect(res.status).toBe(200)
    return String(res.json.stockMovement._id || res.json.stockMovement.id)
  }
  const del = (id: string) => call('DELETE', `/warehouse/movement/${id}`)
  const confirm = (id: string) => call('POST', `/warehouse/movement/${id}/confirm`, {})
  const load = (id: string) => StockMovement.findById(id).lean().exec() as Promise<any>
  const stock = async () =>
    Number(((await StockLevel.findOne({ orgId, productId: bolt._id, warehouseId: main._id }).lean().exec()) as any)?.quantity ?? 0)
  const oid = (id: string) => new mongoose.Types.ObjectId(id)

  return { org, orgId, call, draft, del, confirm, load, stock, oid }
}

describe('DELETE /warehouse/movement/:id', () => {
  it('removes a draft, which moved nothing and moves nothing', async () => {
    const w = await world()
    const id = await w.draft()

    const r = await w.del(id)

    expect(r.status).toBe(200)
    expect(await w.load(id)).toBeNull()
    expect(await w.stock()).toBe(0)
    // Gone means gone: it cannot be confirmed afterwards.
    expect((await w.confirm(id)).status).toBe(404)
  })

  it('refuses a completed movement, which has moved goods', async () => {
    const w = await world()
    const id = await w.draft()
    expect((await w.confirm(id)).status).toBe(200)

    const r = await w.del(id)

    expect(r.status).toBe(400)
    expect((await w.load(id)).status).toBe('completed')
    expect(await w.stock()).toBe(4)
  })

  it('404 for a movement of another org', async () => {
    const a = await world()
    const b = await world()
    const id = await a.draft()

    expect((await b.del(id)).status).toBe(404)
    expect(await a.load(id)).not.toBeNull()
  })

  it('refuses a draft a document names: a sale\'s or an issue\'s transfers, a till\'s, a bill\'s receipts', async () => {
    for (const field of ['pendingTransferIds', 'register.transfersToConfirm', 'register.movementId', 'stockSource.movementIds']) {
      const w = await world()
      const id = await w.draft()
      const ref = field === 'register.movementId' ? w.oid(id) : [w.oid(id)]
      const path = field.split('.')
      const doc: any = { orgId: w.org._id, invoiceNumber: 'INV-2026-00007' }
      if (path.length === 1) doc[path[0]] = ref
      else doc[path[0]] = { [path[1]]: ref }
      await Invoice.collection.insertOne(doc)

      const r = await w.del(id)

      expect(r.status).toBe(409)
      expect(r.json).toMatchObject({ code: 'movement_referenced' })
      expect(r.json.message).toContain('INV-2026-00007')
      expect(await w.load(id)).not.toBeNull()
      await clearCollections()
    }
  })

  it('refuses a draft a Files import booked: its rollback takes it off', async () => {
    const w = await world()
    const id = await w.draft()
    await DocFile.collection.insertOne({ orgId: w.org._id, originalName: 'stokrazp_3000016555.pdf', committedIds: [w.oid(id)] } as any)

    const r = await w.del(id)

    expect(r.status).toBe(409)
    expect(r.json.message).toContain('stokrazp_3000016555.pdf')
    expect(await w.load(id)).not.toBeNull()
  })

  it('refuses a draft drawn up for an invoice', async () => {
    const w = await world()
    const id = await w.draft()
    await StockMovement.updateOne({ _id: id }, { $set: { invoiceId: new mongoose.Types.ObjectId() } })

    expect((await w.del(id)).status).toBe(409)
    expect(await w.load(id)).not.toBeNull()
  })
})

describe('a delete and a confirm: one of them, never both', () => {
  it('a draft a confirm holds is not deleted under it', async () => {
    const w = await world()
    const id = await w.draft()
    await StockMovement.updateOne({ _id: id }, { $set: { claimedUntil: new Date(Date.now() + 60_000) } })

    const r = await w.del(id)

    expect(r.status).toBe(409)
    expect(r.json).toMatchObject({ code: 'movement_busy' })
    expect(await w.load(id)).not.toBeNull()
  })

  it('a hold a crash left behind lapses, and the draft can go', async () => {
    const w = await world()
    const id = await w.draft()
    await StockMovement.updateOne({ _id: id }, { $set: { claimedUntil: new Date(Date.now() - 1000) } })

    expect((await w.del(id)).status).toBe(200)
  })

  it('a confirm on a held draft moves nothing and says so', async () => {
    const w = await world()
    const id = await w.draft()
    await StockMovement.updateOne({ _id: id }, { $set: { claimedUntil: new Date(Date.now() + 60_000) } })

    const r = await w.confirm(id)

    expect(r.status).toBe(409)
    expect(r.json).toMatchObject({ code: 'movement_busy' })
    expect(await w.stock()).toBe(0)
    expect((await w.load(id)).status).toBe('draft')
  })

  it('a confirm lets go of its hold when it is done', async () => {
    const w = await world()
    const id = await w.draft()

    expect((await w.confirm(id)).status).toBe(200)

    const done = await w.load(id)
    expect(done.status).toBe('completed')
    expect(done.claimedUntil ?? null).toBeNull()
  })

  it('two confirms at once move the goods once', async () => {
    const w = await world()
    const id = await w.draft()

    const results = await Promise.all([w.confirm(id), w.confirm(id)])

    // The other finds it held (409) or already completed (400), depending on who got there first.
    expect(results.filter(r => r.status === 200)).toHaveLength(1)
    expect(results.map(r => r.status).every(s => [200, 400, 409].includes(s))).toBe(true)
    expect(await w.stock()).toBe(4)
  })
})
