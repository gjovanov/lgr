import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestContact, createTestOrg, createTestProduct, createTestUser, createTestWarehouse } from '../helpers/factories'
import { uploadPath, useTempUploadDir } from '../helpers/upload-path'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { CostLayer, DocFile, Identity, PermissionSet, StockLevel, StockMovement, Warehouse } from 'db/models'
import { sessionFor } from 'services/biz/auth.service'
import { seedDefaultPermissionSets } from 'services/biz/permission-set.seed'
import { confirmMovement } from 'services/biz/warehouse.service'
import { commitDocuments } from 'services/biz/doc-import/commit'
import { resolveWarehouse } from 'services/biz/doc-import/map-movement'
import { deleteDocFiles } from 'services/biz/files/doc-delete.service'
import { stockMovementDocumentData } from 'services/biz/stock-movement-document.service'

/**
 * An external warehouse: another site's, named in this org so a transfer can say where the goods
 * went or came from. It keeps no stock here.
 *
 * The whole route table is mounted, so every refusal is the one a client gets, and every session is
 * the one sign-in issues. What the tests hold:
 *  - the flag: never with `isDefault`, never put on a warehouse that holds goods;
 *  - a transfer to it takes the goods out of the org's own warehouse and puts them nowhere, a
 *    transfer from it brings them in at the line's cost;
 *  - ⚠ a COMPLETED movement names in `fromWarehouseId` / `toWarehouseId` only warehouses whose stock
 *    it moved (the external one sits in `externalFromWarehouseId` / `externalToWarehouseId`), which
 *    is what every reader that derives stock from movements relies on;
 *  - no other type of movement names one, at any door, and the engine books nothing on one whatever
 *    reaches it.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const sign = (claims: object): Promise<string> => (signer as any).decorator.jwt.sign(claims)
const oid = () => new mongoose.Types.ObjectId()

let app: Elysia
let passwordHash: string
let restoreUploads: () => void

beforeAll(async () => {
  await setupTestDB()
  restoreUploads = useTempUploadDir()
  passwordHash = await Bun.password.hash('test123')
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
}, 60_000)
afterAll(async () => { restoreUploads(); await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

/** A member linked to a person, and their session as sign-in issues it. */
async function member(org: any, role: string, setName?: string) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@extwh.test`
  const identity = await Identity.create({ email, firstName: 'F', lastName: role, isActive: true, passwordSetBy: 'self', password: passwordHash } as any)
  const set = setName ? await PermissionSet.findOne({ orgId: org._id, name: setName }).lean() : null
  const user = await createTestUser(org._id, { role, email, identityId: identity._id, ...(set ? { permissionSetIds: [set._id] } : {}) } as any)
  return { user, token: await sign(await sessionFor(user, identity)) }
}

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const main = await createTestWarehouse(org._id, { name: 'Main warehouse', code: 'MAIN', isDefault: true } as any)
  const second = await createTestWarehouse(org._id, { name: 'Second warehouse', code: 'SECOND' } as any)
  const site = await createTestWarehouse(org._id, { name: 'Other site', code: 'SITE', isExternal: true } as any)
  const bolt = await createTestProduct(org._id, { sku: 'PRD-0001', name: 'Bolt M8', unit: 'pcs', purchasePrice: 5, sellingPrice: 10 } as any)
  const admin = await member(org, 'admin')
  const ids = { main: String(main._id), second: String(second._id), site: String(site._id) }

  function send(method: string, path: string, body?: any, token: string | null = admin.token): Promise<Response> {
    return app.handle(new Request(`http://localhost/api/org/${orgId}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }))
  }
  async function call(method: string, path: string, body?: any, token: string | null = admin.token) {
    const res = await send(method, path, body, token)
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }

  const lines = (quantity = 4, unitCost = 5, product: any = bolt) => [{ productId: String(product._id), quantity, unitCost, totalCost: quantity * unitCost }]
  const movement = (type: string, sides: Record<string, unknown> = {}, quantity = 4, unitCost = 5, product: any = bolt) => ({
    type, date: '2026-11-16', ...sides, lines: lines(quantity, unitCost, product), totalAmount: quantity * unitCost,
  })
  const create = (type: string, sides: Record<string, unknown> = {}, quantity = 4, unitCost = 5, token: string = admin.token) =>
    call('POST', '/warehouse/movement', movement(type, sides, quantity, unitCost), token)
  const confirm = (id: string, token: string = admin.token) => call('POST', `/warehouse/movement/${id}/confirm`, {}, token)
  const idOf = (res: any): string => res.json.stockMovement._id || res.json.stockMovement.id
  /** A draft as it stands in the database: one no door was asked about. */
  const rawDraft = async (type: string, sides: Record<string, unknown>, quantity = 4, unitCost = 5, product: any = bolt) => {
    const doc = await StockMovement.create({
      orgId, movementNumber: `SM-RAW-${oid()}`, status: 'draft', createdBy: admin.user._id, ...movement(type, sides, quantity, unitCost, product),
    } as any)
    return String(doc._id)
  }
  const level = (warehouse: any, product: any = bolt) =>
    StockLevel.findOne({ orgId, productId: product._id, warehouseId: warehouse._id }).lean().exec() as Promise<any>
  const stock = async (warehouse: any = main, product: any = bolt) => Number((await level(warehouse, product))?.quantity ?? 0)
  /** How many level rows the external warehouse has, for any product: it must never get one. */
  const levelsAtSite = () => StockLevel.countDocuments({ orgId, warehouseId: site._id }).exec()
  const load = (id: string) => StockMovement.findById(id).lean().exec() as Promise<any>
  /** Goods on the shelf of one of our own warehouses. */
  const stocked = async (quantity: number, unitCost = 5, warehouse: any = main) => {
    const res = await create('receipt', { toWarehouseId: String(warehouse._id) }, quantity, unitCost)
    expect(res.status).toBe(200)
    expect((await confirm(idOf(res))).status).toBe(200)
  }
  /** A transfer made and booked through the routes; answers its id. */
  const transferred = async (sides: Record<string, unknown>, quantity = 4, unitCost = 5, token: string = admin.token) => {
    const res = await create('transfer', sides, quantity, unitCost, token)
    expect([res.status, res.json?.code]).toEqual([200, undefined])
    const booked = await confirm(idOf(res), token)
    expect([booked.status, booked.json?.code]).toEqual([200, undefined])
    return idOf(res)
  }

  return { org, orgId, main, second, site, ids, bolt, admin, send, call, lines, movement, create, confirm, idOf, rawDraft, level, stock, levelsAtSite, load, stocked, transferred }
}

