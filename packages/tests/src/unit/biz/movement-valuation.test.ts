import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../../setup'
import { createMovementValuationEntry } from 'services/biz/auto-journal.service'
import { confirmMovement } from 'services/biz/warehouse.service'
import { getRepos } from 'services/context'
import { JournalEntry, Org, StockLevel } from 'db/models'
import {
  createTestAccount, createTestOrg, createTestProduct, createTestStockLevel, createTestStockMovement, createTestWarehouse,
} from '../../helpers/factories'

/**
 * What a stock movement's journal entry values goods at (FR-25 R0 #7).
 *
 * ⚠ `unitCost` on an invoice-born line is the document's PRICE (`createInvoiceStockMovement`), so a
 * sale booked with no known cost must not reach the books at what it sold for: that would make
 * cost of sales equal revenue and hide the margin. The chain is what the goods consumed, what the
 * line resolved to, the level's average, and what the article is bought at.
 */

const SALE_PRICE = 25

async function world(productOverrides: Record<string, unknown> = {}) {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const inventory = await createTestAccount(org._id, { code: '304', name: 'Goods', type: 'asset', subType: 'current_asset' })
  const cogs = await createTestAccount(org._id, { code: '601', name: 'Cost of sales', type: 'expense', subType: 'cost_of_goods_sold' })
  await Org.updateOne({ _id: org._id }, { $set: {
    'settings.inventory.defaultInventoryAccountId': inventory._id,
    'settings.inventory.defaultCOGSAccountId': cogs._id,
  } })
  const product = await createTestProduct(org._id, { purchasePrice: 8, ...productOverrides } as any)
  const warehouse = await createTestWarehouse(org._id)
  return { org, orgId, inventory, cogs, product, warehouse }
}

type World = Awaited<ReturnType<typeof world>>

/** A sale of `quantity`, as an invoice books it: the line's `unitCost` is the sale price. */
async function confirmSale(w: World, quantity = 3) {
  const movement = await createTestStockMovement(w.org._id, {
    type: 'dispatch',
    fromWarehouseId: w.warehouse._id,
    lines: [{ productId: w.product._id, quantity, unitCost: SALE_PRICE, totalCost: quantity * SALE_PRICE }],
    totalAmount: quantity * SALE_PRICE,
  } as any)
  return confirmMovement(String(movement._id))
}

const entryValue = (je: any) => je?.lines?.[0]?.baseDebit

