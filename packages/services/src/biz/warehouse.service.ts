import type { RepositoryRegistry } from 'dal'
import { DuplicateError } from 'dal'
import type { IStockMovement } from 'dal/entities'
import type { CostingMethod } from 'config'
import type { ClientSession } from 'mongoose'
import { StockLevel, StockMovement } from 'db/models'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'
import {
  getEffectiveCostingMethod, createCostLayers, consumeCostLayers, costingOfArticles, StockBookingRefusedError,
  type ArticleCosting, type ConsumptionResult,
} from './costing.service.js'
import { eventBus } from '../events/event-bus.js'
import { externalWarehouseIds } from './external-warehouses.js'
import { inTransaction } from './transaction.js'
import { ttlCache } from '../utils/ttl-cache.js'
import { enqueuePosting } from './postings/posting.service.js'

export interface ConfirmMovementOptions {
  /**
   * `<productId>|<warehouseId>` pairs whose cost layers the caller already restored (a void's
   * reversal restores the layers its dispatch consumed). Incoming stock there creates no layer of
   * its own: a second one would hold the same goods twice (#276).
   */
  layersRestored?: Set<string>
  /**
   * The caller's transaction (FR-29.3): the booking joins it and starts none of its own. Its claim, its
   * levels, its layers and its status are then the caller's to commit or abort, and so is
   * `stock.movement.confirmed`, which the caller sends after its commit (`announceMovementConfirmed`).
   * ⚠ A caller that catches an error of this booking must abort, never commit what it holds.
   */
  session?: ClientSession
}

export { StockBookingRefusedError } from './costing.service.js'

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