describe('the flag', () => {
  it('a warehouse is made external, and never both default and external', async () => {
    const w = await world()
    const made = await w.call('POST', '/warehouse/warehouse', { name: 'Third site', code: 'SITE-3', type: 'warehouse', isExternal: true })
    expect(made.status).toBe(200)
    expect(made.json.warehouse.isExternal).toBe(true)
    expect((await Warehouse.findById(made.json.warehouse.id || made.json.warehouse._id).lean().exec() as any).isExternal).toBe(true)

    const before = await Warehouse.countDocuments({ orgId: w.orgId }).exec()
    const both = await w.call('POST', '/warehouse/warehouse', { name: 'Both', code: 'BOTH', type: 'warehouse', isDefault: true, isExternal: true })
    expect([both.status, both.json.code]).toEqual([422, 'external_default'])
    expect(both.json.message).toBeTruthy()
    expect(await Warehouse.countDocuments({ orgId: w.orgId }).exec()).toBe(before)

    // A warehouse made without the flag keeps stock, as every one before it.
    const plain = await w.call('POST', '/warehouse/warehouse', { name: 'Plain', code: 'PLAIN', type: 'warehouse' })
    expect(plain.json.warehouse.isExternal).toBe(false)
  }, 60_000)

  it('an edit is judged as the warehouse would stand: either flag may be the one that changes', async () => {
    const w = await world()
    // The default one marked external.
    const mark = await w.call('PUT', `/warehouse/warehouse/${w.ids.main}`, { isExternal: true })
    expect([mark.status, mark.json.code]).toEqual([422, 'external_default'])
    // The external one made the default.
    const promote = await w.call('PUT', `/warehouse/warehouse/${w.ids.site}`, { isDefault: true })
    expect([promote.status, promote.json.code]).toEqual([422, 'external_default'])
    const stored = await Warehouse.find({ orgId: w.orgId }, { isDefault: 1, isExternal: 1, code: 1 }).sort({ code: 1 }).lean().exec() as any[]
    expect(stored.map(x => [x.code, !!x.isDefault, !!x.isExternal])).toEqual([['MAIN', true, false], ['SECOND', false, false], ['SITE', false, true]])

    // Swapped in one save, while it holds nothing: fine.
    const swap = await w.call('PUT', `/warehouse/warehouse/${w.ids.main}`, { isDefault: false, isExternal: true })
    expect(swap.status).toBe(200)
    expect([swap.json.warehouse.isDefault, swap.json.warehouse.isExternal]).toEqual([false, true])
    // An edit that names neither flag changes neither.
    const rename = await w.call('PUT', `/warehouse/warehouse/${w.ids.site}`, { name: 'Other site, renamed' })
    expect([rename.status, rename.json.warehouse.isExternal]).toEqual([200, true])
  }, 60_000)

  it('a warehouse that holds goods does not become external, and is told how many articles', async () => {
    const w = await world()
    const nut = await createTestProduct(w.org._id, { sku: 'PRD-0002', name: 'Nut M8' } as any)
    await w.stocked(3, 5, w.second)
    await StockLevel.create({ orgId: w.orgId, productId: nut._id, warehouseId: w.second._id, quantity: 0, reservedQuantity: 2, availableQuantity: -2, avgCost: 1 } as any)

    const refused = await w.call('PUT', `/warehouse/warehouse/${w.ids.second}`, { isExternal: true })
    expect([refused.status, refused.json.code, refused.json.articles]).toEqual([422, 'warehouse_holds_stock', 2])
    expect(refused.json.message).toContain('2 articles')
    expect(!!(await Warehouse.findById(w.second._id).lean().exec() as any).isExternal).toBe(false)

    // A reservation alone holds it, and so does a level below zero: both are goods somebody answers for.
    await StockLevel.updateOne({ orgId: w.orgId, productId: w.bolt._id, warehouseId: w.second._id }, { $set: { quantity: 0, availableQuantity: 0 } }).exec()
    const reserved = await w.call('PUT', `/warehouse/warehouse/${w.ids.second}`, { isExternal: true })
    expect([reserved.status, reserved.json.articles]).toEqual([422, 1])
    expect(reserved.json.message).toContain('1 article:')
    await StockLevel.updateOne({ orgId: w.orgId, productId: nut._id, warehouseId: w.second._id }, { $set: { quantity: -1, reservedQuantity: 0 } }).exec()
    expect((await w.call('PUT', `/warehouse/warehouse/${w.ids.second}`, { isExternal: true })).json.code).toBe('warehouse_holds_stock')

    // Empty (its level rows stay, at zero): it becomes external.
    await StockLevel.updateOne({ orgId: w.orgId, productId: nut._id, warehouseId: w.second._id }, { $set: { quantity: 0 } }).exec()
    expect((await w.call('PUT', `/warehouse/warehouse/${w.ids.second}`, { isExternal: true })).status).toBe(200)
    expect((await Warehouse.findById(w.second._id).lean().exec() as any).isExternal).toBe(true)
  }, 60_000)

  it('the way back is always open, and the default is judged before the goods', async () => {
    const w = await world()
    await w.stocked(10)
    const back = await w.call('PUT', `/warehouse/warehouse/${w.ids.site}`, { isExternal: false })
    expect([back.status, back.json.warehouse.isExternal]).toEqual([200, false])
    // A save that keeps a warehouse external asks nothing about goods: it is not becoming one.
    expect((await w.call('PUT', `/warehouse/warehouse/${w.ids.site}`, { isExternal: true })).status).toBe(200)
    expect((await w.call('PUT', `/warehouse/warehouse/${w.ids.site}`, { isExternal: true, name: 'Other site' })).status).toBe(200)

    // The default warehouse holding goods: the answer is about the default, which is what to change first.
    expect((await w.call('PUT', `/warehouse/warehouse/${w.ids.main}`, { isExternal: true })).json.code).toBe('external_default')
    expect((await w.call('PUT', `/warehouse/warehouse/${w.ids.main}`, { isDefault: false, isExternal: true })).json.code).toBe('warehouse_holds_stock')
  }, 60_000)

  it('the list answers the warehouses that keep stock, unless asked for the others', async () => {
    const w = await world()
    const names = async (query = '') => {
      const res = await w.call('GET', `/warehouse/warehouse${query}`)
      expect(res.status).toBe(200)
      return [res.json.warehouses.map((x: any) => x.name), res.json.total]
    }
    expect(await names()).toEqual([['Main warehouse', 'Second warehouse'], 2])
    expect(await names('?size=1000')).toEqual([['Main warehouse', 'Second warehouse'], 2])
    expect(await names('?external=include')).toEqual([['Main warehouse', 'Other site', 'Second warehouse'], 3])
    expect(await names('?external=only')).toEqual([['Other site'], 1])
    // What is no scope is the default one: a picker never gets an external warehouse by a typo.
    expect(await names('?external=true')).toEqual([['Main warehouse', 'Second warehouse'], 2])
    // A search does not bring one in either.
    expect(await names('?search=site')).toEqual([[], 0])
    expect(await names('?search=site&external=include')).toEqual([['Other site'], 1])
    // It is read by id like any other, and says what it is.
    expect((await w.call('GET', `/warehouse/warehouse/${w.ids.site}`)).json.warehouse.isExternal).toBe(true)
  }, 60_000)
})

