import { Product, StockLevel } from 'db/models'

/**
 * FR-27.11.C.4 (#529) — the server prices an inventory count, never the form. Each line's `varianceCost` is its
 * variance at the stock level's average cost in the count's warehouse, on a save and again when the count completes
 * (which books its adjustment at `varianceCost / variance`). A `varianceCost` in the body is ignored: a role that counts
 * without seeing `avgCost` would otherwise book every adjustment at zero cost, and any form could book its own figure.
 *
 * The figure is the form's own formula (variance × average cost, unrounded), so a count saved by a role that sees the
 * cost is priced exactly as before.
 *
 * FR-33.15 (#933), D-4 — **found goods**: an article with no level in the count's warehouse, or a level without an
 * average cost, is priced at the article's purchase price, and at 0 only when it has none. Priced at 0, the completion's
 * adjustment opened the level at an average cost of 0 (`adjustStock` creates the row at the line's unit cost), and every
 * later sale of those goods cost nothing.
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
  const cost = new Map<string, number>()
  for (const s of levels as Array<{ productId: unknown; avgCost?: unknown }>) {
    const avg = Number(s.avgCost) || 0
    if (avg > 0) cost.set(String(s.productId), avg)
  }
  // D-4: what the warehouse cannot price, the article's purchase price prices. One read, for those lines only.
  const found = ids.filter(id => !cost.has(id) && /^[0-9a-f]{24}$/i.test(id))
  if (found.length && warehouseId) {
    const products = await Product.find({ orgId: String(orgId), _id: { $in: found } }, { purchasePrice: 1 }).lean().exec()
    for (const p of products as Array<{ _id: unknown; purchasePrice?: unknown }>) cost.set(String(p._id), Number(p.purchasePrice) || 0)
  }
  return list.map(l => {
    const variance = typeof l?.variance === 'number' ? l.variance : (Number(l?.countedQuantity) || 0) - (Number(l?.systemQuantity) || 0)
    return { ...l, variance, varianceCost: variance * (cost.get(String(l?.productId ?? '')) ?? 0) }
  })
}
