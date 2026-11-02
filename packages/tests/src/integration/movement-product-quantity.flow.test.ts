import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser, createTestProduct, createTestWarehouse } from '../helpers/factories'
import { StockMovement } from 'db/models'
import { movementController } from 'warehouse-api/src/controllers/movement.controller'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * The article's Movements tab reads `productQuantity`, signed: green with a plus, red with a minus
 * (`ProductStockView.vue`). A movement out of a warehouse and into none took stock out, whatever its
 * type: a write-off stored positive read as a green +2, stock in.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

let app: Elysia
let token: string
let orgId: string
let product: string
const quantityOf: Record<string, number | undefined> = {}

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(movementController)
  const org = await createTestOrg()
  orgId = String(org._id)
  const user = await createTestUser(org._id)
  token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'A', lastName: 'B', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  product = String((await createTestProduct(org._id))._id)
  const other = String((await createTestProduct(org._id))._id)
  const from = String((await createTestWarehouse(org._id))._id)
  const to = String((await createTestWarehouse(org._id))._id)

  const book = (number: string, type: string, quantities: number[], warehouses: Record<string, string>) =>
    StockMovement.create({
      orgId: org._id, movementNumber: number, type, status: 'completed', date: new Date('2026-10-01'),
      lines: [
        ...quantities.map(quantity => ({ productId: product, quantity, unitCost: 1, totalCost: quantity })),
        // Another article's line on the same document counts for nothing here.
        { productId: other, quantity: 100, unitCost: 1, totalCost: 100 },
      ],
      totalAmount: 1, createdBy: user._id, ...warehouses,
    })
  await book('write-off positive', 'adjustment', [2], { fromWarehouseId: from })
  await book('write-off negative', 'adjustment', [-2], { fromWarehouseId: from })
  await book('correction up', 'adjustment', [3], { toWarehouseId: to })
  await book('correction down', 'adjustment', [-3], { toWarehouseId: to })
  await book('dispatch', 'dispatch', [4], { fromWarehouseId: from })
  await book('from-only transfer', 'transfer', [5], { fromWarehouseId: from })
  await book('two lines', 'dispatch', [1, 2], { fromWarehouseId: from })
  await book('receipt', 'receipt', [6], { toWarehouseId: to })
  await book('transfer', 'transfer', [7], { fromWarehouseId: from, toWarehouseId: to })

  const res = await app.handle(new Request(`http://localhost/org/${orgId}/warehouse/movement?size=50&productId=${product}`, {
    headers: { authorization: `Bearer ${token}` },
  }))
  expect(res.status).toBe(200)
  for (const m of ((await res.json()) as any).stockMovements) quantityOf[m.number] = m.productQuantity
}, 60_000)

afterAll(async () => { await teardownTestDB() })

describe('GET /warehouse/movement?productId= — the article\'s signed quantity', () => {
  it('a movement out of a warehouse and into none is −|quantity|, whatever its type', () => {
    expect(quantityOf['write-off positive']).toBe(-2)
    expect(quantityOf['write-off negative']).toBe(-2)
    expect(quantityOf.dispatch).toBe(-4)
    expect(quantityOf['from-only transfer']).toBe(-5)
    expect(quantityOf['two lines']).toBe(-3)
  })

  it('a movement into a warehouse keeps the sign on its line', () => {
    expect(quantityOf['correction up']).toBe(3)
    expect(quantityOf['correction down']).toBe(-3)
    expect(quantityOf.receipt).toBe(6)
  })

  it('a transfer between two warehouses stays unsigned: the ledger tab is the per-warehouse view', () => {
    expect(quantityOf.transfer).toBe(7)
  })

  it('without one article picked there is nothing to sign', async () => {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/warehouse/movement?size=50`, {
      headers: { authorization: `Bearer ${token}` },
    }))
    const { stockMovements } = (await res.json()) as any
    expect(stockMovements.length).toBeGreaterThan(0)
    expect(stockMovements.every((m: any) => m.productQuantity === undefined)).toBe(true)
  })
})