/** It is no longer a draft. A confirm that lost to another one reads this after its own check passed. */
export class MovementNotDraftError extends Error {
  constructor() {
    super('Only draft movements can be confirmed')
  }
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
async function claimDraftMovement(movementId: string, session?: ClientSession): Promise<Date> {
  const now = new Date()
  const until = new Date(now.getTime() + MOVEMENT_CLAIM_MS)
  const claimed = await StockMovement.findOneAndUpdate(
    { _id: movementId, status: 'draft', ...unclaimedMovement(now) },
    { $set: { claimedUntil: until } },
    { projection: { _id: 1 }, ...(session ? { session } : {}) },
  ).exec()
  if (claimed) return until
  const current: any = await StockMovement.findById(movementId, { status: 1, movementNumber: 1 }, session ? { session } : {}).lean().exec()
  if (!current) throw new Error('Stock movement not found')
  if (current.status !== 'draft') throw new MovementNotDraftError()
  throw new MovementClaimedError(current.movementNumber)
}

/**
 * Lets go of this confirm's claim (FR-29.2): only the one it took, on a draft. A claim that lapsed and
 * was taken by someone else carries another time, and stays theirs.
 */
async function releaseClaim(movementId: string, claim: Date): Promise<void> {
  try {
    await StockMovement.updateOne({ _id: movementId, status: 'draft', claimedUntil: claim }, { $set: { claimedUntil: null } }).exec()
  } catch (e) {
    // The claim then lapses by itself (MOVEMENT_CLAIM_MS); the refusal the caller is about to get matters more.
    logger.error({ movementId, err: e }, 'A failed confirm could not release its claim')
  }
}

/**
 * The refusal as a person reads it (FR-29.6): the article's name and SKU and the warehouse's name,
 * read after the booking was rolled back. Never an id: an article or warehouse that cannot be read is
 * left unnamed.
 */
async function nameRefusal(e: StockBookingRefusedError, orgId: string, r: RepositoryRegistry): Promise<StockBookingRefusedError> {
  try {
    const [product, warehouse] = await Promise.all([
      r.products.findByIdInOrg(e.productId, orgId, { select: ['name', 'sku'] }),
      r.warehouses.findByIdInOrg(e.warehouseId, orgId, { select: ['name'] }),
    ])
    return e.named({ product: (product as any)?.name, sku: (product as any)?.sku, warehouse: (warehouse as any)?.name })
  } catch {
    return e
  }
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
 *
 * ⚠ An external warehouse keeps no stock in this org (`Warehouse.isExternal`), so a side that names
 * one is booked as if it named none: no level, no cost layer, and the costs read the sides that
 * remain. A transfer from one is goods arriving from outside (the level takes the line's cost, or,
 * where the line carries none, what the article costs here: `costsAt`), a transfer to one goods
 * leaving. This is the last line of defence, for every path that reaches here
 * without passing a user door (an import, a replay, a count): none of them can put stock on an
 * external warehouse. A sale's dispatch and a bill's receipt are refused before they get here
 * (`invoicing.service#stockBooking`), because booking nothing for them is a document issued with
 * its stock unmoved. The id then moves to `externalFromWarehouseId` /
 * `externalToWarehouseId`, so that on a COMPLETED movement `fromWarehouseId` / `toWarehouseId` name
 * only warehouses whose stock it moved. Every reader that derives stock from movements relies on
 * that, and none of them reads the external pair. The flag is read now: the movement records what
 * was true when it was confirmed.
 */
export async function confirmMovement(movementId: string, repos?: RepositoryRegistry, opts?: ConfirmMovementOptions): Promise<IStockMovement> {
  const r = repos ?? getRepos()
  const outer = opts?.session
  const movement = await r.stockMovements.findById(movementId, outer ? { session: outer } : undefined)
  if (!movement) throw new Error('Stock movement not found')
  if (movement.status !== 'draft') throw new MovementNotDraftError()
  const claim = await claimDraftMovement(movementId, outer)

  let updated: IStockMovement
  try {
    // FR-29.1: every level, every cost layer and the status, or none of them. Joined when the caller
    // is in a transaction of its own (FR-29.3): its commit or its abort decides for both.
    updated = outer
      ? await bookMovement(movement, r, opts, outer)
      // A level another booking opens at the same moment aborts this one with a duplicate key: it then
      // runs again, on the row that exists (outside a transaction `adjustStock` lands on it instead).
      : await inTransaction(session => bookMovement(movement, r, opts, session))
  } catch (e) {
    // FR-29.2: a confirm that did not complete lets go of the draft before it answers, so the next
    // one meets the real refusal again and not "is being confirmed". Joined, the caller's abort does.
    if (!outer) await releaseClaim(movementId, claim)
    if (e instanceof StockBookingRefusedError) throw await nameRefusal(e, movement.orgId, r)
    throw e
  }

  // FR-29.7: the event leaves once the booking is stored, never from inside the transaction. Joined,
  // the caller announces it after ITS commit.
  if (!outer) announceMovementConfirmed(updated)
  logger.info({ movementId, type: movement.type }, 'Stock movement confirmed')
  return updated
}

/**
 * `stock.movement.confirmed` for a booked movement: once, after its commit (FR-29.7). `confirmMovement`
 * sends it itself unless it joined a caller's transaction; that caller sends it after committing.
 */
export function announceMovementConfirmed(movement: IStockMovement): void {
  eventBus.emit('stock.movement.confirmed', {
    movementId: String(movement.id),
    orgId: String(movement.orgId),
    type: movement.type,
    lines: (movement.lines ?? []).map((l: any) => ({ productId: l.productId, quantity: l.quantity })),
  })
}

/**
 * The writes of one booking, in `session`: the levels, the cost layers and the movement's status.
 *
 * FR-29.5: what it reads does not grow with the lines: the warehouses' external flags, the articles'
 * costing (`costingOfArticles`, two reads) and, for goods from an external warehouse, what they cost
 * here (`costsAt`, two). Per line it writes the level (one round trip, two when the level is new) and,
 * on a layered method, reads and takes the layers.
 */
async function bookMovement(movement: IStockMovement, r: RepositoryRegistry, opts: ConfirmMovementOptions | undefined, session: ClientSession): Promise<IStockMovement> {
  const movementId = String(movement.id)
  const orgId = movement.orgId
  const movementDate = movement.date || new Date()
  const updatedLines: any[] = []

  // The sides this movement books: its two warehouses, less any that is external now.
  const external = await externalWarehouseIds(orgId, [movement.fromWarehouseId, movement.toWarehouseId])
  const fromExternal = !!movement.fromWarehouseId && external.has(String(movement.fromWarehouseId))
  const toExternal = !!movement.toWarehouseId && external.has(String(movement.toWarehouseId))
  const fromWarehouseId = fromExternal ? undefined : movement.fromWarehouseId
  const toWarehouseId = toExternal ? undefined : movement.toWarehouseId

  // ⚠ Goods from an external warehouse arrive at the line's cost, and a line may carry none: a role that
  // does not see costs has none to send. Booked at zero they would pull the level's average down with
  // every delivery from the other site, so such a line arrives at what the article costs here.
  const costOf = (line: any): number => Number(line.resolvedUnitCost ?? line.unitCost)
  const uncosted = fromExternal && toWarehouseId ? movement.lines.filter(l => !(costOf(l) > 0)).map(l => l.productId) : []
  const costHere = uncosted.length ? await costsAt(orgId, toWarehouseId!, uncosted, r, session) : undefined

  // FR-29.5: the org's costing method once and the articles' in one query, not per line.
  const costing = await costingOfArticles(orgId, movement.lines.map(l => l.productId), r, { session })
  const booking = (productId: unknown): BookingContext => ({ session, ...costing.get(String(productId)) })

  for (const line of movement.lines) {
    const productId = line.productId
    let consumptionResult: ConsumptionResult | undefined

    // Reduce stock from source warehouse
    if (fromWarehouseId) {
      // ⚠ A dispatch's `unitCost` is the sale price. What leaves a level never moves its average, so
      // this only says what a level opened by this movement starts with: no cost known, and not
      // what the goods sold for, which the next sale out of it would read as their cost (FR-25).
      const leavingAt = movement.type === 'dispatch' ? 0 : line.unitCost
      consumptionResult = await adjustStock(orgId, productId, fromWarehouseId, -line.quantity, leavingAt, r, booking(productId))
    }

    // What the goods are worth where they arrive. A return of a sale says so apart, because its `unitCost` is the
    // document's price, as on every invoice-born line (`createInvoiceStockMovement`). What leaves a warehouse on
    // the way here is worth what it consumes.
    //
    // ⚠ Between two of our own warehouses (#778) the goods are already valued: they arrive at what they
    // cost where they left (the source level's average, or the layers they consumed), and the line's
    // `unitCost` is only what the form showed. Taken from the line, a cost left at 0, edited, or sent by
    // an API client changed the org's stock value with nothing bought or sold. Only a source with no
    // level to consume from (the goods went below zero there) falls back to the line.
    const consumedAtSource = fromWarehouseId && toWarehouseId ? consumptionResult?.weightedUnitCost : undefined
    let incomingCost = consumedAtSource ?? (fromWarehouseId ? undefined : (line as any).resolvedUnitCost) ?? line.unitCost
    if (costHere && !(incomingCost > 0)) incomingCost = costHere.get(String(productId)) ?? incomingCost

    // Add stock to destination warehouse
    if (toWarehouseId) {
      await adjustStock(orgId, productId, toWarehouseId, line.quantity, incomingCost, r, booking(productId))

      // For layer-based methods, create cost layers on incoming stock
      const method = costing.get(String(productId))?.method ?? 'wac'
      const restored = opts?.layersRestored?.has(`${String(productId)}|${String(toWarehouseId)}`)
      if (method !== 'wac' && method !== 'standard' && !restored) {
        // A transfer's layer opens at the consumed cost (= incomingCost since #778); a receipt's at the line's
        const layerCost = consumptionResult?.weightedUnitCost ?? incomingCost
        await createCostLayers(orgId, toWarehouseId, movementId, movement.movementNumber, movementDate, {
          productId,
          quantity: line.quantity,
          unitCost: layerCost,
          batchNumber: line.batchNumber,
          expiryDate: line.expiryDate,
          serialNumbers: line.serialNumbers,
        }, r, { session })
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
    // An external side leaves the stock fields: completed, they name what moved (see above).
    ...(fromExternal ? { fromWarehouseId: null, externalFromWarehouseId: movement.fromWarehouseId } : {}),
    ...(toExternal ? { toWarehouseId: null, externalToWarehouseId: movement.toWarehouseId } : {}),
  } as any, { session })
  if (!updated) throw new Error('Failed to update movement status')
  // FR-29.15: the valuation entry it owes, in the booking's own transaction (`postings/posting.service`).
  await enqueuePosting(orgId, { event: 'stock.movement.confirmed', movementId, movementType: movement.type }, { session })
  return updated
}

/**
 * What each of these articles costs in a warehouse, for goods that arrive saying nothing of their own:
 * today's average of its level there, so their arrival moves no average, then what the article is
 * bought at (as a return no dispatch prices, `invoicing.service#costNoDispatchSays`). An article with
 * neither is not in the answer.
 */
async function costsAt(orgId: string, warehouseId: string, productIds: unknown[], r: RepositoryRegistry, session?: ClientSession): Promise<Map<string, number>> {
  const ids = [...new Set(productIds.map(String))]
  // In order, not at once: both run in the booking's transaction (see `costingOfArticles`).
  const levels = await r.stockLevels.findMany({ orgId, warehouseId, productId: { $in: ids } } as any, undefined, { select: ['productId', 'avgCost'], session })
  const products = await r.products.findMany({ orgId, id: { $in: ids } } as any, undefined, { select: ['purchasePrice'], session })
  const cost = new Map<string, number>()
  for (const p of products as any[]) if (Number(p.purchasePrice) > 0) cost.set(String(p.id), Number(p.purchasePrice))
  for (const l of levels as any[]) if (Number(l.avgCost) > 0) cost.set(String(l.productId), Number(l.avgCost))
  return cost
}

/**
 * Move a level by `quantity` and return it as it was, or null when the product has no level there.
 *
 * ⚠ One write, worked out by the server from the row as it stands. Reading the row and writing back
 * a quantity computed from that read loses a movement whenever two land on one level at once: both
 * read 7, both write 8, and both movements still say `completed`.
 */
function moveLevel(orgId: string, productId: string, warehouseId: string, quantity: number, unitCost: number, session?: ClientSession) {
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
    { new: false, ...(session ? { session } : {}) },
  ).lean().exec() as Promise<{ avgCost: number } | null>
}

/**
 * What a booking hands `adjustStock` (FR-29.3, FR-29.5): its transaction, and the article's costing it
 * read once for every line. A caller that passes no costing gets it read here, as before.
 */
export interface BookingContext extends Partial<ArticleCosting> {
  session?: ClientSession
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
  ctx: BookingContext = {},
): Promise<ConsumptionResult | undefined> {
  const r = repos ?? getRepos()
  const { session } = ctx
  let stockLevel = await moveLevel(orgId, productId, warehouseId, quantity, unitCost, session)

  if (!stockLevel) {
    try {
      // A new level: no cost layer here, `confirmMovement` makes those for incoming stock.
      await r.stockLevels.create({
        orgId,
        productId,
        warehouseId,
        quantity,
        reservedQuantity: 0,
        availableQuantity: quantity,
        avgCost: unitCost,
      } as any, { session })
      return undefined
    } catch (err) {
      // Another movement made the row after this one looked: this one lands on that row. Not inside a
      // transaction, which the duplicate key has aborted: the booking runs again (`inTransaction`).
      if (!(err instanceof DuplicateError) || session) throw err
      stockLevel = await moveLevel(orgId, productId, warehouseId, quantity, unitCost)
      if (!stockLevel) throw err
    }
  }

  // For outgoing stock, consume cost layers if using layer-based method
  if (quantity < 0) {
    const method: CostingMethod = ctx.method ?? await getEffectiveCostingMethod(orgId, productId, r)
    if (method !== 'wac' && method !== 'standard') {
      return consumeCostLayers(orgId, productId, warehouseId, Math.abs(quantity), method, r, {
        stockLevel: { avgCost: stockLevel.avgCost },
        session,
      })
    }
    const standardCost = async () => ctx.method
      ? ctx.standardCost
      : (await r.products.findById(productId, { select: ['standardCost'], session }))?.standardCost
    // WAC/Standard: return result without layer consumption
    if (method === 'standard') {
      return consumeCostLayers(orgId, productId, warehouseId, Math.abs(quantity), method, r, {
        standardCost: await standardCost(),
        session,
      })
    }
    return consumeCostLayers(orgId, productId, warehouseId, Math.abs(quantity), method, r, {
      stockLevel: { avgCost: stockLevel.avgCost },
      session,
    })
  }

  return undefined
}

/**
 * Cheap header numbers for dashboards: Σ(quantity × avgCost) + row count in one
 * aggregation. getStockValuation below materialises every item (23k docs + a 23k-id
 * $in on regal — ~1.6s); this stays ~25ms. (Aggregate does NOT auto-cast orgId.)
 */
/**
 * FR-30.16: the dashboard's stock value, at most a minute old. It summed every stock level of the org on each open
 * of the dashboard (about 95 ms on a shop's 46 000 levels).
 */
export const STOCK_TOTALS_TTL_MS = 60_000
const stockTotals = ttlCache<{ totalValue: number; itemCount: number }>(STOCK_TOTALS_TTL_MS)
export function cachedStockValuationTotals(orgId: string): Promise<{ totalValue: number; itemCount: number }> {
  return stockTotals.get(orgId, () => getStockValuationTotals(orgId))
}

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
