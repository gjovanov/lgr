import type { RepositoryRegistry } from 'dal'
import { DuplicateError } from 'dal'
import type { IStockMovement } from 'dal/entities'
import { StockLevel, StockMovement } from 'db/models'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'
import { getEffectiveCostingMethod, createCostLayers, consumeCostLayers, type ConsumptionResult } from './costing.service.js'
import { eventBus } from '../events/event-bus.js'

export interface ConfirmMovementOptions {
  /**
   * `<productId>|<warehouseId>` pairs whose cost layers the caller already restored (a void's
   * reversal restores the layers its dispatch consumed). Incoming stock there creates no layer of
   * its own: a second one would hold the same goods twice (#276).
   */
  layersRestored?: Set<string>
}

/**
 * How long a draft's confirm or delete holds it (#448). Long enough for the biggest receipt to book:
 * a confirm that outlived its hold could be deleted under it, leaving stock moved by a movement that
 * no longer exists. A crash leaves the draft unconfirmable for this long, and then it is free again.
 */
export const MOVEMENT_CLAIM_MS = 10 * 60_000

/** A draft nobody is confirming or deleting right now. */
export function unclaimedMovement(now = new Date()): Record<string, unknown> {
  return { $or: [{ claimedUntil: { $exists: false } }, { claimedUntil: null }, { claimedUntil: { $lt: now } }] }
}

export class MovementClaimedError extends Error {
  readonly code = 'movement_busy'
  constructor(readonly movementNumber?: string) {
    super(`${movementNumber || 'This movement'} is being confirmed or deleted right now — try again in a moment`)
  }
}

/**
 * ⚠ The one door into a draft's stock (#448). `confirmMovement` used to read "draft", move every
 * line, and only then write `completed`, with nothing held between. Two confirms both moved the
 * goods, and once drafts could be deleted, a delete in that gap would leave the stock moved by a
 * movement that is gone. Taken atomically; a delete takes the same hold (`movement.controller`).
 */
async function claimDraftMovement(movementId: string): Promise<void> {
  const now = new Date()
  const claimed = await StockMovement.findOneAndUpdate(
    { _id: movementId, status: 'draft', ...unclaimedMovement(now) },
    { $set: { claimedUntil: new Date(now.getTime() + MOVEMENT_CLAIM_MS) } },
    { projection: { _id: 1 } },
  ).exec()
  if (claimed) return
  const current: any = await StockMovement.findById(movementId, { status: 1, movementNumber: 1 }).lean().exec()
  if (!current) throw new Error('Stock movement not found')
  if (current.status !== 'draft') throw new Error('Only draft movements can be confirmed')
  throw new MovementClaimedError(current.movementNumber)
}

/**
 * Book a draft movement: out of `fromWarehouseId`, into `toWarehouseId`, whatever its `type` says.
 *
 * ⚠ Whether those warehouses fit the type (`config/movement-warehouses`) is checked at the doors a
 * user comes through, not here. Everything else that reaches this function sets the side from the
 * type itself, or replays a movement that already happened: `importMovement` (fenced-import) books
 * what a site really applied, and refusing it there would drop goods that moved. Callers also
 * reach it late: `/receive` has written the bill as received by then, so a refusal here would
 * strand a received bill with no stock.
 */