describe('a transfer with an external warehouse', () => {
  it('own → external: the goods leave our warehouse and are booked nowhere', async () => {
    const w = await world()
    await w.stocked(10)
    const draft = await w.create('transfer', { fromWarehouseId: w.ids.main, toWarehouseId: w.ids.site })
    expect(draft.status).toBe(200)
    const id = w.idOf(draft)

    // A draft keeps the form's choice in the stock field, and says which side is external.
    const asDraft = (await w.call('GET', `/warehouse/movement/${id}`)).json.stockMovement
    expect([asDraft.status, asDraft.fromWarehouseId, asDraft.toWarehouseId, asDraft.fromExternal, asDraft.toExternal])
      .toEqual(['draft', w.ids.main, w.ids.site, false, true])
    expect([await w.stock(), await w.levelsAtSite()]).toEqual([10, 0])

    const booked = await w.confirm(id)
    expect(booked.status).toBe(200)
    expect(booked.json.stockMovement.status).toBe('completed')

    expect(await w.stock()).toBe(6)
    // ⚠ Not a row at zero: no row at all.
    expect(await w.levelsAtSite()).toBe(0)

    // ⚠ Completed, the stock fields name what moved; the external warehouse sits apart.
    const stored = await w.load(id)
    expect(stored.status).toBe('completed')
    expect(String(stored.fromWarehouseId)).toBe(w.ids.main)
    expect(stored.toWarehouseId ?? null).toBeNull()
    expect(String(stored.externalToWarehouseId)).toBe(w.ids.site)
    expect(stored.externalFromWarehouseId ?? null).toBeNull()

    const page = (await w.call('GET', `/warehouse/movement/${id}`)).json.stockMovement
    expect([page.fromWarehouseId, page.toWarehouseId ?? null, page.externalToWarehouseId, page.fromExternal, page.toExternal])
      .toEqual([w.ids.main, null, w.ids.site, false, true])
  }, 60_000)

  it('external → own: the goods arrive at the line\'s cost, averaged in as a receipt is', async () => {
    const w = await world()
    await w.stocked(10, 5)
    const id = await w.transferred({ fromWarehouseId: w.ids.site, toWarehouseId: w.ids.main }, 10, 7)

    const here = await w.level(w.main)
    expect([here.quantity, here.availableQuantity, here.avgCost]).toEqual([20, 20, 6])
    expect(await w.levelsAtSite()).toBe(0)

    const stored = await w.load(id)
    expect(stored.fromWarehouseId ?? null).toBeNull()
    expect(String(stored.externalFromWarehouseId)).toBe(w.ids.site)
    expect(String(stored.toWarehouseId)).toBe(w.ids.main)
    expect(stored.externalToWarehouseId ?? null).toBeNull()
    // Nothing was consumed anywhere: the line is worth what it says.
    expect([stored.lines[0].resolvedUnitCost, stored.lines[0].costAllocations]).toEqual([7, []])

    // Into a warehouse that has none of the article yet: the level opens at the line's cost.
    await w.transferred({ fromWarehouseId: w.ids.site, toWarehouseId: w.ids.second }, 3, 9)
    const there = await w.level(w.second)
    expect([there.quantity, there.avgCost]).toEqual([3, 9])
    expect(await w.levelsAtSite()).toBe(0)
  }, 60_000)

  it('a layer-costed article: layers open where the goods arrive, are consumed where they leave, and never at the external one', async () => {
    const w = await world()
    const rod = await createTestProduct(w.org._id, { sku: 'PRD-0003', name: 'Threaded rod', costingMethod: 'fifo' } as any)
    const book = async (sides: Record<string, unknown>, quantity: number, unitCost: number) => {
      const res = await w.call('POST', '/warehouse/movement', w.movement('transfer', sides, quantity, unitCost, rod))
      expect(res.status).toBe(200)
      expect((await w.confirm(w.idOf(res))).status).toBe(200)
      return w.load(w.idOf(res))
    }

    await book({ fromWarehouseId: w.ids.site, toWarehouseId: w.ids.main }, 10, 7)
    const opened = await CostLayer.find({ orgId: w.orgId, productId: rod._id }).lean().exec() as any[]
    expect(opened.map(l => [String(l.warehouseId), l.unitCost, l.initialQuantity, l.remainingQuantity])).toEqual([[w.ids.main, 7, 10, 10]])

    const out = await book({ fromWarehouseId: w.ids.main, toWarehouseId: w.ids.site }, 4, 0)
    // What left is worth what it consumed, not what the form typed.
    expect(out.lines[0].resolvedUnitCost).toBe(7)
    expect(out.lines[0].costAllocations.map((a: any) => [a.quantity, a.unitCost])).toEqual([[4, 7]])
    const after = await CostLayer.find({ orgId: w.orgId, productId: rod._id }).lean().exec() as any[]
    expect(after.map(l => [String(l.warehouseId), l.remainingQuantity])).toEqual([[w.ids.main, 6]])
    expect(await CostLayer.countDocuments({ orgId: w.orgId, warehouseId: w.site._id }).exec()).toBe(0)
    expect([await w.stock(w.main, rod), await w.levelsAtSite()]).toEqual([6, 0])
  }, 60_000)

  it('the product\'s ledger shows the goods leaving, and no row of them arriving anywhere', async () => {
    const w = await world()
    await w.stocked(10)
    const id = await w.transferred({ fromWarehouseId: w.ids.main, toWarehouseId: w.ids.site })

    const ledger = (await w.call('GET', `/warehouse/product-ledger/${w.bolt._id}`)).json
    expect(ledger.entries.map((e: any) => [e.eventType, e.warehouseName, e.quantityChange, e.endQty])).toEqual([
      ['received', 'Main warehouse', 10, 10],
      ['transferred_out', 'Main warehouse', -4, 6],
    ])
    expect(ledger.entries[1].documentId).toBe(id)
    expect([ledger.summary.totalIn, ledger.summary.totalOut, ledger.summary.currentQty]).toEqual([10, 4, 6])

    // Asked for the external warehouse alone, the ledger has nothing: it keeps no stock.
    const there = (await w.call('GET', `/warehouse/product-ledger/${w.bolt._id}?warehouseId=${w.ids.site}`)).json
    expect([there.entries.length, there.summary.currentQty]).toEqual([0, 0])

    // And the other way round: one row in, none out.
    await w.transferred({ fromWarehouseId: w.ids.site, toWarehouseId: w.ids.main }, 2, 5)
    const both = (await w.call('GET', `/warehouse/product-ledger/${w.bolt._id}`)).json
    expect(both.entries.map((e: any) => [e.eventType, e.warehouseName, e.quantityChange])).toEqual([
      ['received', 'Main warehouse', 10],
      ['transferred_out', 'Main warehouse', -4],
      ['transferred_in', 'Main warehouse', 2],
    ])
    expect(both.summary.currentQty).toBe(8)
  }, 60_000)

  it('a transfer-only session writes it, in both directions', async () => {
    const w = await world()
    await seedDefaultPermissionSets(w.orgId)
    const seller = await member(w.org, 'seller', 'Seller')
    await w.stocked(10)

    // The external warehouse counts as the warehouse the transfer names on that side.
    await w.transferred({ fromWarehouseId: w.ids.main, toWarehouseId: w.ids.site }, 4, 5, seller.token)
    expect([await w.stock(), await w.levelsAtSite()]).toEqual([6, 0])
    await w.transferred({ fromWarehouseId: w.ids.site, toWarehouseId: w.ids.main }, 1, 5, seller.token)
    expect([await w.stock(), await w.levelsAtSite()]).toEqual([7, 0])

    // It still needs both sides named, and one of them ours.
    const oneSided = await w.create('transfer', { fromWarehouseId: w.ids.site }, 1, 5, seller.token)
    expect([oneSided.status, oneSided.json.code]).toEqual([422, 'transfer_needs_both_warehouses'])
    const noneOurs = await w.create('transfer', { fromWarehouseId: w.ids.site, toWarehouseId: w.ids.site }, 1, 5, seller.token)
    expect([noneOurs.status, noneOurs.json.code]).toEqual([422, 'transfer_without_own_warehouse'])
    // And its picker is told of the external warehouse only when it asks.
    const picker = await w.call('GET', '/warehouse/warehouse?size=1000&external=include', undefined, seller.token)
    expect(picker.json.warehouses.map((x: any) => [x.name, !!x.isExternal])).toEqual([['Main warehouse', false], ['Other site', true], ['Second warehouse', false]])
  }, 60_000)
})