/** The entry for a movement already stored as `line` says, without confirming it again. */
async function valueStored(w: World, type: string, side: Record<string, unknown>, line: Record<string, unknown>) {
  const stored = { productId: w.product._id, quantity: 2, unitCost: SALE_PRICE, totalCost: 50, ...line }
  const movement = await createTestStockMovement(w.org._id, { type, status: 'completed', ...side, lines: [stored], totalAmount: 50 } as any)
  const read = await getRepos().stockMovements.findById(String(movement._id))
  return createMovementValuationEntry(w.orgId, read, read!.lines, new Date())
}

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('a dispatch is valued at what the goods cost, never at what they sold for', () => {
  it('under WAC: the level\'s average', async () => {
    const w = await world()
    await createTestStockLevel(w.org._id, w.product._id, w.warehouse._id, { quantity: 10, availableQuantity: 10, avgCost: 10 })

    const moved = await confirmSale(w)
    const je = await createMovementValuationEntry(w.orgId, moved, moved.lines, new Date())

    expect(entryValue(je)).toBe(30)
    expect(je.lines[0].accountId).toBe(String(w.cogs._id))
    expect(je.lines[1].accountId).toBe(String(w.inventory._id))
    expect(je.lines[1].baseCredit).toBe(30)
  })

  it('under FIFO: what each layer it consumed cost', async () => {
    const w = await world({ costingMethod: 'fifo' })
    for (const [quantity, unitCost] of [[2, 10], [5, 14]] as const) {
      const receipt = await createTestStockMovement(w.org._id, {
        type: 'receipt',
        toWarehouseId: w.warehouse._id,
        lines: [{ productId: w.product._id, quantity, unitCost, totalCost: quantity * unitCost }],
      } as any)
      await confirmMovement(String(receipt._id))
    }

    const moved = await confirmSale(w, 3)
    const je = await createMovementValuationEntry(w.orgId, moved, moved.lines, new Date())

    expect(entryValue(je)).toBe(2 * 10 + 1 * 14)
  })

  it('a level holding no cost falls to the purchase price, where it used to fall to the sale price', async () => {
    const w = await world()
    await createTestStockLevel(w.org._id, w.product._id, w.warehouse._id, { quantity: 10, availableQuantity: 10, avgCost: 0 })

    const moved = await confirmSale(w)
    const je = await createMovementValuationEntry(w.orgId, moved, moved.lines, new Date())

    expect(entryValue(je)).toBe(3 * 8)
  })

  it('goods sold before their delivery was booked: no level, so the purchase price', async () => {
    const w = await world()

    const moved = await confirmSale(w)
    const je = await createMovementValuationEntry(w.orgId, moved, moved.lines, new Date())

    expect(entryValue(je)).toBe(3 * 8)
  })

  it('the level such a sale opens does not hold the sale price, so the next sale cannot read it', async () => {
    const w = await world()

    await confirmSale(w)
    const level = await StockLevel.findOne({ orgId: w.org._id, productId: w.product._id, warehouseId: w.warehouse._id })
    expect(level!.quantity).toBe(-3)
    expect(level!.avgCost).toBe(0)

    const moved = await confirmSale(w)
    const je = await createMovementValuationEntry(w.orgId, moved, moved.lines, new Date())
    expect(entryValue(je)).toBe(3 * 8)
  })

  it('the delivery that follows sets the average, whatever such a sale left', async () => {
    const w = await world()
    await confirmSale(w)

    const receipt = await createTestStockMovement(w.org._id, {
      type: 'receipt',
      toWarehouseId: w.warehouse._id,
      lines: [{ productId: w.product._id, quantity: 10, unitCost: 12, totalCost: 120 }],
    } as any)
    await confirmMovement(String(receipt._id))

    const level = await StockLevel.findOne({ orgId: w.org._id, productId: w.product._id, warehouseId: w.warehouse._id })
    expect(level!.quantity).toBe(7)
    expect(level!.avgCost).toBe(12)
  })

  it('no cost known anywhere: no entry, never one at the sale price', async () => {
    const w = await world({ purchasePrice: 0 })

    const moved = await confirmSale(w)
    const je = await createMovementValuationEntry(w.orgId, moved, moved.lines, new Date())

    expect(je).toBeNull()
    expect(await JournalEntry.countDocuments({ orgId: w.org._id })).toBe(0)
  })

  it('a line stored before this fix, resolved to its own price, is read through to a real cost', async () => {
    const w = await world()
    await createTestStockLevel(w.org._id, w.product._id, w.warehouse._id, { quantity: 10, availableQuantity: 10, avgCost: 9 })

    const je = await valueStored(w, 'dispatch', { fromWarehouseId: w.warehouse._id }, { resolvedUnitCost: SALE_PRICE })

    expect(entryValue(je)).toBe(2 * 9)
  })

  it('a level such a line opened long ago, at the sale price, is no cost either', async () => {
    const w = await world()
    await createTestStockLevel(w.org._id, w.product._id, w.warehouse._id, { quantity: -2, availableQuantity: -2, avgCost: SALE_PRICE })

    const je = await valueStored(w, 'dispatch', { fromWarehouseId: w.warehouse._id }, { resolvedUnitCost: SALE_PRICE })

    expect(entryValue(je)).toBe(2 * 8)
  })

  it('each line finds its own cost, and an average equal to the price by chance still counts', async () => {
    const w = await world()
    const atChance = await createTestProduct(w.org._id, { purchasePrice: 1 } as any)
    const noLevel = await createTestProduct(w.org._id, { purchasePrice: 4 } as any)
    await createTestStockLevel(w.org._id, w.product._id, w.warehouse._id, { quantity: 10, availableQuantity: 10, avgCost: 10 })
    await createTestStockLevel(w.org._id, atChance._id, w.warehouse._id, { quantity: 10, availableQuantity: 10, avgCost: SALE_PRICE })

    const movement = await createTestStockMovement(w.org._id, {
      type: 'dispatch',
      fromWarehouseId: w.warehouse._id,
      lines: [
        { productId: w.product._id, quantity: 1, unitCost: SALE_PRICE, totalCost: SALE_PRICE },
        { productId: atChance._id, quantity: 1, unitCost: SALE_PRICE, totalCost: SALE_PRICE },
        { productId: noLevel._id, quantity: 1, unitCost: SALE_PRICE, totalCost: SALE_PRICE },
      ],
    } as any)
    const moved = await confirmMovement(String(movement._id))
    const je = await createMovementValuationEntry(w.orgId, moved, moved.lines, new Date())

    expect(entryValue(je)).toBe(10 + SALE_PRICE + 4)
  })

  it('reads another org\'s product and level for nothing', async () => {
    const w = await world({ purchasePrice: 0 })
    const other = await world({ purchasePrice: 77 })
    await createTestStockLevel(other.org._id, w.product._id, w.warehouse._id, { quantity: 5, availableQuantity: 5, avgCost: 66 })

    const moved = await confirmSale(w)

    expect(await createMovementValuationEntry(w.orgId, moved, moved.lines, new Date())).toBeNull()
  })

  it('a production issue follows the same chain', async () => {
    const w = await world()
    const movement = await createTestStockMovement(w.org._id, {
      type: 'production_out',
      fromWarehouseId: w.warehouse._id,
      lines: [{ productId: w.product._id, quantity: 2, unitCost: 99, totalCost: 198 }],
    } as any)

    const moved = await confirmMovement(String(movement._id))
    const je = await createMovementValuationEntry(w.orgId, moved, moved.lines, new Date())

    expect(entryValue(je)).toBe(2 * 8)
  })
})

