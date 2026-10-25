import { getRepos } from '../context.js'
import { confirmMovement } from './warehouse.service.js'
import { loadReservationBudgets } from './invoicing.service.js'

export interface StockShortfall {
  productId: string
  productName: string
  warehouseId: string
  warehouseName: string
  requested: number
  available: number
  deficit: number
}

export interface TransferSource {
  fromWarehouseId: string
  fromWarehouseName: string
  available: number
  transferQuantity: number
}

export interface TransferProposal {
  productId: string
  productName: string
  toWarehouseId: string
  toWarehouseName: string
  sources: TransferSource[]
  totalTransfer: number
  deficit: number
}

export interface StockAvailabilityResult {
  sufficient: boolean
  shortfalls: StockShortfall[]
  proposals: TransferProposal[]
  allResolvable: boolean
}

/**
 * Check stock availability for invoice lines across all warehouses.
 * For each line with insufficient stock, propose transfers from other warehouses.
 */
export async function checkCrossWarehouseAvailability(
  orgId: string,
  lines: { productId: string; warehouseId: string; quantity: number; reservationId?: string }[],
): Promise<StockAvailabilityResult> {
  const r = getRepos()
  const shortfalls: StockShortfall[] = []
  const proposals: TransferProposal[] = []

  // Reservation-backed lines consume their own hold (the same budgets Issue applies, shared
  // across the document's lines) — fold the exemption into the demand aggregation so the
  // pre-flight doesn't propose transferring the client's own reserve, and does report goods a
  // supplier order has not delivered yet.
  const budgets = await loadReservationBudgets(
    orgId,
    [...new Set(lines.map(l => l.reservationId).filter(Boolean) as string[])],
  )

  // Aggregate net demand per product+warehouse
  const demand = new Map<string, { productId: string; warehouseId: string; quantity: number }>()
  for (const line of lines) {
    if (!line.productId || !line.warehouseId) continue
    let required = line.quantity
    if (line.reservationId) required -= budgets.take(String(line.reservationId), required)
    if (required <= 1e-9) continue // subtraction residue on fractional units is not demand
    const key = `${line.productId}|${line.warehouseId}`
    const existing = demand.get(key)
    if (existing) {
      existing.quantity += required
    } else {
      demand.set(key, { productId: line.productId, warehouseId: line.warehouseId, quantity: required })
    }
  }

  // Sellable stock = quantity − reservedQuantity, computed from the authoritative
  // fields (the denormalised availableQuantity can be stale on legacy/seeded rows).
  const sellable = (sl: any) => (sl.quantity || 0) - (sl.reservedQuantity || 0)

  // Check each demand entry
  for (const entry of demand.values()) {
    // Get stock at target warehouse
    const targetLevel = await r.stockLevels.findOne({
      orgId, productId: entry.productId, warehouseId: entry.warehouseId,
    } as any)
    const available = targetLevel ? sellable(targetLevel) : 0

    if (available >= entry.quantity) continue // sufficient

    const deficit = entry.quantity - available

    // Get product name
    const product = await r.products.findById(entry.productId)
    const productName = product?.name || entry.productId

    // Get target warehouse name
    const targetWh = await r.warehouses.findById(entry.warehouseId)
    const warehouseName = targetWh?.name || entry.warehouseId

    shortfalls.push({
      productId: entry.productId,
      productName,
      warehouseId: entry.warehouseId,
      warehouseName,
      requested: entry.quantity,
      available,
      deficit,
    })

    // Find stock in other warehouses
    const allLevels = await r.stockLevels.findMany({
      orgId, productId: entry.productId,
    } as any)

    const sources: TransferSource[] = []
    let remainingDeficit = deficit

    // Sort by sellable quantity descending (greedy: take from largest first)
    const otherLevels = allLevels
      .filter((sl: any) => sl.warehouseId !== entry.warehouseId && sellable(sl) > 0)
      .sort((a: any, b: any) => sellable(b) - sellable(a))

    // Include ALL available warehouses so the user can choose which to transfer from.
    // The greedy algorithm pre-fills suggested transferQuantity.
    for (const sl of otherLevels) {
      const wh = await r.warehouses.findById((sl as any).warehouseId)
      let transferQty = 0
      if (remainingDeficit > 0) {
        transferQty = Math.min(sellable(sl), remainingDeficit)
        remainingDeficit -= transferQty
      }
      sources.push({
        fromWarehouseId: (sl as any).warehouseId,
        fromWarehouseName: wh?.name || (sl as any).warehouseId,
        available: sellable(sl),
        transferQuantity: transferQty,
      })
    }

    proposals.push({
      productId: entry.productId,
      productName,
      toWarehouseId: entry.warehouseId,
      toWarehouseName: warehouseName,
      sources,
      totalTransfer: deficit - remainingDeficit,
      deficit: remainingDeficit,
    })
  }

  return {
    sufficient: shortfalls.length === 0,
    shortfalls,
    proposals,
    allResolvable: proposals.every(p => p.deficit === 0),
  }
}

/**
 * Create draft transfer movements for accepted proposals.
 * Returns the created movement IDs.
 */
export async function createTransferMovements(
  orgId: string,
  proposals: TransferProposal[],
  userId: string,
): Promise<string[]> {
  const r = getRepos()
  const transferIds: string[] = []

  for (const proposal of proposals) {
    for (const source of proposal.sources) {
      if (source.transferQuantity <= 0) continue

      // Generate movement number
      const year = new Date().getFullYear()
      const prefix = `SM-${year}-`
      const movements = await r.stockMovements.findMany(
        { orgId, movementNumber: { $regex: `^${prefix}` } } as any,
        { movementNumber: -1 },
      )
      const seq = movements.length > 0
        ? Number(movements[0].movementNumber.replace(prefix, '')) + 1
        : 1
      const movementNumber = `${prefix}${String(seq).padStart(5, '0')}`

      // Look up current cost for the product in the source warehouse
      const stockLevel = await r.stockLevels.findOne({ orgId, productId: proposal.productId, warehouseId: source.fromWarehouseId } as any)
      const unitCost = stockLevel?.avgCost || 0
      const totalCost = source.transferQuantity * unitCost

      const movement = await r.stockMovements.create({
        orgId,
        movementNumber,
        type: 'transfer',
        status: 'draft',
        date: new Date(),
        fromWarehouseId: source.fromWarehouseId,
        toWarehouseId: proposal.toWarehouseId,
        lines: [{
          productId: proposal.productId,
          quantity: source.transferQuantity,
          unitCost,
          totalCost,
        }],
        totalAmount: totalCost,
        notes: `Auto-transfer for invoice: ${proposal.productName} (${source.transferQuantity} units from ${source.fromWarehouseName} to ${proposal.toWarehouseName})`,
        createdBy: userId,
      } as any)

      transferIds.push(movement.id)
    }
  }

  return transferIds
}

/**
 * Confirm transfer movements by ID. Used before sending an invoice
 * that depends on these transfers.
 */
export async function confirmTransferMovements(
  transferIds: string[],
): Promise<void> {
  const r = getRepos()
  for (const id of transferIds) {
    const movement = await r.stockMovements.findById(id)
    if (movement && movement.status === 'draft') {
      await confirmMovement(id, r)
    }
  }
}