describe('no other movement names one', () => {
  it('POST and /with-update refuse it, and write nothing', async () => {
    const w = await world()
    const { main, site } = w.ids
    for (const [type, sides, code] of [
      ['receipt', { toWarehouseId: site }, 'external_warehouse_not_transfer'],
      ['dispatch', { fromWarehouseId: site }, 'external_warehouse_not_transfer'],
      ['adjustment', { toWarehouseId: site }, 'external_warehouse_not_transfer'],
      ['adjustment', { fromWarehouseId: site }, 'external_warehouse_not_transfer'],
      ['return', { toWarehouseId: site }, 'external_warehouse_not_transfer'],
      ['production_in', { toWarehouseId: site }, 'external_warehouse_not_transfer'],
      ['production_out', { fromWarehouseId: site }, 'external_warehouse_not_transfer'],
      // A transfer names it as the other side of one of ours.
      ['transfer', { fromWarehouseId: site }, 'transfer_without_own_warehouse'],
      ['transfer', { fromWarehouseId: site, toWarehouseId: site }, 'transfer_without_own_warehouse'],
      // The rules that stood before still answer for our own warehouses.
      ['transfer', { toWarehouseId: main }, 'transfer_without_from_warehouse'],
    ] as const) {
      const res = await w.create(type, sides)
      expect([type, JSON.stringify(sides), res.status, res.json.code]).toEqual([type, JSON.stringify(sides), 422, code])
      expect(res.json.message).toBeTruthy()
    }
    const withUpdate = await w.call('POST', '/warehouse/movement/with-update', w.movement('receipt', { toWarehouseId: site }))
    expect([withUpdate.status, withUpdate.json.code]).toEqual([422, 'external_warehouse_not_transfer'])
    expect(await StockMovement.countDocuments({ orgId: w.orgId }).exec()).toBe(0)
    expect(await w.levelsAtSite()).toBe(0)
  }, 60_000)

  it('PUT judges the movement as it would stand, and leaves it alone when refused', async () => {
    const w = await world()
    const { main, second, site } = w.ids
    const transfer = w.idOf(await w.create('transfer', { fromWarehouseId: main, toWarehouseId: second }))
    // Our warehouse swapped for the external one on a transfer: that is the document this is for.
    expect((await w.call('PUT', `/warehouse/movement/${transfer}`, { toWarehouseId: site })).status).toBe(200)
    expect(String((await w.load(transfer)).toWarehouseId)).toBe(site)
    // And then the other side too: nothing of ours is left to move.
    const none = await w.call('PUT', `/warehouse/movement/${transfer}`, { fromWarehouseId: site })
    expect([none.status, none.json.code]).toEqual([422, 'transfer_without_own_warehouse'])
    const cleared = await w.call('PUT', `/warehouse/movement/${transfer}`, { fromWarehouseId: null })
    expect([cleared.status, cleared.json.code]).toEqual([422, 'transfer_without_own_warehouse'])
    expect(String((await w.load(transfer)).fromWarehouseId)).toBe(main)

    const receipt = w.idOf(await w.create('receipt', { toWarehouseId: main }))
    const moved = await w.call('PUT', `/warehouse/movement/${receipt}`, { toWarehouseId: site })
    expect([moved.status, moved.json.code]).toEqual([422, 'external_warehouse_not_transfer'])
    // Through the path that also updates products, the same.
    const withUpdates = await w.call('PUT', `/warehouse/movement/${receipt}`, { toWarehouseId: site, productUpdates: [{ productId: String(w.bolt._id), sellingPrice: 11 }] })
    expect(withUpdates.json.code).toBe('external_warehouse_not_transfer')
    expect(String((await w.load(receipt)).toWarehouseId)).toBe(main)
  }, 60_000)

  it('/confirm reads the flag as it is now: a draft whose warehouse became external moves nothing', async () => {
    const w = await world()
    const { main, second } = w.ids
    await w.stocked(10)
    const receipt = w.idOf(await w.create('receipt', { toWarehouseId: second }))
    const dispatch = await w.rawDraft('dispatch', { fromWarehouseId: w.ids.site })
    // The second warehouse holds nothing, so it may become another site's.
    expect((await w.call('PUT', `/warehouse/warehouse/${second}`, { isExternal: true })).status).toBe(200)

    for (const id of [receipt, dispatch]) {
      const refused = await w.confirm(id)
      expect([refused.status, refused.json.code]).toEqual([422, 'external_warehouse_not_transfer'])
      expect((await w.load(id)).status).toBe('draft')
    }
    expect([await w.stock(), await w.stock(w.second), await w.levelsAtSite()]).toEqual([10, 0, 0])
    expect(await StockLevel.countDocuments({ orgId: w.orgId, warehouseId: w.second._id }).exec()).toBe(0)

    // The same door for an import's drafts (`/doc-import/convert`), per id.
    const convert = await w.call('POST', '/doc-import/convert', { target: 'movement', ids: [receipt, dispatch] })
    expect(convert.json.results.map((x: any) => [x.id, x.ok, x.code])).toEqual([
      [receipt, false, 'external_warehouse_not_transfer'], [dispatch, false, 'external_warehouse_not_transfer'],
    ])

    // Repaired, it books as what it is.
    expect((await w.call('PUT', `/warehouse/movement/${receipt}`, { toWarehouseId: main })).status).toBe(200)
    expect((await w.confirm(receipt)).status).toBe(200)
    expect(await w.stock()).toBe(14)
  }, 60_000)

  it('an import commits a transfer to it and refuses anything else that names it', async () => {
    const w = await world()
    const { main, site } = w.ids
    await w.stocked(10)
    const mapped = (type: string, sides: Record<string, unknown>) => ({
      type, date: '2026-11-16', ...sides, notes: 'x', marker: 'x', totalAmount: 20, newProducts: [],
      lines: [{ productId: String(w.bolt._id), productName: 'x', quantity: 4, unitCost: 5 }],
    })
    const before = await StockMovement.countDocuments({ orgId: w.orgId }).exec()
    const [receipt] = await commitDocuments(w.orgId, String(w.admin.user._id), 'movement', [{ mapped: mapped('receipt', { toWarehouseId: site }) as any }])
    expect(receipt).toMatchObject({ ok: false, code: 'external_warehouse_not_transfer' })
    const [split] = await commitDocuments(w.orgId, String(w.admin.user._id), 'movement', [{
      mapped: mapped('receipt', { toWarehouseId: main }) as any,
      extraMovements: [mapped('adjustment', { fromWarehouseId: site }) as any],
    }])
    expect(split).toMatchObject({ ok: false, code: 'external_warehouse_not_transfer' })
    expect(await StockMovement.countDocuments({ orgId: w.orgId }).exec()).toBe(before)
    expect([await w.stock(), await w.levelsAtSite()]).toEqual([10, 0])

    const [transfer] = await commitDocuments(w.orgId, String(w.admin.user._id), 'movement', [{ mapped: mapped('transfer', { fromWarehouseId: main, toWarehouseId: site }) as any }])
    expect(transfer.ok).toBe(true)
    expect([await w.stock(), await w.levelsAtSite()]).toEqual([6, 0])

    // A note's printed store is resolved to one of OUR warehouses, never to an external one of that name.
    expect(await resolveWarehouse(w.orgId, 'Main warehouse')).toBe(main)
    expect(await resolveWarehouse(w.orgId, 'Other site')).toBeNull()
    expect(await resolveWarehouse(w.orgId, 'SITE')).toBeNull()
  }, 60_000)

  it('opening stock is not loaded into one', async () => {
    const w = await world()
    const form = new FormData()
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'storeAvailability.xlsx'))
    form.append('warehouseId', w.ids.site)
    const res = await app.handle(new Request(`http://localhost/api/org/${w.orgId}/warehouse/opening-stock`, {
      method: 'POST', headers: { authorization: `Bearer ${w.admin.token}` }, body: form,
    }))
    expect([res.status, (await res.json() as any).code]).toEqual([422, 'external_warehouse'])
    expect(await w.levelsAtSite()).toBe(0)
  }, 60_000)
})

