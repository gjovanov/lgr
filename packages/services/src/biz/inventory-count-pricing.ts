import { StockLevel } from 'db/models'

/**
 * FR-27.11.C.4 (#529) — the server prices an inventory count, never the form. Each line's `varianceCost` is its
 * variance at the stock level's average cost in the count's warehouse, on a save and again when the count completes
 * (which books its adjustment at `varianceCost / variance`). A `varianceCost` in the body is ignored: a role that counts
 * without seeing `avgCost` would otherwise book every adjustment at zero cost, and any form could book its own figure.
 *
 * The figure is the form's own formula (variance × average cost, unrounded), so a count saved by a role that sees the
 * cost is priced exactly as before.
 */
export async function priceCountLines<L extends { productId?: unknown; variance?: number; countedQuantity?: number; systemQuantity?: number }>(
  orgId: unknown,
  warehouseId: unknown,
  lines: readonly L[] | null | undefined,
): Promise<Array<L & { variance: number; varianceCost: number }>> {
  const list = Array.isArray(lines) ? lines : []
  const ids = [...new Set(list.map(l => String(l?.productId ?? '')).filter(Boolean))]
  const levels = ids.length && warehouseId
    ? await StockLevel.find({ orgId, warehouseId, productId: { $in: ids } } as any, { productId: 1, avgCost: 1 }).lean().exec()
    : []
  const avg = new Map(levels.map((s: any) => [String(s.productId), Number(s.avgCost) || 0]))
  return list.map(l => {
    const variance = typeof l?.variance === 'number' ? l.variance : (Number(l?.countedQuantity) || 0) - (Number(l?.systemQuantity) || 0)
    return { ...l, variance, varianceCost: variance * (avg.get(String(l?.productId ?? '')) ?? 0) }
  })
}