describe('goods coming in', () => {
  it('a receipt is still valued at its line cost', async () => {
    const w = await world()
    const movement = await createTestStockMovement(w.org._id, {
      type: 'receipt',
      toWarehouseId: w.warehouse._id,
      lines: [{ productId: w.product._id, quantity: 4, unitCost: 11, totalCost: 44 }],
    } as any)

    const moved = await confirmMovement(String(movement._id))
    const je = await createMovementValuationEntry(w.orgId, moved, moved.lines, new Date())

    expect(entryValue(je)).toBe(44)
    expect(je.lines[0].accountId).toBe(String(w.inventory._id))
  })

  it('a customer\'s return with no known cost is not valued at the price either', async () => {
    const w = await world()
    await createTestStockLevel(w.org._id, w.product._id, w.warehouse._id, { quantity: 10, availableQuantity: 10, avgCost: 6 })

    const je = await valueStored(w, 'return', { toWarehouseId: w.warehouse._id }, { resolvedUnitCost: 0 })

    expect(entryValue(je)).toBe(2 * 6)
  })

  it('a customer\'s return with its cost resolved is valued at that', async () => {
    const w = await world()
    const movement = await createTestStockMovement(w.org._id, {
      type: 'return',
      toWarehouseId: w.warehouse._id,
      lines: [{ productId: w.product._id, quantity: 2, unitCost: SALE_PRICE, totalCost: 50, resolvedUnitCost: 7 }],
    } as any)

    const moved = await confirmMovement(String(movement._id))
    const je = await createMovementValuationEntry(w.orgId, moved, moved.lines, new Date())

    expect(entryValue(je)).toBe(14)
  })

  it('a return to a supplier carries what we paid, so its price is its cost', async () => {
    const w = await world()

    const je = await valueStored(w, 'return', { fromWarehouseId: w.warehouse._id }, { unitCost: 11, resolvedUnitCost: 0 })

    expect(entryValue(je)).toBe(2 * 11)
  })
})