describe('the engine books nothing on one, whatever reaches it', () => {
  it('a dispatch naming an external From, confirmed past every door', async () => {
    const w = await world()
    const id = await w.rawDraft('dispatch', { fromWarehouseId: w.ids.site })
    const confirmed = await confirmMovement(id)
    expect(confirmed.status).toBe('completed')
    // Without the guard this opened a level at −4 on a warehouse that keeps no stock.
    expect(await w.levelsAtSite()).toBe(0)
    expect(await StockLevel.countDocuments({ orgId: w.orgId }).exec()).toBe(0)
    const stored = await w.load(id)
    expect(stored.fromWarehouseId ?? null).toBeNull()
    expect(String(stored.externalFromWarehouseId)).toBe(w.ids.site)
  }, 60_000)

  it('a receipt naming an external To, and a transfer with one on both sides', async () => {
    const w = await world()
    const receipt = await w.rawDraft('receipt', { toWarehouseId: w.ids.site })
    expect((await confirmMovement(receipt)).status).toBe('completed')
    const stored = await w.load(receipt)
    expect(stored.toWarehouseId ?? null).toBeNull()
    expect(String(stored.externalToWarehouseId)).toBe(w.ids.site)

    const third = await createTestWarehouse(w.org._id, { name: 'Third site', code: 'SITE-3', isExternal: true } as any)
    const between = await w.rawDraft('transfer', { fromWarehouseId: w.ids.site, toWarehouseId: String(third._id) })
    expect((await confirmMovement(between)).status).toBe('completed')
    const both = await w.load(between)
    expect([both.fromWarehouseId ?? null, both.toWarehouseId ?? null]).toEqual([null, null])
    expect([String(both.externalFromWarehouseId), String(both.externalToWarehouseId)]).toEqual([w.ids.site, String(third._id)])

    expect(await StockLevel.countDocuments({ orgId: w.orgId }).exec()).toBe(0)
    expect(await CostLayer.countDocuments({ orgId: w.orgId }).exec()).toBe(0)
  }, 60_000)

  it('a movement between our own warehouses is booked as it always was', async () => {
    const w = await world()
    await w.stocked(10)
    const id = await w.transferred({ fromWarehouseId: w.ids.main, toWarehouseId: w.ids.second })
    expect([await w.stock(), await w.stock(w.second)]).toEqual([6, 4])
    const stored = await w.load(id)
    expect([String(stored.fromWarehouseId), String(stored.toWarehouseId)]).toEqual([w.ids.main, w.ids.second])
    // The external pair is not written at all: an old reader's documents are untouched.
    expect('externalFromWarehouseId' in stored || 'externalToWarehouseId' in stored).toBe(false)
  }, 60_000)

  it('a rollback mirrors what moved: the goods come back to our warehouse, and none reach the external one', async () => {
    const w = await world()
    await w.stocked(10)
    const out = await w.transferred({ fromWarehouseId: w.ids.main, toWarehouseId: w.ids.site })
    const back = await w.transferred({ fromWarehouseId: w.ids.site, toWarehouseId: w.ids.main }, 3, 5)
    expect(await w.stock()).toBe(9)

    // The Files rollback (`doc-delete.service#reverseMovement`): the one generic reverse of a movement.
    const file = async (ids: string[], docNumber: string) => {
      const path = uploadPath(w.orgId, `${docNumber}.pdf`)
      await Bun.write(path, '%PDF-1.4 a note')
      return DocFile.create({
        orgId: w.orgId, docType: 'stock_note', docNumber, docDate: '2026-11-16', originalName: `${docNumber}.pdf`,
        currentPath: path, currentChecksum: docNumber, mimeType: 'application/pdf', size: 15,
        uploadedBy: w.admin.user._id, uploadedAt: new Date(Date.now() - 3_600_000), status: 'committed', committedIds: ids,
      } as any)
    }
    const first = await file([out], 'NOTE-1')
    const res = await deleteDocFiles(w.orgId, String(w.admin.user._id), [String(first._id)], { rollback: true, execute: true })
    expect([res.executed, res.reversals?.length, res.warnings]).toEqual([true, 1, []])
    expect([await w.stock(), await w.levelsAtSite()]).toEqual([13, 0])

    const second = await file([back], 'NOTE-2')
    const res2 = await deleteDocFiles(w.orgId, String(w.admin.user._id), [String(second._id)], { rollback: true, execute: true })
    expect([res2.executed, res2.reversals?.length, res2.warnings]).toEqual([true, 1, []])
    expect([await w.stock(), await w.levelsAtSite()]).toEqual([10, 0])

    // Each mirror names only our warehouse, so the rule holds for it too.
    const mirrors = await StockMovement.find({ orgId: w.orgId, notes: /docdelete:/ }).lean().exec() as any[]
    expect(mirrors.map(m => [m.type, m.status, String(m.toWarehouseId ?? ''), String(m.fromWarehouseId ?? '')]).sort()).toEqual([
      ['adjustment', 'completed', '', w.ids.main],
      ['receipt', 'completed', w.ids.main, ''],
    ])
  }, 60_000)
})