export async function confirmMovement(movementId: string, repos?: RepositoryRegistry, opts?: ConfirmMovementOptions): Promise<IStockMovement> {
  const r = repos ?? getRepos()
  const movement = await r.stockMovements.findById(movementId)
  if (!movement) throw new Error('Stock movement not found')
  if (movement.status !== 'draft') throw new Error('Only draft movements can be confirmed')
  await claimDraftMovement(movementId)

  const orgId = movement.orgId
  const movementDate = movement.date || new Date()
  const updatedLines: any[] = []

  for (const line of movement.lines) {
    const productId = line.productId
    let consumptionResult: ConsumptionResult | undefined

    // Reduce stock from source warehouse
    if (movement.fromWarehouseId) {
      consumptionResult = await adjustStock(orgId, productId, movement.fromWarehouseId, -line.quantity, line.unitCost, r)
    }

    // What the goods are worth where they arrive. A return of a sale says so apart, because its `unitCost` is the
    // document's price, as on every invoice-born line (`createInvoiceStockMovement`). What leaves a warehouse on
    // the way here is worth what it consumes.
    const incomingCost = (movement.fromWarehouseId ? undefined : (line as any).resolvedUnitCost) ?? line.unitCost

    // Add stock to destination warehouse
    if (movement.toWarehouseId) {
      await adjustStock(orgId, productId, movement.toWarehouseId, line.quantity, incomingCost, r)

      // For layer-based methods, create cost layers on incoming stock
      const method = await getEffectiveCostingMethod(orgId, productId, r)
      const restored = opts?.layersRestored?.has(`${String(productId)}|${String(movement.toWarehouseId)}`)
      if (method !== 'wac' && method !== 'standard' && !restored) {
        // For transfers, use the consumed cost; for receipts, use the line cost
        const layerCost = consumptionResult?.weightedUnitCost ?? incomingCost
        await createCostLayers(orgId, movement.toWarehouseId, movementId, movement.movementNumber, movementDate, {
          productId,
          quantity: line.quantity,
          unitCost: layerCost,
          batchNumber: line.batchNumber,
          expiryDate: line.expiryDate,
          serialNumbers: line.serialNumbers,
        }, r)
      }
    }

    // Store cost allocation data on the line
    updatedLines.push({
      ...line,
      costAllocations: consumptionResult?.allocations,
      resolvedUnitCost: consumptionResult?.weightedUnitCost ?? incomingCost,
      costingMethod: consumptionResult?.costingMethod,
    })
  }

  const updated = await r.stockMovements.update(movementId, {
    status: 'completed',
    lines: updatedLines,
    claimedUntil: null,
  } as any)
  if (!updated) throw new Error('Failed to update movement status')

  // Emit event for cross-module journal entry creation (replaces inline createMovementJournalEntry)
  eventBus.emit('stock.movement.confirmed', {
    movementId,
    orgId,
    type: movement.type,
    lines: updatedLines.map((l: any) => ({ productId: l.productId, quantity: l.quantity })),
  })

  logger.info({ movementId, type: movement.type }, 'Stock movement confirmed')
  return updated
}

/**
 * Move a level by `quantity` and return it as it was, or null when the product has no level there.
 *
 * ⚠ One write, worked out by the server from the row as it stands. Reading the row and writing back
 * a quantity computed from that read loses a movement whenever two land on one level at once: both
 * read 7, both write 8, and both movements still say `completed`.
 */
function moveLevel(orgId: string, productId: string, warehouseId: string, quantity: number, unitCost: number) {
  const newQuantity = { $add: ['$quantity', quantity] }
  // Weighted average cost (maintained for WAC and as fallback)
  const avgCost = quantity > 0
    ? {
        $cond: [
          { $gt: ['$quantity', 0] },
          { $divide: [{ $add: [{ $multiply: ['$quantity', '$avgCost'] }, quantity * unitCost] }, newQuantity] },
          unitCost,
        ],
      }
    : '$avgCost'
  return StockLevel.findOneAndUpdate(
    { orgId, productId, warehouseId } as any,
    [{ $set: { quantity: newQuantity, availableQuantity: { $subtract: [newQuantity, { $ifNull: ['$reservedQuantity', 0] }] }, avgCost } }],
    { new: false },
  ).lean().exec() as Promise<{ avgCost: number } | null>
}

/**
 * Adjust stock level for a product in a warehouse.
 * Returns cost consumption result for outgoing stock (layer-based methods).
 */