describe('the movements list', () => {
  it('names the external side, finds a movement by it, and sorts by its name', async () => {
    const w = await world()
    const { main, second, site } = w.ids
    await w.stocked(20)
    const toSecond = await w.transferred({ fromWarehouseId: main, toWarehouseId: second }, 1)
    const toSite = await w.transferred({ fromWarehouseId: main, toWarehouseId: site }, 2)
    const fromSite = await w.transferred({ fromWarehouseId: site, toWarehouseId: main }, 3)
    const draft = w.idOf(await w.create('transfer', { fromWarehouseId: main, toWarehouseId: site }, 5))

    const rows = async (query: string) => {
      const res = await w.call('GET', `/warehouse/movement?type=transfer&size=50${query}`)
      expect(res.status).toBe(200)
      return res.json.stockMovements as any[]
    }
    const shape = (list: any[]) => Object.fromEntries(list.map(m => [m.id || m._id, [m.fromWarehouseName, m.fromExternal, m.toWarehouseName, m.toExternal]]))
    expect(shape(await rows(''))).toEqual({
      [toSecond]: ['Main warehouse', false, 'Second warehouse', false],
      [toSite]: ['Main warehouse', false, 'Other site', true],
      [fromSite]: ['Other site', true, 'Main warehouse', false],
      // A draft holds its choice in the stock field: the flag is read as it is now.
      [draft]: ['Main warehouse', false, 'Other site', true],
    })

    // The warehouse filter finds it on either side, booked or not.
    const ofSite = (await rows(`&warehouseId=${site}`)).map(m => m.id || m._id).sort()
    expect(ofSite).toEqual([toSite, fromSite, draft].sort())
    expect((await rows(`&warehouseId=${second}`)).map(m => m.id || m._id)).toEqual([toSecond])

    // Sorted by a side's name, the external one stands where its name puts it.
    const byTo = (await rows('&sortBy=toWarehouseName&sortOrder=asc')).map(m => m.toWarehouseName)
    expect(byTo).toEqual(['Main warehouse', 'Other site', 'Other site', 'Second warehouse'])
    const byFrom = (await rows('&sortBy=fromWarehouseName&sortOrder=desc')).map(m => m.fromWarehouseName)
    expect(byFrom).toEqual(['Other site', 'Main warehouse', 'Main warehouse', 'Main warehouse'])
  }, 60_000)
})