export async function adjustStock(
  orgId: string,
  productId: string,
  warehouseId: string,
  quantity: number,
  unitCost: number,
  repos?: RepositoryRegistry,
): Promise<ConsumptionResult | undefined> {
  const r = repos ?? getRepos()
  let stockLevel = await moveLevel(orgId, productId, warehouseId, quantity, unitCost)

  if (!stockLevel) {
    try {
      await r.stockLevels.create({
        orgId,
        productId,
        warehouseId,
        quantity,
        reservedQuantity: 0,
        availableQuantity: quantity,
        avgCost: unitCost,
      } as any)

      // Create cost layer for new incoming stock (layer-based methods)
      if (quantity > 0) {
        const method = await getEffectiveCostingMethod(orgId, productId, r)
        if (method !== 'wac' && method !== 'standard') {
          // Layers are created by confirmMovement, not here
          // This function only handles stock level updates
        }
      }
      return undefined
    } catch (err) {
      // Another movement made the row after this one looked: this one lands on that row.
      if (!(err instanceof DuplicateError)) throw err
      stockLevel = await moveLevel(orgId, productId, warehouseId, quantity, unitCost)
      if (!stockLevel) throw err
    }
  }

  // For outgoing stock, consume cost layers if using layer-based method
  if (quantity < 0) {
    const method = await getEffectiveCostingMethod(orgId, productId, r)
    if (method !== 'wac' && method !== 'standard') {
      const product = await r.products.findById(productId)
      return consumeCostLayers(orgId, productId, warehouseId, Math.abs(quantity), method, r, {
        stockLevel: { avgCost: stockLevel.avgCost },
        standardCost: product?.standardCost,
      })
    }
    // WAC/Standard: return result without layer consumption
    if (method === 'standard') {
      const product = await r.products.findById(productId)
      return consumeCostLayers(orgId, productId, warehouseId, Math.abs(quantity), method, r, {
        standardCost: product?.standardCost,
      })
    }
    return consumeCostLayers(orgId, productId, warehouseId, Math.abs(quantity), method, r, {
      stockLevel: { avgCost: stockLevel.avgCost },
    })
  }

  return undefined
}

/**
 * Cheap header numbers for dashboards: Σ(quantity × avgCost) + row count in one
 * aggregation. getStockValuation below materialises every item (23k docs + a 23k-id
 * $in on regal — ~1.6s); this stays ~25ms. (Aggregate does NOT auto-cast orgId.)
 */
export async function getStockValuationTotals(orgId: string): Promise<{ totalValue: number; itemCount: number }> {
  const [res] = await StockLevel.aggregate([
    { $match: { orgId: new StockLevel.base.Types.ObjectId(orgId) } },
    { $group: { _id: null, totalValue: { $sum: { $multiply: ['$quantity', '$avgCost'] } }, itemCount: { $sum: 1 } } },
  ]).exec()
  return { totalValue: +(res?.totalValue || 0).toFixed(2), itemCount: res?.itemCount || 0 }
}

export async function getStockValuation(orgId: string, repos?: RepositoryRegistry): Promise<{
  items: { productId: string; name: string; totalQty: number; avgCost: number; totalValue: number }[]
  totalValue: number
}> {
  const r = repos ?? getRepos()
  const levels = await r.stockLevels.findMany({ orgId })
  const productIds = [...new Set(levels.map(l => l.productId))]
  const products = await r.products.findMany({ orgId, id: { $in: productIds } } as any)
  const productMap = new Map(products.map(p => [p.id, p]))

  const aggregated = new Map<string, { qty: number; value: number }>()

  for (const level of levels) {
    const key = level.productId
    const current = aggregated.get(key) || { qty: 0, value: 0 }
    current.qty += level.quantity
    current.value += level.quantity * level.avgCost
    aggregated.set(key, current)
  }

  const items = [...aggregated.entries()].map(([productId, data]) => ({
    productId,
    name: productMap.get(productId)?.name || 'Unknown',
    totalQty: data.qty,
    avgCost: data.qty > 0 ? data.value / data.qty : 0,
    totalValue: data.value,
  }))

  const totalValue = items.reduce((sum, i) => sum + i.totalValue, 0)
  return { items, totalValue }
}