describe('the printed document', () => {
  it('names both warehouses and marks the external one, booked or draft, and carries no price', async () => {
    const w = await world()
    await w.stocked(10)
    const partner = await createTestContact(w.org._id, { companyName: 'Partner Ltd' } as any)
    const draftRes = await w.call('POST', '/warehouse/movement', {
      ...w.movement('transfer', { fromWarehouseId: w.ids.main, toWarehouseId: w.ids.site }), contactId: String(partner._id), reference: 'REF-7', notes: 'Handle with care',
    })
    const id = w.idOf(draftRes)

    const asDraft = await stockMovementDocumentData(w.orgId, await w.load(id), { locale: 'bg' })
    expect(asDraft).toMatchObject({
      number: draftRes.json.stockMovement.movementNumber, type: 'transfer', draft: true, locale: 'bg',
      from: { name: 'Main warehouse', external: false }, to: { name: 'Other site', external: true },
      partner: 'Partner Ltd', reference: 'REF-7', note: 'Handle with care',
    })
    // ⚠ A line is what moved and how much. Its cost is not handed to the sheet at all.
    expect(asDraft.lines).toEqual([{ name: 'Bolt M8', unit: 'pcs', quantity: 4 }])

    expect((await w.confirm(id)).status).toBe(200)
    const booked = await stockMovementDocumentData(w.orgId, await w.load(id), {})
    expect(booked).toMatchObject({ draft: false, locale: 'en', from: { name: 'Main warehouse', external: false }, to: { name: 'Other site', external: true } })

    // The other way round, and a movement that names no external warehouse.
    const inbound = await w.transferred({ fromWarehouseId: w.ids.site, toWarehouseId: w.ids.main }, 1)
    expect(await stockMovementDocumentData(w.orgId, await w.load(inbound), {})).toMatchObject({ from: { name: 'Other site', external: true }, to: { name: 'Main warehouse', external: false } })
    const receipt = w.idOf(await w.create('receipt', { toWarehouseId: w.ids.main }))
    expect(await stockMovementDocumentData(w.orgId, await w.load(receipt), {})).toMatchObject({ type: 'receipt', from: null, to: { name: 'Main warehouse', external: false }, partner: '' })
  }, 60_000)

  it('the route answers a PDF named by the movement\'s number, to whoever may read the movement', async () => {
    const w = await world()
    await seedDefaultPermissionSets(w.orgId)
    const seller = await member(w.org, 'seller', 'Seller')
    const payroll = await member(w.org, 'hr_manager')
    await w.stocked(10)
    const id = await w.transferred({ fromWarehouseId: w.ids.main, toWarehouseId: w.ids.site })
    const number = (await w.load(id)).movementNumber

    const res = await w.send('GET', `/warehouse/movement/${id}/export?locale=bg`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${number}.pdf"`)
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF')

    // A draft prints too: the sheet says it is one.
    const draft = w.idOf(await w.create('transfer', { fromWarehouseId: w.ids.main, toWarehouseId: w.ids.site }))
    const asDraft = await w.send('GET', `/warehouse/movement/${draft}/export`)
    expect([asDraft.status, asDraft.headers.get('content-type')]).toEqual([200, 'application/pdf'])
    await asDraft.arrayBuffer()

    // Whoever reads movements prints one; whoever does not, and whoever is nobody, gets none.
    const asSeller = await w.send('GET', `/warehouse/movement/${id}/export`, undefined, seller.token)
    expect(asSeller.status).toBe(200)
    await asSeller.arrayBuffer()
    expect((await w.call('GET', `/warehouse/movement/${id}/export`, undefined, payroll.token)).status).toBe(403)
    expect((await w.call('GET', `/warehouse/movement/${id}/export`, undefined, null)).status).toBe(401)

    // No movement of this org by that id: 404, whether the id is nobody's, somebody else's or no id.
    const elsewhere = await world()
    const foreign = await elsewhere.rawDraft('receipt', { toWarehouseId: elsewhere.ids.main })
    for (const missing of [String(oid()), foreign, 'not-an-id']) {
      const none = await w.call('GET', `/warehouse/movement/${missing}/export`)
      expect([missing, none.status, none.json?.message]).toEqual([missing, 404, 'Stock movement not found'])
    }
  }, 180_000)
})
